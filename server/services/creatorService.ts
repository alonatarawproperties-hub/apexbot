import * as db from "../db";
import { getTokenInfo, getTokensByAddresses } from "./dexscreener";
import { logger } from "../utils/logger";
import { getCurrentTimestamp, getPumpFunUrl, formatMarketCap } from "../utils/helpers";
import { fetchCreatorTokenHistory } from "./bitqueryService";
import type { Creator, Token, UserSettings, CreatorStats } from "@shared/schema";

export async function processNewToken(
  creatorAddress: string,
  tokenAddress: string,
  tokenName?: string,
  tokenSymbol?: string
): Promise<{ creator: Creator; token: Token; isQualified: boolean; watcherUserIds: string[] }> {
  let creator = db.getCreator(creatorAddress);
  const isNewCreator = !creator;

  if (!creator) {
    creator = db.upsertCreator({
      address: creatorAddress,
      total_launches: 1,
      bonded_count: 0,
      hits_100k_count: 0,
      best_mc_ever: 0,
      is_qualified: 0,
      qualification_reason: null,
      last_updated: getCurrentTimestamp(),
    });
    
    importCreatorHistory(creatorAddress).catch(err => {
      logger.error(`Failed to import history for ${creatorAddress.slice(0, 8)}:`, err.message);
    });
  } else {
    creator = db.upsertCreator({
      ...creator,
      total_launches: creator.total_launches + 1,
      last_updated: getCurrentTimestamp(),
    });
  }

  let token = db.getToken(tokenAddress);
  if (!token) {
    token = db.createToken({
      address: tokenAddress,
      creator_address: creatorAddress,
      name: tokenName || null,
      symbol: tokenSymbol || null,
      bonded: 0,
      peak_mc: 0,
      peak_mc_timestamp: null,
      peak_mc_held_minutes: 0,
      current_mc: 0,
      pumpfun_url: getPumpFunUrl(tokenAddress),
    });
  }

  // Don't call DexScreener here -- new tokens won't have data yet.
  // The mcTracker job will pick up market data on its next run (every 2 min).
  // Use existing creator stats from DB to decide qualification.

  creator = db.getCreator(creatorAddress)!;

  const watcherUserIds = db.getWatchersForCreator(creatorAddress);

  return {
    creator,
    token,
    isQualified: creator.is_qualified === 1,
    watcherUserIds,
  };
}

export type CreatorTier = "elite" | "proven" | "none";

/**
 * Check if a creator is likely a spammer based on launch volume and success rate
 * Returns true if creator should be filtered out
 */
export function isSpamCreator(totalLaunches: number, bondedCount: number, hits100kCount: number): boolean {
  if (totalLaunches <= 0) return false;
  
  const bondingRate = (bondedCount / totalLaunches) * 100;
  const successCount = bondedCount + hits100kCount;
  
  // Rule 1: 20+ launches with 0 bonds = spam
  if (totalLaunches >= 20 && bondedCount === 0) return true;
  
  // Rule 2: 10+ launches requires at least 5% bonding rate
  if (totalLaunches >= 10 && bondingRate < 5) return true;
  
  // Rule 3: 50+ launches requires at least 3% bonding rate (more lenient for high volume)
  if (totalLaunches >= 50 && bondingRate < 3) return true;
  
  // Rule 4: 100+ launches requires at least 2% bonding rate
  if (totalLaunches >= 100 && bondingRate < 2) return true;
  
  // Rule 5: 500+ launches with less than 1% = definitely spam
  if (totalLaunches >= 500 && bondingRate < 1) return true;
  
  return false;
}

export function getCreatorTier(bondedCount: number, hits100kCount: number, totalLaunches: number, bestMcEver: number): CreatorTier {
  const bondingRate = totalLaunches > 0 ? bondedCount / totalLaunches : 0;
  
  // ABSOLUTE MINIMUM REQUIREMENT: Must have at least 2 bonded tokens
  // This is the #1 rule to prevent spam - single lucky hits don't qualify
  if (bondedCount < 2) {
    return "none";
  }
  
  // First check if this is a spam creator - they get no tier
  if (isSpamCreator(totalLaunches, bondedCount, hits100kCount)) {
    return "none";
  }

  // STRICT BONDING RATE REQUIREMENTS:
  // 5+ launches needs at least 20% bonding rate
  if (totalLaunches >= 5 && bondingRate < 0.2) {
    return "none";
  }
  
  // 10+ launches needs at least 15% bonding rate AND 2+ bonded
  if (totalLaunches >= 10 && (bondingRate < 0.15 || bondedCount < 2)) {
    return "none";
  }
  
  // 15+ launches needs at least 3 bonded tokens
  if (totalLaunches >= 15 && bondedCount < 3) {
    return "none";
  }
  
  // 20+ launches needs at least 4 bonded tokens
  if (totalLaunches >= 20 && bondedCount < 4) {
    return "none";
  }

  // Elite: 500k+ MC AND at least 3 bonded tokens OR 4+ bonded with 40%+ rate
  if (bestMcEver >= 500000 && bondedCount >= 3) return "elite";
  if (bondedCount >= 4 && bondingRate >= 0.4) return "elite";

  // Proven: 2+ tokens hit 100k+ with good rate OR 3+ bonded tokens with 25%+ rate
  if (hits100kCount >= 2 && bondingRate >= 0.2) return "proven";
  if (bondedCount >= 3 && bondingRate >= 0.25) return "proven";
  
  // 2 bonded tokens qualifies only with very high rate (33%+)
  if (bondedCount >= 2 && bondingRate >= 0.33) return "proven";

  return "none";
}

export async function recalculateCreatorStats(creatorAddress: string): Promise<void> {
  const tokens = db.getTokensByCreator(creatorAddress);

  if (tokens.length === 0) {
    return;
  }

  const tokenAddresses = tokens.map(t => t.address);
  const tokenInfoMap = await getTokensByAddresses(tokenAddresses);

  let bondedCount = 0;
  let hits100kCount = 0;
  let bestMcEver = 0;

  for (const token of tokens) {
    const info = tokenInfoMap.get(token.address);

    if (info) {
      const effectivePeakMc = Math.max(info.marketCap, token.peak_mc);
      // If MC ever hit 69K+, it's bonded (PumpFun bonding threshold)
      const isBonded = info.isBonded || effectivePeakMc >= 69000 || token.bonded === 1;
      
      db.updateToken(token.address, {
        current_mc: info.marketCap,
        bonded: isBonded ? 1 : 0,
        name: info.name,
        symbol: info.symbol,
      });

      if (info.marketCap > token.peak_mc) {
        db.updateToken(token.address, {
          peak_mc: info.marketCap,
          peak_mc_timestamp: getCurrentTimestamp(),
        });
      }

      if (isBonded) bondedCount++;
      if (effectivePeakMc >= 100000) hits100kCount++;
      if (effectivePeakMc > bestMcEver) bestMcEver = effectivePeakMc;
    } else {
      // If peak MC >= 69K, it's bonded
      const isBonded = token.bonded === 1 || token.peak_mc >= 69000;
      if (isBonded) bondedCount++;
      if (token.peak_mc >= 100000) hits100kCount++;
      if (token.peak_mc > bestMcEver) bestMcEver = token.peak_mc;
    }
  }

  const totalLaunches = tokens.length;
  const bondingRate = totalLaunches > 0 ? bondedCount / totalLaunches : 0;

  const tier = getCreatorTier(bondedCount, hits100kCount, totalLaunches, bestMcEver);
  const isQualified = tier !== "none";
  let qualificationReason: string | null = null;

  if (tier === "elite") {
    const reasons: string[] = [];
    if (bestMcEver >= 500000) reasons.push(`best MC ${formatMarketCap(bestMcEver)}`);
    if (bondedCount >= 3 && bondingRate >= 0.5) reasons.push(`${(bondingRate * 100).toFixed(0)}% bonding rate (${bondedCount}/${totalLaunches})`);
    qualificationReason = `ELITE: ${reasons.join(", ")}`;
  } else if (tier === "proven") {
    const reasons: string[] = [];
    if (hits100kCount >= 1) reasons.push(`${hits100kCount} hit 100k MC`);
    if (bondedCount >= 2) reasons.push(`${bondedCount} bonded tokens`);
    qualificationReason = `PROVEN: ${reasons.join(", ")}`;
  }

  db.upsertCreator({
    address: creatorAddress,
    total_launches: tokens.length,
    bonded_count: bondedCount,
    hits_100k_count: hits100kCount,
    best_mc_ever: bestMcEver,
    is_qualified: isQualified ? 1 : 0,
    qualification_reason: qualificationReason,
    last_updated: getCurrentTimestamp(),
  });
}

export function checkQualification(creator: Creator, settings: UserSettings): boolean {
  // Filter out spam launchers with too many launches and low success rate
  if (creator.total_launches > settings.max_launches) {
    const successRate = creator.total_launches > 0 
      ? ((creator.bonded_count / creator.total_launches) * 100) 
      : 0;
    if (successRate < settings.min_success_rate) {
      return false;
    }
  }

  const tier = getCreatorTier(
    creator.bonded_count,
    creator.hits_100k_count,
    creator.total_launches,
    creator.best_mc_ever,
  );
  // Elite always qualifies
  if (tier === "elite") return true;
  // Proven qualifies if it meets user's custom thresholds
  if (tier === "proven") {
    if (creator.bonded_count >= settings.min_bonded_count) return true;
    if (creator.hits_100k_count >= settings.min_100k_count) return true;
  }
  return false;
}

export function getCreatorStats(creatorAddress: string): CreatorStats | null {
  const creator = db.getCreator(creatorAddress);
  if (!creator) return null;

  const tokens = db.getTokensByCreator(creatorAddress);
  const recentTokens = tokens.slice(0, 5);

  return {
    address: creator.address,
    total_launches: creator.total_launches,
    bonded_count: creator.bonded_count,
    bonded_rate: creator.total_launches > 0 ? (creator.bonded_count / creator.total_launches) * 100 : 0,
    hits_100k_count: creator.hits_100k_count,
    hits_100k_rate: creator.total_launches > 0 ? (creator.hits_100k_count / creator.total_launches) * 100 : 0,
    best_mc_ever: creator.best_mc_ever,
    is_qualified: creator.is_qualified === 1,
    qualification_reason: creator.qualification_reason,
    recent_tokens: recentTokens,
  };
}

export async function ensureCreatorExists(creatorAddress: string): Promise<Creator> {
  let creator = db.getCreator(creatorAddress);

  if (!creator) {
    creator = db.upsertCreator({
      address: creatorAddress,
      total_launches: 0,
      bonded_count: 0,
      hits_100k_count: 0,
      best_mc_ever: 0,
      is_qualified: 0,
      qualification_reason: null,
      last_updated: getCurrentTimestamp(),
    });
  }

  return creator;
}

export async function importCreatorHistory(creatorAddress: string): Promise<void> {
  try {
    const { tokens, totalCount } = await fetchCreatorTokenHistory(creatorAddress, 1000);
    
    if (totalCount === 0) {
      return;
    }
    
    logger.info(`Importing ${totalCount} historical tokens for creator ${creatorAddress.slice(0, 8)}...`);
    
    let importedCount = 0;
    for (const tokenData of tokens) {
      if (!tokenData.mint) continue;
      
      const existingToken = db.getToken(tokenData.mint);
      if (!existingToken) {
        db.createToken({
          address: tokenData.mint,
          creator_address: creatorAddress,
          name: null,
          symbol: null,
          bonded: 0,
          peak_mc: 0,
          peak_mc_timestamp: null,
          peak_mc_held_minutes: 0,
          current_mc: 0,
          pumpfun_url: getPumpFunUrl(tokenData.mint),
        });
        importedCount++;
      }
    }
    
    const creator = db.getCreator(creatorAddress);
    if (creator) {
      const allTokens = db.getTokensByCreator(creatorAddress);
      db.upsertCreator({
        ...creator,
        total_launches: allTokens.length,
        last_updated: getCurrentTimestamp(),
      });
    }
    
    logger.info(`Imported ${importedCount} new tokens for creator ${creatorAddress.slice(0, 8)}`);
    
    await recalculateCreatorStats(creatorAddress);
  } catch (error: any) {
    logger.error(`Error importing history for ${creatorAddress.slice(0, 8)}:`, error.message);
  }
}

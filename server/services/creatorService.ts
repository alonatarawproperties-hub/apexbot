import * as db from "../db";
import { getTokenInfo, getTokensByAddresses } from "./dexscreener";
import { logger } from "../utils/logger";
import { getCurrentTimestamp, getPumpFunUrl } from "../utils/helpers";
import type { Creator, Token, UserSettings, CreatorStats } from "@shared/schema";

export async function processNewToken(
  creatorAddress: string,
  tokenAddress: string,
  tokenName?: string,
  tokenSymbol?: string
): Promise<{ creator: Creator; token: Token; isQualified: boolean; watcherUserIds: string[] }> {
  let creator = db.getCreator(creatorAddress);
  
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
  
  const tokenInfo = await getTokenInfo(tokenAddress);
  if (tokenInfo) {
    db.updateToken(tokenAddress, {
      name: tokenInfo.name,
      symbol: tokenInfo.symbol,
      current_mc: tokenInfo.marketCap,
      peak_mc: tokenInfo.marketCap,
      peak_mc_timestamp: getCurrentTimestamp(),
      bonded: tokenInfo.isBonded ? 1 : 0,
    });
    token = db.getToken(tokenAddress)!;
  }
  
  await recalculateCreatorStats(creatorAddress);
  creator = db.getCreator(creatorAddress)!;
  
  const watcherUserIds = db.getWatchersForCreator(creatorAddress);
  
  return {
    creator,
    token,
    isQualified: creator.is_qualified === 1,
    watcherUserIds,
  };
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
      db.updateToken(token.address, {
        current_mc: info.marketCap,
        bonded: info.isBonded ? 1 : 0,
        name: info.name,
        symbol: info.symbol,
      });
      
      if (info.marketCap > token.peak_mc) {
        db.updateToken(token.address, {
          peak_mc: info.marketCap,
          peak_mc_timestamp: getCurrentTimestamp(),
        });
      }
      
      if (info.isBonded) bondedCount++;
      if (info.marketCap >= 100000) hits100kCount++;
      if (info.marketCap > bestMcEver) bestMcEver = info.marketCap;
    } else {
      if (token.bonded === 1) bondedCount++;
      if (token.peak_mc >= 100000) hits100kCount++;
      if (token.peak_mc > bestMcEver) bestMcEver = token.peak_mc;
    }
  }
  
  const isQualified = bondedCount >= 1 || hits100kCount >= 1;
  let qualificationReason: string | null = null;
  
  if (isQualified) {
    const reasons: string[] = [];
    if (bondedCount >= 1) reasons.push(`${bondedCount} bonded`);
    if (hits100kCount >= 1) reasons.push(`${hits100kCount} hit 100k MC`);
    qualificationReason = reasons.join(", ");
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
  if (creator.bonded_count >= settings.min_bonded_count) return true;
  if (creator.hits_100k_count >= settings.min_100k_count) return true;
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

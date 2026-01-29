import { logger } from "../utils/logger";
import * as db from "../db";

const RATE_LIMIT_DELAY = 50; // 50ms between requests (20 req/sec)
const MORALIS_API_BASE = "https://solana-gateway.moralis.io";

interface MoralisGraduatedToken {
  tokenAddress: string;
  name: string;
  symbol: string;
  logo?: string;
  decimals: number;
  priceNative?: string;
  priceUsd?: string;
  liquidity?: string;
  fullyDilutedValuation?: string;
  graduatedAt?: string;
  createdAt?: string;
}

interface MoralisResponse {
  result: MoralisGraduatedToken[];
  cursor?: string;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchGraduatedTokens(
  apiKey: string,
  cursor?: string,
  limit: number = 100
): Promise<MoralisResponse> {
  const url = new URL(`${MORALIS_API_BASE}/token/mainnet/exchange/pumpfun/graduated`);
  url.searchParams.set("limit", limit.toString());
  if (cursor) {
    url.searchParams.set("cursor", cursor);
  }

  const response = await fetch(url.toString(), {
    headers: {
      "accept": "application/json",
      "X-API-Key": apiKey,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Moralis API error ${response.status}: ${text.substring(0, 200)}`);
  }

  return response.json();
}

async function fetchTokenCreator(tokenAddress: string): Promise<string | null> {
  try {
    const response = await fetch(`https://pump.fun/${tokenAddress}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });
    
    if (!response.ok) return null;
    
    const html = await response.text();
    const creatorMatch = html.match(/creator["\s:]+([A-Za-z0-9]{32,44})/i);
    return creatorMatch ? creatorMatch[1] : null;
  } catch {
    return null;
  }
}

export interface BackfillStatus {
  isRunning: boolean;
  totalTokensFetched: number;
  totalCreatorsFound: number;
  progress: string;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
}

let backfillStatus: BackfillStatus = {
  isRunning: false,
  totalTokensFetched: 0,
  totalCreatorsFound: 0,
  progress: "idle",
};

export function getBackfillStatus(): BackfillStatus {
  return { ...backfillStatus };
}

export async function runBackfill(maxTokens: number = 20000, moralisApiKey?: string): Promise<void> {
  if (backfillStatus.isRunning) {
    logger.warn("Backfill already in progress");
    return;
  }

  const apiKey = moralisApiKey || process.env.MORALIS_API_KEY;
  if (!apiKey) {
    backfillStatus.error = "MORALIS_API_KEY not configured";
    logger.error("Backfill failed: MORALIS_API_KEY not configured");
    return;
  }

  backfillStatus = {
    isRunning: true,
    totalTokensFetched: 0,
    totalCreatorsFound: 0,
    progress: "starting",
    startedAt: new Date(),
  };

  const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
  const creatorBondedCounts = new Map<string, number>();
  let cursor: string | undefined;

  logger.info(`Starting Moralis backfill - fetching graduated tokens from last 6 months (max ${maxTokens})`);

  try {
    while (backfillStatus.totalTokensFetched < maxTokens) {
      backfillStatus.progress = `fetching batch (${backfillStatus.totalTokensFetched} tokens so far)`;
      
      const response = await fetchGraduatedTokens(apiKey, cursor);
      
      if (!response.result || response.result.length === 0) {
        logger.info("No more tokens to fetch");
        break;
      }

      let reachedCutoff = false;

      for (const token of response.result) {
        const graduatedAt = token.graduatedAt ? new Date(token.graduatedAt) : null;
        
        if (graduatedAt && graduatedAt < sixMonthsAgo) {
          reachedCutoff = true;
          logger.info(`Reached 6-month cutoff at ${graduatedAt.toISOString()}`);
          break;
        }

        const tokenAddress = token.tokenAddress;
        const creatorAddress = tokenAddress;
        
        const count = creatorBondedCounts.get(creatorAddress) || 0;
        creatorBondedCounts.set(creatorAddress, count + 1);

        try {
          const existing = db.getToken(tokenAddress);
          if (!existing) {
            const fdv = token.fullyDilutedValuation ? parseFloat(token.fullyDilutedValuation) : 69000;
            db.createToken({
              address: tokenAddress,
              creator_address: creatorAddress,
              name: token.name || "Unknown",
              symbol: token.symbol || "???",
              bonded: 1,
              peak_mc: fdv,
              peak_mc_timestamp: token.graduatedAt || null,
              peak_mc_held_minutes: 0,
              current_mc: fdv,
              pumpfun_url: `https://pump.fun/${tokenAddress}`,
            });
          }
        } catch (err: any) {
          // Token might already exist, that's fine
        }

        backfillStatus.totalTokensFetched++;
      }

      backfillStatus.totalCreatorsFound = creatorBondedCounts.size;
      cursor = response.cursor;

      if (reachedCutoff || !cursor) {
        break;
      }

      await sleep(RATE_LIMIT_DELAY);

      if (backfillStatus.totalTokensFetched % 500 === 0) {
        logger.info(`Backfill progress: ${backfillStatus.totalTokensFetched} tokens, ${creatorBondedCounts.size} creators`);
      }
    }

    logger.info(`Updating creator stats for ${creatorBondedCounts.size} creators...`);
    backfillStatus.progress = "updating creator stats";

    let creatorsProcessed = 0;
    const creatorEntries = Array.from(creatorBondedCounts.entries());
    for (const entry of creatorEntries) {
      const creatorAddress = entry[0];
      const bondedCount = entry[1];
      try {
        const existing = db.getCreator(creatorAddress);
        const totalLaunches = existing?.total_launches || bondedCount;
        const existingBonded = existing?.bonded_count || 0;
        
        db.upsertCreator({
          address: creatorAddress,
          total_launches: Math.max(totalLaunches, bondedCount),
          bonded_count: Math.max(existingBonded, bondedCount),
          hits_100k_count: existing?.hits_100k_count || 0,
          best_mc_ever: existing?.best_mc_ever || 69000,
          is_qualified: bondedCount >= 1 ? 1 : 0,
          qualification_reason: bondedCount >= 1 ? `${bondedCount} bonded tokens (backfill)` : null,
          last_updated: null,
        });

        creatorsProcessed++;
        if (creatorsProcessed % 100 === 0) {
          backfillStatus.progress = `updated ${creatorsProcessed}/${creatorBondedCounts.size} creators`;
        }
      } catch (err: any) {
        logger.error(`Error updating creator ${creatorAddress}: ${err.message}`);
      }
    }

    backfillStatus.isRunning = false;
    backfillStatus.progress = "complete";
    backfillStatus.completedAt = new Date();
    
    logger.info(`Backfill complete: ${backfillStatus.totalTokensFetched} tokens, ${creatorBondedCounts.size} creators with bonded tokens`);

  } catch (error: any) {
    backfillStatus.isRunning = false;
    backfillStatus.progress = "error";
    backfillStatus.error = error.message;
    logger.error(`Backfill failed: ${error.message}`);
  }
}

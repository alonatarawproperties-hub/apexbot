import { logger } from "../utils/logger";
import * as db from "../db";
import { isSpamCreator } from "./creatorService";

const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const PUMPFUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

interface SignatureInfo {
  signature: string;
  slot: number;
  err: any;
  memo: string | null;
  blockTime: number | null;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getCreatorLaunchCount(creatorAddress: string): Promise<number> {
  let totalCount = 0;
  let lastSignature: string | null = null;
  let retries = 0;
  const maxRetries = 3;

  while (true) {
    try {
      const params: any[] = [
        creatorAddress,
        { limit: 1000 }
      ];
      
      if (lastSignature) {
        params[1].before = lastSignature;
      }

      const response = await fetch(HELIUS_RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getSignaturesForAddress",
          params
        })
      });

      if (!response.ok) {
        if (response.status === 429) {
          logger.warn(`Rate limited, waiting 5s...`);
          await sleep(5000);
          continue;
        }
        throw new Error(`Helius API error: ${response.status}`);
      }

      const data = await response.json();
      
      if (data.error) {
        throw new Error(data.error.message);
      }

      const signatures: SignatureInfo[] = data.result || [];
      
      if (signatures.length === 0) break;

      totalCount += signatures.length;
      lastSignature = signatures[signatures.length - 1].signature;
      
      if (signatures.length < 1000) break;
      
      await sleep(100);
      retries = 0;
      
    } catch (error: any) {
      retries++;
      if (retries >= maxRetries) {
        logger.error(`Failed to get signatures for ${creatorAddress.slice(0, 8)}: ${error.message}`);
        return totalCount;
      }
      await sleep(1000 * retries);
    }
  }

  return totalCount;
}

export interface BackfillProgress {
  total: number;
  processed: number;
  updated: number;
  spamDetected: number;
  errors: number;
  isRunning: boolean;
  startTime: number | null;
  estimatedTimeRemaining: string;
}

let backfillProgress: BackfillProgress = {
  total: 0,
  processed: 0,
  updated: 0,
  spamDetected: 0,
  errors: 0,
  isRunning: false,
  startTime: null,
  estimatedTimeRemaining: "Unknown"
};

export function getBackfillProgress(): BackfillProgress {
  return { ...backfillProgress };
}

export async function runCreatorBackfill(batchSize: number = 100): Promise<BackfillProgress> {
  if (backfillProgress.isRunning) {
    logger.warn("Backfill already running");
    return backfillProgress;
  }

  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    logger.error("HELIUS_API_KEY not set");
    return backfillProgress;
  }

  const qualifiedCreators = db.getQualifiedCreators();
  
  backfillProgress = {
    total: qualifiedCreators.length,
    processed: 0,
    updated: 0,
    spamDetected: 0,
    errors: 0,
    isRunning: true,
    startTime: Date.now(),
    estimatedTimeRemaining: "Calculating..."
  };

  logger.info(`Starting creator backfill for ${qualifiedCreators.length} creators...`);

  for (const creator of qualifiedCreators) {
    try {
      const actualLaunches = await getCreatorLaunchCount(creator.address);
      
      if (actualLaunches > creator.total_launches) {
        const isSpam = isSpamCreator(actualLaunches, creator.bonded_count, creator.hits_100k_count);
        
        db.upsertCreator({
          ...creator,
          total_launches: actualLaunches,
          is_qualified: isSpam ? 0 : 1,
          qualification_reason: isSpam 
            ? `spam_detected: ${creator.bonded_count}/${actualLaunches} bonded` 
            : creator.qualification_reason,
        });

        backfillProgress.updated++;
        
        if (isSpam) {
          backfillProgress.spamDetected++;
          logger.info(`Spam detected: ${creator.address.slice(0, 8)} - ${creator.bonded_count}/${actualLaunches} bonded (${((creator.bonded_count/actualLaunches)*100).toFixed(1)}%)`);
        }
      }

      backfillProgress.processed++;

      if (backfillProgress.processed % 50 === 0) {
        const elapsed = (Date.now() - backfillProgress.startTime!) / 1000;
        const rate = backfillProgress.processed / elapsed;
        const remaining = (backfillProgress.total - backfillProgress.processed) / rate;
        backfillProgress.estimatedTimeRemaining = `${Math.ceil(remaining / 60)} minutes`;
        
        logger.info(`Backfill progress: ${backfillProgress.processed}/${backfillProgress.total} (${backfillProgress.updated} updated, ${backfillProgress.spamDetected} spam)`);
      }

      await sleep(100);

    } catch (error: any) {
      backfillProgress.errors++;
      logger.error(`Error processing ${creator.address.slice(0, 8)}: ${error.message}`);
    }
  }

  backfillProgress.isRunning = false;
  backfillProgress.estimatedTimeRemaining = "Complete";
  
  logger.info(`Backfill complete: ${backfillProgress.processed} processed, ${backfillProgress.updated} updated, ${backfillProgress.spamDetected} spam detected`);
  
  return backfillProgress;
}

export async function backfillSingleCreator(creatorAddress: string): Promise<{ launches: number; isSpam: boolean }> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    throw new Error("HELIUS_API_KEY not set");
  }

  const launches = await getCreatorLaunchCount(creatorAddress);
  const creator = db.getCreator(creatorAddress);
  
  if (!creator) {
    return { launches, isSpam: false };
  }

  const isSpam = isSpamCreator(launches, creator.bonded_count, creator.hits_100k_count);
  
  if (launches > creator.total_launches) {
    db.upsertCreator({
      ...creator,
      total_launches: launches,
      is_qualified: isSpam ? 0 : 1,
      qualification_reason: isSpam 
        ? `spam_detected: ${creator.bonded_count}/${launches} bonded` 
        : creator.qualification_reason,
    });
  }

  return { launches, isSpam };
}

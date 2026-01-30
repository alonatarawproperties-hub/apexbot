import { logger } from "../utils/logger";
import * as db from "../db";
import { getCreatorLaunchCount } from "./creatorLaunchCounter";
import { checkIfSpamLauncher } from "./spamDetection";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const MORALIS_API_KEY = process.env.MORALIS_API_KEY;

interface ImportProgress {
  isRunning: boolean;
  totalFound: number;
  verified: number;
  imported: number;
  spam: number;
  errors: number;
  startTime: number | null;
}

let importProgress: ImportProgress = {
  isRunning: false,
  totalFound: 0,
  verified: 0,
  imported: 0,
  spam: 0,
  errors: 0,
  startTime: null,
};

export function getImportProgress(): ImportProgress {
  return { ...importProgress };
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchGraduatedTokensFromMoralis(cursor?: string): Promise<{ tokens: string[]; nextCursor?: string }> {
  if (!MORALIS_API_KEY) {
    throw new Error("MORALIS_API_KEY not set");
  }

  const url = `https://solana-gateway.moralis.io/token/mainnet/exchange/pumpfun/graduated?limit=100${cursor ? `&cursor=${cursor}` : ''}`;
  
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "X-API-Key": MORALIS_API_KEY
    }
  });

  if (!response.ok) {
    throw new Error(`Moralis API error: ${response.status}`);
  }

  const data = await response.json();
  const tokens = (data.result || []).map((t: any) => t.tokenAddress);
  
  return { tokens, nextCursor: data.cursor };
}

async function getCreatorFromHelius(tokenMint: string): Promise<string | null> {
  if (!HELIUS_API_KEY) return null;

  try {
    const url = `https://api.helius.xyz/v0/addresses/${tokenMint}/transactions?api-key=${HELIUS_API_KEY}&limit=50`;
    const response = await fetch(url);
    
    if (!response.ok) {
      if (response.status === 429) {
        await sleep(1000);
        return getCreatorFromHelius(tokenMint);
      }
      return null;
    }
    
    const txs = await response.json();
    
    for (const tx of txs) {
      if (tx.type === "CREATE" || tx.source === "PUMP_FUN") {
        return tx.feePayer || null;
      }
    }
    
    if (txs.length > 0) {
      const lastTx = txs[txs.length - 1];
      return lastTx.feePayer || null;
    }
  } catch (error: any) {
    logger.error(`Helius lookup error for ${tokenMint.slice(0, 8)}: ${error.message}`);
  }
  
  return null;
}

export async function importFromHelius(maxCreators: number = 200): Promise<ImportProgress> {
  if (importProgress.isRunning) {
    logger.warn("Import already running");
    return importProgress;
  }

  if (!HELIUS_API_KEY) {
    logger.error("HELIUS_API_KEY not set");
    return importProgress;
  }

  if (!MORALIS_API_KEY) {
    logger.error("MORALIS_API_KEY not set");
    return importProgress;
  }

  importProgress = {
    isRunning: true,
    totalFound: 0,
    verified: 0,
    imported: 0,
    spam: 0,
    errors: 0,
    startTime: Date.now(),
  };

  logger.info(`[HELIUS IMPORT] Starting import (max ${maxCreators} creators)...`);

  const creatorsFound = new Map<string, number>();
  
  try {
    let cursor: string | undefined;
    let totalTokens = 0;
    const maxTokens = 500;
    
    while (totalTokens < maxTokens) {
      logger.info(`[HELIUS IMPORT] Fetching graduated tokens from Moralis (page ${Math.floor(totalTokens / 100) + 1})...`);
      
      const { tokens, nextCursor } = await fetchGraduatedTokensFromMoralis(cursor);
      
      if (tokens.length === 0) break;
      
      logger.info(`[HELIUS IMPORT] Got ${tokens.length} tokens, looking up creators via Helius...`);
      
      for (const tokenMint of tokens) {
        if (creatorsFound.size >= maxCreators) break;
        
        try {
          const creator = await getCreatorFromHelius(tokenMint);
          
          if (creator) {
            creatorsFound.set(creator, (creatorsFound.get(creator) || 0) + 1);
            importProgress.totalFound = creatorsFound.size;
          }
          
          await sleep(100);
        } catch (error: any) {
          importProgress.errors++;
        }
        
        totalTokens++;
      }
      
      if (!nextCursor || creatorsFound.size >= maxCreators) break;
      cursor = nextCursor;
      
      await sleep(300);
    }

    logger.info(`[HELIUS IMPORT] Found ${creatorsFound.size} unique creators with ${totalTokens} bonded tokens`);
    logger.info(`[HELIUS IMPORT] Now verifying each creator...`);

    for (const [creatorAddress, bondedCount] of creatorsFound) {
      try {
        const existingCreator = db.getCreator(creatorAddress);
        
        if (existingCreator && existingCreator.is_qualified === 1) {
          continue;
        }

        const launchData = await getCreatorLaunchCount(creatorAddress);
        const actualLaunches = launchData.actualLaunches;
        
        const hits100k = existingCreator?.hits_100k_count || 0;
        
        importProgress.verified++;
        
        const spamCheck = await checkIfSpamLauncher(
          creatorAddress,
          bondedCount,
          hits100k,
          actualLaunches
        );
        
        if (spamCheck.isSpam) {
          logger.info(`[SPAM] ${creatorAddress.slice(0, 8)}: ${spamCheck.reason} (${bondedCount}/${actualLaunches})`);
          importProgress.spam++;
          
          db.upsertCreator({
            address: creatorAddress,
            total_launches: actualLaunches,
            bonded_count: bondedCount,
            hits_100k_count: hits100k,
            best_mc_ever: existingCreator?.best_mc_ever || 69000,
            is_qualified: 0,
            qualification_reason: spamCheck.reason || "spam_detected",
            last_updated: null,
          });
          continue;
        }
        
        db.upsertCreator({
          address: creatorAddress,
          total_launches: actualLaunches,
          bonded_count: bondedCount,
          hits_100k_count: hits100k,
          best_mc_ever: existingCreator?.best_mc_ever || 69000,
          is_qualified: 1,
          qualification_reason: `helius_import: ${bondedCount}/${actualLaunches} bonded`,
          last_updated: null,
        });

        importProgress.imported++;
        
        if (importProgress.verified % 10 === 0) {
          logger.info(`[HELIUS IMPORT] Progress: ${importProgress.imported} imported, ${importProgress.spam} spam blocked`);
        }
        
        await sleep(150);

      } catch (error: any) {
        importProgress.errors++;
        logger.error(`[HELIUS IMPORT] Error for ${creatorAddress.slice(0, 8)}: ${error.message}`);
      }
    }

  } catch (error: any) {
    logger.error(`[HELIUS IMPORT] Fatal error: ${error.message}`);
  }

  importProgress.isRunning = false;
  
  logger.info(`[HELIUS IMPORT] Complete: ${importProgress.imported} imported, ${importProgress.spam} spam, ${importProgress.errors} errors`);
  
  return importProgress;
}

export async function runHeliusImportJob(): Promise<void> {
  try {
    await importFromHelius(200);
  } catch (error: any) {
    logger.error("Helius import job failed:", error.message);
  }
}

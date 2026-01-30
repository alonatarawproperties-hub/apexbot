import { logger } from "../utils/logger";
import * as db from "../db";
import { checkIfSpamLauncher } from "./spamDetection";
import { getCreatorLaunchCount } from "./creatorLaunchCounter";

interface DuneImportProgress {
  isRunning: boolean;
  totalFound: number;
  verified: number;
  imported: number;
  spam: number;
  errors: number;
  startTime: number | null;
}

let importProgress: DuneImportProgress = {
  isRunning: false,
  totalFound: 0,
  verified: 0,
  imported: 0,
  spam: 0,
  errors: 0,
  startTime: null,
};

export function getDuneImportProgress(): DuneImportProgress {
  return { ...importProgress };
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchGraduatedTokensFromMoralis(cursor?: string): Promise<{ tokens: string[]; nextCursor?: string }> {
  const apiKey = process.env.MORALIS_API_KEY;
  if (!apiKey) {
    throw new Error("MORALIS_API_KEY not set");
  }

  const url = `https://solana-gateway.moralis.io/token/mainnet/exchange/pumpfun/graduated?limit=100${cursor ? `&cursor=${cursor}` : ''}`;
  
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "X-API-Key": apiKey
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
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return null;

  try {
    const url = `https://api.helius.xyz/v0/addresses/${tokenMint}/transactions?api-key=${apiKey}&limit=50`;
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

export async function importFromDune(
  months: number = 3,
  maxCreators: number = 500,
  progressCallback?: (message: string) => Promise<void>
): Promise<DuneImportProgress> {
  if (importProgress.isRunning) {
    throw new Error("Import already in progress");
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

  try {
    logger.info(`[DUNE IMPORT] Starting extended historical import (max ${maxCreators} creators)`);
    
    if (progressCallback) {
      await progressCallback(`Fetching graduated tokens from Moralis...\nThis fetches more data than regular /import.`);
    }

    const allTokens: string[] = [];
    let cursor: string | undefined;
    const maxTokens = maxCreators * 3;

    while (allTokens.length < maxTokens) {
      try {
        const { tokens, nextCursor } = await fetchGraduatedTokensFromMoralis(cursor);
        allTokens.push(...tokens);
        
        if (!nextCursor || tokens.length === 0) break;
        cursor = nextCursor;
        
        await sleep(200);
        
        if (allTokens.length % 200 === 0 && progressCallback) {
          await progressCallback(`Fetched ${allTokens.length} graduated tokens...`);
        }
      } catch (err: any) {
        logger.error(`Moralis fetch error: ${err.message}`);
        break;
      }
    }

    logger.info(`[DUNE IMPORT] Found ${allTokens.length} graduated tokens`);
    importProgress.totalFound = allTokens.length;

    if (progressCallback) {
      await progressCallback(`Found ${allTokens.length} graduated tokens.\nLooking up creators via Helius...`);
    }

    const creatorStats = new Map<string, { bonded: number; total: number }>();
    let processed = 0;

    for (const tokenMint of allTokens) {
      try {
        const creator = await getCreatorFromHelius(tokenMint);
        
        if (creator) {
          const existing = creatorStats.get(creator) || { bonded: 0, total: 0 };
          existing.bonded++;
          creatorStats.set(creator, existing);
          importProgress.verified++;
        }
        
        processed++;
        await sleep(100);

        if (processed % 100 === 0 && progressCallback) {
          await progressCallback(
            `Processing graduated tokens:\n` +
            `- Checked: ${processed}/${allTokens.length}\n` +
            `- Unique creators: ${creatorStats.size}`
          );
        }

        if (creatorStats.size >= maxCreators) break;
      } catch (err: any) {
        importProgress.errors++;
      }
    }

    logger.info(`[DUNE IMPORT] Found ${creatorStats.size} unique creators`);

    if (progressCallback) {
      await progressCallback(`Found ${creatorStats.size} creators.\nVerifying launch counts and filtering spam...`);
    }

    let importedCount = 0;
    const creatorEntries = Array.from(creatorStats.entries());

    for (const [creatorAddress, stats] of creatorEntries) {
      try {
        const existingCreator = db.getCreator(creatorAddress);
        if (existingCreator) continue;

        const launchCount = await getCreatorLaunchCount(creatorAddress);
        const totalLaunches = Math.max(launchCount, stats.bonded);
        
        await sleep(100);

        const spamResult = await checkIfSpamLauncher(creatorAddress, totalLaunches, stats.bonded, 0);
        
        if (spamResult.isSpam) {
          importProgress.spam++;
          continue;
        }

        const isQualified = stats.bonded >= 1;
        db.upsertCreator({
          address: creatorAddress,
          total_launches: totalLaunches,
          bonded_count: stats.bonded,
          hits_100k_count: 0,
          best_mc_ever: 0,
          is_qualified: isQualified ? 1 : 0,
          qualification_reason: isQualified ? `PROVEN: ${stats.bonded} bonded` : "",
          last_updated: new Date().toISOString(),
        });

        importProgress.imported++;
        importedCount++;

        if (importedCount % 10 === 0 && progressCallback) {
          await progressCallback(
            `Import progress:\n` +
            `- Imported: ${importProgress.imported}\n` +
            `- Spam blocked: ${importProgress.spam}`
          );
        }
      } catch (err: any) {
        importProgress.errors++;
        logger.error(`[DUNE IMPORT] Error importing ${creatorAddress.slice(0, 8)}: ${err.message}`);
      }
    }

    logger.info(`[DUNE IMPORT] Complete: ${importProgress.imported} imported, ${importProgress.spam} spam blocked`);
    
    importProgress.isRunning = false;
    return importProgress;
  } catch (error: any) {
    logger.error(`[DUNE IMPORT] Fatal error: ${error.message}`);
    importProgress.isRunning = false;
    importProgress.errors++;
    throw error;
  }
}

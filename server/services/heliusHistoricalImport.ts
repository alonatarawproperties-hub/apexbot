import { logger } from "../utils/logger";
import * as db from "../db";
import { getCreatorLaunchCount } from "./creatorLaunchCounter";
import { checkIfSpamLauncher } from "./spamDetection";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const PUMPFUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

interface HeliusTransaction {
  signature: string;
  type: string;
  source: string;
  fee: number;
  feePayer: string;
  slot: number;
  timestamp: number;
  tokenTransfers?: any[];
  nativeTransfers?: any[];
  accountData?: any[];
  description?: string;
}

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

async function fetchPumpFunTransactions(beforeSignature?: string): Promise<HeliusTransaction[]> {
  if (!HELIUS_API_KEY) {
    throw new Error("HELIUS_API_KEY not set");
  }

  const url = `https://api.helius.xyz/v0/addresses/${PUMPFUN_PROGRAM_ID}/transactions?api-key=${HELIUS_API_KEY}&limit=100${beforeSignature ? `&before=${beforeSignature}` : ''}`;

  const response = await fetch(url);
  
  if (!response.ok) {
    if (response.status === 429) {
      logger.warn("Helius rate limited, waiting...");
      await sleep(2000);
      return fetchPumpFunTransactions(beforeSignature);
    }
    throw new Error(`Helius API error: ${response.status}`);
  }

  return response.json();
}

async function getTokenCreationDetails(signature: string): Promise<{ creator: string; tokenMint: string; name: string; symbol: string } | null> {
  if (!HELIUS_API_KEY) return null;

  try {
    const url = `https://api.helius.xyz/v0/transactions/?api-key=${HELIUS_API_KEY}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactions: [signature] })
    });

    if (!response.ok) return null;

    const [tx] = await response.json();
    if (!tx) return null;

    if (tx.type === "CREATE" && tx.source === "PUMP_FUN") {
      return {
        creator: tx.feePayer,
        tokenMint: tx.tokenTransfers?.[0]?.mint || "",
        name: tx.description?.match(/created (\w+)/)?.[1] || "Unknown",
        symbol: tx.description?.match(/\((\w+)\)/)?.[1] || "???",
      };
    }

    return null;
  } catch {
    return null;
  }
}

async function fetchBondedTokensFromDexScreener(limit: number = 100): Promise<Array<{ tokenAddress: string; creator?: string }>> {
  const tokens: Array<{ tokenAddress: string; creator?: string }> = [];
  
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/search?q=pump`);
    if (!response.ok) return tokens;
    
    const data = await response.json();
    const pairs = data.pairs || [];
    
    for (const pair of pairs.slice(0, limit)) {
      if (pair.baseToken?.address?.endsWith("pump")) {
        tokens.push({ tokenAddress: pair.baseToken.address });
      }
    }
  } catch (error: any) {
    logger.error(`DexScreener fetch error: ${error.message}`);
  }
  
  return tokens;
}

async function getCreatorFromToken(tokenMint: string): Promise<string | null> {
  if (!HELIUS_API_KEY) return null;

  try {
    const url = `https://api.helius.xyz/v0/addresses/${tokenMint}/transactions?api-key=${HELIUS_API_KEY}&limit=1&type=CREATE`;
    const response = await fetch(url);
    
    if (!response.ok) return null;
    
    const txs = await response.json();
    if (txs.length > 0) {
      return txs[0].feePayer || null;
    }
  } catch {
    return null;
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

  importProgress = {
    isRunning: true,
    totalFound: 0,
    verified: 0,
    imported: 0,
    spam: 0,
    errors: 0,
    startTime: Date.now(),
  };

  logger.info(`[HELIUS IMPORT] Starting historical import (max ${maxCreators} creators)...`);

  const creatorsFound = new Set<string>();
  
  try {
    logger.info("[HELIUS IMPORT] Fetching bonded tokens from DexScreener...");
    const bondedTokens = await fetchBondedTokensFromDexScreener(300);
    logger.info(`[HELIUS IMPORT] Found ${bondedTokens.length} bonded tokens`);

    for (const token of bondedTokens) {
      if (creatorsFound.size >= maxCreators) break;
      
      try {
        const creator = await getCreatorFromToken(token.tokenAddress);
        if (creator && !creatorsFound.has(creator)) {
          creatorsFound.add(creator);
          importProgress.totalFound = creatorsFound.size;
          
          if (creatorsFound.size % 20 === 0) {
            logger.info(`[HELIUS IMPORT] Found ${creatorsFound.size} unique creators...`);
          }
        }
        await sleep(100);
      } catch (error: any) {
        importProgress.errors++;
      }
    }

    logger.info(`[HELIUS IMPORT] Found ${creatorsFound.size} unique creators, now verifying...`);

    for (const creatorAddress of creatorsFound) {
      try {
        const existingCreator = db.getCreator(creatorAddress);
        
        if (existingCreator && existingCreator.is_qualified === 1) {
          continue;
        }

        const launchData = await getCreatorLaunchCount(creatorAddress);
        const actualLaunches = launchData.actualLaunches;
        
        const bondedCount = (existingCreator?.bonded_count || 0) + 1;
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
        
        if (importProgress.imported % 10 === 0) {
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

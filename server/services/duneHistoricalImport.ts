import { logger } from "../utils/logger";
import * as db from "../db";
import { isSpamCreator } from "./creatorService";

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

const DUNE_PUMPFUN_QUERY_ID = "4085161";

async function getCreatorForToken(tokenMint: string, heliusApiKey: string): Promise<string | null> {
  try {
    const response = await fetch(
      `https://api.helius.xyz/v0/addresses/${tokenMint}/transactions?api-key=${heliusApiKey}&limit=100&type=UNKNOWN`
    );
    
    if (!response.ok) return null;
    
    const transactions = await response.json();
    
    for (const tx of transactions) {
      if (tx.type === "UNKNOWN" && tx.instructions) {
        for (const ix of tx.instructions) {
          if (ix.programId === "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P") {
            return tx.feePayer || null;
          }
        }
      }
    }
    
    return null;
  } catch {
    return null;
  }
}

export async function importFromDune(
  months: number = 3,
  maxCreators: number = 500,
  progressCallback?: (message: string) => Promise<void>
): Promise<DuneImportProgress> {
  const duneApiKey = process.env.DUNE_API_KEY;
  const heliusApiKey = process.env.HELIUS_API_KEY;
  
  if (!duneApiKey) {
    throw new Error("DUNE_API_KEY not configured");
  }
  
  if (!heliusApiKey) {
    throw new Error("HELIUS_API_KEY not configured");
  }

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
    logger.info(`[DUNE IMPORT] Starting historical import using public query`);
    
    if (progressCallback) {
      await progressCallback(`Executing Dune query for graduated tokens...\nThis may take 2-5 minutes.`);
    }

    const executeResponse = await fetch(`https://api.dune.com/api/v1/query/${DUNE_PUMPFUN_QUERY_ID}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-DUNE-API-KEY": duneApiKey,
      },
      body: JSON.stringify({
        performance: "medium",
      }),
    });

    if (!executeResponse.ok) {
      const errorText = await executeResponse.text();
      throw new Error(`Dune execute failed: ${executeResponse.status} - ${errorText}`);
    }

    const executeResult = await executeResponse.json();
    const executionId = executeResult.execution_id;
    
    if (!executionId) {
      throw new Error("No execution ID returned from Dune");
    }

    logger.info(`[DUNE] Query submitted, execution ID: ${executionId}`);

    if (progressCallback) {
      await progressCallback(`Query submitted. Waiting for results...`);
    }

    let attempts = 0;
    const maxAttempts = 60;
    let rows: any[] = [];

    while (attempts < maxAttempts) {
      await sleep(5000);
      
      const statusResponse = await fetch(`https://api.dune.com/api/v1/execution/${executionId}/results`, {
        headers: {
          "X-DUNE-API-KEY": duneApiKey,
        },
      });

      if (!statusResponse.ok) {
        attempts++;
        continue;
      }

      const statusResult = await statusResponse.json();
      
      if (statusResult.state === "QUERY_STATE_COMPLETED") {
        rows = statusResult.result?.rows || [];
        break;
      } else if (statusResult.state === "QUERY_STATE_FAILED") {
        throw new Error(`Dune query failed: ${statusResult.error || "Unknown error"}`);
      }

      attempts++;
      
      if (attempts % 6 === 0 && progressCallback) {
        await progressCallback(`Still waiting for Dune results... (${Math.floor(attempts * 5 / 60)} min elapsed)`);
      }
    }

    if (rows.length === 0 && attempts >= maxAttempts) {
      throw new Error("Dune query timed out after 5 minutes");
    }

    logger.info(`[DUNE IMPORT] Found ${rows.length} graduated tokens from Dune`);

    if (progressCallback) {
      await progressCallback(`Found ${rows.length} graduated tokens. Looking up creators via Helius...`);
    }

    const creatorCounts = new Map<string, { total: number; bonded: number }>();
    let processed = 0;
    const tokensToProcess = rows.slice(0, maxCreators * 2);
    importProgress.totalFound = tokensToProcess.length;

    for (const row of tokensToProcess) {
      const tokenMint = row.token_mint || row.mint || row.token_address || row.address;
      
      if (!tokenMint) {
        processed++;
        continue;
      }

      const creator = await getCreatorForToken(tokenMint, heliusApiKey);
      
      if (creator) {
        const existing = creatorCounts.get(creator) || { total: 0, bonded: 0 };
        existing.bonded++;
        existing.total++;
        creatorCounts.set(creator, existing);
        importProgress.verified++;
      }

      processed++;
      
      await sleep(100);

      if (processed % 50 === 0 && progressCallback) {
        await progressCallback(
          `Processing graduated tokens:\n` +
          `- Checked: ${processed}/${tokensToProcess.length}\n` +
          `- Unique creators found: ${creatorCounts.size}`
        );
      }
    }

    logger.info(`[DUNE IMPORT] Found ${creatorCounts.size} unique creators`);

    if (progressCallback) {
      await progressCallback(`Found ${creatorCounts.size} creators. Filtering spam and importing...`);
    }

    const creatorEntries = Array.from(creatorCounts.entries());
    for (const [creatorAddress, stats] of creatorEntries) {
      try {
        const spamCheck = isSpamCreator(stats.total, stats.bonded, 0);
        
        if (spamCheck) {
          importProgress.spam++;
          continue;
        }

        const existingCreator = db.getCreator(creatorAddress);
        
        if (!existingCreator) {
          const isQualified = stats.bonded >= 1;
          const qualificationReason = isQualified ? `PROVEN: ${stats.bonded} bonded` : "";

          db.upsertCreator({
            address: creatorAddress,
            total_launches: stats.total,
            bonded_count: stats.bonded,
            hits_100k_count: 0,
            best_mc_ever: 0,
            is_qualified: isQualified ? 1 : 0,
            qualification_reason: qualificationReason,
            last_updated: new Date().toISOString(),
          });

          importProgress.imported++;
        }
      } catch (err: any) {
        logger.error(`[DUNE IMPORT] Error processing creator ${creatorAddress}: ${err.message}`);
        importProgress.errors++;
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

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

export async function importFromDune(
  months: number = 3,
  maxCreators: number = 500,
  progressCallback?: (message: string) => Promise<void>
): Promise<DuneImportProgress> {
  const apiKey = process.env.DUNE_API_KEY;
  
  if (!apiKey) {
    throw new Error("DUNE_API_KEY not configured. Get a free key at dune.com");
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
    logger.info(`[DUNE IMPORT] Starting ${months}-month historical import`);
    
    if (progressCallback) {
      await progressCallback(`Querying Dune for ${months} months of graduated tokens...\nThis may take 2-5 minutes.`);
    }

    const sql = `
      WITH pumpfun_creates AS (
        SELECT 
          tx_signer as creator_address,
          account_arguments[1] as token_mint,
          block_time
        FROM solana.instruction_calls
        WHERE executing_account = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
        AND block_time >= NOW() - INTERVAL '${months}' MONTH
        AND tx_success = true
      ),
      pumpfun_withdraws AS (
        SELECT DISTINCT
          account_arguments[1] as token_mint
        FROM solana.instruction_calls
        WHERE executing_account = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
        AND inner_executing_account = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
        AND block_time >= NOW() - INTERVAL '${months}' MONTH
        AND tx_success = true
      )
      SELECT 
        c.creator_address,
        COUNT(DISTINCT c.token_mint) as total_launches,
        COUNT(DISTINCT w.token_mint) as bonded_count
      FROM pumpfun_creates c
      LEFT JOIN pumpfun_withdraws w ON c.token_mint = w.token_mint
      GROUP BY c.creator_address
      HAVING COUNT(DISTINCT w.token_mint) >= 1
      ORDER BY bonded_count DESC
      LIMIT ${maxCreators}
    `;

    logger.info(`[DUNE] Executing SQL query for ${months} months of data...`);
    
    const executeResponse = await fetch("https://api.dune.com/api/v1/query/3000000/execute", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-DUNE-API-KEY": apiKey,
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
      await progressCallback(`Query submitted to Dune. Waiting for results...`);
    }

    let attempts = 0;
    const maxAttempts = 60;
    let rows: any[] = [];

    while (attempts < maxAttempts) {
      await sleep(5000);
      
      const statusResponse = await fetch(`https://api.dune.com/api/v1/execution/${executionId}/results`, {
        headers: {
          "X-DUNE-API-KEY": apiKey,
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

    importProgress.totalFound = rows.length;
    logger.info(`[DUNE IMPORT] Found ${rows.length} creators with graduated tokens`);

    if (progressCallback) {
      await progressCallback(`Found ${rows.length} creators. Processing and filtering spam...`);
    }

    let processed = 0;
    const batchSize = 20;

    for (const row of rows) {
      try {
        const creatorAddress = String(row.creator_address || "");
        const totalLaunches = parseInt(String(row.total_launches)) || 0;
        const bondedCount = parseInt(String(row.bonded_count)) || 0;

        if (!creatorAddress) {
          processed++;
          continue;
        }

        importProgress.verified++;

        const spamCheck = isSpamCreator(totalLaunches, bondedCount, 0);
        
        if (spamCheck) {
          importProgress.spam++;
          processed++;
          continue;
        }

        const existingCreator = db.getCreator(creatorAddress);
        
        if (!existingCreator) {
          const isQualified = bondedCount >= 1;
          const qualificationReason = isQualified ? `PROVEN: ${bondedCount} bonded` : "";

          db.upsertCreator({
            address: creatorAddress,
            total_launches: totalLaunches,
            bonded_count: bondedCount,
            hits_100k_count: 0,
            best_mc_ever: 0,
            is_qualified: isQualified ? 1 : 0,
            qualification_reason: qualificationReason,
            last_updated: new Date().toISOString(),
          });

          importProgress.imported++;
        }

        processed++;

        if (processed % batchSize === 0 && progressCallback) {
          await progressCallback(
            `Dune Import progress:\n` +
            `- Processed: ${processed}/${importProgress.totalFound}\n` +
            `- Imported: ${importProgress.imported}\n` +
            `- Spam blocked: ${importProgress.spam}`
          );
        }
      } catch (err: any) {
        logger.error(`[DUNE IMPORT] Error processing row: ${err.message}`);
        importProgress.errors++;
        processed++;
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

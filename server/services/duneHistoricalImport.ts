import { DuneClient } from "@duneanalytics/client-sdk";
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

  const client = new DuneClient(apiKey);

  try {
    logger.info(`[DUNE IMPORT] Starting ${months}-month historical import`);
    
    if (progressCallback) {
      await progressCallback(`Querying Dune for ${months} months of graduated tokens...\nThis may take 2-5 minutes.`);
    }

    const sql = `
      SELECT 
        creator_address,
        COUNT(*) as total_launches,
        COUNT(CASE WHEN graduated = true THEN 1 END) as bonded_count,
        MAX(market_cap_usd) as best_mc
      FROM (
        SELECT 
          account_arguments[2] as creator_address,
          account_arguments[1] as token_mint,
          tx_id,
          block_time,
          CASE 
            WHEN EXISTS (
              SELECT 1 FROM solana.instructions w 
              WHERE w.executing_account = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
              AND w.inner_instruction_index = 0
              AND array_contains(w.account_arguments, i.account_arguments[1])
            ) THEN true 
            ELSE false 
          END as graduated,
          0 as market_cap_usd
        FROM solana.instructions i
        WHERE executing_account = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
        AND block_time >= NOW() - INTERVAL '${months}' MONTH
      ) tokens
      WHERE graduated = true
      GROUP BY creator_address
      HAVING COUNT(CASE WHEN graduated = true THEN 1 END) >= 1
      ORDER BY bonded_count DESC
      LIMIT ${maxCreators}
    `;

    logger.info(`[DUNE] Executing query for ${months} months of data...`);
    
    const result = await client.runQuery({
      queryId: 0,
      query_parameters: [],
    });

    const rows = result.result?.rows || [];
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
        const bestMc = parseFloat(String(row.best_mc)) || 0;

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
            hits_100k_count: bestMc >= 100000 ? 1 : 0,
            best_mc_ever: bestMc,
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

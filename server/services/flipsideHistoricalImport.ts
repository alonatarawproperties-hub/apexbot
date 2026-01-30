import { Flipside } from "@flipsidecrypto/sdk";
import { logger } from "../utils/logger";
import * as db from "../db";
import { checkIfSpamLauncher } from "./spamDetection";
import { isSpamCreator } from "./creatorService";

const PUMPFUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

interface GraduatedToken {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  createdAt: string;
  graduatedAt: string;
}

interface CreatorStats {
  address: string;
  totalLaunches: number;
  bondedCount: number;
  hits100k: number;
  bestMc: number;
}

interface FlipsideImportProgress {
  isRunning: boolean;
  totalFound: number;
  verified: number;
  imported: number;
  spam: number;
  errors: number;
  startTime: number | null;
}

let importProgress: FlipsideImportProgress = {
  isRunning: false,
  totalFound: 0,
  verified: 0,
  imported: 0,
  spam: 0,
  errors: 0,
  startTime: null,
};

export function getFlipsideImportProgress(): FlipsideImportProgress {
  return { ...importProgress };
}

export async function importFromFlipside(
  months: number = 3,
  maxCreators: number = 500,
  progressCallback?: (message: string) => Promise<void>
): Promise<FlipsideImportProgress> {
  const apiKey = process.env.FLIPSIDE_API_KEY;
  
  if (!apiKey) {
    throw new Error("FLIPSIDE_API_KEY not configured. Get a free key at flipsidecrypto.xyz");
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

  const flipside = new Flipside(apiKey, "https://api-v2.flipsidecrypto.xyz");

  try {
    logger.info(`[FLIPSIDE IMPORT] Starting ${months}-month historical import`);
    
    if (progressCallback) {
      await progressCallback(`Querying Flipside for ${months} months of graduated tokens...\nThis may take 1-2 minutes.`);
    }

    const graduatedTokens = await queryGraduatedTokens(flipside, months);
    
    logger.info(`[FLIPSIDE IMPORT] Found ${graduatedTokens.length} graduated tokens`);

    const creatorMap = new Map<string, GraduatedToken[]>();
    for (const token of graduatedTokens) {
      if (!token.creator) continue;
      
      const existing = creatorMap.get(token.creator) || [];
      existing.push(token);
      creatorMap.set(token.creator, existing);
    }

    importProgress.totalFound = creatorMap.size;
    logger.info(`[FLIPSIDE IMPORT] Found ${importProgress.totalFound} unique creators`);

    if (progressCallback) {
      await progressCallback(
        `Found ${importProgress.totalFound} unique creators from ${graduatedTokens.length} graduated tokens.\n` +
        `Fetching creator stats and verifying...`
      );
    }

    const creatorAddresses = Array.from(creatorMap.keys()).slice(0, maxCreators);
    const creatorStats = await queryCreatorStats(flipside, creatorAddresses);
    
    let processed = 0;
    const batchSize = 20;

    for (const creatorAddress of creatorAddresses) {
      try {
        const stats = creatorStats.get(creatorAddress);
        const tokens = creatorMap.get(creatorAddress) || [];
        
        if (!stats) {
          processed++;
          continue;
        }

        importProgress.verified++;

        const spamCheck = isSpamCreator(stats.totalLaunches, stats.bondedCount, stats.hits100k);
        
        if (spamCheck) {
          importProgress.spam++;
          processed++;
          continue;
        }

        const existingCreator = db.getCreator(creatorAddress);
        
        if (!existingCreator) {
          const qualificationReason = buildQualificationReason(stats);
          const isQualified = stats.bondedCount >= 1 || stats.hits100k >= 1;

          db.upsertCreator({
            address: creatorAddress,
            total_launches: stats.totalLaunches,
            bonded_count: stats.bondedCount,
            hits_100k_count: stats.hits100k,
            best_mc_ever: stats.bestMc,
            is_qualified: isQualified ? 1 : 0,
            qualification_reason: qualificationReason,
            last_updated: new Date().toISOString(),
          });

          importProgress.imported++;
        }

        for (const token of tokens) {
          const existingToken = db.getToken(token.mint);
          
          if (!existingToken) {
            db.createToken({
              address: token.mint,
              creator_address: creatorAddress,
              name: token.name || "Unknown",
              symbol: token.symbol || "???",
              bonded: 1,
              peak_mc: stats.bestMc,
              peak_mc_timestamp: null,
              peak_mc_held_minutes: 0,
              current_mc: stats.bestMc,
              pumpfun_url: `https://pump.fun/${token.mint}`,
            });
          }
        }

        processed++;

        if (processed % batchSize === 0 && progressCallback) {
          await progressCallback(
            `Flipside Import progress:\n` +
            `- Processed: ${processed}/${Math.min(importProgress.totalFound, maxCreators)}\n` +
            `- Imported: ${importProgress.imported}\n` +
            `- Spam blocked: ${importProgress.spam}`
          );
        }
      } catch (err: any) {
        logger.error(`[FLIPSIDE IMPORT] Error processing creator ${creatorAddress}: ${err.message}`);
        importProgress.errors++;
        processed++;
      }
    }

    logger.info(`[FLIPSIDE IMPORT] Complete: ${importProgress.imported} imported, ${importProgress.spam} spam blocked`);
    
    importProgress.isRunning = false;
    return importProgress;
  } catch (error: any) {
    logger.error(`[FLIPSIDE IMPORT] Fatal error: ${error.message}`);
    importProgress.isRunning = false;
    importProgress.errors++;
    throw error;
  }
}

async function queryGraduatedTokens(flipside: Flipside, months: number): Promise<GraduatedToken[]> {
  const sql = `
    WITH token_creations AS (
      SELECT 
        tx_id,
        block_timestamp,
        instruction:accounts[0]::string as mint_address,
        instruction:accounts[1]::string as creator_address,
        instruction:arguments:name::string as token_name,
        instruction:arguments:symbol::string as token_symbol
      FROM solana.core.fact_events
      WHERE program_id = '${PUMPFUN_PROGRAM_ID}'
        AND instruction:method IN ('create', 'create_v2')
        AND succeeded = TRUE
        AND block_timestamp >= CURRENT_DATE - INTERVAL '${months} months'
    ),
    graduated_tokens AS (
      SELECT DISTINCT
        instruction:accounts[0]::string as mint_address,
        block_timestamp as graduation_time
      FROM solana.core.fact_events
      WHERE program_id = '${PUMPFUN_PROGRAM_ID}'
        AND instruction:method = 'withdraw'
        AND succeeded = TRUE
        AND block_timestamp >= CURRENT_DATE - INTERVAL '${months} months'
    )
    SELECT 
      tc.mint_address,
      tc.token_name,
      tc.token_symbol,
      tc.creator_address,
      tc.block_timestamp as created_at,
      gt.graduation_time as graduated_at
    FROM token_creations tc
    INNER JOIN graduated_tokens gt ON tc.mint_address = gt.mint_address
    ORDER BY gt.graduation_time DESC
    LIMIT 2000
  `;

  try {
    logger.info(`[FLIPSIDE] Executing graduated tokens query for ${months} months...`);
    
    const queryResult = await flipside.query.run({ sql });
    
    if (queryResult.error) {
      logger.error(`[FLIPSIDE] Query error: ${queryResult.error}`);
      return [];
    }

    const records = queryResult.records || [];
    logger.info(`[FLIPSIDE] Query returned ${records.length} graduated tokens`);

    return records.map((record: any) => ({
      mint: String(record.mint_address || ""),
      name: String(record.token_name || ""),
      symbol: String(record.token_symbol || ""),
      creator: String(record.creator_address || ""),
      createdAt: String(record.created_at || ""),
      graduatedAt: String(record.graduated_at || ""),
    }));
  } catch (error: any) {
    logger.error(`[FLIPSIDE] Query failed: ${error.message}`);
    return [];
  }
}

async function queryCreatorStats(flipside: Flipside, creators: string[]): Promise<Map<string, CreatorStats>> {
  const statsMap = new Map<string, CreatorStats>();
  
  if (creators.length === 0) return statsMap;

  const creatorList = creators.slice(0, 200).map(c => `'${c}'`).join(",");
  
  const sql = `
    WITH creator_tokens AS (
      SELECT 
        instruction:accounts[1]::string as creator_address,
        instruction:accounts[0]::string as mint_address,
        block_timestamp
      FROM solana.core.fact_events
      WHERE program_id = '${PUMPFUN_PROGRAM_ID}'
        AND instruction:method IN ('create', 'create_v2')
        AND succeeded = TRUE
        AND instruction:accounts[1]::string IN (${creatorList})
    ),
    graduated AS (
      SELECT DISTINCT instruction:accounts[0]::string as mint_address
      FROM solana.core.fact_events
      WHERE program_id = '${PUMPFUN_PROGRAM_ID}'
        AND instruction:method = 'withdraw'
        AND succeeded = TRUE
    )
    SELECT 
      ct.creator_address,
      COUNT(DISTINCT ct.mint_address) as total_launches,
      COUNT(DISTINCT g.mint_address) as bonded_count
    FROM creator_tokens ct
    LEFT JOIN graduated g ON ct.mint_address = g.mint_address
    GROUP BY ct.creator_address
  `;

  try {
    logger.info(`[FLIPSIDE] Querying stats for ${creators.length} creators...`);
    
    const queryResult = await flipside.query.run({ sql });
    
    if (queryResult.error) {
      logger.error(`[FLIPSIDE] Stats query error: ${queryResult.error}`);
      return statsMap;
    }

    for (const record of queryResult.records || []) {
      const creatorAddr = String(record.creator_address || "");
      statsMap.set(creatorAddr, {
        address: creatorAddr,
        totalLaunches: parseInt(String(record.total_launches)) || 0,
        bondedCount: parseInt(String(record.bonded_count)) || 0,
        hits100k: 0,
        bestMc: 0,
      });
    }

    logger.info(`[FLIPSIDE] Got stats for ${statsMap.size} creators`);
    return statsMap;
  } catch (error: any) {
    logger.error(`[FLIPSIDE] Stats query failed: ${error.message}`);
    return statsMap;
  }
}

function buildQualificationReason(stats: CreatorStats): string {
  const reasons: string[] = [];
  
  if (stats.bondedCount >= 1) {
    reasons.push(`${stats.bondedCount} bonded`);
  }
  if (stats.hits100k >= 1) {
    reasons.push(`${stats.hits100k} hit 100k MC`);
  }
  
  return reasons.length > 0 ? `PROVEN: ${reasons.join(", ")}` : "";
}

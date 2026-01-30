import { logger } from "../utils/logger";
import * as db from "../db";

const MORALIS_API_URL = "https://solana-gateway.moralis.io";

interface MoralisToken {
  mint: string;
  name?: string;
  symbol?: string;
  creatorAddress?: string;
}

interface MoralisGraduatedResponse {
  result?: MoralisToken[];
  cursor?: string;
}

export async function fetchGraduatedTokens(limit: number = 100, cursor?: string): Promise<{ tokens: MoralisToken[]; nextCursor?: string }> {
  const apiKey = process.env.MORALIS_API_KEY;
  
  if (!apiKey) {
    logger.warn("MORALIS_API_KEY not set, skipping graduated tokens fetch");
    return { tokens: [] };
  }

  try {
    let url = `${MORALIS_API_URL}/token/mainnet/exchange/pumpfun/graduated?limit=${limit}`;
    if (cursor) {
      url += `&cursor=${cursor}`;
    }

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "X-API-Key": apiKey,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      logger.error(`Moralis API error ${response.status}: ${text}`);
      return { tokens: [] };
    }

    const result: MoralisGraduatedResponse = await response.json();
    
    logger.info(`Moralis returned ${result.result?.length || 0} tokens`);
    if (result.result && result.result.length > 0) {
      logger.info(`Sample token fields: ${JSON.stringify(Object.keys(result.result[0]))}`);
      logger.info(`Sample token: ${JSON.stringify(result.result[0])}`);
    }
    
    return {
      tokens: result.result || [],
      nextCursor: result.cursor,
    };
  } catch (error: any) {
    logger.error("Moralis fetch error:", error.message);
    return { tokens: [] };
  }
}

export async function importHistoricalCreators(maxTokens: number = 1000): Promise<{ imported: number; skipped: number; spam: number }> {
  logger.info(`Starting historical creator import (max ${maxTokens} tokens)...`);
  
  const creatorSet = new Set<string>();
  const stats = { imported: 0, skipped: 0, spam: 0 };
  let cursor: string | undefined;
  let totalFetched = 0;

  while (totalFetched < maxTokens) {
    const batchSize = Math.min(100, maxTokens - totalFetched);
    const { tokens, nextCursor } = await fetchGraduatedTokens(batchSize, cursor);
    
    logger.info(`[IMPORT] Batch fetched: ${tokens.length} tokens, nextCursor: ${nextCursor ? 'yes' : 'no'}`);
    
    if (tokens.length === 0) break;
    
    let tokensWithCreator = 0;
    for (const token of tokens) {
      if (token.creatorAddress) {
        tokensWithCreator++;
        if (!creatorSet.has(token.creatorAddress)) {
          creatorSet.add(token.creatorAddress);
        }
      }
    }
    logger.info(`[IMPORT] Tokens with creatorAddress: ${tokensWithCreator}/${tokens.length}`);
    
    totalFetched += tokens.length;
    cursor = nextCursor;
    
    if (!nextCursor) break;
    
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  logger.info(`Found ${creatorSet.size} unique creators from ${totalFetched} graduated tokens`);

  // Since these are from Moralis graduated tokens, they already bonded
  // We don't need Bitquery validation - just import them directly
  const creatorArray = Array.from(creatorSet);
  for (const creatorAddress of creatorArray) {
    try {
      const existingCreator = db.getCreator(creatorAddress);
      
      // Skip if already has bonded token
      if (existingCreator && existingCreator.bonded_count >= 1) {
        stats.skipped++;
        continue;
      }

      // Count how many graduated tokens this creator has from our batch
      const creatorBondedCount = 1; // At least 1 since they're in graduated list
      
      db.upsertCreator({
        address: creatorAddress,
        total_launches: existingCreator?.total_launches || 1,
        bonded_count: (existingCreator?.bonded_count || 0) + creatorBondedCount,
        hits_100k_count: existingCreator?.hits_100k_count || 0,
        best_mc_ever: existingCreator?.best_mc_ever || 69000,
        is_qualified: 1,
        qualification_reason: "graduated_token_import",
        last_updated: null,
      });

      stats.imported++;
      
      if (stats.imported % 50 === 0) {
        logger.info(`Import progress: ${stats.imported} creators imported`);
      }

    } catch (error: any) {
      logger.error(`Failed to import creator ${creatorAddress.slice(0, 8)}...: ${error.message}`);
      stats.skipped++;
    }
  }

  logger.info(`Historical import complete: ${stats.imported} imported, ${stats.skipped} skipped, ${stats.spam} spam`);
  return stats;
}

export async function runHistoricalImportJob(): Promise<void> {
  try {
    await importHistoricalCreators(500);
  } catch (error: any) {
    logger.error("Historical import job failed:", error.message);
  }
}

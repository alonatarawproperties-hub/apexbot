import { logger } from "../utils/logger";

const MORALIS_API_BASE = "https://solana-gateway.moralis.io";
const RATE_LIMIT_DELAY = 50; // 50ms between requests (20 req/sec to stay under 25 limit)

interface MoralisToken {
  tokenAddress: string;
  name: string;
  symbol: string;
  createdAt?: string;
  graduatedAt?: string;
  priceUsd?: string;
  liquidity?: string;
  fullyDilutedValuation?: string;
  creatorAddress?: string;
}

interface MoralisResponse {
  result: MoralisToken[];
  cursor?: string;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function fetchGraduatedTokens(
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
      accept: "application/json",
      "X-API-Key": apiKey,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Moralis API error ${response.status}: ${text}`);
  }

  return response.json();
}

export async function fetchTokenDetails(
  apiKey: string,
  tokenAddress: string
): Promise<any> {
  const url = `${MORALIS_API_BASE}/token/mainnet/${tokenAddress}/metadata`;
  
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "X-API-Key": apiKey,
    },
  });

  if (!response.ok) {
    return null;
  }

  return response.json();
}

export interface BackfillProgress {
  totalFetched: number;
  totalCreators: number;
  cursor?: string;
  isComplete: boolean;
  error?: string;
}

export async function* backfillGraduatedTokens(
  apiKey: string,
  maxTokens: number = 50000,
  sixMonthsAgo?: Date
): AsyncGenerator<BackfillProgress> {
  const cutoffDate = sixMonthsAgo || new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
  let cursor: string | undefined;
  let totalFetched = 0;
  const creatorCounts = new Map<string, number>();
  
  logger.info(`Starting backfill - fetching graduated tokens since ${cutoffDate.toISOString()}`);

  try {
    while (totalFetched < maxTokens) {
      const response = await fetchGraduatedTokens(apiKey, cursor);
      
      if (!response.result || response.result.length === 0) {
        logger.info("No more tokens to fetch");
        break;
      }

      let reachedCutoff = false;
      
      for (const token of response.result) {
        const graduatedAt = token.graduatedAt ? new Date(token.graduatedAt) : null;
        
        if (graduatedAt && graduatedAt < cutoffDate) {
          reachedCutoff = true;
          break;
        }

        if (token.creatorAddress) {
          const count = creatorCounts.get(token.creatorAddress) || 0;
          creatorCounts.set(token.creatorAddress, count + 1);
        }
        
        totalFetched++;
      }

      cursor = response.cursor;
      
      yield {
        totalFetched,
        totalCreators: creatorCounts.size,
        cursor,
        isComplete: false,
      };

      if (reachedCutoff || !cursor) {
        break;
      }

      await sleep(RATE_LIMIT_DELAY);
    }

    yield {
      totalFetched,
      totalCreators: creatorCounts.size,
      isComplete: true,
    };

  } catch (error: any) {
    yield {
      totalFetched,
      totalCreators: creatorCounts.size,
      isComplete: true,
      error: error.message,
    };
  }
}

export { MoralisToken, MoralisResponse };

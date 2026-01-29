import axios from "axios";
import { config } from "../utils/config";
import { logger } from "../utils/logger";
import { sleep } from "../utils/helpers";

const BASE_URL = "https://api.dexscreener.com/latest/dex";

interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  priceUsd: string;
  liquidity?: { usd: number };
  fdv?: number;
  marketCap?: number;
}

interface DexScreenerResponse {
  pairs: DexScreenerPair[] | null;
}

export interface TokenInfo {
  address: string;
  name: string;
  symbol: string;
  priceUsd: number;
  marketCap: number;
  liquidity: number;
  dexId: string;
  isBonded: boolean;
}

let lastRequestTime = 0;

async function rateLimitedRequest<T>(url: string): Promise<T | null> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  
  if (timeSinceLastRequest < config.dexscreenerRateLimit) {
    await sleep(config.dexscreenerRateLimit - timeSinceLastRequest);
  }
  
  lastRequestTime = Date.now();
  
  try {
    const response = await axios.get<T>(url, { timeout: 10000 });
    return response.data;
  } catch (error: any) {
    logger.error(`DexScreener API error: ${error.message}`);
    return null;
  }
}

export async function getTokenInfo(tokenAddress: string): Promise<TokenInfo | null> {
  const data = await rateLimitedRequest<DexScreenerResponse>(
    `${BASE_URL}/tokens/${tokenAddress}`
  );
  
  if (!data || !data.pairs || data.pairs.length === 0) {
    return null;
  }
  
  const pair = data.pairs[0];
  const marketCap = pair.marketCap || pair.fdv || 0;
  const isBonded = pair.dexId === "raydium";
  
  return {
    address: tokenAddress,
    name: pair.baseToken.name,
    symbol: pair.baseToken.symbol,
    priceUsd: parseFloat(pair.priceUsd) || 0,
    marketCap,
    liquidity: pair.liquidity?.usd || 0,
    dexId: pair.dexId,
    isBonded,
  };
}

export async function getTokensByAddresses(addresses: string[]): Promise<Map<string, TokenInfo>> {
  const result = new Map<string, TokenInfo>();
  
  const chunks: string[][] = [];
  for (let i = 0; i < addresses.length; i += 30) {
    chunks.push(addresses.slice(i, i + 30));
  }
  
  for (const chunk of chunks) {
    const addressList = chunk.join(",");
    const data = await rateLimitedRequest<DexScreenerResponse>(
      `${BASE_URL}/tokens/${addressList}`
    );
    
    if (data && data.pairs) {
      for (const pair of data.pairs) {
        const address = pair.baseToken.address;
        const marketCap = pair.marketCap || pair.fdv || 0;
        const isBonded = pair.dexId === "raydium";
        
        if (!result.has(address) || marketCap > (result.get(address)?.marketCap || 0)) {
          result.set(address, {
            address,
            name: pair.baseToken.name,
            symbol: pair.baseToken.symbol,
            priceUsd: parseFloat(pair.priceUsd) || 0,
            marketCap,
            liquidity: pair.liquidity?.usd || 0,
            dexId: pair.dexId,
            isBonded,
          });
        }
      }
    }
  }
  
  return result;
}

export async function searchTokensByCreator(creatorAddress: string): Promise<TokenInfo[]> {
  return [];
}

import { logger } from "../utils/logger";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

interface SignatureResult {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: any | null;
}

interface LaunchCountResult {
  actualLaunches: number;
  totalTransactions: number;
  error?: string;
  fromCache: boolean;
}

const launchCountCache = new Map<string, { result: LaunchCountResult; timestamp: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

async function fetchSignatures(address: string, before?: string): Promise<SignatureResult[]> {
  const params: any = { limit: 1000 };
  if (before) params.before = before;

  const response = await fetch(HELIUS_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getSignaturesForAddress",
      params: [address, params]
    })
  });

  if (!response.ok) {
    throw new Error(`Helius RPC error: ${response.status}`);
  }

  const data = await response.json();
  if (data.error) {
    throw new Error(data.error.message || "RPC error");
  }

  return data.result || [];
}

async function isPumpFunCreate(signature: string): Promise<boolean> {
  try {
    const response = await fetch(HELIUS_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [signature, { encoding: "json", maxSupportedTransactionVersion: 0 }]
      })
    });

    const data = await response.json();
    if (!data.result?.meta?.logMessages) return false;

    const logs: string[] = data.result.meta.logMessages;
    return logs.some((log: string) => log.includes("Program log: Create"));
  } catch {
    return false;
  }
}

export async function getCreatorLaunchCount(creatorAddress: string): Promise<LaunchCountResult> {
  // Check cache first
  const cached = launchCountCache.get(creatorAddress);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return { ...cached.result, fromCache: true };
  }

  if (!HELIUS_API_KEY) {
    return { actualLaunches: 0, totalTransactions: 0, error: "No Helius API key", fromCache: false };
  }

  try {
    // Step 1: Get total transaction count (paginate up to 5 pages = 5000 txs max)
    let allSignatures: SignatureResult[] = [];
    let lastSignature: string | undefined;
    const MAX_PAGES = 5;

    for (let page = 0; page < MAX_PAGES; page++) {
      const sigs = await fetchSignatures(creatorAddress, lastSignature);
      if (sigs.length === 0) break;
      
      allSignatures.push(...sigs);
      lastSignature = sigs[sigs.length - 1].signature;
      
      if (sigs.length < 1000) break; // End of history
      await new Promise(r => setTimeout(r, 100)); // Rate limit
    }

    const totalTransactions = allSignatures.length;
    
    if (totalTransactions === 0) {
      const result: LaunchCountResult = { actualLaunches: 0, totalTransactions: 0, fromCache: false };
      launchCountCache.set(creatorAddress, { result, timestamp: Date.now() });
      return result;
    }

    // Step 2: Sample up to 30 transactions to check PumpFun create ratio
    const sampleSize = Math.min(30, totalTransactions);
    const sampleIndices: number[] = [];
    
    // Take evenly distributed samples
    for (let i = 0; i < sampleSize; i++) {
      const idx = Math.floor((i / sampleSize) * totalTransactions);
      if (!sampleIndices.includes(idx)) {
        sampleIndices.push(idx);
      }
    }

    let pumpFunCount = 0;
    let sampledCount = 0;

    for (const idx of sampleIndices) {
      const sig = allSignatures[idx];
      if (!sig || sig.err) continue;
      
      const isCreate = await isPumpFunCreate(sig.signature);
      if (isCreate) pumpFunCount++;
      sampledCount++;
      
      await new Promise(r => setTimeout(r, 50)); // Rate limit
    }

    // Step 3: Extrapolate
    const ratio = sampledCount > 0 ? pumpFunCount / sampledCount : 0;
    const estimatedLaunches = Math.round(ratio * totalTransactions);

    logger.info(`[LAUNCH COUNT] ${creatorAddress.slice(0, 8)}...: ~${estimatedLaunches} launches (${totalTransactions} txs, ${pumpFunCount}/${sampledCount} sampled)`);

    const result: LaunchCountResult = {
      actualLaunches: estimatedLaunches,
      totalTransactions,
      fromCache: false
    };

    launchCountCache.set(creatorAddress, { result, timestamp: Date.now() });
    return result;
  } catch (error: any) {
    logger.error(`[LAUNCH COUNT ERROR] ${creatorAddress.slice(0, 8)}...: ${error.message}`);
    return { actualLaunches: 0, totalTransactions: 0, error: error.message, fromCache: false };
  }
}

// Quick check - just get total transaction count (faster, no sampling)
export async function getQuickTransactionCount(creatorAddress: string): Promise<number> {
  if (!HELIUS_API_KEY) return 0;
  
  try {
    const sigs = await fetchSignatures(creatorAddress);
    // If we got 1000, there are likely more
    if (sigs.length >= 1000) {
      // Get one more page to estimate
      const lastSig = sigs[sigs.length - 1].signature;
      const page2 = await fetchSignatures(creatorAddress, lastSig);
      return sigs.length + page2.length;
    }
    return sigs.length;
  } catch {
    return 0;
  }
}

export function clearLaunchCountCache(): void {
  launchCountCache.clear();
}

import { Connection, Keypair, Transaction, VersionedTransaction, PublicKey } from "@solana/web3.js";
import { logger } from "../utils/logger";

const JITO_BLOCK_ENGINES = [
  "https://mainnet.block-engine.jito.wtf/api/v1/bundles",
  "https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles",
  "https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles",
  "https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles",
  "https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles",
];

const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4bVrUg5ABG4uw5wLPfAuquc",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

function getRandomTipAccount(): PublicKey {
  const randomIndex = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
  return new PublicKey(JITO_TIP_ACCOUNTS[randomIndex]);
}

function getRandomBlockEngine(): string {
  const randomIndex = Math.floor(Math.random() * JITO_BLOCK_ENGINES.length);
  return JITO_BLOCK_ENGINES[randomIndex];
}

export interface BundleResult {
  success: boolean;
  bundleId?: string;
  error?: string;
}

export async function sendBundle(
  transactions: (Transaction | VersionedTransaction)[],
  signers: Keypair[]
): Promise<BundleResult> {
  const blockEngine = getRandomBlockEngine();
  
  try {
    const serializedTxs = transactions.map(tx => {
      if (tx instanceof Transaction) {
        return Buffer.from(tx.serialize()).toString("base64");
      } else {
        return Buffer.from(tx.serialize()).toString("base64");
      }
    });
    
    const response = await fetch(blockEngine, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [serializedTxs],
      }),
    });
    
    if (!response.ok) {
      const text = await response.text();
      logger.error(`Jito bundle failed: ${response.status} - ${text}`);
      return { success: false, error: text };
    }
    
    const result = await response.json();
    
    if (result.error) {
      logger.error(`Jito bundle error: ${JSON.stringify(result.error)}`);
      return { success: false, error: result.error.message || JSON.stringify(result.error) };
    }
    
    logger.info(`Jito bundle sent: ${result.result}`);
    return { success: true, bundleId: result.result };
  } catch (error: any) {
    logger.error(`Jito bundle exception: ${error.message}`);
    return { success: false, error: error.message };
  }
}

export async function getBundleStatus(bundleId: string): Promise<string> {
  const blockEngine = getRandomBlockEngine().replace("/bundles", "/getBundleStatuses");
  
  try {
    const response = await fetch(blockEngine, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getBundleStatuses",
        params: [[bundleId]],
      }),
    });
    
    const result = await response.json();
    
    if (result.result?.value?.[0]) {
      return result.result.value[0].confirmation_status || "unknown";
    }
    
    return "pending";
  } catch (error: any) {
    return "error";
  }
}

export function getTipAccount(): PublicKey {
  return getRandomTipAccount();
}

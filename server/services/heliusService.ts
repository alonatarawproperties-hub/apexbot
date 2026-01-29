import axios from "axios";
import { config } from "../utils/config";
import { logger } from "../utils/logger";

const HELIUS_API_BASE = "https://api.helius.xyz/v0";

export interface TokenCreationData {
  signature: string;
  tokenMint: string;
  creator: string;
  name?: string;
  symbol?: string;
  timestamp: number;
}

// PumpFun "create" instruction discriminator (first 8 bytes)
const PUMPFUN_CREATE_DISCRIMINATOR = "181ec828051c0777";

export function parseTokenCreation(transaction: any): TokenCreationData | null {
  try {
    if (!transaction) return null;

    const { signature, feePayer, timestamp, instructions, type } = transaction;

    // Method 1: Check if Helius already classified this as a token creation
    if (type === "CREATE" || type === "TOKEN_MINT" || type === "CREATE_TOKEN") {
      const mint = transaction.events?.nft?.mint;
      if (mint) {
        return {
          signature,
          tokenMint: mint,
          creator: feePayer || "",
          name: transaction.events?.nft?.metadata?.name,
          symbol: transaction.events?.nft?.metadata?.symbol,
          timestamp: timestamp || Date.now() / 1000,
        };
      }
    }

    // Method 2: Look for PumpFun create instruction specifically
    if (instructions && Array.isArray(instructions)) {
      for (const ix of instructions) {
        if (ix.programId === config.pumpfunProgram) {
          // Check instruction data for create discriminator
          if (ix.data && ix.data.startsWith(PUMPFUN_CREATE_DISCRIMINATOR)) {
            const accounts = ix.accounts || [];
            if (accounts.length >= 2) {
              return {
                signature,
                tokenMint: accounts[0],
                creator: feePayer || accounts[1],
                timestamp: timestamp || Date.now() / 1000,
              };
            }
          }

          // Fallback: PumpFun create transactions typically have 10+ accounts
          // Buy/sell transactions have fewer accounts (usually 6-8)
          const accounts = ix.accounts || [];
          if (accounts.length >= 10) {
            return {
              signature,
              tokenMint: accounts[0],
              creator: feePayer || accounts[1],
              timestamp: timestamp || Date.now() / 1000,
            };
          }
        }
      }
    }

    return null;
  } catch (error: any) {
    logger.error("Error parsing token creation", error.message);
    return null;
  }
}

export async function setupWebhook(webhookUrl: string): Promise<string | null> {
  try {
    const existingWebhooks = await axios.get(
      `${HELIUS_API_BASE}/webhooks?api-key=${config.heliusApiKey}`
    );

    for (const webhook of existingWebhooks.data) {
      if (webhook.webhookURL === webhookUrl) {
        if (config.webhookSecret) {
          await axios.put(
            `${HELIUS_API_BASE}/webhooks/${webhook.webhookID}?api-key=${config.heliusApiKey}`,
            {
              webhookURL: webhookUrl,
              transactionTypes: ["Any"],
              accountAddresses: [config.pumpfunProgram],
              webhookType: "enhanced",
              authHeader: `Bearer ${config.webhookSecret}`,
            }
          );
          logger.info("Webhook updated with auth header", webhook.webhookID);
        } else {
          logger.info("Webhook already exists", webhook.webhookID);
        }
        return webhook.webhookID;
      }
    }

    const webhookConfig: any = {
      webhookURL: webhookUrl,
      transactionTypes: ["Any"],
      accountAddresses: [config.pumpfunProgram],
      webhookType: "enhanced",
    };

    if (config.webhookSecret) {
      webhookConfig.authHeader = `Bearer ${config.webhookSecret}`;
    }

    const response = await axios.post(
      `${HELIUS_API_BASE}/webhooks?api-key=${config.heliusApiKey}`,
      webhookConfig
    );

    logger.info("Webhook created", response.data.webhookID);
    return response.data.webhookID;
  } catch (error: any) {
    logger.error("Failed to setup Helius webhook", error.response?.data || error.message);
    return null;
  }
}

export async function getWebhooks(): Promise<any[]> {
  try {
    const response = await axios.get(
      `${HELIUS_API_BASE}/webhooks?api-key=${config.heliusApiKey}`
    );
    return response.data;
  } catch (error: any) {
    logger.error("Failed to get webhooks", error.message);
    return [];
  }
}

import { Router, Request, Response } from "express";
import { config } from "./utils/config";
import { logger } from "./utils/logger";
import { parseTokenCreation } from "./services/heliusService";
import { processNewToken } from "./services/creatorService";
import { sendNewTokenAlert } from "./services/alertService";

const router = Router();

let lastWebhookReceived: string | null = null;
let webhookCount = 0;

router.post("/webhook/helius", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (config.webhookSecret) {
      if (!authHeader) {
        logger.warn("Missing webhook authorization header");
        return res.status(401).json({ error: "Unauthorized" });
      }
      if (authHeader !== `Bearer ${config.webhookSecret}`) {
        logger.warn("Invalid webhook authorization");
        return res.status(401).json({ error: "Unauthorized" });
      }
    }
    
    lastWebhookReceived = new Date().toISOString();
    webhookCount++;
    
    const body = req.body;
    if (!body || (typeof body !== "object")) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    const transactions = Array.isArray(body) ? body : [body];

    if (transactions.length > 100) {
      logger.warn(`Webhook payload too large: ${transactions.length} transactions`);
      return res.status(400).json({ error: "Payload too large" });
    }

    logger.info(`Webhook received: ${transactions.length} transactions`);
    
    for (const tx of transactions) {
      const tokenData = parseTokenCreation(tx);
      
      if (tokenData) {
        logger.info(`Token creation detected: ${tokenData.tokenMint} by ${tokenData.creator}`);
        
        try {
          const result = await processNewToken(
            tokenData.creator,
            tokenData.tokenMint,
            tokenData.name,
            tokenData.symbol
          );
          
          if (result.isQualified || result.watcherUserIds.length > 0) {
            logger.alert(`Qualified creator detected: ${result.creator.address}`);
            await sendNewTokenAlert(result.creator, result.token);
          }
        } catch (error: any) {
          logger.error(`Failed to process token: ${error.message}`);
        }
      }
    }
    
    res.status(200).json({ success: true });
  } catch (error: any) {
    logger.error("Webhook error", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/webhook/status", (req: Request, res: Response) => {
  res.json({
    lastReceived: lastWebhookReceived,
    count: webhookCount,
  });
});

export function getLastWebhookReceived(): string | null {
  return lastWebhookReceived;
}

export function getWebhookCount(): number {
  return webhookCount;
}

export default router;

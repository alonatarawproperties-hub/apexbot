import type { Express } from "express";
import { type Server } from "http";
import * as db from "./db";
import webhookRoutes, { getLastWebhookReceived, getWebhookCount } from "./webhookRoutes";
import { isBotRunning } from "./bot";
import { getWebhooks } from "./services/heliusService";
import type { BotStatus } from "@shared/schema";

const startTime = Date.now();

// Cache webhook registration status (refresh every 5 minutes)
let cachedWebhookRegistered = false;
let webhookCacheTime = 0;
const WEBHOOK_CACHE_TTL = 5 * 60 * 1000;

async function isWebhookRegistered(): Promise<boolean> {
  if (Date.now() - webhookCacheTime < WEBHOOK_CACHE_TTL) {
    return cachedWebhookRegistered;
  }
  try {
    const webhooks = await getWebhooks();
    cachedWebhookRegistered = webhooks.length > 0;
    webhookCacheTime = Date.now();
  } catch {
    // Return cached value on error
  }
  return cachedWebhookRegistered;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.use(webhookRoutes);

  app.get("/api/status", async (req, res) => {
    try {
      const webhookRegistered = await isWebhookRegistered();
      
      const status: BotStatus = {
        isOnline: isBotRunning(),
        webhookRegistered,
        totalUsers: db.getUserCount(),
        totalCreators: db.getCreatorCount(),
        totalTokens: db.getTokenCount(),
        qualifiedCreators: db.getQualifiedCreatorCount(),
        alertsSentToday: db.getAlertsSentToday(),
        lastWebhookReceived: getLastWebhookReceived(),
        uptime: Math.floor((Date.now() - startTime) / 1000),
      };
      
      res.json(status);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
  
  app.get("/api/creators", (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const creators = db.getAllCreators().slice(0, limit);
      res.json(creators);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
  
  app.get("/api/creators/qualified", (req, res) => {
    try {
      const creators = db.getQualifiedCreators();
      res.json(creators);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
  
  app.get("/api/tokens/recent", (req, res) => {
    try {
      const hours = parseInt(req.query.hours as string) || 24;
      const tokens = db.getRecentTokens(hours);
      res.json(tokens);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
  
  app.get("/api/alerts/today", (req, res) => {
    try {
      const count = db.getAlertsSentToday();
      res.json({ count });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  return httpServer;
}

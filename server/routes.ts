import type { Express } from "express";
import { type Server } from "http";
import * as db from "./db";
import webhookRoutes, { getLastWebhookReceived, getWebhookCount } from "./webhookRoutes";
import { getWebhooks } from "./services/heliusService";
import type { BotStatus } from "@shared/schema";
import { getBot, isBotRunning, startBot } from "./bot";

const startTime = Date.now();

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  await startBot(app);
  app.use(webhookRoutes);
  
  app.get("/api/status", async (req, res) => {
    try {
      const webhooks = await getWebhooks();
      const webhookRegistered = webhooks.length > 0;
      const bot = getBot();
      
      const status: BotStatus = {
        isOnline: bot !== null && isBotRunning(),
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

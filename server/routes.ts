import type { Express } from "express";
import { type Server } from "http";
import * as db from "./db";
import webhookRoutes, { getLastWebhookReceived, getWebhookCount } from "./webhookRoutes";
import { getWebhooks } from "./services/heliusService";
import type { BotStatus } from "@shared/schema";
import { Bot, webhookCallback } from "grammy";
import { config } from "./utils/config";
import { logger } from "./utils/logger";
import { registerCommands } from "./bot/commands";
import { setBotInstance } from "./services/alertService";

const startTime = Date.now();
let telegramBot: Bot | null = null;

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.use(webhookRoutes);
  
  // Register Telegram webhook route FIRST before any other routes
  if (config.telegramBotToken) {
    try {
      telegramBot = new Bot(config.telegramBotToken);
      const me = await telegramBot.api.getMe();
      logger.info(`Bot authenticated as @${me.username}`);
      
      registerCommands(telegramBot);
      setBotInstance(telegramBot);
      
      telegramBot.catch((err) => {
        logger.error("Bot error", err);
      });
      
      // Always register the webhook route
      app.post("/telegram/webhook", webhookCallback(telegramBot, "express"));
      logger.info("Telegram webhook route registered at /telegram/webhook");
      
      // Always use polling mode - more reliable for Replit
      logger.info("Using polling mode for bot");
      await telegramBot.api.deleteWebhook({ drop_pending_updates: true });
      telegramBot.start({
        onStart: () => logger.info("Telegram bot polling started"),
      }).catch((err) => {
        logger.warn("Bot polling issue", err.message);
      });
    } catch (err: any) {
      logger.error("Failed to setup Telegram bot", err.message);
    }
  }
  
  app.get("/api/status", async (req, res) => {
    try {
      const webhooks = await getWebhooks();
      const webhookRegistered = webhooks.length > 0;
      
      const status: BotStatus = {
        isOnline: telegramBot !== null,
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

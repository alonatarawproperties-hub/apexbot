import type { Express } from "express";
import { type Server } from "http";
import * as db from "./db";
import type { BotStatus } from "@shared/schema";
import { getBot, isBotRunning, startBot } from "./bot";
import { startPumpPortalStream, isPumpPortalConnected } from "./services/pumpPortalService";
import { startMcTracker } from "./jobs/mcTracker";
import { startStatsAggregator } from "./jobs/statsAggregator";
import { runBackfill, getBackfillStatus } from "./jobs/backfillJob";
import { recalculateCreatorStats } from "./services/creatorService";
import { runCreatorBackfill, getBackfillProgress } from "./services/heliusBackfill";

const startTime = Date.now();

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  await startBot();
  
  startPumpPortalStream();
  startMcTracker();
  startStatsAggregator();
  
  app.get("/api/status", async (req, res) => {
    try {
      const bot = getBot();
      
      const status: BotStatus = {
        isOnline: bot !== null && isBotRunning(),
        webhookRegistered: isPumpPortalConnected(),
        totalUsers: db.getUserCount(),
        totalCreators: db.getCreatorCount(),
        totalTokens: db.getTokenCount(),
        qualifiedCreators: db.getQualifiedCreatorCount(),
        alertsSentToday: db.getAlertsSentToday(),
        alertStats: db.getAlertAttemptsTodayStats(),
        lastWebhookReceived: null,
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

  app.post("/api/backfill/start", (req, res) => {
    try {
      const status = getBackfillStatus();
      if (status.isRunning) {
        res.status(400).json({ error: "Backfill already in progress", status });
        return;
      }
      
      const maxTokens = parseInt(req.query.maxTokens as string) || 20000;
      runBackfill(maxTokens);
      
      res.json({ message: "Backfill started", maxTokens });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/backfill/status", (req, res) => {
    try {
      const status = getBackfillStatus();
      res.json(status);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/backfill/helius", async (req, res) => {
    try {
      const progress = getBackfillProgress();
      if (progress.isRunning) {
        res.json({ message: "Backfill already running", progress });
        return;
      }
      
      res.json({ message: "Helius backfill started", progress: getBackfillProgress() });
      
      runCreatorBackfill().catch(err => {
        console.error("Helius backfill error:", err.message);
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/backfill/helius/status", (req, res) => {
    try {
      const progress = getBackfillProgress();
      res.json(progress);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/creators/recalculate", async (req, res) => {
    try {
      const creators = db.getAllCreators();
      let updated = 0;
      
      for (const creator of creators) {
        if (creator.hits_100k_count > 0 && creator.bonded_count === 0) {
          await recalculateCreatorStats(creator.address);
          updated++;
        }
      }
      
      res.json({ message: "Recalculation complete", updated });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  return httpServer;
}

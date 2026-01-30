import WebSocket from "ws";
import { logger } from "../utils/logger";
import { processNewToken } from "./creatorService";
import { trackCreatorLaunch } from "./spamDetection";
import * as db from "../db";

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY = 5000;

export interface PumpPortalToken {
  signature: string;
  mint: string;
  traderPublicKey: string;
  txType: string;
  initialBuy: number;
  bondingCurveKey: string;
  vTokensInBondingCurve: number;
  vSolInBondingCurve: number;
  marketCapSol: number;
  name: string;
  symbol: string;
  uri: string;
}

export function startPumpPortalStream(): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    logger.warn("PumpPortal WebSocket already connected");
    return;
  }

  try {
    ws = new WebSocket("wss://pumpportal.fun/api/data");

    ws.on("open", () => {
      logger.info("PumpPortal WebSocket connected");
      reconnectAttempts = 0;

      const payload = {
        method: "subscribeNewToken",
      };
      ws!.send(JSON.stringify(payload));
      logger.info("Subscribed to PumpPortal new token events");
    });

    ws.on("message", async (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString());
        
        if (message.txType === "create" && message.mint && message.traderPublicKey) {
          await handleNewToken(message);
        }
      } catch (error: any) {
        logger.error("Error processing PumpPortal message", error.message);
      }
    });

    ws.on("error", (error) => {
      logger.error("PumpPortal WebSocket error", error.message);
    });

    ws.on("close", () => {
      logger.warn("PumpPortal WebSocket closed");
      ws = null;
      attemptReconnect();
    });
  } catch (error: any) {
    logger.error("Failed to connect to PumpPortal", error.message);
    attemptReconnect();
  }
}

function attemptReconnect(): void {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    logger.error("Max PumpPortal reconnect attempts reached");
    return;
  }

  reconnectAttempts++;
  logger.info(`Reconnecting to PumpPortal in ${RECONNECT_DELAY / 1000}s (attempt ${reconnectAttempts})`);
  
  setTimeout(() => {
    startPumpPortalStream();
  }, RECONNECT_DELAY);
}

async function handleNewToken(token: PumpPortalToken): Promise<void> {
  try {
    if (!token.mint.toLowerCase().endsWith("pump")) {
      return;
    }
    
    // Track creator launch for rapid-fire spam detection
    trackCreatorLaunch(token.traderPublicKey, token.symbol);
    
    // Calculate dev buy amount using vSolInBondingCurve (actual SOL locked in curve)
    // Initial virtual SOL is ~30, so any amount above that is what the dev added
    // Note: marketCapSol represents total market cap VALUE, NOT actual SOL in curve
    const INITIAL_VIRTUAL_SOL = 30;
    const vSol = token.vSolInBondingCurve ?? 0;
    const devBuySOL = Math.max(0, vSol - INITIAL_VIRTUAL_SOL);
    
    // Log all tokens with any dev buy for debugging
    if (devBuySOL > 0.5) {
      logger.info(`[DEV_BUY] ${token.symbol}: ${devBuySOL.toFixed(2)} SOL (vSol=${vSol})`);
    }
    
    // Check bundle alerts FIRST (instant, before qualified creator check)
    if (devBuySOL > 0) {
      await checkBundleAlerts(token, devBuySOL);
    }
    
    const result = await processNewToken(
      token.traderPublicKey,
      token.mint,
      token.name,
      token.symbol
    );

    if (result.isQualified || result.watcherUserIds.length > 0) {
      const { sendNewTokenAlert } = await import("./alertService");
      await sendNewTokenAlert(result.creator, result.token);
    }
  } catch (error: any) {
    logger.error("Failed to process PumpPortal token", error.message);
  }
}

async function checkBundleAlerts(token: PumpPortalToken, devBuySOL: number): Promise<void> {
  const { sendBundleAlert } = await import("./alertService");
  
  // Log dev buys >= 2 SOL for testing
  if (devBuySOL >= 2) {
    logger.info(`[DEV_BUY] ${token.symbol}: ${devBuySOL.toFixed(2)} SOL by ${token.traderPublicKey.slice(0, 8)}...`);
  }
  
  const allUsers = db.getAllUsers();
  
  // Debug: log how many users we're checking
  if (devBuySOL >= 2) {
    logger.info(`[BUNDLE_CHECK] Checking ${allUsers.length} users for ${token.symbol} (${devBuySOL.toFixed(2)} SOL)`);
  }
  
  for (const user of allUsers) {
    const settings = user.settings;
    
    // Check if user has bundle alerts enabled (default to true)
    if (settings.bundle_alerts_enabled === false) {
      if (devBuySOL >= 2) logger.info(`[BUNDLE_CHECK] User ${user.telegram_id} has bundle alerts disabled`);
      continue;
    }
    
    // Check if dev buy is within user's min/max range (defaults match DEFAULT_SETTINGS)
    const minSOL = settings.bundle_min_sol ?? 2;  // Default to 2 SOL for easier testing
    const maxSOL = settings.bundle_max_sol ?? 200;
    
    if (devBuySOL >= 2) {
      logger.info(`[BUNDLE_CHECK] User ${user.telegram_id}: enabled=${settings.bundle_alerts_enabled}, min=${minSOL}, max=${maxSOL}, devBuy=${devBuySOL.toFixed(2)}`);
    }
    
    if (devBuySOL >= minSOL && devBuySOL <= maxSOL) {
      logger.info(`[BUNDLE] ${token.symbol} - Dev bought ${devBuySOL.toFixed(2)} SOL, alerting user ${user.telegram_id}`);
      
      await sendBundleAlert(
        user,
        token.mint,
        token.name,
        token.symbol,
        token.traderPublicKey,
        devBuySOL,
        settings.bundle_auto_snipe ?? false,
        settings.bundle_buy_amount_sol ?? 0.1
      );
    }
  }
}

export function stopPumpPortalStream(): void {
  if (ws) {
    ws.close();
    ws = null;
    logger.info("PumpPortal WebSocket stopped");
  }
}

export function isPumpPortalConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

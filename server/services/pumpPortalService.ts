import WebSocket from "ws";
import { logger } from "../utils/logger";
import { processNewToken } from "./creatorService";
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

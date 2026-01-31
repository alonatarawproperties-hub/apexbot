import { Connection, PublicKey } from "@solana/web3.js";
import * as db from "../db";
import { logger } from "../utils/logger";
import { sellTokens } from "./sniperService";
import { sendTPSLNotification } from "./alertService";
import type { Position, SniperSettings } from "@shared/schema";

let monitorInterval: NodeJS.Timeout | null = null;

function getConnection(): Connection {
  const rpcUrl = process.env.HELIUS_RPC_URL || 
    `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` ||
    "https://api.mainnet-beta.solana.com";
  return new Connection(rpcUrl, "confirmed");
}

export function startPositionMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
  }
  
  monitorInterval = setInterval(async () => {
    await checkPositions();
  }, 30000);
  
  logger.info("Position monitor started (30s interval)");
}

export function stopPositionMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
    logger.info("Position monitor stopped");
  }
}

async function checkPositions(): Promise<void> {
  const openPositions = db.getOpenPositions();
  
  if (openPositions.length === 0) return;
  
  for (const position of openPositions) {
    try {
      await updatePositionPrice(position);
      await checkTPSL(position);
    } catch (error: any) {
      logger.error(`Error checking position ${position.id}: ${error.message}`);
    }
  }
}

async function updatePositionPrice(position: Position): Promise<void> {
  try {
    const priceData = await fetchTokenPrice(position.token_address);
    
    if (priceData && priceData.priceNative) {
      const currentPrice = parseFloat(priceData.priceNative);
      const pnlPercent = ((currentPrice - position.entry_price_sol) / position.entry_price_sol) * 100;
      
      db.updatePosition(position.id, {
        current_price_sol: currentPrice,
        unrealized_pnl_percent: pnlPercent,
      });
    }
  } catch (error: any) {
    logger.debug(`Could not update price for position ${position.id}: ${error.message}`);
  }
}

async function fetchTokenPrice(tokenAddress: string): Promise<any> {
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    if (!response.ok) return null;
    
    const data = await response.json();
    const pair = data.pairs?.[0];
    
    if (pair) {
      return {
        priceNative: pair.priceNative,
        priceUsd: pair.priceUsd,
      };
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

async function checkTPSL(position: Position): Promise<void> {
  const settings = db.getSniperSettings(position.user_id);
  if (!settings) return;
  
  // Use bundle-specific settings if position was created from bundle snipe
  const isBundle = position.snipe_mode === "bundle";
  const stopLoss = isBundle ? (settings.bundle_stop_loss_percent ?? 50) : settings.stop_loss_percent;
  const brackets = isBundle ? (settings.bundle_tp_brackets || []) : (settings.tp_brackets || []);
  const moonBagPercent = isBundle ? (settings.bundle_moon_bag_percent ?? 0) : (settings.moon_bag_percent || 0);
  
  const currentMultiplier = position.current_price_sol / position.entry_price_sol;
  
  if (stopLoss > 0) {
    const stopLossThreshold = 1 - (stopLoss / 100);
    if (currentMultiplier <= stopLossThreshold) {
      const slPnl = (currentMultiplier - 1) * 100;
      logger.info(`Stop loss triggered for position ${position.id}: ${slPnl.toFixed(1)}%`);

      const slResult = await sellTokens(position.user_id, position.id, 100, "stop_loss");
      await sendTPSLNotification(
        position.user_id, position.token_symbol, "stop_loss",
        `SL at -${stopLoss}%`, position.entry_amount_sol, slPnl, slResult?.txSignature
      );
      return;
    }
  }
  
  const totalTPPercent = brackets.reduce((sum, b) => sum + b.percentage, 0);
  
  if (brackets.length >= 1 && !position.tp1_hit) {
    const tp1 = brackets[0];
    if (currentMultiplier >= tp1.multiplier) {
      const tp1Pnl = (currentMultiplier - 1) * 100;
      logger.info(`TP1 triggered for position ${position.id}: ${currentMultiplier.toFixed(2)}x (target: ${tp1.multiplier}x)`);

      const sellPercent = (tp1.percentage / (100 - moonBagPercent)) * 100;
      const tp1Result = await sellTokens(position.user_id, position.id, sellPercent, `tp1_${tp1.multiplier}x`);
      await sendTPSLNotification(
        position.user_id, position.token_symbol, "take_profit",
        `TP1 at ${tp1.multiplier}x (sold ${tp1.percentage}%)`, position.entry_amount_sol, tp1Pnl, tp1Result?.txSignature
      );

      db.updatePosition(position.id, { tp1_hit: true });
    }
  }
  
  if (brackets.length >= 2 && position.tp1_hit && !position.tp2_hit) {
    const tp2 = brackets[1];
    if (currentMultiplier >= tp2.multiplier) {
      const tp2Pnl = (currentMultiplier - 1) * 100;
      logger.info(`TP2 triggered for position ${position.id}: ${currentMultiplier.toFixed(2)}x (target: ${tp2.multiplier}x)`);

      const remainingPercent = 100 - brackets[0].percentage;
      const sellPercent = (tp2.percentage / remainingPercent) * 100;
      const tp2Result = await sellTokens(position.user_id, position.id, sellPercent, `tp2_${tp2.multiplier}x`);
      await sendTPSLNotification(
        position.user_id, position.token_symbol, "take_profit",
        `TP2 at ${tp2.multiplier}x (sold ${tp2.percentage}%)`, position.entry_amount_sol, tp2Pnl, tp2Result?.txSignature
      );

      db.updatePosition(position.id, { tp2_hit: true });
    }
  }
  
  if (brackets.length >= 3 && position.tp2_hit && !position.tp3_hit) {
    const tp3 = brackets[2];
    if (currentMultiplier >= tp3.multiplier) {
      const tp3Pnl = (currentMultiplier - 1) * 100;
      logger.info(`TP3 triggered for position ${position.id}: ${currentMultiplier.toFixed(2)}x (target: ${tp3.multiplier}x)`);

      let tp3Result;
      if (moonBagPercent > 0) {
        const remainingAfterTP2 = 100 - brackets[0].percentage - brackets[1].percentage;
        const sellPercent = (tp3.percentage / remainingAfterTP2) * 100;
        tp3Result = await sellTokens(position.user_id, position.id, sellPercent, `tp3_${tp3.multiplier}x`);
      } else {
        tp3Result = await sellTokens(position.user_id, position.id, 100, `tp3_${tp3.multiplier}x`);
      }
      await sendTPSLNotification(
        position.user_id, position.token_symbol, "take_profit",
        `TP3 at ${tp3.multiplier}x (sold ${tp3.percentage}%)`, position.entry_amount_sol, tp3Pnl, tp3Result?.txSignature
      );

      db.updatePosition(position.id, { tp3_hit: true });
    }
  }
}

export async function getPositionWithPnL(positionId: number): Promise<Position | null> {
  const position = db.getPosition(positionId);
  if (!position) return null;
  
  await updatePositionPrice(position);
  return db.getPosition(positionId) || null;
}

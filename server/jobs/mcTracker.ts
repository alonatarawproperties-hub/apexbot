import * as db from "../db";
import { getTokensByAddresses } from "../services/dexscreener";
import { recalculateCreatorStats } from "../services/creatorService";
import { logger } from "../utils/logger";
import { getCurrentTimestamp, getMinutesAgo } from "../utils/helpers";
import { config } from "../utils/config";

let intervalId: NodeJS.Timeout | null = null;

export function startMcTracker(): void {
  if (intervalId) {
    clearInterval(intervalId);
  }
  
  intervalId = setInterval(runMcTracking, config.mcTrackerInterval);
  logger.info("MC tracker started (2 min interval)");
  
  setTimeout(runMcTracking, 10000);
}

export function stopMcTracker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info("MC tracker stopped");
  }
}

async function runMcTracking(): Promise<void> {
  try {
    const recentTokens = db.getRecentTokens(24);
    
    if (recentTokens.length === 0) {
      return;
    }
    
    logger.info(`MC tracker: checking ${recentTokens.length} tokens`);
    
    const addresses = recentTokens.map((t) => t.address);
    const tokenInfoMap = await getTokensByAddresses(addresses);
    
    const creatorsToRecalculate = new Set<string>();
    
    for (const token of recentTokens) {
      const info = tokenInfoMap.get(token.address);
      
      if (!info) continue;
      
      // If MC ever hit 69K+, it's bonded (PumpFun bonding threshold)
      // Also trust DexScreener's isBonded flag if true
      const effectivePeakMc = Math.max(info.marketCap, token.peak_mc);
      const isBonded = info.isBonded || effectivePeakMc >= 69000 || token.bonded === 1;
      
      const updates: any = {
        current_mc: info.marketCap,
        bonded: isBonded ? 1 : 0,
      };
      
      if (info.marketCap > token.peak_mc) {
        updates.peak_mc = info.marketCap;
        updates.peak_mc_timestamp = getCurrentTimestamp();
      }
      
      if (token.peak_mc >= 100000 && token.peak_mc_timestamp) {
        const minutesAtPeak = getMinutesAgo(token.peak_mc_timestamp);
        if (info.marketCap >= 100000 && minutesAtPeak > token.peak_mc_held_minutes) {
          updates.peak_mc_held_minutes = minutesAtPeak;
        }
      }
      
      db.updateToken(token.address, updates);
      
      if (info.isBonded !== (token.bonded === 1) || info.marketCap >= 100000) {
        creatorsToRecalculate.add(token.creator_address);
      }
    }
    
    for (const creatorAddress of Array.from(creatorsToRecalculate)) {
      await recalculateCreatorStats(creatorAddress);
    }
    
    logger.info(`MC tracker: updated ${tokenInfoMap.size} tokens, recalculated ${creatorsToRecalculate.size} creators`);
  } catch (error: any) {
    logger.error("MC tracker error", error.message);
  }
}

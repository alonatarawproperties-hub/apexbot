import * as db from "../db";
import { recalculateCreatorStats } from "../services/creatorService";
import { logger } from "../utils/logger";
import { config } from "../utils/config";

let intervalId: NodeJS.Timeout | null = null;

export function startStatsAggregator(): void {
  if (intervalId) {
    clearInterval(intervalId);
  }
  
  intervalId = setInterval(runStatsAggregation, config.statsAggregatorInterval);
  logger.info("Stats aggregator started (30 min interval)");
}

export function stopStatsAggregator(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info("Stats aggregator stopped");
  }
}

async function runStatsAggregation(): Promise<void> {
  try {
    const creators = db.getAllCreators();
    
    logger.info(`Stats aggregator: recalculating ${creators.length} creators`);
    
    for (const creator of creators) {
      await recalculateCreatorStats(creator.address);
    }
    
    logger.info("Stats aggregator: completed");
  } catch (error: any) {
    logger.error("Stats aggregator error", error.message);
  }
}

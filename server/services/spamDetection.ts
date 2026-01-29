import { logger } from "../utils/logger";

export interface SpamCheckResult {
  isSpam: boolean;
  reason?: string;
}

export async function checkIfSpamLauncher(
  creatorAddress: string,
  bondedCount: number,
  hits100kCount: number,
  totalLaunchesInDb: number
): Promise<SpamCheckResult> {
  const successCount = bondedCount + hits100kCount;
  
  if (totalLaunchesInDb < 50) {
    return { isSpam: false };
  }
  
  if (totalLaunchesInDb >= 50 && successCount === 0) {
    return {
      isSpam: true,
      reason: `No successes in ${totalLaunchesInDb} launches`
    };
  }
  
  if (totalLaunchesInDb >= 100 && successCount <= 2) {
    const successRate = (successCount / totalLaunchesInDb) * 100;
    return {
      isSpam: true,
      reason: `Spam launcher: only ${successCount} successes in ${totalLaunchesInDb} launches (${successRate.toFixed(1)}%)`
    };
  }
  
  return { isSpam: false };
}

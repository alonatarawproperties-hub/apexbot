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
  
  if (totalLaunchesInDb <= 5) {
    return { isSpam: false };
  }
  
  const dbSuccessRate = (successCount / totalLaunchesInDb) * 100;
  
  if (dbSuccessRate < 10 && successCount <= 2) {
    return {
      isSpam: true,
      reason: `Low quality: ${successCount} successes in ${totalLaunchesInDb} observed launches (${dbSuccessRate.toFixed(1)}% rate)`
    };
  }
  
  return { isSpam: false };
}

import { logger } from "../utils/logger";
import { getCreatorLaunchCount } from "./creatorLaunchCounter";

export interface CreatorVerification {
  actualLaunches: number | null;
  isSpam: boolean;
  reason?: string;
}

const verificationCache = new Map<string, { data: CreatorVerification; timestamp: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes cache

export async function verifyCreatorNotSpam(
  creatorAddress: string,
  trackedBondedCount: number,
  trackedLaunches: number
): Promise<CreatorVerification> {
  // Check cache first
  const cached = verificationCache.get(creatorAddress);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  // Try to get actual launch count from Helius
  const launchCountResult = await getCreatorLaunchCount(creatorAddress);
  
  // Use actual launches if available, otherwise use tracked
  const launches = launchCountResult.actualLaunches ?? trackedLaunches;
  const hasActualData = launchCountResult.actualLaunches !== null;
  
  let result: CreatorVerification = { isSpam: false, actualLaunches: launches };
  const bondingRate = launches > 0 ? trackedBondedCount / launches : 0;

  // Log if we have actual data
  if (hasActualData && launches !== trackedLaunches) {
    logger.info(`[VERIFICATION] ${creatorAddress.slice(0, 8)}...: Actual=${launches}, Tracked=${trackedLaunches}, Bonded=${trackedBondedCount}`);
  }

  // RULE 1: Bonded token requirements based on launch count
  // Under 5 launches: 1 bonded is OK (new creator)
  // 5+ launches: Must have 2+ bonded tokens
  if (trackedBondedCount < 1) {
    result = {
      isSpam: true,
      actualLaunches: launches,
      reason: `No bonded tokens`,
    };
  } else if (launches >= 5 && trackedBondedCount < 2) {
    result = {
      isSpam: true,
      actualLaunches: launches,
      reason: `Only ${trackedBondedCount} bonded in ${launches} launches - need 2+`,
    };
  }
  
  // RULE 2: If they have 5+ launches, need 20%+ bonding rate
  else if (launches >= 5 && bondingRate < 0.2) {
    result = {
      isSpam: true,
      actualLaunches: launches,
      reason: `Low bonding rate: ${(bondingRate * 100).toFixed(1)}% (${trackedBondedCount}/${launches})`,
    };
  }
  
  // RULE 3: If they have 10+ launches, need 15%+ bonding rate
  else if (launches >= 10 && bondingRate < 0.15) {
    result = {
      isSpam: true,
      actualLaunches: launches,
      reason: `Mass launcher: ${(bondingRate * 100).toFixed(1)}% rate (${trackedBondedCount}/${launches})`,
    };
  }
  
  // RULE 4: 15+ launches need 3+ bonded tokens
  else if (launches >= 15 && trackedBondedCount < 3) {
    result = {
      isSpam: true,
      actualLaunches: launches,
      reason: `High volume: only ${trackedBondedCount} bonded in ${launches} launches`,
    };
  }
  
  // RULE 5: 20+ launches need 4+ bonded tokens
  else if (launches >= 20 && trackedBondedCount < 4) {
    result = {
      isSpam: true,
      actualLaunches: launches,
      reason: `Very high volume: only ${trackedBondedCount} bonded in ${launches} launches`,
    };
  }
  
  // RULE 6: 50+ launches is suspicious regardless - need 5+ bonded
  else if (launches >= 50 && trackedBondedCount < 5) {
    result = {
      isSpam: true,
      actualLaunches: launches,
      reason: `Extreme volume: only ${trackedBondedCount} bonded in ${launches} launches`,
    };
  }
  
  // RULE 7: 100+ launches need 10+ bonded (10% minimum)
  else if (launches >= 100 && trackedBondedCount < 10) {
    result = {
      isSpam: true,
      actualLaunches: launches,
      reason: `Spam territory: only ${trackedBondedCount} bonded in ${launches} launches`,
    };
  }

  if (result.isSpam) {
    logger.info(`[SPAM BLOCKED] ${creatorAddress.slice(0, 8)}...: ${result.reason}`);
  }

  verificationCache.set(creatorAddress, { data: result, timestamp: Date.now() });
  return result;
}

export function clearVerificationCache(): void {
  verificationCache.clear();
}

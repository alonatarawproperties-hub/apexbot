import { logger } from "../utils/logger";

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

  // STRICT LOCAL RULES - Don't rely on external APIs
  // These rules assume tracked data may be incomplete
  
  let result: CreatorVerification = { isSpam: false, actualLaunches: trackedLaunches };
  const bondingRate = trackedLaunches > 0 ? trackedBondedCount / trackedLaunches : 0;

  // RULE 1: ABSOLUTE MINIMUM - Must have 2+ bonded tokens
  // Single lucky hits are almost always spam
  if (trackedBondedCount < 2) {
    result = {
      isSpam: true,
      actualLaunches: trackedLaunches,
      reason: `Only ${trackedBondedCount} bonded token(s) - minimum 2 required`,
    };
  }
  
  // RULE 2: If they have 5+ tracked launches, need 20%+ bonding rate
  else if (trackedLaunches >= 5 && bondingRate < 0.2) {
    result = {
      isSpam: true,
      actualLaunches: trackedLaunches,
      reason: `Low bonding rate: ${(bondingRate * 100).toFixed(0)}% (${trackedBondedCount}/${trackedLaunches})`,
    };
  }
  
  // RULE 3: If they have 10+ tracked launches, need 15%+ bonding rate
  else if (trackedLaunches >= 10 && bondingRate < 0.15) {
    result = {
      isSpam: true,
      actualLaunches: trackedLaunches,
      reason: `Mass launcher: ${(bondingRate * 100).toFixed(0)}% rate (${trackedBondedCount}/${trackedLaunches})`,
    };
  }
  
  // RULE 4: 15+ launches need 3+ bonded tokens
  else if (trackedLaunches >= 15 && trackedBondedCount < 3) {
    result = {
      isSpam: true,
      actualLaunches: trackedLaunches,
      reason: `High volume: only ${trackedBondedCount} bonded in ${trackedLaunches} launches`,
    };
  }
  
  // RULE 5: 20+ launches need 4+ bonded tokens
  else if (trackedLaunches >= 20 && trackedBondedCount < 4) {
    result = {
      isSpam: true,
      actualLaunches: trackedLaunches,
      reason: `Very high volume: only ${trackedBondedCount} bonded in ${trackedLaunches} launches`,
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

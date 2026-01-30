import { logger } from "../utils/logger";

export interface SpamCheckResult {
  isSpam: boolean;
  reason?: string;
}

export async function checkIfSpamLauncher(
  creatorAddress: string,
  bondedCount: number,
  hits100kCount: number,
  totalLaunches: number
): Promise<SpamCheckResult> {
  if (totalLaunches <= 0) {
    return { isSpam: false };
  }
  
  const bondingRate = (bondedCount / totalLaunches) * 100;
  
  // Rule 1: 20+ launches with 0 bonds = spam
  if (totalLaunches >= 20 && bondedCount === 0) {
    return {
      isSpam: true,
      reason: `0 bonds in ${totalLaunches} launches`
    };
  }
  
  // Rule 2: 10+ launches requires at least 5% bonding rate
  if (totalLaunches >= 10 && bondingRate < 5) {
    return {
      isSpam: true,
      reason: `Only ${bondingRate.toFixed(1)}% bonding rate (${bondedCount}/${totalLaunches})`
    };
  }
  
  // Rule 3: 50+ launches requires at least 3% bonding rate
  if (totalLaunches >= 50 && bondingRate < 3) {
    return {
      isSpam: true,
      reason: `High volume spam: ${bondingRate.toFixed(1)}% rate (${bondedCount}/${totalLaunches})`
    };
  }
  
  // Rule 4: 100+ launches requires at least 2% bonding rate
  if (totalLaunches >= 100 && bondingRate < 2) {
    return {
      isSpam: true,
      reason: `Mass spam: ${bondingRate.toFixed(1)}% rate (${bondedCount}/${totalLaunches})`
    };
  }
  
  // Rule 5: 500+ launches with less than 1% = definitely spam
  if (totalLaunches >= 500 && bondingRate < 1) {
    return {
      isSpam: true,
      reason: `Extreme spam: ${bondingRate.toFixed(1)}% rate (${bondedCount}/${totalLaunches})`
    };
  }
  
  return { isSpam: false };
}

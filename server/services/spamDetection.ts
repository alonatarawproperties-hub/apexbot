import { logger } from "../utils/logger";
import * as db from "../db";

export interface SpamCheckResult {
  isSpam: boolean;
  reason?: string;
}

const recentLaunchCache = new Map<string, { timestamps: number[]; symbols: string[] }>();
const RAPID_LAUNCH_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RAPID_LAUNCHES = 3;

export function trackCreatorLaunch(creatorAddress: string, tokenSymbol: string): void {
  const now = Date.now();
  let entry = recentLaunchCache.get(creatorAddress);
  
  if (!entry) {
    entry = { timestamps: [], symbols: [] };
    recentLaunchCache.set(creatorAddress, entry);
  }
  
  entry.timestamps = entry.timestamps.filter(t => now - t < RAPID_LAUNCH_WINDOW_MS);
  entry.symbols = entry.symbols.slice(-10);
  
  entry.timestamps.push(now);
  entry.symbols.push(tokenSymbol || "");
}

export async function checkIfSpamLauncher(
  creatorAddress: string,
  bondedCount: number,
  hits100kCount: number,
  totalLaunches: number
): Promise<SpamCheckResult> {
  
  // Rule 0: Check for rapid-fire launches (multiple launches in 5 minutes)
  const recentActivity = recentLaunchCache.get(creatorAddress);
  if (recentActivity) {
    const now = Date.now();
    const recentCount = recentActivity.timestamps.filter(t => now - t < RAPID_LAUNCH_WINDOW_MS).length;
    
    if (recentCount >= MAX_RAPID_LAUNCHES) {
      return {
        isSpam: true,
        reason: `Rapid-fire: ${recentCount} launches in 5 min`
      };
    }
    
    // Check for duplicate symbols (same token name spam)
    const recentSymbols = recentActivity.symbols.slice(-5);
    const uniqueSymbols = new Set(recentSymbols.filter(s => s.length > 0));
    if (recentSymbols.length >= 3 && uniqueSymbols.size === 1) {
      return {
        isSpam: true,
        reason: `Duplicate token spam: ${recentSymbols[0]}`
      };
    }
  }
  
  if (totalLaunches <= 0) {
    return { isSpam: false };
  }
  
  const bondingRate = (bondedCount / totalLaunches) * 100;
  
  // Rule 1: 5+ launches with 0 bonds and 0 100k hits = likely spam
  if (totalLaunches >= 5 && bondedCount === 0 && hits100kCount === 0) {
    return {
      isSpam: true,
      reason: `0 success in ${totalLaunches} launches`
    };
  }
  
  // Rule 2: 10+ launches with 0 bonds = spam
  if (totalLaunches >= 10 && bondedCount === 0) {
    return {
      isSpam: true,
      reason: `0 bonds in ${totalLaunches} launches`
    };
  }
  
  // Rule 3: 10+ launches requires at least 10% bonding rate (was 5%)
  if (totalLaunches >= 10 && bondingRate < 10) {
    return {
      isSpam: true,
      reason: `Only ${bondingRate.toFixed(1)}% bonding rate (${bondedCount}/${totalLaunches})`
    };
  }
  
  // Rule 4: 20+ launches requires at least 5% bonding rate
  if (totalLaunches >= 20 && bondingRate < 5) {
    return {
      isSpam: true,
      reason: `Low volume spam: ${bondingRate.toFixed(1)}% rate (${bondedCount}/${totalLaunches})`
    };
  }
  
  // Rule 5: 50+ launches requires at least 3% bonding rate
  if (totalLaunches >= 50 && bondingRate < 3) {
    return {
      isSpam: true,
      reason: `High volume spam: ${bondingRate.toFixed(1)}% rate (${bondedCount}/${totalLaunches})`
    };
  }
  
  // Rule 6: 100+ launches requires at least 2% bonding rate
  if (totalLaunches >= 100 && bondingRate < 2) {
    return {
      isSpam: true,
      reason: `Mass spam: ${bondingRate.toFixed(1)}% rate (${bondedCount}/${totalLaunches})`
    };
  }
  
  return { isSpam: false };
}

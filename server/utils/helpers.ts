import bs58 from "bs58";

export function isValidSolanaAddress(address: string): boolean {
  try {
    if (!address || address.length < 32 || address.length > 44) {
      return false;
    }
    const decoded = bs58.decode(address);
    return decoded.length === 32;
  } catch {
    return false;
  }
}

export function formatAddress(address: string, chars: number = 4): string {
  if (!address || address.length < chars * 2) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

export function formatMarketCap(mc: number): string {
  if (mc >= 1_000_000) {
    return `$${(mc / 1_000_000).toFixed(2)}M`;
  } else if (mc >= 1_000) {
    return `$${(mc / 1_000).toFixed(1)}K`;
  }
  return `$${mc.toFixed(0)}`;
}

export function formatPercentage(value: number, total: number): string {
  if (total === 0) return "0%";
  return `${((value / total) * 100).toFixed(0)}%`;
}

export function getPumpFunUrl(tokenAddress: string): string {
  return `https://pump.fun/${tokenAddress}`;
}

export function getPumpFunProfileUrl(creatorAddress: string): string {
  return `https://pump.fun/profile/${creatorAddress}`;
}

export function getDexScreenerUrl(tokenAddress: string): string {
  return `https://dexscreener.com/solana/${tokenAddress}`;
}

export function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

export function getCurrentTimestamp(): string {
  return new Date().toISOString();
}

export function getMinutesAgo(timestamp: string): number {
  const then = new Date(timestamp).getTime();
  const now = Date.now();
  return Math.floor((now - then) / (1000 * 60));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

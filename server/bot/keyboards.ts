import type { InlineKeyboard } from "grammy";
import { getPumpFunUrl, getDexScreenerUrl } from "../utils/helpers";
import type { UserSettings } from "@shared/schema";

export function getStartKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "⚙️ Settings", callback_data: "apex:settings:show" },
        { text: "📖 Help", callback_data: "apex:help:show" },
      ],
      [
        { text: "🎯 Sniper", callback_data: "sniper:back" },
      ],
    ],
  };
}

export function getHelpKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "⚙️ Settings", callback_data: "apex:settings:show" },
        { text: "🏠 Home", callback_data: "apex:start:show" },
      ],
    ],
  };
}

export function getSettingsKeyboard(settings: UserSettings) {
  const watchedOnlyText = settings.alert_watched_only ? "Watched Only: ON" : "Watched Only: OFF";
  const alertsText = settings.notifications_enabled ? "Alerts: ON" : "Alerts: OFF";
  
  return {
    inline_keyboard: [
      [
        { text: "−", callback_data: "apex:min_bonded:dec" },
        { text: `Min Bonded: ${settings.min_bonded_count}`, callback_data: "apex:noop" },
        { text: "+", callback_data: "apex:min_bonded:inc" },
      ],
      [
        { text: "−", callback_data: "apex:min_100k:dec" },
        { text: `Min 100k Hits: ${settings.min_100k_count}`, callback_data: "apex:noop" },
        { text: "+", callback_data: "apex:min_100k:inc" },
      ],
      [
        { text: "−", callback_data: "apex:mc_hold:dec" },
        { text: `Hold Minutes: ${settings.mc_hold_minutes}`, callback_data: "apex:noop" },
        { text: "+", callback_data: "apex:mc_hold:inc" },
      ],
      [
        { text: "−", callback_data: "apex:lookback:dec" },
        { text: `Lookback Days: ${settings.lookback_days}`, callback_data: "apex:noop" },
        { text: "+", callback_data: "apex:lookback:inc" },
      ],
      [
        { text: watchedOnlyText, callback_data: "apex:watched_only:toggle" },
        { text: alertsText, callback_data: "apex:alerts:toggle" },
      ],
      [
        { text: "↺ Reset Defaults", callback_data: "apex:settings:reset" },
      ],
    ],
  };
}

export function getStatsKeyboard(creatorAddress: string, isWatched: boolean) {
  const watchButton = isWatched
    ? { text: "❌ Unwatch", callback_data: `apex:unwatch:${creatorAddress}` }
    : { text: "⭐ Watch", callback_data: `apex:watch:${creatorAddress}` };
  
  return {
    inline_keyboard: [
      [
        watchButton,
        { text: "🔍 View Tokens", callback_data: `apex:tokens:${creatorAddress}` },
      ],
    ],
  };
}

export function getWatchlistKeyboard(creatorAddress: string) {
  return {
    inline_keyboard: [
      [
        { text: "📊 Stats", callback_data: `apex:stats:${creatorAddress}` },
        { text: "❌ Remove", callback_data: `apex:unwatch:${creatorAddress}` },
      ],
    ],
  };
}

export function getAlertKeyboard(creatorAddress: string, tokenAddress: string) {
  return {
    inline_keyboard: [
      [
        { text: "⭐ Watch Creator", callback_data: `apex:watch:${creatorAddress}` },
        { text: "📊 Full Stats", callback_data: `apex:stats:${creatorAddress}` },
      ],
      [
        { text: "🔗 PumpFun", url: getPumpFunUrl(tokenAddress) },
        { text: "📈 DexScreener", url: getDexScreenerUrl(tokenAddress) },
      ],
    ],
  };
}

export function getBackToWatchlistKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "← Back to Watchlist", callback_data: "apex:watchlist:show" }],
    ],
  };
}

export function getTokensKeyboard(creatorAddress: string, tokens: { address: string; symbol: string | null }[]) {
  const tokenButtons = tokens.slice(0, 5).map((token) => [
    { text: `$${token.symbol || "???"}`, url: getPumpFunUrl(token.address) },
    { text: "📈", url: getDexScreenerUrl(token.address) },
  ]);
  
  return {
    inline_keyboard: [
      ...tokenButtons,
      [{ text: "← Back to Stats", callback_data: `apex:stats:${creatorAddress}` }],
    ],
  };
}

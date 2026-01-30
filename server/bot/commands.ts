import { Bot, Context } from "grammy";
import * as db from "../db";
import { getCreatorStats, ensureCreatorExists, recalculateCreatorStats } from "../services/creatorService";
import { logger } from "../utils/logger";
import { isValidSolanaAddress, formatAddress, formatMarketCap, formatPercentage, escapeMarkdown, getPumpFunUrl, getDexScreenerUrl } from "../utils/helpers";
import { getStartKeyboard, getHelpKeyboard, getSettingsKeyboard, getBundleSettingsKeyboard, getStatsKeyboard, getWatchlistKeyboard, getBackToWatchlistKeyboard, getTokensKeyboard } from "./keyboards";
import { importHistoricalCreators } from "../services/historicalImport";
import { runCreatorBackfill, getBackfillProgress } from "../services/heliusBackfill";
import { registerSniperCommands, handleSniperCallback, handlePrivateKeyImport, hasPendingInput, handleCustomInput } from "./sniperCommands";
import type { UserSettings } from "@shared/schema";

const DEFAULT_SETTINGS: UserSettings = {
  min_bonded_count: 1,
  min_100k_count: 1,
  mc_hold_minutes: 5,
  lookback_days: 90,
  alert_watched_only: false,
  notifications_enabled: true,
  min_success_rate: 5,
  max_launches: 500,
  // Bundle detection defaults
  bundle_alerts_enabled: true,
  bundle_min_sol: 2,
  bundle_max_sol: 200,
  bundle_auto_snipe: false,
  bundle_buy_amount_sol: 0.1,
};

const ADMIN_USER_IDS = ["7463078053", "8322709778"];

export function registerCommands(bot: Bot): void {
  bot.command("start", handleStart);
  bot.command("help", handleHelp);
  bot.command("stats", handleStats);
  bot.command("watch", handleWatch);
  bot.command("unwatch", handleUnwatch);
  bot.command("watchlist", handleWatchlist);
  bot.command("settings", handleSettings);
  bot.command("recent", handleRecent);
  bot.command("import", handleImport);
  bot.command("importdune", handleDuneImport);
  bot.command("backfill", handleBackfill);
  bot.command("backfillstatus", handleBackfillStatus);
  
  registerSniperCommands(bot);
  
  bot.on("callback_query:data", handleCallback);
  
  bot.on("message:text", async (ctx) => {
    const text = ctx.message?.text || "";
    const userId = ctx.from?.id.toString();
    
    // Check for pending custom input first
    if (userId && hasPendingInput(userId)) {
      await handleCustomInput(ctx, text);
      return;
    }
    
    // Check for private key import
    if (text.startsWith("[") || text.length === 88 || text.length === 128) {
      await handlePrivateKeyImport(ctx, text);
    }
  });
}

async function handleImport(ctx: Context): Promise<void> {
  const userId = ctx.from?.id.toString();
  logger.info(`Import command from user: ${userId}`);
  
  if (!userId || !ADMIN_USER_IDS.includes(userId)) {
    await ctx.reply(`This command is only available to admins. Your ID: ${userId}`);
    return;
  }

  const { getImportProgress, importFromHelius } = await import("../services/heliusHistoricalImport");
  
  const currentProgress = getImportProgress();
  if (currentProgress.isRunning) {
    await ctx.reply(
      `Import already running:\n` +
      `- Found: ${currentProgress.totalFound}\n` +
      `- Verified: ${currentProgress.verified}\n` +
      `- Imported: ${currentProgress.imported}\n` +
      `- Spam blocked: ${currentProgress.spam}`
    );
    return;
  }

  await ctx.reply("Starting Helius historical import... This may take 5-10 minutes. I'll update you on progress.");
  
  const updateInterval = setInterval(async () => {
    const progress = getImportProgress();
    if (!progress.isRunning) {
      clearInterval(updateInterval);
      return;
    }
    try {
      await ctx.reply(
        `Import progress:\n` +
        `- Found: ${progress.totalFound} creators\n` +
        `- Verified: ${progress.verified}\n` +
        `- Imported: ${progress.imported}\n` +
        `- Spam: ${progress.spam}`
      );
    } catch {}
  }, 60000);
  
  try {
    const stats = await importFromHelius(200);
    clearInterval(updateInterval);
    
    await ctx.reply(
      `Historical import complete:\n` +
      `- Creators found: ${stats.totalFound}\n` +
      `- Verified: ${stats.verified}\n` +
      `- Imported: ${stats.imported}\n` +
      `- Spam blocked: ${stats.spam}\n` +
      `- Errors: ${stats.errors}`
    );
  } catch (error: any) {
    clearInterval(updateInterval);
    await ctx.reply(`Import failed: ${error.message}`);
    logger.error("Historical import failed:", error.message);
  }
}

async function handleDuneImport(ctx: Context): Promise<void> {
  const userId = ctx.from?.id.toString();
  logger.info(`Dune import command from user: ${userId}`);
  
  if (!userId || !ADMIN_USER_IDS.includes(userId)) {
    await ctx.reply(`This command is only available to admins. Your ID: ${userId}`);
    return;
  }

  if (!process.env.DUNE_API_KEY) {
    await ctx.reply(
      `DUNE_API_KEY not configured.\n\n` +
      `To use Dune Analytics for 3-month historical data:\n` +
      `1. Sign up at dune.com\n` +
      `2. Go to Settings > API Keys\n` +
      `3. Generate a key and add DUNE_API_KEY to secrets`
    );
    return;
  }

  const { getDuneImportProgress, importFromDune } = await import("../services/duneHistoricalImport");
  
  const currentProgress = getDuneImportProgress();
  if (currentProgress.isRunning) {
    await ctx.reply(
      `Dune import already running:\n` +
      `- Found: ${currentProgress.totalFound}\n` +
      `- Verified: ${currentProgress.verified}\n` +
      `- Imported: ${currentProgress.imported}\n` +
      `- Spam blocked: ${currentProgress.spam}`
    );
    return;
  }

  await ctx.reply("Starting Dune 3-month historical import... This may take 5-10 minutes. I'll update you on progress.");
  
  const updateInterval = setInterval(async () => {
    const progress = getDuneImportProgress();
    if (!progress.isRunning) {
      clearInterval(updateInterval);
      return;
    }
    try {
      await ctx.reply(
        `Dune import progress:\n` +
        `- Found: ${progress.totalFound} creators\n` +
        `- Verified: ${progress.verified}\n` +
        `- Imported: ${progress.imported}\n` +
        `- Spam: ${progress.spam}`
      );
    } catch {}
  }, 60000);
  
  try {
    const stats = await importFromDune(3, 500);
    clearInterval(updateInterval);
    
    await ctx.reply(
      `Dune 3-month import complete:\n` +
      `- Creators found: ${stats.totalFound}\n` +
      `- Verified: ${stats.verified}\n` +
      `- Imported: ${stats.imported}\n` +
      `- Spam blocked: ${stats.spam}\n` +
      `- Errors: ${stats.errors}`
    );
  } catch (error: any) {
    clearInterval(updateInterval);
    await ctx.reply(`Dune import failed: ${error.message}`);
    logger.error("Dune import failed:", error.message);
  }
}

async function handleBackfill(ctx: Context): Promise<void> {
  const userId = ctx.from?.id.toString();
  logger.info(`Backfill command from user: ${userId}`);
  
  if (!userId || !ADMIN_USER_IDS.includes(userId)) {
    await ctx.reply(`This command is only available to admins. Your ID: ${userId}`);
    return;
  }

  const progress = getBackfillProgress();
  if (progress.isRunning) {
    await ctx.reply(
      `Backfill already in progress:\n` +
      `- Processed: ${progress.processed}/${progress.total}\n` +
      `- Updated: ${progress.updated}\n` +
      `- Spam detected: ${progress.spamDetected}\n` +
      `- ETA: ${progress.estimatedTimeRemaining}`
    );
    return;
  }

  await ctx.reply(
    `Starting creator backfill using Helius API...\n\n` +
    `This will index launch history for all qualified creators.\n` +
    `Use /backfillstatus to check progress.\n\n` +
    `Estimated time: ~30-60 minutes for 20K creators.`
  );
  
  runCreatorBackfill().then(async (stats) => {
    try {
      await ctx.reply(
        `Backfill complete!\n\n` +
        `- Processed: ${stats.processed}/${stats.total}\n` +
        `- Updated: ${stats.updated} creators\n` +
        `- Spam detected: ${stats.spamDetected}\n` +
        `- Errors: ${stats.errors}`
      );
    } catch (e) {
      logger.error("Failed to send backfill completion message");
    }
  }).catch((error: any) => {
    logger.error("Backfill failed:", error.message);
  });
}

async function handleBackfillStatus(ctx: Context): Promise<void> {
  const userId = ctx.from?.id.toString();
  
  if (!userId || !ADMIN_USER_IDS.includes(userId)) {
    await ctx.reply(`This command is only available to admins.`);
    return;
  }

  const progress = getBackfillProgress();
  
  if (!progress.isRunning && progress.processed === 0) {
    await ctx.reply(`No backfill has been started. Use /backfill to start.`);
    return;
  }

  const status = progress.isRunning ? "Running" : "Complete";
  const elapsed = progress.startTime 
    ? Math.round((Date.now() - progress.startTime) / 60000) 
    : 0;
  
  await ctx.reply(
    `Backfill Status: ${status}\n\n` +
    `- Progress: ${progress.processed}/${progress.total} (${((progress.processed/progress.total)*100).toFixed(1)}%)\n` +
    `- Updated: ${progress.updated} creators\n` +
    `- Spam detected: ${progress.spamDetected}\n` +
    `- Errors: ${progress.errors}\n` +
    `- Elapsed: ${elapsed} minutes\n` +
    `- ETA: ${progress.estimatedTimeRemaining}`
  );
}

async function ensureUser(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  
  let user = db.getUser(telegramId);
  if (!user) {
    db.createUser({
      telegram_id: telegramId,
      username: ctx.from?.username || null,
      tier: "free",
      settings: DEFAULT_SETTINGS,
      alerts_today: 0,
      last_alert_reset: null,
    });
  }
}

async function handleStart(ctx: Context): Promise<void> {
  await ensureUser(ctx);
  
  const message = `🔺 *Welcome to Apex*

Your edge in tracking successful PumpFun creators\\.

Apex monitors new token launches and alerts you when proven creators deploy new tokens\\.

*Quick Start:*
1\\. Configure your thresholds with /settings
2\\. Watch specific creators with /watch \\<address\\>
3\\. Check any creator with /stats \\<address\\>`;
  
  await ctx.reply(message, {
    parse_mode: "MarkdownV2",
    reply_markup: getStartKeyboard(),
  });
}

async function handleHelp(ctx: Context): Promise<void> {
  await ensureUser(ctx);
  
  const message = `🔺 *Apex Commands*

/start \\- Welcome & quick setup
/stats \\<address\\> \\- Creator statistics
/watch \\<address\\> \\- Add to watchlist
/unwatch \\<address\\> \\- Remove from watchlist
/watchlist \\- View watched creators
/settings \\- Configure thresholds
/recent \\- Recent alerts

*How Apex Works:*
Apex tracks PumpFun creators who have proven success \\(bonded tokens or 100k\\+ MC\\)\\. When they launch again, you get instant alerts\\.

*Tips:*
• Lower thresholds \\= more alerts
• Use watchlist for high\\-conviction creators
• Check /stats before watching`;
  
  await ctx.reply(message, {
    parse_mode: "MarkdownV2",
    reply_markup: getHelpKeyboard(),
  });
}

async function handleStats(ctx: Context): Promise<void> {
  await ensureUser(ctx);
  
  const text = ctx.message?.text || "";
  const parts = text.split(" ");
  
  if (parts.length < 2) {
    await ctx.reply("Usage: /stats \\<creator\\_address\\>", { parse_mode: "MarkdownV2" });
    return;
  }
  
  const address = parts[1].trim();
  
  if (!isValidSolanaAddress(address)) {
    await ctx.reply("Invalid Solana address\\. Please provide a valid creator address\\.", { parse_mode: "MarkdownV2" });
    return;
  }
  
  await ctx.reply("🔍 Fetching creator stats\\.\\.\\.", { parse_mode: "MarkdownV2" });
  
  await ensureCreatorExists(address);
  await recalculateCreatorStats(address);
  
  const stats = getCreatorStats(address);
  
  if (!stats) {
    await ctx.reply("Creator not found or no data available\\.", { parse_mode: "MarkdownV2" });
    return;
  }
  
  const isWatched = db.isOnWatchlist(ctx.from!.id.toString(), address);
  const qualifiedText = stats.is_qualified ? "✅ Qualified" : "❌ Not Qualified";
  
  const message = `📊 *Creator Stats*

*Address:* \`${address}\`
*Status:* ${qualifiedText}${stats.qualification_reason ? ` \\(${escapeMarkdown(stats.qualification_reason)}\\)` : ""}

📈 *Performance:*
├ Total Launches: ${stats.total_launches}
├ Bonded: ${stats.bonded_count} \\(${stats.bonded_rate.toFixed(0)}%\\)
├ 100k\\+ MC: ${stats.hits_100k_count} \\(${stats.hits_100k_rate.toFixed(0)}%\\)
└ Best MC: ${formatMarketCap(stats.best_mc_ever)}`;
  
  await ctx.reply(message, {
    parse_mode: "MarkdownV2",
    reply_markup: getStatsKeyboard(address, isWatched),
  });
}

async function handleWatch(ctx: Context): Promise<void> {
  await ensureUser(ctx);
  
  const text = ctx.message?.text || "";
  const parts = text.split(" ");
  
  if (parts.length < 2) {
    await ctx.reply("Usage: /watch \\<creator\\_address\\>", { parse_mode: "MarkdownV2" });
    return;
  }
  
  const address = parts[1].trim();
  
  if (!isValidSolanaAddress(address)) {
    await ctx.reply("Invalid Solana address\\.", { parse_mode: "MarkdownV2" });
    return;
  }
  
  const userId = ctx.from!.id.toString();
  
  if (db.isOnWatchlist(userId, address)) {
    await ctx.reply("This creator is already on your watchlist\\.", { parse_mode: "MarkdownV2" });
    return;
  }
  
  await ensureCreatorExists(address);
  
  const entry = db.addToWatchlist({
    user_id: userId,
    creator_address: address,
    notes: null,
  });
  
  if (entry) {
    const stats = getCreatorStats(address);
    const statsInfo = stats 
      ? `\\(${stats.total_launches} launches, ${stats.bonded_count} bonded\\)`
      : "";
    
    await ctx.reply(`⭐ Added creator to watchlist ${statsInfo}\n\n\`${address}\``, {
      parse_mode: "MarkdownV2",
    });
  } else {
    await ctx.reply("Failed to add creator to watchlist\\.", { parse_mode: "MarkdownV2" });
  }
}

async function handleUnwatch(ctx: Context): Promise<void> {
  await ensureUser(ctx);
  
  const text = ctx.message?.text || "";
  const parts = text.split(" ");
  
  if (parts.length < 2) {
    await ctx.reply("Usage: /unwatch \\<creator\\_address\\>", { parse_mode: "MarkdownV2" });
    return;
  }
  
  const address = parts[1].trim();
  const userId = ctx.from!.id.toString();
  
  const removed = db.removeFromWatchlist(userId, address);
  
  if (removed) {
    await ctx.reply(`❌ Removed creator from watchlist\n\n\`${address}\``, {
      parse_mode: "MarkdownV2",
    });
  } else {
    await ctx.reply("Creator was not on your watchlist\\.", { parse_mode: "MarkdownV2" });
  }
}

async function handleWatchlist(ctx: Context): Promise<void> {
  await ensureUser(ctx);
  
  const userId = ctx.from!.id.toString();
  const watchlist = db.getUserWatchlist(userId);
  
  if (watchlist.length === 0) {
    await ctx.reply("Your watchlist is empty\\.\n\nUse /watch \\<address\\> to add creators\\.", {
      parse_mode: "MarkdownV2",
    });
    return;
  }
  
  let message = `📋 *Your Watchlist* \\(${watchlist.length} creators\\)\n\n`;
  
  for (const entry of watchlist) {
    const stats = getCreatorStats(entry.creator_address);
    const statsInfo = stats 
      ? `${stats.total_launches}L / ${stats.bonded_count}B / ${stats.hits_100k_count}H`
      : "No data";
    
    message += `• \`${formatAddress(entry.creator_address, 6)}\` \\- ${statsInfo}\n`;
  }
  
  message += `\nTap a creator below for details:`;
  
  const keyboard = {
    inline_keyboard: watchlist.slice(0, 5).map((entry) => [
      { text: formatAddress(entry.creator_address, 6), callback_data: `apex:stats:${entry.creator_address}` },
      { text: "❌", callback_data: `apex:unwatch:${entry.creator_address}` },
    ]),
  };
  
  await ctx.reply(message, {
    parse_mode: "MarkdownV2",
    reply_markup: keyboard,
  });
}

async function handleSettings(ctx: Context): Promise<void> {
  await ensureUser(ctx);
  
  const userId = ctx.from!.id.toString();
  const user = db.getUser(userId);
  
  if (!user) return;
  
  const message = `🔺 *Apex Settings*

Configure your alert thresholds below\\.
Lower values \\= more alerts\\.`;
  
  await ctx.reply(message, {
    parse_mode: "MarkdownV2",
    reply_markup: getSettingsKeyboard(user.settings),
  });
}

async function handleRecent(ctx: Context): Promise<void> {
  await ensureUser(ctx);
  
  const userId = ctx.from!.id.toString();
  const alerts = db.getRecentAlerts(userId, 10);
  
  if (alerts.length === 0) {
    await ctx.reply("No recent alerts\\.", { parse_mode: "MarkdownV2" });
    return;
  }
  
  let message = `📬 *Recent Alerts*\n\n`;
  
  for (const alert of alerts) {
    const tokenAddr = formatAddress(alert.token_address, 4);
    const creatorAddr = formatAddress(alert.creator_address, 4);
    const time = new Date(alert.sent_at).toLocaleString();
    const icon = alert.alert_type === "watched" ? "⭐" : "🔺";
    
    message += `${icon} \`${tokenAddr}\` from \`${creatorAddr}\`\n   ${escapeMarkdown(time)}\n\n`;
  }
  
  await ctx.reply(message, { parse_mode: "MarkdownV2" });
}

async function handleCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;
  
  await ensureUser(ctx);
  
  const parts = data.split(":");
  const prefix = parts[0];
  const action = parts[1];
  const value = parts.slice(2).join(":");
  
  if (prefix === "sniper") {
    await handleSniperCallback(ctx, action, value);
    return;
  }
  
  if (prefix !== "apex") return;
  
  const userId = ctx.from!.id.toString();
  const user = db.getUser(userId);
  
  if (!user) {
    await ctx.answerCallbackQuery("User not found");
    return;
  }
  
  try {
    switch (action) {
      case "noop":
        await ctx.answerCallbackQuery();
        break;
        
      case "settings":
        if (value === "show") {
          await ctx.editMessageText(`🔺 *Apex Settings*\n\nConfigure your alert thresholds below\\.\nLower values \\= more alerts\\.`, {
            parse_mode: "MarkdownV2",
            reply_markup: getSettingsKeyboard(user.settings),
          });
        } else if (value === "reset") {
          db.updateUserSettings(userId, DEFAULT_SETTINGS);
          await ctx.editMessageReplyMarkup({ reply_markup: getSettingsKeyboard(DEFAULT_SETTINGS) });
          await ctx.answerCallbackQuery("Settings reset to defaults");
        }
        break;
        
      case "help":
        if (value === "show") {
          try {
            await ctx.editMessageText(`🔺 *Apex Commands*\n\n/start \\- Welcome & quick setup\n/stats \\<address\\> \\- Creator statistics\n/watch \\<address\\> \\- Add to watchlist\n/unwatch \\<address\\> \\- Remove from watchlist\n/watchlist \\- View watched creators\n/settings \\- Configure thresholds\n/recent \\- Recent alerts\n\n*How Apex Works:*\nApex tracks PumpFun creators who have proven success \\(bonded tokens or 100k\\+ MC\\)\\. When they launch again, you get instant alerts\\.\n\n*Tips:*\n• Lower thresholds \\= more alerts\n• Use watchlist for high\\-conviction creators\n• Check /stats before watching`, {
              parse_mode: "MarkdownV2",
              reply_markup: getHelpKeyboard(),
            });
          } catch { await handleHelp(ctx); }
        }
        await ctx.answerCallbackQuery();
        break;

      case "start":
        if (value === "show") {
          try {
            await ctx.editMessageText(`🔺 *Welcome to Apex*\n\nYour edge in tracking successful PumpFun creators\\.\n\nApex monitors new token launches and alerts you when proven creators deploy new tokens\\.\n\n*Quick Start:*\n1\\. Configure your thresholds with /settings\n2\\. Watch specific creators with /watch \\<address\\>\n3\\. Check any creator with /stats \\<address\\>`, {
              parse_mode: "MarkdownV2",
              reply_markup: getStartKeyboard(),
            });
          } catch { await handleStart(ctx); }
        }
        await ctx.answerCallbackQuery();
        break;
        
      case "min_bonded":
        await handleSettingChange(ctx, user, "min_bonded_count", value);
        break;
        
      case "min_100k":
        await handleSettingChange(ctx, user, "min_100k_count", value);
        break;
        
      case "mc_hold":
        await handleSettingChange(ctx, user, "mc_hold_minutes", value);
        break;
        
      case "lookback":
        await handleSettingChange(ctx, user, "lookback_days", value);
        break;
        
      case "watched_only":
        const newWatchedOnly = !user.settings.alert_watched_only;
        const updatedSettings1 = { ...user.settings, alert_watched_only: newWatchedOnly };
        db.updateUserSettings(userId, updatedSettings1);
        await ctx.editMessageReplyMarkup({ reply_markup: getSettingsKeyboard(updatedSettings1) });
        await ctx.answerCallbackQuery(`Watched only: ${newWatchedOnly ? "ON" : "OFF"}`);
        break;
        
      case "alerts":
        const newAlerts = !user.settings.notifications_enabled;
        const updatedSettings2 = { ...user.settings, notifications_enabled: newAlerts };
        db.updateUserSettings(userId, updatedSettings2);
        await ctx.editMessageReplyMarkup({ reply_markup: getSettingsKeyboard(updatedSettings2) });
        await ctx.answerCallbackQuery(`Alerts: ${newAlerts ? "ON" : "OFF"}`);
        break;
        
      case "bundle":
        if (value === "show") {
          const bundleMsg = `🎯 *Bundle Detection Settings*\n\nGet alerts when creators buy significant amounts at token launch\\.\n\n*Current Settings:*\n• Min SOL: ${user.settings.bundle_min_sol ?? 2}\n• Max SOL: ${user.settings.bundle_max_sol ?? 200}\n• Auto\\-Snipe: ${user.settings.bundle_auto_snipe ? "ON" : "OFF"}`;
          await ctx.editMessageText(bundleMsg, {
            parse_mode: "MarkdownV2",
            reply_markup: getBundleSettingsKeyboard(user.settings),
          });
        }
        await ctx.answerCallbackQuery();
        break;
        
      case "bundle_alerts":
        const newBundleAlerts = !user.settings.bundle_alerts_enabled;
        const bundleSettings1 = { ...user.settings, bundle_alerts_enabled: newBundleAlerts };
        db.updateUserSettings(userId, bundleSettings1);
        await ctx.editMessageReplyMarkup({ reply_markup: getBundleSettingsKeyboard(bundleSettings1) });
        await ctx.answerCallbackQuery(`Bundle Alerts: ${newBundleAlerts ? "ON" : "OFF"}`);
        break;
        
      case "bundle_snipe":
        const newBundleSnipe = !user.settings.bundle_auto_snipe;
        const bundleSettings2 = { ...user.settings, bundle_auto_snipe: newBundleSnipe };
        db.updateUserSettings(userId, bundleSettings2);
        await ctx.editMessageReplyMarkup({ reply_markup: getBundleSettingsKeyboard(bundleSettings2) });
        await ctx.answerCallbackQuery(`Bundle Auto-Snipe: ${newBundleSnipe ? "ON" : "OFF"}`);
        break;
        
      case "bundle_min":
        await handleBundleSettingChange(ctx, user, "bundle_min_sol", value);
        break;
        
      case "bundle_max":
        await handleBundleSettingChange(ctx, user, "bundle_max_sol", value);
        break;
        
      case "bundle_buy":
        await handleBundleSettingChange(ctx, user, "bundle_buy_amount_sol", value);
        break;
        
      case "watch":
        if (!db.isOnWatchlist(userId, value)) {
          await ensureCreatorExists(value);
          db.addToWatchlist({ user_id: userId, creator_address: value, notes: null });
          await ctx.answerCallbackQuery("Creator added to watchlist!");
        } else {
          await ctx.answerCallbackQuery("Already on watchlist");
        }
        break;
        
      case "unwatch":
        db.removeFromWatchlist(userId, value);
        await ctx.answerCallbackQuery("Creator removed from watchlist");
        break;
        
      case "stats":
        await ensureCreatorExists(value);
        await recalculateCreatorStats(value);
        const stats = getCreatorStats(value);
        if (stats) {
          const isWatched = db.isOnWatchlist(userId, value);
          const qualifiedText = stats.is_qualified ? "✅ Qualified" : "❌ Not Qualified";
          
          const message = `📊 *Creator Stats*\n\n*Address:* \`${value}\`\n*Status:* ${qualifiedText}${stats.qualification_reason ? ` \\(${escapeMarkdown(stats.qualification_reason)}\\)` : ""}\n\n📈 *Performance:*\n├ Total Launches: ${stats.total_launches}\n├ Bonded: ${stats.bonded_count} \\(${stats.bonded_rate.toFixed(0)}%\\)\n├ 100k\\+ MC: ${stats.hits_100k_count} \\(${stats.hits_100k_rate.toFixed(0)}%\\)\n└ Best MC: ${formatMarketCap(stats.best_mc_ever)}`;
          
          await ctx.editMessageText(message, {
            parse_mode: "MarkdownV2",
            reply_markup: getStatsKeyboard(value, isWatched),
          });
        }
        await ctx.answerCallbackQuery();
        break;
        
      case "tokens":
        const tokens = db.getTokensByCreator(value);
        if (tokens.length === 0) {
          await ctx.answerCallbackQuery("No tokens found");
        } else {
          let tokensMsg = `🪙 *Recent Tokens*\n\nCreator: \`${formatAddress(value, 6)}\`\n\n`;
          for (const token of tokens.slice(0, 5)) {
            tokensMsg += `• $${escapeMarkdown(token.symbol || "???")} \\- ${formatMarketCap(token.peak_mc)}\n`;
          }
          
          await ctx.editMessageText(tokensMsg, {
            parse_mode: "MarkdownV2",
            reply_markup: getTokensKeyboard(value, tokens),
          });
          await ctx.answerCallbackQuery();
        }
        break;
        
      case "watchlist":
        if (value === "show") {
          await handleWatchlist(ctx);
        }
        await ctx.answerCallbackQuery();
        break;
        
      default:
        await ctx.answerCallbackQuery();
    }
  } catch (error: any) {
    logger.error("Callback error", error.message);
    await ctx.answerCallbackQuery("An error occurred");
  }
}

async function handleSettingChange(
  ctx: Context,
  user: NonNullable<ReturnType<typeof db.getUser>>,
  field: keyof UserSettings,
  direction: string
): Promise<void> {
  const userId = ctx.from!.id.toString();
  const settings = { ...user.settings };
  const current = settings[field] as number;
  
  let newValue: number;
  if (direction === "inc") {
    newValue = field === "lookback_days" ? current + 30 : current + 1;
  } else {
    newValue = field === "lookback_days" ? Math.max(30, current - 30) : Math.max(1, current - 1);
  }
  
  (settings[field] as number) = newValue;
  db.updateUserSettings(userId, settings);
  
  await ctx.editMessageReplyMarkup({ reply_markup: getSettingsKeyboard(settings) });
  await ctx.answerCallbackQuery(`Updated to ${newValue}`);
}

async function handleBundleSettingChange(
  ctx: Context,
  user: NonNullable<ReturnType<typeof db.getUser>>,
  field: "bundle_min_sol" | "bundle_max_sol" | "bundle_buy_amount_sol",
  direction: string
): Promise<void> {
  const userId = ctx.from!.id.toString();
  const settings = { ...user.settings };
  const defaultValue = field === "bundle_buy_amount_sol" ? 0.1 : (field === "bundle_max_sol" ? 200 : 40);
  const current = settings[field] ?? defaultValue;
  
  let newValue: number;
  if (field === "bundle_buy_amount_sol") {
    if (direction === "inc") {
      newValue = Math.min(10, current + 0.1);
    } else {
      newValue = Math.max(0.01, current - 0.1);
    }
    newValue = Math.round(newValue * 100) / 100;
  } else {
    if (direction === "inc") {
      newValue = current + 10;
    } else {
      newValue = Math.max(10, current - 10);
    }
  }
  
  (settings[field] as number) = newValue;
  db.updateUserSettings(userId, settings);
  
  await ctx.editMessageReplyMarkup({ reply_markup: getBundleSettingsKeyboard(settings) });
  await ctx.answerCallbackQuery(`Updated to ${newValue}`);
}

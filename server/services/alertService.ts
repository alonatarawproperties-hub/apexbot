import { Bot } from "grammy";
import * as db from "../db";
import { logger } from "../utils/logger";
import { formatAddress, formatMarketCap, formatPercentage, getPumpFunUrl, getPumpFunProfileUrl, getDexScreenerUrl, escapeMarkdown } from "../utils/helpers";
import type { Creator, Token, User } from "@shared/schema";
import { checkQualification, getCreatorTier } from "./creatorService";
import { checkIfSpamLauncher } from "./spamDetection";
import { verifyCreatorNotSpam } from "./pumpFunProfileService";
import { snipeToken } from "./sniperService";

let botInstance: Bot | null = null;

export function setBotInstance(bot: Bot): void {
  botInstance = bot;
}

export async function sendNewTokenAlert(creator: Creator, token: Token): Promise<void> {
  if (!botInstance) {
    logger.error("Bot instance not set for alerts");
    return;
  }
  
  // CRITICAL: Verify actual launch count from PumpFun profile before sending alert
  // This catches spam creators who have 100s of launches but we only tracked a few
  const pumpFunVerification = await verifyCreatorNotSpam(
    creator.address,
    creator.bonded_count,
    creator.total_launches
  );
  
  if (pumpFunVerification.isSpam) {
    logger.info(`[SPAM BLOCKED] ${creator.address.slice(0, 8)}: ${pumpFunVerification.reason}`);
    return;
  }

  // Use actual launch count from PumpFun if available
  let actualLaunches = pumpFunVerification.actualLaunches || creator.total_launches;
  
  // Also run local spam detection as backup
  const localSpamCheck = await checkIfSpamLauncher(
    creator.address,
    creator.bonded_count,
    creator.hits_100k_count,
    actualLaunches
  );
  
  if (localSpamCheck.isSpam) {
    logger.info(`[LOCAL SPAM CHECK] ${creator.address.slice(0, 8)}: ${localSpamCheck.reason}`);
    return;
  }
  
  // Update creator with accurate launch count for message formatting
  const updatedCreator = { ...creator, total_launches: actualLaunches };
  
  const usersToAlert: Array<{ user: User; isWatched: boolean }> = [];
  const allUsers = db.getAllUsers();
  
  for (const user of allUsers) {
    if (!user.settings.notifications_enabled) continue;
    
    const isWatched = db.isOnWatchlist(user.telegram_id, updatedCreator.address);
    
    if (user.settings.alert_watched_only) {
      if (isWatched) {
        usersToAlert.push({ user, isWatched: true });
      }
    } else {
      if (isWatched || checkQualification(updatedCreator, user.settings)) {
        usersToAlert.push({ user, isWatched });
      }
    }
  }
  
  for (const { user, isWatched } of usersToAlert) {
    try {
      const message = formatAlertMessage(updatedCreator, token, isWatched);
      const keyboard = getAlertKeyboard(updatedCreator.address, token.address);
      
      await botInstance.api.sendMessage(user.telegram_id, message, {
        parse_mode: "MarkdownV2",
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true },
      });
      
      db.logAlert({
        user_id: user.telegram_id,
        creator_address: updatedCreator.address,
        token_address: token.address,
        alert_type: isWatched ? "watched" : "qualified",
        delivered: 1,
      });
      
      db.incrementUserAlerts(user.telegram_id);
      
      logger.alert(`Alert sent to ${user.telegram_id} for token ${token.symbol || token.address}`);
      
      const sniperSettings = db.getOrCreateSniperSettings(user.telegram_id);
      if (sniperSettings.auto_buy_enabled) {
        const wallet = db.getWallet(user.telegram_id);
        if (wallet) {
          snipeToken(user.telegram_id, token.address, token.symbol, token.name).then((result) => {
            const symbol = token.symbol || "???";
            if (result.success) {
              botInstance?.api.sendMessage(user.telegram_id, 
                `✅ *AUTO-SNIPE SUCCESS*\n\n` +
                `Bought $${symbol} with ${sniperSettings.buy_amount_sol} SOL\n` +
                `TX: \`${result.txSignature?.slice(0, 20) || "pending"}...\``,
                { parse_mode: "Markdown" }
              ).catch((e) => logger.error(`Failed to send auto-snipe success msg: ${e.message}`));
            } else {
              botInstance?.api.sendMessage(user.telegram_id,
                `❌ *AUTO-SNIPE FAILED*\n\n` +
                `$${symbol}: ${result.error || "Unknown error"}`,
                { parse_mode: "Markdown" }
              ).catch((e) => logger.error(`Failed to send auto-snipe fail msg: ${e.message}`));
            }
          }).catch((err) => {
            logger.error(`Auto-snipe error for ${user.telegram_id}: ${err.message}`);
          });
        }
      }
    } catch (error: any) {
      logger.error(`Failed to send alert to ${user.telegram_id}`, error.message);
      
      db.logAlert({
        user_id: user.telegram_id,
        creator_address: updatedCreator.address,
        token_address: token.address,
        alert_type: isWatched ? "watched" : "qualified",
        delivered: 0,
      });
    }
  }
}

function formatAlertMessage(creator: Creator, token: Token, isWatched: boolean): string {
  const tokenName = token.name || "Unknown";
  const tokenSymbol = token.symbol || "???";
  const bondingRate = creator.total_launches > 0 
    ? `${((creator.bonded_count / creator.total_launches) * 100).toFixed(0)}%` 
    : "N/A";
  
  if (isWatched) {
    return `⭐ *APEX \\- WATCHED CREATOR* ⭐

*Token:* $${escapeMarkdown(tokenSymbol)} (${escapeMarkdown(tokenName)})
\`${token.address}\`

*Creator:* [${formatAddress(creator.address, 6)}](${getPumpFunProfileUrl(creator.address)})

📊 *Creator Stats:*
├ Launches: ${creator.total_launches}
├ Bonded: ${creator.bonded_count} \\(${bondingRate}\\)
├ 100k\\+ MC: ${creator.hits_100k_count}
└ Best: ${formatMarketCap(creator.best_mc_ever)}

🔗 [PumpFun](${getPumpFunUrl(token.address)}) • [DexScreener](${getDexScreenerUrl(token.address)}) • [Creator](${getPumpFunProfileUrl(creator.address)})`;
  }
  
  const tier = getCreatorTier(creator.bonded_count, creator.hits_100k_count, creator.total_launches, creator.best_mc_ever);
  const tierLabel = tier === "elite"
    ? `🔥 *APEX \\- ELITE CREATOR* 🔥`
    : `🔺 *APEX \\- PROVEN CREATOR*`;

  return `${tierLabel}

*Token:* $${escapeMarkdown(tokenSymbol)} (${escapeMarkdown(tokenName)})
\`${token.address}\`

*Creator:* [${formatAddress(creator.address, 6)}](${getPumpFunProfileUrl(creator.address)})

📊 *Creator Stats:*
├ Launches: ${creator.total_launches}
├ Bonded: ${creator.bonded_count} \\(${bondingRate}\\)
├ 100k\\+ MC: ${creator.hits_100k_count}
└ Best: ${formatMarketCap(creator.best_mc_ever)}

🔗 [PumpFun](${getPumpFunUrl(token.address)}) • [DexScreener](${getDexScreenerUrl(token.address)}) • [Creator](${getPumpFunProfileUrl(creator.address)})`;
}

function getAlertKeyboard(creatorAddress: string, tokenAddress: string) {
  return {
    inline_keyboard: [
      [
        { text: "⭐ Watch Creator", callback_data: `apex:watch:${creatorAddress}` },
        { text: "👤 Creator Profile", url: getPumpFunProfileUrl(creatorAddress) },
      ],
      [
        { text: "🔗 PumpFun", url: getPumpFunUrl(tokenAddress) },
        { text: "📈 DexScreener", url: getDexScreenerUrl(tokenAddress) },
      ],
    ],
  };
}

export async function sendBundleAlert(
  user: User,
  tokenAddress: string,
  tokenName: string | null,
  tokenSymbol: string | null,
  creatorAddress: string,
  devBuySOL: number,
  autoSnipe: boolean,
  buyAmountSOL: number
): Promise<void> {
  if (!botInstance) {
    logger.error("Bot instance not set for bundle alerts");
    return;
  }
  
  const name = tokenName || "Unknown";
  const symbol = tokenSymbol || "???";
  const devBuyFormatted = escapeMarkdown(devBuySOL.toFixed(2));
  
  const message = `🎯 *APEX \\- DEV BUNDLE DETECTED* 🎯

*Token:* $${escapeMarkdown(symbol)} \\(${escapeMarkdown(name)}\\)
\`${tokenAddress}\`

*Creator:* [${formatAddress(creatorAddress, 6)}](${getPumpFunProfileUrl(creatorAddress)})

💰 *Dev Buy:* ${devBuyFormatted} SOL

⚡ This creator bought ${devBuyFormatted} SOL worth at launch\\!

🔗 [PumpFun](${getPumpFunUrl(tokenAddress)}) • [DexScreener](${getDexScreenerUrl(tokenAddress)}) • [Creator](${getPumpFunProfileUrl(creatorAddress)})`;
  
  const keyboard = {
    inline_keyboard: [
      [
        { text: "⭐ Watch Creator", callback_data: `apex:watch:${creatorAddress}` },
        { text: "🎯 Snipe Now", callback_data: `sniper:buy:${tokenAddress}` },
      ],
      [
        { text: "🔗 PumpFun", url: getPumpFunUrl(tokenAddress) },
        { text: "📈 DexScreener", url: getDexScreenerUrl(tokenAddress) },
      ],
    ],
  };
  
  try {
    await botInstance.api.sendMessage(user.telegram_id, message, {
      parse_mode: "MarkdownV2",
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
    
    db.logAlert({
      user_id: user.telegram_id,
      creator_address: creatorAddress,
      token_address: tokenAddress,
      alert_type: "bundle",
      delivered: 1,
    });
    
    db.incrementUserAlerts(user.telegram_id);
    
    logger.alert(`Bundle alert sent to ${user.telegram_id} for ${symbol} (${devBuySOL.toFixed(2)} SOL)`);
    
    // Auto-snipe if enabled - pass buy amount directly to avoid race conditions
    if (autoSnipe) {
      const wallet = db.getWallet(user.telegram_id);
      if (wallet) {
        snipeToken(user.telegram_id, tokenAddress, tokenSymbol, tokenName, buyAmountSOL).then((result) => {
          if (result.success) {
            botInstance?.api.sendMessage(user.telegram_id,
              `✅ *BUNDLE AUTO\\-SNIPE SUCCESS*\n\n` +
              `Bought $${escapeMarkdown(symbol)} with ${escapeMarkdown(buyAmountSOL.toString())} SOL\n` +
              `TX: \`${result.txSignature?.slice(0, 20) || "pending"}\\.\\.\\.\``,
              { parse_mode: "MarkdownV2" }
            ).catch((e) => logger.error(`Failed to send bundle snipe success: ${e.message}`));
          } else {
            botInstance?.api.sendMessage(user.telegram_id,
              `❌ *BUNDLE AUTO\\-SNIPE FAILED*\n\n` +
              `$${escapeMarkdown(symbol)}: ${escapeMarkdown(result.error || "Unknown error")}`,
              { parse_mode: "MarkdownV2" }
            ).catch((e) => logger.error(`Failed to send bundle snipe fail: ${e.message}`));
          }
        }).catch((err) => {
          logger.error(`Bundle auto-snipe error for ${user.telegram_id}: ${err.message}`);
        });
      }
    }
  } catch (error: any) {
    logger.error(`Failed to send bundle alert to ${user.telegram_id}`, error.message);
    
    db.logAlert({
      user_id: user.telegram_id,
      creator_address: creatorAddress,
      token_address: tokenAddress,
      alert_type: "bundle",
      delivered: 0,
    });
  }
}

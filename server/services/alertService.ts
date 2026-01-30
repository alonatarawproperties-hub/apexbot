import { Bot } from "grammy";
import * as db from "../db";
import { logger } from "../utils/logger";
import { formatAddress, formatMarketCap, formatPercentage, getPumpFunUrl, getPumpFunProfileUrl, getDexScreenerUrl, escapeMarkdown } from "../utils/helpers";
import type { Creator, Token, User } from "@shared/schema";
import { checkQualification, getCreatorTier } from "./creatorService";
import { checkIfSpamLauncher } from "./spamDetection";
import { getCreatorLaunchCount } from "./bitqueryService";

let botInstance: Bot | null = null;

export function setBotInstance(bot: Bot): void {
  botInstance = bot;
}

export async function sendNewTokenAlert(creator: Creator, token: Token): Promise<void> {
  if (!botInstance) {
    logger.error("Bot instance not set for alerts");
    return;
  }
  
  // Try to get accurate launch count from Bitquery before sending alert
  let actualLaunches = creator.total_launches;
  try {
    const bitqueryCount = await getCreatorLaunchCount(creator.address);
    if (bitqueryCount > 0 && bitqueryCount > creator.total_launches) {
      actualLaunches = bitqueryCount;
      // Update database with accurate count
      db.upsertCreator({
        ...creator,
        total_launches: actualLaunches,
      });
      logger.info(`Updated ${creator.address.slice(0, 8)} launch count: ${creator.total_launches} -> ${actualLaunches}`);
    }
  } catch (error: any) {
    logger.warn(`Could not fetch accurate launch count for ${creator.address.slice(0, 8)}: ${error.message}`);
  }
  
  // Check spam using updated metrics
  const spamCheck = await checkIfSpamLauncher(
    creator.address,
    creator.bonded_count,
    creator.hits_100k_count,
    actualLaunches
  );
  
  if (spamCheck.isSpam) {
    logger.info(`Skipping alert for spam launcher ${creator.address.slice(0, 8)}: ${spamCheck.reason}`);
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
        parse_mode: "Markdown",
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

import { Bot } from "grammy";
import * as db from "../db";
import { logger } from "../utils/logger";
import { formatAddress, formatMarketCap, formatPercentage, getPumpFunUrl, getDexScreenerUrl, escapeMarkdown } from "../utils/helpers";
import type { Creator, Token, User } from "@shared/schema";
import { checkQualification, getCreatorTier } from "./creatorService";
import { checkIfSpamLauncher } from "./spamDetection";
import { fetchCreatorTokenHistory } from "./bitqueryService";

let botInstance: Bot | null = null;

export function setBotInstance(bot: Bot): void {
  botInstance = bot;
}

function needsHistoryRefresh(creator: Creator): boolean {
  const successCount = creator.bonded_count + creator.hits_100k_count;
  
  if (successCount >= 3) {
    return false;
  }
  
  if (creator.bonded_count >= 2) {
    return false;
  }
  
  if (creator.hits_100k_count >= 2) {
    return false;
  }
  
  if (creator.total_launches >= 15 && successCount >= 1) {
    return false;
  }
  
  if (creator.total_launches <= 5 && successCount === 0) {
    return true;
  }
  
  if (successCount === 1 && creator.total_launches <= 8) {
    return true;
  }
  
  return false;
}

export async function sendNewTokenAlert(creator: Creator, token: Token): Promise<void> {
  if (!botInstance) {
    logger.error("Bot instance not set for alerts");
    return;
  }
  
  let actualTotalLaunches = creator.total_launches;
  
  const shouldRefresh = needsHistoryRefresh(creator);
  
  if (shouldRefresh) {
    logger.info(`Refreshing history for creator ${creator.address.slice(0, 8)}... (DB shows ${creator.total_launches} launches)`);
    
    try {
      const { tokens: historyTokens, totalCount } = await fetchCreatorTokenHistory(creator.address, 1000);
      
      if (totalCount > 0) {
        actualTotalLaunches = totalCount;
        
        if (totalCount > creator.total_launches) {
          logger.info(`Bitquery: Creator has ${totalCount} actual launches (DB had ${creator.total_launches})`);
          
          db.updateCreatorTotalLaunches(creator.address, totalCount);
        }
      }
    } catch (error: any) {
      logger.warn(`Failed to refresh history: ${error.message}`);
    }
  }
  
  const spamCheck = await checkIfSpamLauncher(
    creator.address,
    creator.bonded_count,
    creator.hits_100k_count,
    actualTotalLaunches
  );
  
  if (spamCheck.isSpam) {
    logger.info(`Skipping alert for spam launcher ${creator.address}: ${spamCheck.reason}`);
    return;
  }
  
  const usersToAlert: Array<{ user: User; isWatched: boolean }> = [];
  const allUsers = db.getAllUsers();
  
  for (const user of allUsers) {
    if (!user.settings.notifications_enabled) continue;
    
    const isWatched = db.isOnWatchlist(user.telegram_id, creator.address);
    
    if (user.settings.alert_watched_only) {
      if (isWatched) {
        usersToAlert.push({ user, isWatched: true });
      }
    } else {
      if (isWatched || checkQualification(creator, user.settings)) {
        usersToAlert.push({ user, isWatched });
      }
    }
  }
  
  for (const { user, isWatched } of usersToAlert) {
    try {
      const message = formatAlertMessage(creator, token, isWatched);
      const keyboard = getAlertKeyboard(creator.address, token.address);
      
      await botInstance.api.sendMessage(user.telegram_id, message, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true },
      });
      
      db.logAlert({
        user_id: user.telegram_id,
        creator_address: creator.address,
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
        creator_address: creator.address,
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
  const bondedRate = creator.total_launches > 0 
    ? formatPercentage(creator.bonded_count, creator.total_launches) 
    : "0%";
  const hits100kRate = creator.total_launches > 0 
    ? formatPercentage(creator.hits_100k_count, creator.total_launches) 
    : "0%";
  
  if (isWatched) {
    return `⭐ *APEX \\- WATCHED CREATOR* ⭐

*Token:* $${escapeMarkdown(tokenSymbol)} (${escapeMarkdown(tokenName)})
\`${token.address}\`

*Creator:* \`${creator.address}\`

📊 *Creator Stats:*
├ Launches: ${creator.total_launches}
├ Bonded: ${creator.bonded_count} (${bondedRate})
├ 100k\\+ MC: ${creator.hits_100k_count} (${hits100kRate})
└ Best: ${formatMarketCap(creator.best_mc_ever)}

🔗 [PumpFun](${getPumpFunUrl(token.address)}) • [DexScreener](${getDexScreenerUrl(token.address)})`;
  }
  
  const tier = getCreatorTier(creator.bonded_count, creator.hits_100k_count, creator.total_launches, creator.best_mc_ever);
  const tierLabel = tier === "elite"
    ? `🔥 *APEX \\- ELITE CREATOR* 🔥`
    : `🔺 *APEX \\- PROVEN CREATOR*`;

  return `${tierLabel}

*Token:* $${escapeMarkdown(tokenSymbol)} (${escapeMarkdown(tokenName)})
\`${token.address}\`

*Creator:* \`${creator.address}\`

📊 *Creator Stats:*
├ Launches: ${creator.total_launches}
├ Bonded: ${creator.bonded_count} (${bondedRate})
├ 100k\\+ MC: ${creator.hits_100k_count} (${hits100kRate})
└ Best: ${formatMarketCap(creator.best_mc_ever)}

🔗 [PumpFun](${getPumpFunUrl(token.address)}) • [DexScreener](${getDexScreenerUrl(token.address)})`;
}

function getAlertKeyboard(creatorAddress: string, tokenAddress: string) {
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

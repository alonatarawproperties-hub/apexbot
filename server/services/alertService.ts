import { Bot } from "grammy";
import * as db from "../db";
import { logger } from "../utils/logger";
import { formatAddress, formatMarketCap, formatPercentage, getPumpFunUrl, getPumpFunProfileUrl, getDexScreenerUrl, escapeMarkdown } from "../utils/helpers";
import type { Creator, Token, User } from "@shared/schema";
import { checkQualification, getCreatorTier } from "./creatorService";
import { checkIfSpamLauncher } from "./spamDetection";

let botInstance: Bot | null = null;

export function setBotInstance(bot: Bot): void {
  botInstance = bot;
}

export async function sendNewTokenAlert(creator: Creator, token: Token): Promise<void> {
  if (!botInstance) {
    logger.error("Bot instance not set for alerts");
    return;
  }
  
  // Check spam using our database metrics (no external API needed)
  const spamCheck = await checkIfSpamLauncher(
    creator.address,
    creator.bonded_count,
    creator.hits_100k_count,
    creator.total_launches
  );
  
  if (spamCheck.isSpam) {
    logger.info(`Skipping alert for spam launcher ${creator.address.slice(0, 8)}: ${spamCheck.reason}`);
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
  
  if (isWatched) {
    return `⭐ *APEX \\- WATCHED CREATOR* ⭐

*Token:* $${escapeMarkdown(tokenSymbol)} (${escapeMarkdown(tokenName)})
\`${token.address}\`

*Creator:* [${formatAddress(creator.address, 6)}](${getPumpFunProfileUrl(creator.address)})

📊 *Tracked Stats:*
├ Bonded: ${creator.bonded_count}
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

📊 *Tracked Stats:*
├ Bonded: ${creator.bonded_count}
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

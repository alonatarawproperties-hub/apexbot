import { Bot, GrammyError } from "grammy";
import { config } from "../utils/config";
import { logger } from "../utils/logger";
import { registerCommands } from "./commands";
import { setBotInstance } from "../services/alertService";

let bot: Bot | null = null;
let isRunning = false;

export async function startBot(): Promise<Bot | null> {
  if (!config.telegramBotToken) {
    logger.warn("TELEGRAM_BOT_TOKEN is not set - bot disabled");
    return null;
  }

  if (bot) {
    logger.warn("Telegram bot already initialized - skipping duplicate startup");
    return bot;
  }

  try {
    bot = new Bot(config.telegramBotToken);

    const me = await bot.api.getMe();
    logger.info(`Bot authenticated as @${me.username}`);

    registerCommands(bot);
    setBotInstance(bot);

    // Set up the Menu button with bot commands
    await bot.api.setMyCommands([
      { command: "start", description: "Welcome & quick setup" },
      { command: "settings", description: "Configure alert thresholds" },
      { command: "sniper", description: "Sniper bot settings" },
      { command: "watchlist", description: "View watched creators" },
      { command: "watch", description: "Add creator to watchlist" },
      { command: "stats", description: "Check creator statistics" },
      { command: "recent", description: "Recent alerts" },
      { command: "help", description: "Tips and commands" },
    ]);
    
    // Set the menu button to show commands
    await bot.api.setChatMenuButton({
      menu_button: { type: "commands" }
    });
    
    logger.info("Bot menu commands set up");

    bot.catch((err) => {
      logger.error("Bot error", err);
    });

    await bot.api.deleteWebhook({ drop_pending_updates: true });
    
    bot
      .start({
        onStart: () => {
          isRunning = true;
          logger.info("Telegram bot polling started");
        },
      })
      .catch((err) => {
        if (err instanceof GrammyError && err.error_code === 409) {
          logger.warn("Bot conflict: another instance is polling");
        } else {
          logger.error("Bot polling error", err);
        }
      });
    
    logger.info("Telegram bot initialized (polling mode)");
  } catch (err: any) {
    logger.error("Failed to start bot", err.message);
    return null;
  }

  return bot;
}

export function getBot(): Bot | null {
  return bot;
}

export function isBotRunning(): boolean {
  return isRunning;
}

export async function stopBot(): Promise<void> {
  if (bot) {
    await bot.stop();
    isRunning = false;
    logger.info("Telegram bot stopped");
  }
}

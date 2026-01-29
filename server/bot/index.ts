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

  try {
    bot = new Bot(config.telegramBotToken);

    // Test the token is valid
    const me = await bot.api.getMe();
    logger.info(`Bot authenticated as @${me.username}`);

    // Drop pending updates so we get a clean polling session
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    logger.info("Cleared pending updates");

    registerCommands(bot);
    setBotInstance(bot);

    bot.catch((err) => {
      if (err instanceof GrammyError && err.error_code === 409) {
        logger.warn("Bot conflict detected - another instance is running");
        isRunning = false;
      } else {
        logger.error("Bot error", err);
      }
    });

    bot.start({
      onStart: () => {
        isRunning = true;
        logger.info("Telegram bot polling started successfully");
      },
    });
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

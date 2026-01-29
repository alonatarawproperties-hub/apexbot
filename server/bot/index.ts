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
  
  bot = new Bot(config.telegramBotToken);
  
  registerCommands(bot);
  
  setBotInstance(bot);
  
  bot.catch((err) => {
    if (err instanceof GrammyError && err.error_code === 409) {
      logger.warn("Bot conflict detected - another instance is running (likely published version)");
      isRunning = false;
    } else {
      logger.error("Bot error", err);
    }
  });
  
  try {
    bot.start({
      onStart: () => {
        isRunning = true;
        logger.info("Telegram bot started");
      },
    }).catch((err) => {
      if (err instanceof GrammyError && err.error_code === 409) {
        logger.warn("Bot conflict: another instance is running. Dashboard will continue working.");
        isRunning = false;
      } else {
        logger.error("Bot start error", err);
      }
    });
  } catch (err) {
    logger.warn("Failed to start bot - dashboard will continue working");
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

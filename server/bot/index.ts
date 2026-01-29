import { Bot } from "grammy";
import { config } from "../utils/config";
import { logger } from "../utils/logger";
import { registerCommands } from "./commands";
import { setBotInstance } from "../services/alertService";

let bot: Bot | null = null;
let isRunning = false;

export async function startBot(): Promise<Bot> {
  if (!config.telegramBotToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set");
  }
  
  bot = new Bot(config.telegramBotToken);
  
  registerCommands(bot);
  
  setBotInstance(bot);
  
  bot.catch((err) => {
    logger.error("Bot error", err);
  });
  
  bot.start({
    onStart: () => {
      isRunning = true;
      logger.info("Telegram bot started");
    },
  });
  
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

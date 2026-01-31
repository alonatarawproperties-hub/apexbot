import { Bot, GrammyError } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import { config } from "../utils/config";
import { logger } from "../utils/logger";
import { registerCommands } from "./commands";
import { setBotInstance } from "../services/alertService";

let bot: Bot | null = null;
let runner: ReturnType<typeof run> | null = null;
let isRunning = false;

// Get session key for sequentializing updates per user
function getSessionKey(ctx: any): string | undefined {
  return ctx.from?.id.toString();
}

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

    // Use sequentialize to process updates per-user concurrently
    bot.use(sequentialize(getSessionKey));

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
    
    // Use Grammy Runner for concurrent processing instead of bot.start()
    runner = run(bot);
    isRunning = true;
    logger.info("Telegram bot initialized with Grammy Runner (concurrent mode)");
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
  if (runner) {
    runner.stop();
    runner = null;
  }
  if (bot) {
    isRunning = false;
    bot = null;
    logger.info("Telegram bot stopped");
  }
}

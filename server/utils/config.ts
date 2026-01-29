export const config = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  heliusApiKey: process.env.HELIUS_API_KEY || "",
  webhookSecret: process.env.WEBHOOK_SECRET || "",
  databasePath: process.env.DATABASE_PATH || "./data/apex.db",
  port: parseInt(process.env.PORT || "5000", 10),
  pumpfunProgram: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  dexscreenerRateLimit: 200,
  mcTrackerInterval: 2 * 60 * 1000,
  statsAggregatorInterval: 30 * 60 * 1000,
};

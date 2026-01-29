export const config = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  heliusApiKey: process.env.HELIUS_API_KEY || "",
  heliusTransactionTypes: (process.env.HELIUS_TRANSACTION_TYPES || "CREATE")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean),
  autoResetDatabaseOnCorruption: process.env.DATABASE_AUTO_RESET === "true",
  webhookSecret: process.env.WEBHOOK_SECRET || "apex_webhook_secret_2024",
  databasePath: process.env.DATABASE_PATH || "./data/apex.db",
  port: parseInt(process.env.PORT || "5000", 10),
  pumpfunProgram: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  dexscreenerRateLimit: 500,
  mcTrackerInterval: 2 * 60 * 1000,
  statsAggregatorInterval: 30 * 60 * 1000,
};

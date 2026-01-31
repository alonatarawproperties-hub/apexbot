import { z } from "zod";

// User settings schema
export const userSettingsSchema = z.object({
  min_bonded_count: z.number().default(1),
  min_100k_count: z.number().default(1),
  mc_hold_minutes: z.number().default(5),
  lookback_days: z.number().default(90),
  alert_watched_only: z.boolean().default(false),
  notifications_enabled: z.boolean().default(true),
  min_success_rate: z.number().default(1),
  max_launches: z.number().default(500),
  // Bundle detection settings
  bundle_alerts_enabled: z.boolean().default(true),
  bundle_min_sol: z.number().default(2),
  bundle_max_sol: z.number().default(200),
  bundle_auto_snipe: z.boolean().default(false),
  bundle_buy_amount_sol: z.number().default(0.1),
});

export type UserSettings = z.infer<typeof userSettingsSchema>;

// User schema
export const userSchema = z.object({
  telegram_id: z.string(),
  username: z.string().nullable(),
  tier: z.string().default("free"),
  settings: userSettingsSchema,
  alerts_today: z.number().default(0),
  last_alert_reset: z.string().nullable(),
  created_at: z.string(),
});

export type User = z.infer<typeof userSchema>;

export const insertUserSchema = userSchema.omit({ created_at: true });
export type InsertUser = z.infer<typeof insertUserSchema>;

// Creator schema
export const creatorSchema = z.object({
  address: z.string(),
  total_launches: z.number().default(0),
  bonded_count: z.number().default(0),
  hits_100k_count: z.number().default(0),
  best_mc_ever: z.number().default(0),
  is_qualified: z.number().default(0),
  qualification_reason: z.string().nullable(),
  last_updated: z.string().nullable(),
  first_seen: z.string(),
});

export type Creator = z.infer<typeof creatorSchema>;

export const insertCreatorSchema = creatorSchema.omit({ first_seen: true });
export type InsertCreator = z.infer<typeof insertCreatorSchema>;

// Token schema
export const tokenSchema = z.object({
  address: z.string(),
  creator_address: z.string(),
  name: z.string().nullable(),
  symbol: z.string().nullable(),
  bonded: z.number().default(0),
  peak_mc: z.number().default(0),
  peak_mc_timestamp: z.string().nullable(),
  peak_mc_held_minutes: z.number().default(0),
  current_mc: z.number().default(0),
  created_at: z.string(),
  pumpfun_url: z.string().nullable(),
});

export type Token = z.infer<typeof tokenSchema>;

export const insertTokenSchema = tokenSchema.omit({ created_at: true });
export type InsertToken = z.infer<typeof insertTokenSchema>;

// Watchlist schema
export const watchlistSchema = z.object({
  id: z.number(),
  user_id: z.string(),
  creator_address: z.string(),
  notes: z.string().nullable(),
  added_at: z.string(),
});

export type WatchlistEntry = z.infer<typeof watchlistSchema>;

export const insertWatchlistSchema = watchlistSchema.omit({ id: true, added_at: true });
export type InsertWatchlistEntry = z.infer<typeof insertWatchlistSchema>;

// Alert log schema
export const alertLogSchema = z.object({
  id: z.number(),
  user_id: z.string(),
  creator_address: z.string(),
  token_address: z.string(),
  alert_type: z.string(),
  delivered: z.number().default(0),
  sent_at: z.string(),
});

export type AlertLog = z.infer<typeof alertLogSchema>;

export const insertAlertLogSchema = alertLogSchema.omit({ id: true, sent_at: true });
export type InsertAlertLog = z.infer<typeof insertAlertLogSchema>;

// Bot status for dashboard
export const botStatusSchema = z.object({
  isOnline: z.boolean(),
  webhookRegistered: z.boolean(),
  totalUsers: z.number(),
  totalCreators: z.number(),
  totalTokens: z.number(),
  qualifiedCreators: z.number(),
  alertsSentToday: z.number(),
  alertStats: z.object({
    delivered: z.number(),
    failed: z.number(),
  }).optional(),
  alertsByType: z.object({
    creator: z.number(),
    bundle: z.number(),
    watched: z.number(),
  }).optional(),
  lastWebhookReceived: z.string().nullable(),
  uptime: z.number(),
});

export type BotStatus = z.infer<typeof botStatusSchema>;

// Creator stats for display
export const creatorStatsSchema = z.object({
  address: z.string(),
  total_launches: z.number(),
  bonded_count: z.number(),
  bonded_rate: z.number(),
  hits_100k_count: z.number(),
  hits_100k_rate: z.number(),
  best_mc_ever: z.number(),
  is_qualified: z.boolean(),
  qualification_reason: z.string().nullable(),
  recent_tokens: z.array(tokenSchema).optional(),
});

export type CreatorStats = z.infer<typeof creatorStatsSchema>;

// Webhook payload from Helius
export const heliusWebhookPayloadSchema = z.array(z.object({
  type: z.string(),
  signature: z.string(),
  slot: z.number(),
  timestamp: z.number(),
  feePayer: z.string().optional(),
  nativeTransfers: z.array(z.any()).optional(),
  tokenTransfers: z.array(z.any()).optional(),
  accountData: z.array(z.any()).optional(),
  instructions: z.array(z.any()).optional(),
  events: z.any().optional(),
}));

export type HeliusWebhookPayload = z.infer<typeof heliusWebhookPayloadSchema>;

// Sniper settings schema
export const takeProfitBracketSchema = z.object({
  percentage: z.number().min(0).max(100),
  multiplier: z.number().min(1),
});

export type TakeProfitBracket = z.infer<typeof takeProfitBracketSchema>;

export const sniperSettingsSchema = z.object({
  user_id: z.string(),
  auto_buy_enabled: z.boolean().default(false),
  buy_amount_sol: z.number().default(0.1),
  slippage_percent: z.number().default(20),
  jito_tip_sol: z.number().default(0.005),
  priority_fee_lamports: z.number().default(100000),
  tp_brackets: z.array(takeProfitBracketSchema).default([
    { percentage: 50, multiplier: 2 },
    { percentage: 30, multiplier: 5 },
    { percentage: 20, multiplier: 10 },
  ]),
  moon_bag_percent: z.number().default(0),
  moon_bag_multiplier: z.number().default(0),
  stop_loss_percent: z.number().default(50),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

export type SniperSettings = z.infer<typeof sniperSettingsSchema>;

export const insertSniperSettingsSchema = sniperSettingsSchema.omit({ created_at: true, updated_at: true });
export type InsertSniperSettings = z.infer<typeof insertSniperSettingsSchema>;

// Wallet schema
export const walletSchema = z.object({
  user_id: z.string(),
  public_key: z.string(),
  encrypted_private_key: z.string(),
  created_at: z.string().optional(),
});

export type Wallet = z.infer<typeof walletSchema>;

export const insertWalletSchema = walletSchema.omit({ created_at: true });
export type InsertWallet = z.infer<typeof insertWalletSchema>;

// Position schema
export const positionSchema = z.object({
  id: z.number(),
  user_id: z.string(),
  token_address: z.string(),
  token_symbol: z.string().nullable(),
  token_name: z.string().nullable(),
  entry_price_sol: z.number(),
  entry_amount_sol: z.number(),
  tokens_bought: z.number(),
  tokens_remaining: z.number(),
  current_price_sol: z.number().default(0),
  unrealized_pnl_percent: z.number().default(0),
  tp1_hit: z.boolean().default(false),
  tp2_hit: z.boolean().default(false),
  tp3_hit: z.boolean().default(false),
  status: z.enum(["open", "closed", "partial"]).default("open"),
  created_at: z.string().optional(),
  closed_at: z.string().nullable().optional(),
});

export type Position = z.infer<typeof positionSchema>;

export const insertPositionSchema = positionSchema.omit({ id: true, created_at: true, closed_at: true });
export type InsertPosition = z.infer<typeof insertPositionSchema>;

// Trade history schema
export const tradeHistorySchema = z.object({
  id: z.number(),
  user_id: z.string(),
  position_id: z.number(),
  token_address: z.string(),
  token_symbol: z.string().nullable(),
  trade_type: z.enum(["buy", "sell"]),
  amount_sol: z.number(),
  tokens_amount: z.number(),
  price_per_token: z.number(),
  tx_signature: z.string().nullable(),
  trigger_reason: z.string().nullable(),
  created_at: z.string().optional(),
});

export type TradeHistory = z.infer<typeof tradeHistorySchema>;

export const insertTradeHistorySchema = tradeHistorySchema.omit({ id: true, created_at: true });
export type InsertTradeHistory = z.infer<typeof insertTradeHistorySchema>;

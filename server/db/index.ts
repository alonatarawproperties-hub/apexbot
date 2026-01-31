import Database from "better-sqlite3";
import fs from "fs";
import { config } from "../utils/config";
import { logger } from "../utils/logger";
import { getCurrentTimestamp } from "../utils/helpers";
import { userCache, sniperSettingsCache } from "../utils/cache";
import type { 
  User, InsertUser, UserSettings, 
  Creator, InsertCreator, 
  Token, InsertToken,
  WatchlistEntry, InsertWatchlistEntry,
  AlertLog, InsertAlertLog,
  SniperSettings, InsertSniperSettings,
  Wallet, InsertWallet,
  Position, InsertPosition,
  TradeHistory, InsertTradeHistory,
  TakeProfitBracket
} from "@shared/schema";

let db: Database.Database;

export function initDatabase(): void {
  try {
    db = new Database(config.databasePath);
    db.pragma("journal_mode = WAL");
    runMigrations();
    logger.info("Database initialized");
  } catch (error: any) {
    const message = error?.message || "";
    if (message.includes("database disk image is malformed") && config.autoResetDatabaseOnCorruption) {
      logger.warn("Database corrupted - resetting SQLite file");
      if (fs.existsSync(config.databasePath)) {
        fs.unlinkSync(config.databasePath);
      }
      db = new Database(config.databasePath);
      db.pragma("journal_mode = WAL");
      runMigrations();
      logger.info("Database recreated after corruption");
      return;
    }
    throw error;
  }
}

function runMigrations(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id TEXT PRIMARY KEY,
      username TEXT,
      tier TEXT DEFAULT 'free',
      settings TEXT DEFAULT '{"min_bonded_count":1,"min_100k_count":1,"mc_hold_minutes":5,"lookback_days":90,"alert_watched_only":false,"notifications_enabled":true}',
      alerts_today INTEGER DEFAULT 0,
      last_alert_reset TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS creators (
      address TEXT PRIMARY KEY,
      total_launches INTEGER DEFAULT 0,
      bonded_count INTEGER DEFAULT 0,
      hits_100k_count INTEGER DEFAULT 0,
      best_mc_ever REAL DEFAULT 0,
      is_qualified INTEGER DEFAULT 0,
      qualification_reason TEXT,
      last_updated TEXT,
      first_seen TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tokens (
      address TEXT PRIMARY KEY,
      creator_address TEXT,
      name TEXT,
      symbol TEXT,
      bonded INTEGER DEFAULT 0,
      peak_mc REAL DEFAULT 0,
      peak_mc_timestamp TEXT,
      peak_mc_held_minutes INTEGER DEFAULT 0,
      current_mc REAL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      pumpfun_url TEXT,
      FOREIGN KEY (creator_address) REFERENCES creators(address)
    );

    CREATE TABLE IF NOT EXISTS watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      creator_address TEXT,
      notes TEXT,
      added_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(telegram_id),
      FOREIGN KEY (creator_address) REFERENCES creators(address),
      UNIQUE(user_id, creator_address)
    );

    CREATE TABLE IF NOT EXISTS alerts_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      creator_address TEXT,
      token_address TEXT,
      alert_type TEXT,
      delivered INTEGER DEFAULT 0,
      sent_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_creators_qualified ON creators(is_qualified);
    CREATE INDEX IF NOT EXISTS idx_tokens_creator ON tokens(creator_address);
    CREATE INDEX IF NOT EXISTS idx_watchlist_user ON watchlist(user_id);
    CREATE INDEX IF NOT EXISTS idx_watchlist_creator ON watchlist(creator_address);

    -- Sniper tables
    CREATE TABLE IF NOT EXISTS wallets (
      user_id TEXT PRIMARY KEY,
      public_key TEXT NOT NULL,
      encrypted_private_key TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(telegram_id)
    );

    CREATE TABLE IF NOT EXISTS sniper_settings (
      user_id TEXT PRIMARY KEY,
      auto_buy_enabled INTEGER DEFAULT 0,
      buy_amount_sol REAL DEFAULT 0.1,
      slippage_percent REAL DEFAULT 20,
      jito_tip_sol REAL DEFAULT 0.005,
      priority_fee_lamports INTEGER DEFAULT 100000,
      tp_brackets TEXT DEFAULT '[{"percentage":50,"multiplier":2},{"percentage":30,"multiplier":5},{"percentage":20,"multiplier":10}]',
      moon_bag_percent REAL DEFAULT 0,
      moon_bag_multiplier REAL DEFAULT 0,
      stop_loss_percent REAL DEFAULT 50,
      max_open_positions INTEGER DEFAULT 5,
      bundle_auto_buy_enabled INTEGER DEFAULT 0,
      bundle_buy_amount_sol REAL DEFAULT 0.1,
      bundle_slippage_percent REAL DEFAULT 20,
      bundle_jito_tip_sol REAL DEFAULT 0.005,
      bundle_tp_brackets TEXT DEFAULT '[{"percentage":50,"multiplier":2},{"percentage":30,"multiplier":5},{"percentage":20,"multiplier":10}]',
      bundle_moon_bag_percent REAL DEFAULT 0,
      bundle_moon_bag_multiplier REAL DEFAULT 0,
      bundle_stop_loss_percent REAL DEFAULT 50,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(telegram_id)
    );
    

    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      token_address TEXT NOT NULL,
      token_symbol TEXT,
      token_name TEXT,
      entry_price_sol REAL NOT NULL,
      entry_amount_sol REAL NOT NULL,
      tokens_bought REAL NOT NULL,
      tokens_remaining REAL NOT NULL,
      current_price_sol REAL DEFAULT 0,
      unrealized_pnl_percent REAL DEFAULT 0,
      tp1_hit INTEGER DEFAULT 0,
      tp2_hit INTEGER DEFAULT 0,
      tp3_hit INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open',
      snipe_mode TEXT DEFAULT 'creator',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      closed_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(telegram_id)
    );

    CREATE TABLE IF NOT EXISTS trade_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      position_id INTEGER,
      token_address TEXT NOT NULL,
      token_symbol TEXT,
      trade_type TEXT NOT NULL,
      amount_sol REAL NOT NULL,
      tokens_amount REAL NOT NULL,
      price_per_token REAL NOT NULL,
      tx_signature TEXT,
      trigger_reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(telegram_id),
      FOREIGN KEY (position_id) REFERENCES positions(id)
    );

    CREATE INDEX IF NOT EXISTS idx_positions_user ON positions(user_id);
    CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
    CREATE INDEX IF NOT EXISTS idx_trade_history_user ON trade_history(user_id);
  `);
  
  // Safe migration: add moon_bag_multiplier column if it doesn't exist
  try {
    db.exec(`ALTER TABLE sniper_settings ADD COLUMN moon_bag_multiplier REAL DEFAULT 0`);
  } catch (e: any) {
    // Column already exists - ignore error
  }
  
  // Safe migration: add max_open_positions column if it doesn't exist
  try {
    db.exec(`ALTER TABLE sniper_settings ADD COLUMN max_open_positions INTEGER DEFAULT 5`);
  } catch (e: any) {
    // Column already exists - ignore error
  }
  
  // Safe migrations for bundle sniper settings
  const bundleColumns = [
    { name: "bundle_auto_buy_enabled", type: "INTEGER DEFAULT 0" },
    { name: "bundle_buy_amount_sol", type: "REAL DEFAULT 0.1" },
    { name: "bundle_slippage_percent", type: "REAL DEFAULT 20" },
    { name: "bundle_jito_tip_sol", type: "REAL DEFAULT 0.005" },
    { name: "bundle_tp_brackets", type: "TEXT DEFAULT '[{\"percentage\":50,\"multiplier\":2},{\"percentage\":30,\"multiplier\":5},{\"percentage\":20,\"multiplier\":10}]'" },
    { name: "bundle_moon_bag_percent", type: "REAL DEFAULT 0" },
    { name: "bundle_moon_bag_multiplier", type: "REAL DEFAULT 0" },
    { name: "bundle_stop_loss_percent", type: "REAL DEFAULT 50" },
  ];
  
  for (const col of bundleColumns) {
    try {
      db.exec(`ALTER TABLE sniper_settings ADD COLUMN ${col.name} ${col.type}`);
    } catch (e: any) {
      // Column already exists - ignore error
    }
  }
  
  // Safe migration: add snipe_mode column to positions if it doesn't exist
  try {
    db.exec(`ALTER TABLE positions ADD COLUMN snipe_mode TEXT DEFAULT 'creator'`);
  } catch (e: any) {
    // Column already exists - ignore error
  }
}

// User operations
export function getUser(telegramId: string): User | undefined {
  // Check cache first
  const cached = userCache.get(telegramId);
  if (cached) return cached;
  
  const row = db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(telegramId) as any;
  if (!row) return undefined;
  const user = {
    ...row,
    settings: JSON.parse(row.settings),
  };
  userCache.set(telegramId, user);
  return user;
}

export function createUser(user: InsertUser): User {
  const stmt = db.prepare(`
    INSERT INTO users (telegram_id, username, tier, settings, alerts_today, last_alert_reset)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const settings = JSON.stringify(user.settings);
  stmt.run(user.telegram_id, user.username, user.tier, settings, user.alerts_today, user.last_alert_reset);
  return getUser(user.telegram_id)!;
}

export function updateUserSettings(telegramId: string, settings: UserSettings): void {
  db.prepare("UPDATE users SET settings = ? WHERE telegram_id = ?")
    .run(JSON.stringify(settings), telegramId);
  userCache.invalidate(telegramId);
}

export function incrementUserAlerts(telegramId: string): void {
  db.prepare("UPDATE users SET alerts_today = alerts_today + 1 WHERE telegram_id = ?")
    .run(telegramId);
  userCache.invalidate(telegramId);
}

export function resetUserAlerts(telegramId: string): void {
  db.prepare("UPDATE users SET alerts_today = 0, last_alert_reset = ? WHERE telegram_id = ?")
    .run(getCurrentTimestamp(), telegramId);
  userCache.invalidate(telegramId);
}

export function getAllUsers(): User[] {
  const rows = db.prepare("SELECT * FROM users").all() as any[];
  return rows.map(row => ({
    ...row,
    settings: JSON.parse(row.settings),
  }));
}

export function getUserCount(): number {
  const row = db.prepare("SELECT COUNT(*) as count FROM users").get() as any;
  return row.count;
}

// Creator operations
export function getCreator(address: string): Creator | undefined {
  return db.prepare("SELECT * FROM creators WHERE address = ?").get(address) as Creator | undefined;
}

export function upsertCreator(creator: InsertCreator): Creator {
  const existing = getCreator(creator.address);
  if (existing) {
    db.prepare(`
      UPDATE creators SET 
        total_launches = ?, bonded_count = ?, hits_100k_count = ?, 
        best_mc_ever = ?, is_qualified = ?, qualification_reason = ?, last_updated = ?
      WHERE address = ?
    `).run(
      creator.total_launches, creator.bonded_count, creator.hits_100k_count,
      creator.best_mc_ever, creator.is_qualified, creator.qualification_reason,
      getCurrentTimestamp(), creator.address
    );
  } else {
    db.prepare(`
      INSERT INTO creators (address, total_launches, bonded_count, hits_100k_count, best_mc_ever, is_qualified, qualification_reason, last_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      creator.address, creator.total_launches, creator.bonded_count,
      creator.hits_100k_count, creator.best_mc_ever, creator.is_qualified,
      creator.qualification_reason, getCurrentTimestamp()
    );
  }
  return getCreator(creator.address)!;
}

export function getQualifiedCreators(): Creator[] {
  return db.prepare("SELECT * FROM creators WHERE is_qualified = 1").all() as Creator[];
}

export function updateCreatorTotalLaunches(address: string, totalLaunches: number): void {
  db.prepare(`
    UPDATE creators SET total_launches = ?, last_updated = ?
    WHERE address = ?
  `).run(totalLaunches, getCurrentTimestamp(), address);
}

export function getCreatorCount(): number {
  const row = db.prepare("SELECT COUNT(*) as count FROM creators").get() as any;
  return row.count;
}

export function getQualifiedCreatorCount(): number {
  // Exclude spam launchers with comprehensive spam detection rules
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM creators 
    WHERE is_qualified = 1 
    AND NOT (
      -- Rule 1: 20+ launches with 0 bonds = spam
      (total_launches >= 20 AND bonded_count = 0)
      -- Rule 2: 10+ launches requires at least 5% bonding rate
      OR (total_launches >= 10 AND (bonded_count * 100.0 / total_launches) < 5)
      -- Rule 3: 50+ launches requires at least 3% bonding rate
      OR (total_launches >= 50 AND (bonded_count * 100.0 / total_launches) < 3)
      -- Rule 4: 100+ launches requires at least 2% bonding rate
      OR (total_launches >= 100 AND (bonded_count * 100.0 / total_launches) < 2)
      -- Rule 5: 500+ launches with less than 1% = definitely spam
      OR (total_launches >= 500 AND (bonded_count * 100.0 / total_launches) < 1)
    )
  `).get() as any;
  return row.count;
}

export function getAllCreators(): Creator[] {
  return db.prepare("SELECT * FROM creators ORDER BY best_mc_ever DESC").all() as Creator[];
}

// Token operations
export function getToken(address: string): Token | undefined {
  return db.prepare("SELECT * FROM tokens WHERE address = ?").get(address) as Token | undefined;
}

export function createToken(token: InsertToken): Token {
  db.prepare(`
    INSERT OR IGNORE INTO tokens (address, creator_address, name, symbol, bonded, peak_mc, peak_mc_timestamp, peak_mc_held_minutes, current_mc, pumpfun_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    token.address, token.creator_address, token.name, token.symbol,
    token.bonded, token.peak_mc, token.peak_mc_timestamp, token.peak_mc_held_minutes,
    token.current_mc, token.pumpfun_url
  );
  return getToken(token.address)!;
}

export function updateToken(address: string, updates: Partial<Token>): void {
  const fields: string[] = [];
  const values: any[] = [];

  if (updates.bonded !== undefined) { fields.push("bonded = ?"); values.push(updates.bonded); }
  if (updates.peak_mc !== undefined) { fields.push("peak_mc = ?"); values.push(updates.peak_mc); }
  if (updates.peak_mc_timestamp !== undefined) { fields.push("peak_mc_timestamp = ?"); values.push(updates.peak_mc_timestamp); }
  if (updates.peak_mc_held_minutes !== undefined) { fields.push("peak_mc_held_minutes = ?"); values.push(updates.peak_mc_held_minutes); }
  if (updates.current_mc !== undefined) { fields.push("current_mc = ?"); values.push(updates.current_mc); }

  if (fields.length > 0) {
    values.push(address);
    db.prepare(`UPDATE tokens SET ${fields.join(", ")} WHERE address = ?`).run(...values);
  }
}

export function getTokensByCreator(creatorAddress: string): Token[] {
  return db.prepare("SELECT * FROM tokens WHERE creator_address = ? ORDER BY created_at DESC").all(creatorAddress) as Token[];
}

export function getRecentTokens(hours: number = 24): Token[] {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  return db.prepare("SELECT * FROM tokens WHERE created_at > ? ORDER BY created_at DESC").all(since) as Token[];
}

export function getTokenCount(): number {
  const row = db.prepare("SELECT COUNT(*) as count FROM tokens").get() as any;
  return row.count;
}

// Watchlist operations
export function addToWatchlist(entry: InsertWatchlistEntry): WatchlistEntry | null {
  try {
    db.prepare(`
      INSERT INTO watchlist (user_id, creator_address, notes)
      VALUES (?, ?, ?)
    `).run(entry.user_id, entry.creator_address, entry.notes);
    const row = db.prepare("SELECT * FROM watchlist WHERE user_id = ? AND creator_address = ?")
      .get(entry.user_id, entry.creator_address) as WatchlistEntry;
    return row;
  } catch (e) {
    return null;
  }
}

export function removeFromWatchlist(userId: string, creatorAddress: string): boolean {
  const result = db.prepare("DELETE FROM watchlist WHERE user_id = ? AND creator_address = ?")
    .run(userId, creatorAddress);
  return result.changes > 0;
}

export function getUserWatchlist(userId: string): WatchlistEntry[] {
  return db.prepare("SELECT * FROM watchlist WHERE user_id = ? ORDER BY added_at DESC").all(userId) as WatchlistEntry[];
}

export function getWatchersForCreator(creatorAddress: string): string[] {
  const rows = db.prepare("SELECT user_id FROM watchlist WHERE creator_address = ?").all(creatorAddress) as any[];
  return rows.map(row => row.user_id);
}

export function isOnWatchlist(userId: string, creatorAddress: string): boolean {
  const row = db.prepare("SELECT 1 FROM watchlist WHERE user_id = ? AND creator_address = ?")
    .get(userId, creatorAddress);
  return !!row;
}

// Alert log operations
export function logAlert(alert: InsertAlertLog): void {
  db.prepare(`
    INSERT INTO alerts_log (user_id, creator_address, token_address, alert_type, delivered)
    VALUES (?, ?, ?, ?, ?)
  `).run(alert.user_id, alert.creator_address, alert.token_address, alert.alert_type, alert.delivered);
}

export function getRecentAlerts(userId: string, limit: number = 10): AlertLog[] {
  return db.prepare("SELECT * FROM alerts_log WHERE user_id = ? ORDER BY sent_at DESC LIMIT ?")
    .all(userId, limit) as AlertLog[];
}

export function getAlertsSentToday(): number {
  const today = new Date().toISOString().split("T")[0];
  const row = db.prepare("SELECT COUNT(*) as count FROM alerts_log WHERE DATE(sent_at) = ? AND delivered = 1").get(today) as any;
  return row.count;
}

export function getAlertAttemptsTodayStats(): { delivered: number; failed: number } {
  const today = new Date().toISOString().split("T")[0];
  const delivered = db.prepare("SELECT COUNT(*) as count FROM alerts_log WHERE DATE(sent_at) = ? AND delivered = 1").get(today) as any;
  const failed = db.prepare("SELECT COUNT(*) as count FROM alerts_log WHERE DATE(sent_at) = ? AND delivered = 0").get(today) as any;
  return { delivered: delivered.count, failed: failed.count };
}

export function getAlertsByTypeToday(): { creator: number; bundle: number; watched: number } {
  const today = new Date().toISOString().split("T")[0];
  const creator = db.prepare("SELECT COUNT(*) as count FROM alerts_log WHERE DATE(sent_at) = ? AND delivered = 1 AND alert_type = 'qualified'").get(today) as any;
  const bundle = db.prepare("SELECT COUNT(*) as count FROM alerts_log WHERE DATE(sent_at) = ? AND delivered = 1 AND alert_type = 'bundle'").get(today) as any;
  const watched = db.prepare("SELECT COUNT(*) as count FROM alerts_log WHERE DATE(sent_at) = ? AND delivered = 1 AND alert_type = 'watched'").get(today) as any;
  return { creator: creator.count, bundle: bundle.count, watched: watched.count };
}

export function getDatabase(): Database.Database {
  return db;
}

// ============ SNIPER OPERATIONS ============

// Wallet operations
export function getWallet(userId: string): Wallet | undefined {
  return db.prepare("SELECT * FROM wallets WHERE user_id = ?").get(userId) as Wallet | undefined;
}

export function createWallet(wallet: InsertWallet): Wallet {
  db.prepare(`
    INSERT INTO wallets (user_id, public_key, encrypted_private_key)
    VALUES (?, ?, ?)
  `).run(wallet.user_id, wallet.public_key, wallet.encrypted_private_key);
  return getWallet(wallet.user_id)!;
}

export function updateWallet(userId: string, wallet: Partial<InsertWallet>): void {
  const fields: string[] = [];
  const values: any[] = [];
  if (wallet.public_key) { fields.push("public_key = ?"); values.push(wallet.public_key); }
  if (wallet.encrypted_private_key) { fields.push("encrypted_private_key = ?"); values.push(wallet.encrypted_private_key); }
  if (fields.length > 0) {
    values.push(userId);
    db.prepare(`UPDATE wallets SET ${fields.join(", ")} WHERE user_id = ?`).run(...values);
  }
}

export function deleteWallet(userId: string): boolean {
  const result = db.prepare("DELETE FROM wallets WHERE user_id = ?").run(userId);
  return result.changes > 0;
}

// Sniper settings operations
export function getSniperSettings(userId: string): SniperSettings | undefined {
  // Check cache first
  const cached = sniperSettingsCache.get(userId);
  if (cached) return cached;
  
  const row = db.prepare("SELECT * FROM sniper_settings WHERE user_id = ?").get(userId) as any;
  if (!row) return undefined;
  const settings = {
    ...row,
    auto_buy_enabled: Boolean(row.auto_buy_enabled),
    tp_brackets: JSON.parse(row.tp_brackets) as TakeProfitBracket[],
    bundle_auto_buy_enabled: Boolean(row.bundle_auto_buy_enabled),
    bundle_tp_brackets: row.bundle_tp_brackets ? JSON.parse(row.bundle_tp_brackets) as TakeProfitBracket[] : [
      { percentage: 50, multiplier: 2 },
      { percentage: 30, multiplier: 5 },
      { percentage: 20, multiplier: 10 },
    ],
  };
  sniperSettingsCache.set(userId, settings);
  return settings;
}

export function createSniperSettings(settings: InsertSniperSettings): SniperSettings {
  db.prepare(`
    INSERT INTO sniper_settings (user_id, auto_buy_enabled, buy_amount_sol, slippage_percent, jito_tip_sol, priority_fee_lamports, tp_brackets, moon_bag_percent, moon_bag_multiplier, stop_loss_percent, max_open_positions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    settings.user_id,
    settings.auto_buy_enabled ? 1 : 0,
    settings.buy_amount_sol,
    settings.slippage_percent,
    settings.jito_tip_sol,
    settings.priority_fee_lamports,
    JSON.stringify(settings.tp_brackets),
    settings.moon_bag_percent,
    settings.moon_bag_multiplier || 0,
    settings.stop_loss_percent,
    settings.max_open_positions ?? 5
  );
  return getSniperSettings(settings.user_id)!;
}

export function updateSniperSettings(userId: string, updates: Partial<InsertSniperSettings>): void {
  const fields: string[] = [];
  const values: any[] = [];
  
  if (updates.auto_buy_enabled !== undefined) { fields.push("auto_buy_enabled = ?"); values.push(updates.auto_buy_enabled ? 1 : 0); }
  if (updates.buy_amount_sol !== undefined) { fields.push("buy_amount_sol = ?"); values.push(updates.buy_amount_sol); }
  if (updates.slippage_percent !== undefined) { fields.push("slippage_percent = ?"); values.push(updates.slippage_percent); }
  if (updates.jito_tip_sol !== undefined) { fields.push("jito_tip_sol = ?"); values.push(updates.jito_tip_sol); }
  if (updates.priority_fee_lamports !== undefined) { fields.push("priority_fee_lamports = ?"); values.push(updates.priority_fee_lamports); }
  if (updates.tp_brackets !== undefined) { fields.push("tp_brackets = ?"); values.push(JSON.stringify(updates.tp_brackets)); }
  if (updates.moon_bag_percent !== undefined) { fields.push("moon_bag_percent = ?"); values.push(updates.moon_bag_percent); }
  if (updates.moon_bag_multiplier !== undefined) { fields.push("moon_bag_multiplier = ?"); values.push(updates.moon_bag_multiplier); }
  if (updates.stop_loss_percent !== undefined) { fields.push("stop_loss_percent = ?"); values.push(updates.stop_loss_percent); }
  if (updates.max_open_positions !== undefined) { fields.push("max_open_positions = ?"); values.push(updates.max_open_positions); }
  // Bundle sniper settings
  if (updates.bundle_auto_buy_enabled !== undefined) { fields.push("bundle_auto_buy_enabled = ?"); values.push(updates.bundle_auto_buy_enabled ? 1 : 0); }
  if (updates.bundle_buy_amount_sol !== undefined) { fields.push("bundle_buy_amount_sol = ?"); values.push(updates.bundle_buy_amount_sol); }
  if (updates.bundle_slippage_percent !== undefined) { fields.push("bundle_slippage_percent = ?"); values.push(updates.bundle_slippage_percent); }
  if (updates.bundle_jito_tip_sol !== undefined) { fields.push("bundle_jito_tip_sol = ?"); values.push(updates.bundle_jito_tip_sol); }
  if (updates.bundle_tp_brackets !== undefined) { fields.push("bundle_tp_brackets = ?"); values.push(JSON.stringify(updates.bundle_tp_brackets)); }
  if (updates.bundle_moon_bag_percent !== undefined) { fields.push("bundle_moon_bag_percent = ?"); values.push(updates.bundle_moon_bag_percent); }
  if (updates.bundle_moon_bag_multiplier !== undefined) { fields.push("bundle_moon_bag_multiplier = ?"); values.push(updates.bundle_moon_bag_multiplier); }
  if (updates.bundle_stop_loss_percent !== undefined) { fields.push("bundle_stop_loss_percent = ?"); values.push(updates.bundle_stop_loss_percent); }
  
  if (fields.length > 0) {
    fields.push("updated_at = ?");
    values.push(getCurrentTimestamp());
    values.push(userId);
    db.prepare(`UPDATE sniper_settings SET ${fields.join(", ")} WHERE user_id = ?`).run(...values);
    sniperSettingsCache.invalidate(userId);
  }
}

export function getOrCreateSniperSettings(userId: string): SniperSettings {
  let settings = getSniperSettings(userId);
  if (!settings) {
    settings = createSniperSettings({
      user_id: userId,
      auto_buy_enabled: false,
      buy_amount_sol: 0.1,
      slippage_percent: 20,
      jito_tip_sol: 0.005,
      priority_fee_lamports: 100000,
      tp_brackets: [
        { percentage: 50, multiplier: 2 },
        { percentage: 30, multiplier: 5 },
        { percentage: 20, multiplier: 10 },
      ],
      moon_bag_percent: 0,
      moon_bag_multiplier: 0,
      stop_loss_percent: 50,
      max_open_positions: 5,
    });
  }
  return settings;
}

// Position operations
export function createPosition(position: InsertPosition): Position {
  const result = db.prepare(`
    INSERT INTO positions (user_id, token_address, token_symbol, token_name, entry_price_sol, entry_amount_sol, tokens_bought, tokens_remaining, current_price_sol, unrealized_pnl_percent, status, snipe_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    position.user_id,
    position.token_address,
    position.token_symbol,
    position.token_name,
    position.entry_price_sol,
    position.entry_amount_sol,
    position.tokens_bought,
    position.tokens_remaining,
    position.current_price_sol || 0,
    position.unrealized_pnl_percent || 0,
    position.status || "open",
    position.snipe_mode || "creator"
  );
  return getPosition(result.lastInsertRowid as number)!;
}

export function getPosition(id: number): Position | undefined {
  const row = db.prepare("SELECT * FROM positions WHERE id = ?").get(id) as any;
  if (!row) return undefined;
  return {
    ...row,
    tp1_hit: Boolean(row.tp1_hit),
    tp2_hit: Boolean(row.tp2_hit),
    tp3_hit: Boolean(row.tp3_hit),
  };
}

export function getUserPositions(userId: string, status?: string): Position[] {
  let query = "SELECT * FROM positions WHERE user_id = ?";
  const params: any[] = [userId];
  if (status) {
    query += " AND status = ?";
    params.push(status);
  }
  query += " ORDER BY created_at DESC";
  const rows = db.prepare(query).all(...params) as any[];
  return rows.map(row => ({
    ...row,
    tp1_hit: Boolean(row.tp1_hit),
    tp2_hit: Boolean(row.tp2_hit),
    tp3_hit: Boolean(row.tp3_hit),
  }));
}

export function getOpenPositions(): Position[] {
  const rows = db.prepare("SELECT * FROM positions WHERE status = 'open' OR status = 'partial'").all() as any[];
  return rows.map(row => ({
    ...row,
    tp1_hit: Boolean(row.tp1_hit),
    tp2_hit: Boolean(row.tp2_hit),
    tp3_hit: Boolean(row.tp3_hit),
  }));
}

export function getUserOpenPositionCount(userId: string): number {
  const row = db.prepare("SELECT COUNT(*) as count FROM positions WHERE user_id = ? AND (status = 'open' OR status = 'partial')").get(userId) as any;
  return row?.count || 0;
}

export function updatePosition(id: number, updates: Partial<Position>): void {
  const fields: string[] = [];
  const values: any[] = [];
  
  if (updates.tokens_remaining !== undefined) { fields.push("tokens_remaining = ?"); values.push(updates.tokens_remaining); }
  if (updates.current_price_sol !== undefined) { fields.push("current_price_sol = ?"); values.push(updates.current_price_sol); }
  if (updates.unrealized_pnl_percent !== undefined) { fields.push("unrealized_pnl_percent = ?"); values.push(updates.unrealized_pnl_percent); }
  if (updates.tp1_hit !== undefined) { fields.push("tp1_hit = ?"); values.push(updates.tp1_hit ? 1 : 0); }
  if (updates.tp2_hit !== undefined) { fields.push("tp2_hit = ?"); values.push(updates.tp2_hit ? 1 : 0); }
  if (updates.tp3_hit !== undefined) { fields.push("tp3_hit = ?"); values.push(updates.tp3_hit ? 1 : 0); }
  if (updates.status !== undefined) { fields.push("status = ?"); values.push(updates.status); }
  if (updates.closed_at !== undefined) { fields.push("closed_at = ?"); values.push(updates.closed_at); }
  
  if (fields.length > 0) {
    values.push(id);
    db.prepare(`UPDATE positions SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }
}

export function closePosition(id: number): void {
  db.prepare("UPDATE positions SET status = 'closed', closed_at = ? WHERE id = ?")
    .run(getCurrentTimestamp(), id);
}

// Trade history operations
export function createTradeHistory(trade: InsertTradeHistory): TradeHistory {
  const result = db.prepare(`
    INSERT INTO trade_history (user_id, position_id, token_address, token_symbol, trade_type, amount_sol, tokens_amount, price_per_token, tx_signature, trigger_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    trade.user_id,
    trade.position_id,
    trade.token_address,
    trade.token_symbol,
    trade.trade_type,
    trade.amount_sol,
    trade.tokens_amount,
    trade.price_per_token,
    trade.tx_signature,
    trade.trigger_reason
  );
  return db.prepare("SELECT * FROM trade_history WHERE id = ?").get(result.lastInsertRowid) as TradeHistory;
}

export function getUserTradeHistory(userId: string, limit: number = 20): TradeHistory[] {
  return db.prepare("SELECT * FROM trade_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(userId, limit) as TradeHistory[];
}

import Database from "better-sqlite3";
import fs from "fs";
import { config } from "../utils/config";
import { logger } from "../utils/logger";
import { getCurrentTimestamp } from "../utils/helpers";
import type { 
  User, InsertUser, UserSettings, 
  Creator, InsertCreator, 
  Token, InsertToken,
  WatchlistEntry, InsertWatchlistEntry,
  AlertLog, InsertAlertLog 
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
  `);
}

// User operations
export function getUser(telegramId: string): User | undefined {
  const row = db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(telegramId) as any;
  if (!row) return undefined;
  return {
    ...row,
    settings: JSON.parse(row.settings),
  };
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
}

export function incrementUserAlerts(telegramId: string): void {
  db.prepare("UPDATE users SET alerts_today = alerts_today + 1 WHERE telegram_id = ?")
    .run(telegramId);
}

export function resetUserAlerts(telegramId: string): void {
  db.prepare("UPDATE users SET alerts_today = 0, last_alert_reset = ? WHERE telegram_id = ?")
    .run(getCurrentTimestamp(), telegramId);
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

export function getCreatorCount(): number {
  const row = db.prepare("SELECT COUNT(*) as count FROM creators").get() as any;
  return row.count;
}

export function getQualifiedCreatorCount(): number {
  const row = db.prepare("SELECT COUNT(*) as count FROM creators WHERE is_qualified = 1").get() as any;
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
  const row = db.prepare("SELECT COUNT(*) as count FROM alerts_log WHERE DATE(sent_at) = ?").get(today) as any;
  return row.count;
}

export function getDatabase(): Database.Database {
  return db;
}

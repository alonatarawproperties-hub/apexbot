# Apex - PumpFun Creator Tracker

## Overview

Apex is a Telegram bot that monitors PumpFun token launches in real-time and alerts users when tokens are created by historically successful creators. Success is defined by configurable thresholds including bonded token counts and market cap milestones (100K+ hits). The system tracks creator performance metrics and provides personalized alerts based on user preferences.

The application consists of four main components:
1. **Telegram Bot** - User interface for settings, watchlists, and receiving alerts
2. **Webhook Handler** - Receives real-time token creation events from Helius
3. **Dashboard** - Web interface for monitoring system status and statistics
4. **Sniper Bot** - Automated token buying with TP/SL brackets and Jito MEV protection

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Backend Architecture
- **Runtime**: Node.js with Express.js
- **Language**: TypeScript with ES modules
- **Bot Framework**: Grammy for Telegram bot functionality
- **Database**: SQLite with better-sqlite3 for local persistent storage
- **Build System**: Custom build script using esbuild for server bundling and Vite for client

### Frontend Architecture
- **Framework**: React 18 with TypeScript
- **Routing**: Wouter (lightweight router)
- **State Management**: TanStack React Query for server state
- **Styling**: Tailwind CSS with shadcn/ui component library
- **Build Tool**: Vite with path aliases (@/, @shared/, @assets/)

### Data Flow
1. Helius webhooks send PumpFun token creation events to `/webhook/helius`
2. Webhook handler parses transactions and identifies token creators
3. Creator stats are calculated and updated in SQLite
4. Qualified creators trigger alerts to subscribed Telegram users
5. Background jobs track market cap changes and aggregate statistics

### Background Jobs
- **MC Tracker** (2-minute interval): Monitors market cap changes for recent tokens
- **Stats Aggregator** (30-minute interval): Recalculates creator qualification stats
- **Position Monitor** (30-second interval): Checks TP/SL triggers for open positions

### Sniper Bot Architecture
The system has TWO independent sniper bots that can operate simultaneously:

- **Creator Sniper**: Auto-buys tokens from qualified creators (those meeting bonded/100k thresholds)
- **Bundle Sniper**: Auto-buys tokens when dev bundles are detected (significant dev buys at launch)

Each sniper has its own independent settings:
- Buy amount (SOL)
- Slippage percentage
- Jito tip (SOL)
- Take-profit brackets
- Moon bag percentage and TP multiplier
- Stop-loss percentage

Core services:
- **Wallet Service**: AES-256-GCM encrypted wallet storage with WALLET_ENCRYPTION_KEY
- **Sniper Service**: PumpFun swap execution via bonding curve calculations
- **Jito Service**: MEV-protected bundle transactions for faster execution
- **Position Monitor**: Automatic TP/SL execution using settings based on position.snipe_mode ("creator" or "bundle")

### Sniper Bot Features
- Auto-buy on qualified creator alerts OR dev bundle detection
- Customizable buy amount, slippage, and Jito tip per sniper
- Take-profit brackets (Conservative/Balanced/Aggressive presets + Straight TP option)
- Moon bag with configurable TP multiplier (or hold forever)
- Stop-loss with 100% sell
- Manual sell controls (50%/100%)
- Trade history tracking
- Max open positions limit (999 = unlimited)
- Position tracking by snipe_mode for correct TP/SL calculation

### Bundle Detection Feature
- Detects when token creators buy significant SOL amounts of their own token at launch
- Uses PumpPortal WebSocket for real-time monitoring of tokens ending in "pump"
- Dev buy calculated from marketCapSol field (mcSol - 30 baseline)
- User-configurable min/max SOL thresholds (default: 2-200 SOL)
- Separate bundle alerts enable/disable setting
- Bundle Sniper has independent settings from Creator Sniper
- Access via Telegram: /sniper -> Bundle Sniper

### Key Design Decisions
- **SQLite over PostgreSQL**: Chosen for simplicity and zero-configuration deployment. Drizzle config exists for potential PostgreSQL migration.
- **Grammy over Telegraf**: Selected for its modern TypeScript support and middleware system
- **better-sqlite3**: Synchronous API simplifies code flow for the bot's command handlers
- **Monorepo Structure**: Client, server, and shared code in single repository with TypeScript path aliases

## External Dependencies

### APIs and Services
- **Helius API**: Real-time Solana transaction monitoring via webhooks for PumpFun program events
- **DexScreener API**: Free tier for fetching token market cap data and bonding status
- **Telegram Bot API**: User interaction through Grammy framework

### Environment Variables Required
- `TELEGRAM_BOT_TOKEN` - Bot authentication token from BotFather
- `HELIUS_API_KEY` - API key for Helius webhook service
- `DATABASE_PATH` - SQLite database file location (default: ./data/apex.db)
- `WEBHOOK_SECRET` - Secret for authenticating incoming Helius webhooks
- `PORT` - Server port (default: 5000)
- `DATABASE_URL` - PostgreSQL connection string (for Drizzle migrations, optional)

### Key Program Addresses
- **PumpFun Program**: `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`

### Rate Limiting
- DexScreener API: 200ms minimum between requests
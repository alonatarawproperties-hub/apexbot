import { Bot, Context, InlineKeyboard } from "grammy";
import * as db from "../db";
import { logger } from "../utils/logger";
import { formatAddress, escapeMarkdown } from "../utils/helpers";
import { 
  generateNewWallet, 
  importWallet, 
  getWalletAddress, 
  exportPrivateKey 
} from "../services/walletService";
import { 
  snipeToken, 
  sellTokens, 
  getWalletBalance 
} from "../services/sniperService";
import type { SniperSettings, Position } from "@shared/schema";

const formatMarkdownValue = (value: string | number): string => escapeMarkdown(String(value));

// Conversation state for custom input
type InputType = "jito" | "sl" | "tp_pct" | "tp_mult" | "moon" | "buy" | "slip" | "priority";
interface PendingInput {
  type: InputType;
  tpIndex?: number; // For editing specific TP bracket
}
const pendingInputs = new Map<string, PendingInput>();

export function hasPendingInput(userId: string): boolean {
  return pendingInputs.has(userId);
}

export async function handleCustomInput(ctx: Context, text: string): Promise<boolean> {
  const userId = ctx.from?.id.toString();
  if (!userId) return false;
  
  const pending = pendingInputs.get(userId);
  if (!pending) return false;
  
  const value = parseFloat(text);
  if (isNaN(value)) {
    await ctx.reply("Please enter a valid number.");
    return true;
  }
  
  pendingInputs.delete(userId);
  const settings = db.getOrCreateSniperSettings(userId);
  
  switch (pending.type) {
    case "jito":
      if (value < 0 || value > 1) {
        await ctx.reply("Jito tip must be between 0 and 1 SOL.");
        return true;
      }
      db.updateSniperSettings(userId, { jito_tip_sol: value });
      await ctx.reply(`Jito tip set to ${value} SOL`);
      break;
    case "sl":
      if (value < 0 || value > 100) {
        await ctx.reply("Stop loss must be between 0 and 100%.");
        return true;
      }
      db.updateSniperSettings(userId, { stop_loss_percent: value });
      await ctx.reply(value === 0 ? "Stop loss disabled" : `Stop loss set to -${value}%`);
      break;
    case "moon":
      if (value < 0 || value > 100) {
        await ctx.reply("Moon bag must be between 0 and 100%.");
        return true;
      }
      db.updateSniperSettings(userId, { moon_bag_percent: value });
      await ctx.reply(`Moon bag set to ${value}%`);
      break;
    case "buy":
      if (value <= 0 || value > 100) {
        await ctx.reply("Buy amount must be between 0.001 and 100 SOL.");
        return true;
      }
      db.updateSniperSettings(userId, { buy_amount_sol: value });
      await ctx.reply(`Buy amount set to ${value} SOL`);
      break;
    case "slip":
      if (value < 1 || value > 100) {
        await ctx.reply("Slippage must be between 1 and 100%.");
        return true;
      }
      db.updateSniperSettings(userId, { slippage_percent: value });
      await ctx.reply(`Slippage set to ${value}%`);
      break;
    case "priority":
      if (value < 0) {
        await ctx.reply("Priority must be 0 or higher.");
        return true;
      }
      db.updateSniperSettings(userId, { priority_fee_lamports: Math.floor(value) });
      await ctx.reply(`Priority fee set to ${Math.floor(value)} lamports`);
      break;
    case "tp_pct":
      if (value < 1 || value > 100) {
        await ctx.reply("TP percentage must be between 1 and 100%.");
        return true;
      }
      if (pending.tpIndex !== undefined) {
        const brackets = [...(settings.tp_brackets || [])];
        if (brackets[pending.tpIndex]) {
          brackets[pending.tpIndex].percentage = value;
          db.updateSniperSettings(userId, { tp_brackets: brackets });
          await ctx.reply(`TP${pending.tpIndex + 1} percentage set to ${value}%`);
        }
      }
      break;
    case "tp_mult":
      if (value < 1.1 || value > 1000) {
        await ctx.reply("TP multiplier must be between 1.1x and 1000x.");
        return true;
      }
      if (pending.tpIndex !== undefined) {
        const brackets = [...(settings.tp_brackets || [])];
        if (brackets[pending.tpIndex]) {
          brackets[pending.tpIndex].multiplier = value;
          db.updateSniperSettings(userId, { tp_brackets: brackets });
          await ctx.reply(`TP${pending.tpIndex + 1} multiplier set to ${value}x`);
        }
      }
      break;
  }
  
  return true;
}

export function registerSniperCommands(bot: Bot): void {
  bot.command("sniper", handleSniper);
}

export function registerSniperCallbacks(bot: Bot): void {
}

async function handleSniper(ctx: Context): Promise<void> {
  const userId = ctx.from?.id.toString();
  if (!userId) return;
  
  db.getUser(userId) || db.createUser({
    telegram_id: userId,
    username: ctx.from?.username || null,
    tier: "free",
    settings: {
      min_bonded_count: 1,
      min_100k_count: 1,
      mc_hold_minutes: 5,
      lookback_days: 90,
      alert_watched_only: false,
      notifications_enabled: true,
      min_success_rate: 5,
      max_launches: 500,
    },
    alerts_today: 0,
    last_alert_reset: null,
  });
  
  const settings = db.getOrCreateSniperSettings(userId);
  const wallet = db.getWallet(userId);
  let balance = 0;
  
  if (wallet) {
    balance = await getWalletBalance(userId);
  }
  
  const keyboard = getSniperMainKeyboard();
  
  const walletStatus = wallet 
    ? `💼 Wallet: \`${formatMarkdownValue(formatAddress(wallet.public_key, 6))}\` \\- ${formatMarkdownValue(balance.toFixed(4))} SOL`
    : "💼 Wallet: Not configured";
  
  const autoBuyStatus = settings.auto_buy_enabled ? "🟢 ON" : "🔴 OFF";
  
  const message = `🎯 *SNIPER BOT*

${walletStatus}
🎯 Auto\\-Buy: ${autoBuyStatus}

⚙️ *Settings:*
├ Buy: ${formatMarkdownValue(settings.buy_amount_sol)} SOL
├ Slip: ${formatMarkdownValue(settings.slippage_percent)}%
├ Jito: ${formatMarkdownValue(settings.jito_tip_sol)} SOL
└ SL: ${formatMarkdownValue(`-${settings.stop_loss_percent}`)}%

📈 *Take Profit:*`;

  let tpMessage = "";
  const brackets = settings.tp_brackets || [];
  brackets.forEach((b, i) => {
    const prefix = i === brackets.length - 1 && settings.moon_bag_percent === 0 ? "└" : "├";
    tpMessage += `\n${prefix} TP${i + 1}: ${formatMarkdownValue(b.percentage)}% @ ${formatMarkdownValue(b.multiplier)}x`;
  });
  if (settings.moon_bag_percent > 0) {
    tpMessage += `\n└ Moon: ${formatMarkdownValue(settings.moon_bag_percent)}% keep`;
  }
  
  await ctx.reply(message + tpMessage, {
    parse_mode: "MarkdownV2",
    reply_markup: keyboard,
  });
}

function getSniperMainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("⚙️ Settings", "sniper:settings")
    .text("💼 Wallet", "sniper:wallet")
    .row()
    .text("📊 Positions", "sniper:positions")
    .text("📜 History", "sniper:history")
    .row()
    .text("← Back to Menu", "apex:start:show");
}

export async function handleSniperCallback(ctx: Context, action: string, value: string): Promise<void> {
  const userId = ctx.from?.id.toString();
  if (!userId) return;
  
  try {
    switch (action) {
      case "settings":
        await showSettingsMenu(ctx, userId);
        break;
      case "wallet":
        await showWalletMenu(ctx, userId);
        break;
      case "positions":
        await showPositionsMenu(ctx, userId);
        break;
      case "history":
        await showHistoryMenu(ctx, userId);
        break;
      case "toggle_autobuy":
        await toggleAutoBuy(ctx, userId);
        break;
      case "edit_buy":
        await promptEditBuy(ctx, userId);
        break;
      case "edit_slip":
        await promptEditSlippage(ctx, userId);
        break;
      case "edit_jito":
        await promptEditJito(ctx, userId);
        break;
      case "edit_sl":
        await promptEditStopLoss(ctx, userId);
        break;
      case "edit_tp":
        await showTPMenu(ctx, userId);
        break;
      case "new_wallet":
        await createNewWallet(ctx, userId);
        break;
      case "import_wallet":
        await promptImportWallet(ctx, userId);
        break;
      case "export_wallet":
        await exportWallet(ctx, userId);
        break;
      case "show_address":
        await showWalletAddress(ctx, userId);
        break;
      case "sell":
        await handleSellAction(ctx, userId, value);
        break;
      case "sell_all":
        await handleSellAll(ctx, userId);
        break;
      case "back":
        await handleSniper(ctx);
        break;
      case "custom":
        await promptCustomInput(ctx, userId, value as InputType);
        break;
      case "edit_tp_bracket":
        await showTPBracketEdit(ctx, userId, parseInt(value));
        break;
      case "set_tp_pct":
        await setTPBracketPct(ctx, userId, value);
        break;
      case "set_tp_mult":
        await setTPBracketMult(ctx, userId, value);
        break;
      default:
        if (action.startsWith("set_")) {
          await handleSettingUpdate(ctx, userId, action, value);
        }
    }
  } catch (error: any) {
    logger.error(`Sniper callback error: ${error.message}`);
    await ctx.answerCallbackQuery({ text: "Error processing request" });
  }
}

async function showSettingsMenu(ctx: Context, userId: string): Promise<void> {
  const settings = db.getOrCreateSniperSettings(userId);
  
  const keyboard = new InlineKeyboard()
    .text(`Buy: ${settings.buy_amount_sol} SOL`, "sniper:edit_buy")
    .text(`Slip: ${settings.slippage_percent}%`, "sniper:edit_slip")
    .row()
    .text(`Jito: ${settings.jito_tip_sol} SOL`, "sniper:edit_jito")
    .text(`SL: -${settings.stop_loss_percent}%`, "sniper:edit_sl")
    .row()
    .text("📈 Edit Take Profit", "sniper:edit_tp")
    .row()
    .text(settings.auto_buy_enabled ? "🟢 Auto-Buy ON" : "🔴 Auto-Buy OFF", "sniper:toggle_autobuy")
    .row()
    .text("← Back", "sniper:back");
  
  const brackets = settings.tp_brackets || [];
  let tpText = "";
  brackets.forEach((b, i) => {
    tpText += `\nTP${i + 1}: ${formatMarkdownValue(b.percentage)}% @ ${formatMarkdownValue(b.multiplier)}x`;
  });
  if (settings.moon_bag_percent > 0) {
    tpText += `\nMoon Bag: ${formatMarkdownValue(settings.moon_bag_percent)}%`;
  }
  
  await ctx.editMessageText(
    `⚙️ *SNIPER SETTINGS*

💰 *Buy Settings:*
├ Amount: ${formatMarkdownValue(settings.buy_amount_sol)} SOL
├ Slippage: ${formatMarkdownValue(settings.slippage_percent)}%
├ Jito Tip: ${formatMarkdownValue(settings.jito_tip_sol)} SOL
└ Priority: ${formatMarkdownValue(settings.priority_fee_lamports)} lamports

📈 *Take Profit:*${tpText}

📉 *Stop Loss:* ${formatMarkdownValue(`-${settings.stop_loss_percent}`)}%

🎯 *Auto\\-Buy:* ${settings.auto_buy_enabled ? "Enabled" : "Disabled"}`,
    {
      parse_mode: "MarkdownV2",
      reply_markup: keyboard,
    }
  );
}

async function showWalletMenu(ctx: Context, userId: string): Promise<void> {
  const wallet = db.getWallet(userId);
  
  if (!wallet) {
    const keyboard = new InlineKeyboard()
      .text("🆕 Generate New Wallet", "sniper:new_wallet")
      .row()
      .text("📥 Import Wallet", "sniper:import_wallet")
      .row()
      .text("← Back", "sniper:back");
    
    await ctx.editMessageText(
      `💼 *WALLET*

No wallet configured yet\\.

Choose an option:
• *Generate New* \\- Create a fresh wallet
• *Import* \\- Use your existing private key`,
      {
        parse_mode: "MarkdownV2",
        reply_markup: keyboard,
      }
    );
    return;
  }
  
  const balance = await getWalletBalance(userId);
  
  const keyboard = new InlineKeyboard()
    .text("📋 Copy Address", "sniper:show_address")
    .row()
    .text("🔑 Export Key", "sniper:export_wallet")
    .text("🔄 New Wallet", "sniper:new_wallet")
    .row()
    .text("← Back", "sniper:back");
  
  await ctx.editMessageText(
    `💼 *YOUR WALLET*

*Address:*
\`${wallet.public_key}\`

*Balance:* ${formatMarkdownValue(balance.toFixed(6))} SOL

⚠️ Send SOL to this address to start sniping\\.`,
    {
      parse_mode: "MarkdownV2",
      reply_markup: keyboard,
    }
  );
}

async function showPositionsMenu(ctx: Context, userId: string): Promise<void> {
  const positions = db.getUserPositions(userId, "open");
  const partialPositions = db.getUserPositions(userId, "partial");
  const allOpen = [...positions, ...partialPositions];
  
  if (allOpen.length === 0) {
    const keyboard = new InlineKeyboard()
      .text("← Back", "sniper:back");
    
    await ctx.editMessageText(
      `📊 *POSITIONS*

No open positions\\.

Positions will appear here when you snipe tokens\\.`,
      {
        parse_mode: "MarkdownV2",
        reply_markup: keyboard,
      }
    );
    return;
  }
  
  let message = `📊 *OPEN POSITIONS* \\(${allOpen.length}\\)\n\n`;
  
  const keyboard = new InlineKeyboard();
  
  for (const pos of allOpen.slice(0, 5)) {
    const pnlEmoji = pos.unrealized_pnl_percent >= 0 ? "🟢" : "🔴";
    const pnlText = pos.unrealized_pnl_percent >= 0 
      ? `+${pos.unrealized_pnl_percent.toFixed(1)}%`
      : `${pos.unrealized_pnl_percent.toFixed(1)}%`;
    
    const tokenLabel = pos.token_symbol ? formatMarkdownValue(pos.token_symbol) : formatMarkdownValue(formatAddress(pos.token_address, 6));
    message += `*${tokenLabel}*\n`;
    message += `Entry: ${formatMarkdownValue(pos.entry_amount_sol)} SOL\n`;
    message += `P&L: ${pnlEmoji} ${formatMarkdownValue(pnlText)}\n\n`;
    
    keyboard
      .text(`Sell 50% #${pos.id}`, `sniper:sell:${pos.id}:50`)
      .text(`Sell 100% #${pos.id}`, `sniper:sell:${pos.id}:100`)
      .row();
  }
  
  keyboard
    .text("🚨 SELL ALL", "sniper:sell_all")
    .row()
    .text("← Back", "sniper:back");
  
  await ctx.editMessageText(message, {
    parse_mode: "MarkdownV2",
    reply_markup: keyboard,
  });
}

async function showHistoryMenu(ctx: Context, userId: string): Promise<void> {
  const trades = db.getUserTradeHistory(userId, 10);
  
  if (trades.length === 0) {
    const keyboard = new InlineKeyboard()
      .text("← Back", "sniper:back");
    
    await ctx.editMessageText(
      `📜 *TRADE HISTORY*

No trades yet\\.`,
      {
        parse_mode: "MarkdownV2",
        reply_markup: keyboard,
      }
    );
    return;
  }
  
  let message = `📜 *RECENT TRADES*\n\n`;
  
  for (const trade of trades.slice(0, 10)) {
    const emoji = trade.trade_type === "buy" ? "🟢" : "🔴";
    const type = trade.trade_type.toUpperCase();
    const tradeSymbol = trade.token_symbol ? formatMarkdownValue(trade.token_symbol) : "???";
    message += `${emoji} ${formatMarkdownValue(type)} ${tradeSymbol}\n`;
    message += `${formatMarkdownValue(trade.amount_sol.toFixed(4))} SOL\n\n`;
  }
  
  const keyboard = new InlineKeyboard()
    .text("← Back", "sniper:back");
  
  await ctx.editMessageText(message, {
    parse_mode: "MarkdownV2",
    reply_markup: keyboard,
  });
}

async function toggleAutoBuy(ctx: Context, userId: string): Promise<void> {
  const settings = db.getOrCreateSniperSettings(userId);
  const wallet = db.getWallet(userId);
  
  if (!wallet && !settings.auto_buy_enabled) {
    await ctx.answerCallbackQuery({ 
      text: "Configure wallet first!", 
      show_alert: true 
    });
    return;
  }
  
  db.updateSniperSettings(userId, { 
    auto_buy_enabled: !settings.auto_buy_enabled 
  });
  
  await ctx.answerCallbackQuery({ 
    text: settings.auto_buy_enabled ? "Auto-Buy disabled" : "Auto-Buy enabled!" 
  });
  
  await showSettingsMenu(ctx, userId);
}

async function createNewWallet(ctx: Context, userId: string): Promise<void> {
  const { publicKey } = generateNewWallet(userId);
  
  await ctx.answerCallbackQuery({ text: "New wallet generated!" });
  
  await ctx.editMessageText(
    `✅ *NEW WALLET CREATED*

*Address:*
\`${publicKey}\`

⚠️ *IMPORTANT:* Export and save your private key\\!
Send SOL to this address to start sniping\\.`,
    {
      parse_mode: "MarkdownV2",
      reply_markup: new InlineKeyboard()
        .text("🔑 Export Key", "sniper:export_wallet")
        .row()
        .text("← Back", "sniper:wallet"),
    }
  );
}

async function promptImportWallet(ctx: Context, userId: string): Promise<void> {
  await ctx.editMessageText(
    `📥 *IMPORT WALLET*

Send your private key in one of these formats:
• Base64 \\(88 characters\\)
• Hex \\(128 characters\\)
• JSON array \\[1,2,3\\.\\.\\.\\]

⚠️ Your key will be encrypted and stored securely\\.

Reply with your private key:`,
    {
      parse_mode: "MarkdownV2",
      reply_markup: new InlineKeyboard()
        .text("← Cancel", "sniper:wallet"),
    }
  );
}

async function exportWallet(ctx: Context, userId: string): Promise<void> {
  const privateKey = exportPrivateKey(userId);
  
  if (!privateKey) {
    await ctx.answerCallbackQuery({ text: "No wallet found" });
    return;
  }
  
  await ctx.reply(
    `🔑 *YOUR PRIVATE KEY*

⚠️ *NEVER SHARE THIS WITH ANYONE\\!*

\`${escapeMarkdown(privateKey)}\`

This message will NOT auto\\-delete\\. Delete it manually after saving\\.`,
    {
      parse_mode: "MarkdownV2",
    }
  );
  
  await ctx.answerCallbackQuery({ text: "Key sent in private message" });
}

async function showWalletAddress(ctx: Context, userId: string): Promise<void> {
  const wallet = db.getWallet(userId);
  if (!wallet) {
    await ctx.answerCallbackQuery({ text: "No wallet found" });
    return;
  }
  
  await ctx.reply(`\`${wallet.public_key}\``, { parse_mode: "MarkdownV2" });
  await ctx.answerCallbackQuery({ text: "Address sent!" });
}

async function handleSellAction(ctx: Context, userId: string, value: string): Promise<void> {
  const [positionId, percent] = value.split(":");
  
  const result = await sellTokens(
    userId,
    parseInt(positionId),
    parseInt(percent),
    "manual_sell"
  );
  
  if (result.success) {
    await ctx.answerCallbackQuery({ text: `Sold ${percent}%!` });
    await showPositionsMenu(ctx, userId);
  } else {
    await ctx.answerCallbackQuery({ 
      text: result.error || "Sell failed", 
      show_alert: true 
    });
  }
}

async function handleSellAll(ctx: Context, userId: string): Promise<void> {
  const positions = db.getUserPositions(userId, "open");
  const partialPositions = db.getUserPositions(userId, "partial");
  const allOpen = [...positions, ...partialPositions];
  
  let sold = 0;
  for (const pos of allOpen) {
    const result = await sellTokens(userId, pos.id, 100, "force_sell_all");
    if (result.success) sold++;
  }
  
  await ctx.answerCallbackQuery({ text: `Sold ${sold} positions` });
  await showPositionsMenu(ctx, userId);
}

async function promptEditBuy(ctx: Context, userId: string): Promise<void> {
  await ctx.editMessageText(
    `💰 *EDIT BUY AMOUNT*

Current: ${formatMarkdownValue(db.getOrCreateSniperSettings(userId).buy_amount_sol)} SOL

Select amount:`,
    {
      parse_mode: "MarkdownV2",
      reply_markup: new InlineKeyboard()
        .text("0.05", "sniper:set_buy:0.05")
        .text("0.1", "sniper:set_buy:0.1")
        .text("0.25", "sniper:set_buy:0.25")
        .row()
        .text("0.5", "sniper:set_buy:0.5")
        .text("1.0", "sniper:set_buy:1")
        .text("2.0", "sniper:set_buy:2")
        .row()
        .text("Custom...", "sniper:custom:buy")
        .row()
        .text("← Back", "sniper:settings"),
    }
  );
}

async function promptEditSlippage(ctx: Context, userId: string): Promise<void> {
  await ctx.editMessageText(
    `📊 *EDIT SLIPPAGE*

Current: ${formatMarkdownValue(db.getOrCreateSniperSettings(userId).slippage_percent)}%

Select slippage:`,
    {
      parse_mode: "MarkdownV2",
      reply_markup: new InlineKeyboard()
        .text("10%", "sniper:set_slip:10")
        .text("15%", "sniper:set_slip:15")
        .text("20%", "sniper:set_slip:20")
        .row()
        .text("25%", "sniper:set_slip:25")
        .text("30%", "sniper:set_slip:30")
        .text("50%", "sniper:set_slip:50")
        .row()
        .text("Custom...", "sniper:custom:slip")
        .row()
        .text("← Back", "sniper:settings"),
    }
  );
}

async function promptEditJito(ctx: Context, userId: string): Promise<void> {
  await ctx.editMessageText(
    `⚡ *EDIT JITO TIP*

Current: ${formatMarkdownValue(db.getOrCreateSniperSettings(userId).jito_tip_sol)} SOL

Higher tip \\= faster execution

Select tip or type custom value:`,
    {
      parse_mode: "MarkdownV2",
      reply_markup: new InlineKeyboard()
        .text("0.001", "sniper:set_jito:0.001")
        .text("0.003", "sniper:set_jito:0.003")
        .text("0.005", "sniper:set_jito:0.005")
        .row()
        .text("0.01", "sniper:set_jito:0.01")
        .text("0.02", "sniper:set_jito:0.02")
        .text("0.05", "sniper:set_jito:0.05")
        .row()
        .text("Custom...", "sniper:custom:jito")
        .row()
        .text("← Back", "sniper:settings"),
    }
  );
}

async function promptEditStopLoss(ctx: Context, userId: string): Promise<void> {
  await ctx.editMessageText(
    `📉 *EDIT STOP LOSS*

Current: ${formatMarkdownValue(`-${db.getOrCreateSniperSettings(userId).stop_loss_percent}`)}%

Sells 100% when price drops this much\\.

Select stop loss or type custom value:`,
    {
      parse_mode: "MarkdownV2",
      reply_markup: new InlineKeyboard()
        .text("-20%", "sniper:set_sl:20")
        .text("-30%", "sniper:set_sl:30")
        .text("-40%", "sniper:set_sl:40")
        .row()
        .text("-50%", "sniper:set_sl:50")
        .text("-70%", "sniper:set_sl:70")
        .text("OFF", "sniper:set_sl:0")
        .row()
        .text("Custom...", "sniper:custom:sl")
        .row()
        .text("← Back", "sniper:settings"),
    }
  );
}

async function showTPMenu(ctx: Context, userId: string): Promise<void> {
  const settings = db.getOrCreateSniperSettings(userId);
  const brackets = settings.tp_brackets || [];
  
  let tpText = "";
  brackets.forEach((b, i) => {
    tpText += `TP${i + 1}: ${formatMarkdownValue(b.percentage)}% @ ${formatMarkdownValue(b.multiplier)}x\n`;
  });
  tpText += `Moon Bag: ${formatMarkdownValue(settings.moon_bag_percent)}%`;
  
  await ctx.editMessageText(
    `📈 *TAKE PROFIT BRACKETS*

${tpText}

Select preset or edit individual brackets:`,
    {
      parse_mode: "MarkdownV2",
      reply_markup: new InlineKeyboard()
        .text("Conservative", "sniper:set_tp:conservative")
        .text("Balanced", "sniper:set_tp:balanced")
        .text("Aggressive", "sniper:set_tp:aggressive")
        .row()
        .text("Edit TP1", "sniper:edit_tp_bracket:0")
        .text("Edit TP2", "sniper:edit_tp_bracket:1")
        .text("Edit TP3", "sniper:edit_tp_bracket:2")
        .row()
        .text("Moon Bag 10%", "sniper:set_moon:10")
        .text("Moon Bag 20%", "sniper:set_moon:20")
        .text("Custom", "sniper:custom:moon")
        .row()
        .text("← Back", "sniper:settings"),
    }
  );
}

async function promptCustomInput(ctx: Context, userId: string, inputType: InputType): Promise<void> {
  pendingInputs.set(userId, { type: inputType });
  
  const prompts: Record<InputType, string> = {
    jito: "Enter your custom Jito tip in SOL (e.g., 0.007):",
    sl: "Enter your custom stop loss percentage (e.g., 35 for -35%):",
    moon: "Enter your custom moon bag percentage (e.g., 15):",
    buy: "Enter your custom buy amount in SOL (e.g., 0.25):",
    slip: "Enter your custom slippage percentage (e.g., 25):",
    priority: "Enter priority fee in lamports (e.g., 50000):",
    tp_pct: "Enter TP percentage to sell (1-100):",
    tp_mult: "Enter TP multiplier target (e.g., 3 for 3x):",
  };
  
  await ctx.answerCallbackQuery();
  await ctx.reply(prompts[inputType] || "Enter your value:");
}

async function showTPBracketEdit(ctx: Context, userId: string, bracketIndex: number): Promise<void> {
  const settings = db.getOrCreateSniperSettings(userId);
  const brackets = settings.tp_brackets || [];
  const bracket = brackets[bracketIndex];
  
  if (!bracket) {
    await ctx.answerCallbackQuery({ text: "Bracket not found" });
    return;
  }
  
  await ctx.editMessageText(
    `📈 *EDIT TP${bracketIndex + 1}*

Current: ${formatMarkdownValue(bracket.percentage)}% @ ${formatMarkdownValue(bracket.multiplier)}x

This sells ${formatMarkdownValue(bracket.percentage)}% of your position when price reaches ${formatMarkdownValue(bracket.multiplier)}x\\.`,
    {
      parse_mode: "MarkdownV2",
      reply_markup: new InlineKeyboard()
        .text("10%", `sniper:set_tp_pct:${bracketIndex}:10`)
        .text("20%", `sniper:set_tp_pct:${bracketIndex}:20`)
        .text("30%", `sniper:set_tp_pct:${bracketIndex}:30`)
        .text("50%", `sniper:set_tp_pct:${bracketIndex}:50`)
        .row()
        .text("2x", `sniper:set_tp_mult:${bracketIndex}:2`)
        .text("3x", `sniper:set_tp_mult:${bracketIndex}:3`)
        .text("5x", `sniper:set_tp_mult:${bracketIndex}:5`)
        .text("10x", `sniper:set_tp_mult:${bracketIndex}:10`)
        .row()
        .text("20x", `sniper:set_tp_mult:${bracketIndex}:20`)
        .text("50x", `sniper:set_tp_mult:${bracketIndex}:50`)
        .text("100x", `sniper:set_tp_mult:${bracketIndex}:100`)
        .row()
        .text("← Back to TP", "sniper:edit_tp"),
    }
  );
}

async function setTPBracketPct(ctx: Context, userId: string, value: string): Promise<void> {
  const [indexStr, pctStr] = value.split(":");
  const index = parseInt(indexStr);
  const pct = parseFloat(pctStr);
  
  const settings = db.getOrCreateSniperSettings(userId);
  const brackets = [...(settings.tp_brackets || [])];
  
  if (brackets[index]) {
    brackets[index].percentage = pct;
    db.updateSniperSettings(userId, { tp_brackets: brackets });
    await ctx.answerCallbackQuery({ text: `TP${index + 1} sell: ${pct}%` });
    await showTPBracketEdit(ctx, userId, index);
  }
}

async function setTPBracketMult(ctx: Context, userId: string, value: string): Promise<void> {
  const [indexStr, multStr] = value.split(":");
  const index = parseInt(indexStr);
  const mult = parseFloat(multStr);
  
  const settings = db.getOrCreateSniperSettings(userId);
  const brackets = [...(settings.tp_brackets || [])];
  
  if (brackets[index]) {
    brackets[index].multiplier = mult;
    db.updateSniperSettings(userId, { tp_brackets: brackets });
    await ctx.answerCallbackQuery({ text: `TP${index + 1} target: ${mult}x` });
    await showTPBracketEdit(ctx, userId, index);
  }
}

async function handleSettingUpdate(ctx: Context, userId: string, action: string, value: string): Promise<void> {
  const setting = action.replace("set_", "");
  
  switch (setting) {
    case "buy":
      db.updateSniperSettings(userId, { buy_amount_sol: parseFloat(value) });
      await ctx.answerCallbackQuery({ text: `Buy amount: ${value} SOL` });
      break;
    case "slip":
      db.updateSniperSettings(userId, { slippage_percent: parseFloat(value) });
      await ctx.answerCallbackQuery({ text: `Slippage: ${value}%` });
      break;
    case "jito":
      db.updateSniperSettings(userId, { jito_tip_sol: parseFloat(value) });
      await ctx.answerCallbackQuery({ text: `Jito tip: ${value} SOL` });
      break;
    case "sl":
      db.updateSniperSettings(userId, { stop_loss_percent: parseFloat(value) });
      await ctx.answerCallbackQuery({ text: value === "0" ? "Stop loss disabled" : `Stop loss: -${value}%` });
      break;
    case "tp":
      const presets: Record<string, any> = {
        conservative: [
          { percentage: 50, multiplier: 1.5 },
          { percentage: 30, multiplier: 2 },
          { percentage: 20, multiplier: 3 },
        ],
        balanced: [
          { percentage: 50, multiplier: 2 },
          { percentage: 30, multiplier: 5 },
          { percentage: 20, multiplier: 10 },
        ],
        aggressive: [
          { percentage: 30, multiplier: 3 },
          { percentage: 30, multiplier: 10 },
          { percentage: 40, multiplier: 50 },
        ],
      };
      if (presets[value]) {
        db.updateSniperSettings(userId, { tp_brackets: presets[value] });
        await ctx.answerCallbackQuery({ text: `TP preset: ${value}` });
      }
      break;
    case "moon":
      db.updateSniperSettings(userId, { moon_bag_percent: parseFloat(value) });
      await ctx.answerCallbackQuery({ text: `Moon bag: ${value}%` });
      break;
  }
  
  await showSettingsMenu(ctx, userId);
}

export async function handlePrivateKeyImport(ctx: Context, privateKey: string): Promise<boolean> {
  const userId = ctx.from?.id.toString();
  if (!userId) return false;
  
  const result = importWallet(userId, privateKey.trim());
  
  if (result) {
    await ctx.reply(
      `✅ *WALLET IMPORTED*

*Address:*
\`${result.publicKey}\`

Your wallet is now ready for sniping\\.`,
      { parse_mode: "MarkdownV2" }
    );
    return true;
  } else {
    await ctx.reply(
      `❌ *IMPORT FAILED*

Invalid private key format\\. Use:
• Base64 \\(88 characters\\)
• Hex \\(128 characters\\)
• JSON array`,
      { parse_mode: "MarkdownV2" }
    );
    return false;
  }
}

import { 
  Connection, 
  PublicKey, 
  Transaction, 
  SystemProgram,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { logger } from "../utils/logger";
import * as db from "../db";
import { getUserKeypair } from "./walletService";
import { sendBundle, getTipAccount } from "./jitoService";
import type { SniperSettings, Position, Token } from "@shared/schema";

const PUMPFUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

function getConnection(): Connection {
  const rpcUrl = process.env.HELIUS_RPC_URL || 
    `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` ||
    "https://api.mainnet-beta.solana.com";
  return new Connection(rpcUrl, "confirmed");
}

export interface SnipeResult {
  success: boolean;
  txSignature?: string;
  position?: Position;
  error?: string;
  tokensBought?: number;
}

export async function snipeToken(
  userId: string,
  tokenAddress: string,
  tokenSymbol: string | null,
  tokenName: string | null,
  buyAmountOverride?: number,
  mode: "creator" | "bundle" = "creator"
): Promise<SnipeResult> {
  const keypair = getUserKeypair(userId);
  if (!keypair) {
    return { success: false, error: "No wallet configured. Use /sniper -> Wallet to set up." };
  }
  
  const settings = db.getOrCreateSniperSettings(userId);
  
  // Use bundle-specific settings if mode is "bundle"
  const actualBuyAmount = buyAmountOverride ?? (mode === "bundle" ? settings.bundle_buy_amount_sol : settings.buy_amount_sol) ?? 0.1;
  const jitoTip = mode === "bundle" ? (settings.bundle_jito_tip_sol ?? 0.005) : settings.jito_tip_sol;
  const slippage = mode === "bundle" ? (settings.bundle_slippage_percent ?? 20) : settings.slippage_percent;
  
  const connection = getConnection();
  const balance = await connection.getBalance(keypair.publicKey);
  const buyAmountLamports = actualBuyAmount * LAMPORTS_PER_SOL;
  const jitoTipLamports = jitoTip * LAMPORTS_PER_SOL;
  const totalNeeded = buyAmountLamports + jitoTipLamports + 10000;
  
  if (balance < totalNeeded) {
    return { 
      success: false, 
      error: `Insufficient balance. Need ${(totalNeeded / LAMPORTS_PER_SOL).toFixed(4)} SOL, have ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL` 
    };
  }
  
  try {
    const tokenMint = new PublicKey(tokenAddress);
    
    const transaction = new Transaction();
    
    transaction.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: settings.priority_fee_lamports,
      })
    );
    
    transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: 200000,
      })
    );
    
    const tipAccount = getTipAccount();
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: tipAccount,
        lamports: jitoTipLamports,
      })
    );
    
    const pumpfunBuyIx = await createPumpFunBuyInstruction(
      keypair.publicKey,
      tokenMint,
      buyAmountLamports,
      settings.slippage_percent
    );
    
    if (pumpfunBuyIx) {
      transaction.add(pumpfunBuyIx);
    } else {
      return { success: false, error: "Failed to create PumpFun buy instruction" };
    }
    
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = keypair.publicKey;
    transaction.sign(keypair);
    
    const bundleResult = await sendBundle([transaction], [keypair]);
    
    if (!bundleResult.success) {
      const txSignature = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: true,
        maxRetries: 3,
      });
      
      const confirmation = await connection.confirmTransaction(txSignature, "confirmed");
      
      if (confirmation.value.err) {
        return { success: false, error: `Transaction failed: ${JSON.stringify(confirmation.value.err)}` };
      }
      
      const tokensBought = await getTokenBalance(connection, keypair.publicKey, tokenMint);
      const entryPrice = tokensBought > 0 ? actualBuyAmount / tokensBought : 0;
      
      const position = db.createPosition({
        user_id: userId,
        token_address: tokenAddress,
        token_symbol: tokenSymbol,
        token_name: tokenName,
        entry_price_sol: entryPrice,
        entry_amount_sol: actualBuyAmount,
        tokens_bought: tokensBought,
        tokens_remaining: tokensBought,
        current_price_sol: entryPrice,
        unrealized_pnl_percent: 0,
        tp1_hit: false,
        tp2_hit: false,
        tp3_hit: false,
        status: "open",
        snipe_mode: mode,
      });
      
      db.createTradeHistory({
        user_id: userId,
        position_id: position.id,
        token_address: tokenAddress,
        token_symbol: tokenSymbol,
        trade_type: "buy",
        amount_sol: settings.buy_amount_sol,
        tokens_amount: tokensBought,
        price_per_token: entryPrice,
        tx_signature: txSignature,
        trigger_reason: "auto_snipe",
      });
      
      logger.info(`Sniped ${tokenSymbol || tokenAddress.slice(0, 8)} for user ${userId}: ${tokensBought} tokens`);
      
      return { 
        success: true, 
        txSignature, 
        position,
        tokensBought,
      };
    }
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const tokensBought = await getTokenBalance(connection, keypair.publicKey, new PublicKey(tokenAddress));
    const entryPrice = tokensBought > 0 ? actualBuyAmount / tokensBought : 0;
    
    const position = db.createPosition({
      user_id: userId,
      token_address: tokenAddress,
      token_symbol: tokenSymbol,
      token_name: tokenName,
      entry_price_sol: entryPrice,
      entry_amount_sol: actualBuyAmount,
      tokens_bought: tokensBought,
      tokens_remaining: tokensBought,
      current_price_sol: entryPrice,
      unrealized_pnl_percent: 0,
      tp1_hit: false,
      tp2_hit: false,
      tp3_hit: false,
      status: "open",
      snipe_mode: mode,
    });
    
    db.createTradeHistory({
      user_id: userId,
      position_id: position.id,
      token_address: tokenAddress,
      token_symbol: tokenSymbol,
      trade_type: "buy",
      amount_sol: actualBuyAmount,
      tokens_amount: tokensBought,
      price_per_token: entryPrice,
      tx_signature: bundleResult.bundleId || null,
      trigger_reason: mode === "bundle" ? "bundle_snipe_jito" : "auto_snipe_jito",
    });
    
    logger.info(`Jito sniped ${tokenSymbol || tokenAddress.slice(0, 8)} for user ${userId}: ${tokensBought} tokens`);
    
    return { 
      success: true, 
      txSignature: bundleResult.bundleId, 
      position,
      tokensBought,
    };
    
  } catch (error: any) {
    logger.error(`Snipe failed for user ${userId}: ${error.message}`);
    return { success: false, error: error.message };
  }
}

export async function sellTokens(
  userId: string,
  positionId: number,
  percentToSell: number,
  triggerReason: string
): Promise<SnipeResult> {
  const keypair = getUserKeypair(userId);
  if (!keypair) {
    return { success: false, error: "No wallet configured" };
  }
  
  const position = db.getPosition(positionId);
  if (!position) {
    return { success: false, error: "Position not found" };
  }
  
  if (position.tokens_remaining <= 0) {
    return { success: false, error: "No tokens to sell" };
  }
  
  const settings = db.getOrCreateSniperSettings(userId);
  const connection = getConnection();
  
  try {
    const tokensToSell = position.tokens_remaining * (percentToSell / 100);
    const tokenMint = new PublicKey(position.token_address);
    
    const transaction = new Transaction();
    
    transaction.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: settings.priority_fee_lamports,
      })
    );
    
    transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: 200000,
      })
    );
    
    const jitoTipLamports = settings.jito_tip_sol * LAMPORTS_PER_SOL;
    const tipAccount = getTipAccount();
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: tipAccount,
        lamports: jitoTipLamports,
      })
    );
    
    const pumpfunSellIx = await createPumpFunSellInstruction(
      keypair.publicKey,
      tokenMint,
      tokensToSell,
      settings.slippage_percent
    );
    
    if (pumpfunSellIx) {
      transaction.add(pumpfunSellIx);
    } else {
      return { success: false, error: "Failed to create PumpFun sell instruction" };
    }
    
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = keypair.publicKey;
    transaction.sign(keypair);
    
    const txSignature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });
    
    await connection.confirmTransaction(txSignature, "confirmed");
    
    const newRemaining = position.tokens_remaining - tokensToSell;
    const soldValue = tokensToSell * position.current_price_sol;
    
    db.updatePosition(positionId, {
      tokens_remaining: newRemaining,
      status: newRemaining <= 0 ? "closed" : "partial",
      closed_at: newRemaining <= 0 ? new Date().toISOString() : null,
    });
    
    db.createTradeHistory({
      user_id: userId,
      position_id: positionId,
      token_address: position.token_address,
      token_symbol: position.token_symbol,
      trade_type: "sell",
      amount_sol: soldValue,
      tokens_amount: tokensToSell,
      price_per_token: position.current_price_sol,
      tx_signature: txSignature,
      trigger_reason: triggerReason,
    });
    
    logger.info(`Sold ${percentToSell}% of position ${positionId} for user ${userId}: ${tokensToSell} tokens`);
    
    return { 
      success: true, 
      txSignature,
      tokensBought: tokensToSell,
    };
    
  } catch (error: any) {
    logger.error(`Sell failed for user ${userId}, position ${positionId}: ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function createPumpFunBuyInstruction(
  buyer: PublicKey,
  tokenMint: PublicKey,
  amountLamports: number,
  slippagePercent: number
): Promise<TransactionInstruction | null> {
  return new TransactionInstruction({
    keys: [
      { pubkey: buyer, isSigner: true, isWritable: true },
      { pubkey: tokenMint, isSigner: false, isWritable: true },
      { pubkey: PUMPFUN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: PUMPFUN_PROGRAM_ID,
    data: Buffer.from([]),
  });
}

async function createPumpFunSellInstruction(
  seller: PublicKey,
  tokenMint: PublicKey,
  tokenAmount: number,
  slippagePercent: number
): Promise<TransactionInstruction | null> {
  return new TransactionInstruction({
    keys: [
      { pubkey: seller, isSigner: true, isWritable: true },
      { pubkey: tokenMint, isSigner: false, isWritable: true },
      { pubkey: PUMPFUN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: PUMPFUN_PROGRAM_ID,
    data: Buffer.from([]),
  });
}

async function getTokenBalance(connection: Connection, owner: PublicKey, mint: PublicKey): Promise<number> {
  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(owner, { mint });
    if (tokenAccounts.value.length > 0) {
      const balance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
      return balance || 0;
    }
    return 0;
  } catch (error) {
    return 0;
  }
}

export async function getWalletBalance(userId: string): Promise<number> {
  const keypair = getUserKeypair(userId);
  if (!keypair) return 0;
  
  try {
    const connection = getConnection();
    const balance = await connection.getBalance(keypair.publicKey);
    return balance / LAMPORTS_PER_SOL;
  } catch (error) {
    return 0;
  }
}

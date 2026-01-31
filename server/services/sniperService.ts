import { 
  Connection, 
  PublicKey, 
  Transaction, 
  SystemProgram,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
  TransactionInstruction,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import { logger } from "../utils/logger";
import * as db from "../db";
import { getUserKeypair } from "./walletService";
import { sendBundle, getTipAccount } from "./jitoService";
import type { SniperSettings, Position, Token } from "@shared/schema";

const PUMPFUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMPPORTAL_API_URL = "https://pumpportal.fun/api/trade-local";

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

async function getPumpPortalTransaction(
  publicKey: string,
  mint: string,
  action: "buy" | "sell",
  amount: number,
  slippage: number,
  priorityFee: number,
  denominatedInSol: boolean = true
): Promise<{ success: boolean; txBytes?: Uint8Array; error?: string }> {
  try {
    const response = await fetch(PUMPPORTAL_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        publicKey,
        action,
        mint,
        denominatedInSol: denominatedInSol.toString(),
        amount,
        slippage,
        priorityFee,
        pool: "pump"
      })
    });
    
    if (response.status === 200) {
      const data = await response.arrayBuffer();
      return { success: true, txBytes: new Uint8Array(data) };
    } else {
      const errorText = await response.text();
      logger.error(`PumpPortal API error: ${response.status} - ${errorText}`);
      return { success: false, error: `PumpPortal error: ${errorText}` };
    }
  } catch (error: any) {
    logger.error(`PumpPortal request failed: ${error.message}`);
    return { success: false, error: error.message };
  }
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
  const priorityFee = settings.priority_fee_lamports / 1_000_000; // Convert lamports to SOL for API
  
  const connection = getConnection();
  const balance = await connection.getBalance(keypair.publicKey);
  const buyAmountLamports = actualBuyAmount * LAMPORTS_PER_SOL;
  const jitoTipLamports = jitoTip * LAMPORTS_PER_SOL;
  const totalNeeded = buyAmountLamports + jitoTipLamports + 50000; // Extra for fees
  
  if (balance < totalNeeded) {
    return { 
      success: false, 
      error: `Insufficient balance. Need ${(totalNeeded / LAMPORTS_PER_SOL).toFixed(4)} SOL, have ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL` 
    };
  }
  
  try {
    const tokenMint = new PublicKey(tokenAddress);
    
    // Get transaction from PumpPortal API
    const txResult = await getPumpPortalTransaction(
      keypair.publicKey.toBase58(),
      tokenAddress,
      "buy",
      actualBuyAmount,
      slippage,
      priorityFee > 0 ? priorityFee : 0.0001 // Minimum priority fee
    );
    
    if (!txResult.success || !txResult.txBytes) {
      return { success: false, error: txResult.error || "Failed to get transaction from PumpPortal" };
    }
    
    // Deserialize the versioned transaction
    let tx: VersionedTransaction;
    try {
      tx = VersionedTransaction.deserialize(txResult.txBytes);
    } catch (e) {
      logger.error(`Failed to deserialize transaction: ${e}`);
      return { success: false, error: "Failed to parse transaction" };
    }
    
    // Sign the transaction
    tx.sign([keypair]);
    
    // Try to send via Jito bundle first for MEV protection
    let txSignature: string | undefined;
    let usedJito = false;
    
    if (jitoTip > 0) {
      // Create a tip transaction and bundle it
      const tipTransaction = new Transaction();
      tipTransaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 10000 })
      );
      tipTransaction.add(
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: getTipAccount(),
          lamports: jitoTipLamports,
        })
      );
      
      const { blockhash } = await connection.getLatestBlockhash();
      tipTransaction.recentBlockhash = blockhash;
      tipTransaction.feePayer = keypair.publicKey;
      tipTransaction.sign(keypair);
      
      // Send both transactions as a bundle
      // Note: For now, send main tx directly since PumpPortal tx is already signed
      // Jito bundles work better with legacy transactions
    }
    
    // Send the versioned transaction directly
    try {
      txSignature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        maxRetries: 3,
      });
      
      logger.info(`Transaction sent: ${txSignature}`);
      
      // Try to confirm with timeout, but don't fail if it times out
      let confirmed = false;
      let confirmError: string | null = null;
      
      try {
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        const confirmation = await Promise.race([
          connection.confirmTransaction({
            signature: txSignature,
            blockhash,
            lastValidBlockHeight,
          }, "confirmed"),
          new Promise<null>((_, reject) => 
            setTimeout(() => reject(new Error("Confirmation timeout")), 60000)
          )
        ]);
        
        if (confirmation && typeof confirmation === 'object' && 'value' in confirmation) {
          if (confirmation.value.err) {
            const errorStr = JSON.stringify(confirmation.value.err);
            
            if (errorStr.includes('"Custom":101')) {
              confirmError = "Slippage exceeded - try increasing slippage";
            } else if (errorStr.includes('"Custom":100')) {
              confirmError = "Insufficient funds in wallet";
            } else if (errorStr.includes('"Custom":102')) {
              confirmError = "Token not available for trading";
            } else if (errorStr.includes('"Custom":6000')) {
              confirmError = "Bonding curve complete - token graduated";
            } else if (errorStr.includes('InsufficientFunds')) {
              confirmError = "Insufficient SOL balance";
            } else {
              confirmError = errorStr;
            }
          } else {
            confirmed = true;
          }
        }
      } catch (confirmErr: any) {
        // Timeout or other confirmation error - transaction may still have succeeded
        logger.warn(`Confirmation uncertain for ${txSignature}: ${confirmErr.message}`);
      }
      
      if (confirmError) {
        return { success: false, error: confirmError };
      }
      
      // If not confirmed but no error, check if transaction exists on-chain
      if (!confirmed) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        try {
          const status = await connection.getSignatureStatus(txSignature);
          if (status.value?.err) {
            return { success: false, error: "Transaction failed on-chain" };
          }
          // Transaction exists and no error - likely succeeded
          confirmed = status.value !== null;
        } catch (e) {
          // Continue anyway - we'll check token balance
        }
      }
      
    } catch (sendError: any) {
      logger.error(`Transaction send failed: ${sendError.message}`);
      return { success: false, error: `Send failed: ${sendError.message}` };
    }
    
    // Wait a moment for token account to update
    await new Promise(resolve => setTimeout(resolve, 2000));
    
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
      amount_sol: actualBuyAmount,
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
    
  } catch (error: any) {
    logger.error(`Snipe failed for user ${userId}: ${error.message}`);
    return { success: false, error: error.message };
  }
}

export async function sellPosition(
  userId: string,
  positionId: number,
  sellPercentage: number = 100,
  reason: string = "manual"
): Promise<SnipeResult> {
  const keypair = getUserKeypair(userId);
  if (!keypair) {
    return { success: false, error: "No wallet configured" };
  }
  
  const position = db.getPosition(positionId);
  if (!position || position.user_id !== userId) {
    return { success: false, error: "Position not found" };
  }
  
  const settings = db.getOrCreateSniperSettings(userId);
  const slippage = position.snipe_mode === "bundle" 
    ? (settings.bundle_slippage_percent ?? 20) 
    : settings.slippage_percent;
  const priorityFee = settings.priority_fee_lamports / 1_000_000;
  
  const connection = getConnection();
  const tokenMint = new PublicKey(position.token_address);
  
  try {
    // Get current token balance
    const currentBalance = await getTokenBalance(connection, keypair.publicKey, tokenMint);
    if (currentBalance <= 0) {
      db.updatePosition(positionId, { status: "closed" });
      return { success: false, error: "No tokens to sell" };
    }
    
    const tokensToSell = (currentBalance * sellPercentage) / 100;
    
    // Get sell transaction from PumpPortal API
    const txResult = await getPumpPortalTransaction(
      keypair.publicKey.toBase58(),
      position.token_address,
      "sell",
      sellPercentage === 100 ? currentBalance : tokensToSell,
      slippage,
      priorityFee > 0 ? priorityFee : 0.0001,
      false // denominatedInSol = false for selling tokens
    );
    
    if (!txResult.success || !txResult.txBytes) {
      return { success: false, error: txResult.error || "Failed to get sell transaction" };
    }
    
    // Deserialize and sign
    let tx: VersionedTransaction;
    try {
      tx = VersionedTransaction.deserialize(txResult.txBytes);
    } catch (e) {
      return { success: false, error: "Failed to parse sell transaction" };
    }
    
    tx.sign([keypair]);
    
    // Send transaction
    const txSignature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });
    
    const confirmation = await connection.confirmTransaction(txSignature, "confirmed");
    
    if (confirmation.value.err) {
      const errorStr = JSON.stringify(confirmation.value.err);
      let friendlyError = errorStr;
      
      if (errorStr.includes('"Custom":101')) {
        friendlyError = "Slippage exceeded - try increasing slippage";
      } else if (errorStr.includes('"Custom":6000')) {
        friendlyError = "Bonding curve complete - use DEX to sell";
      }
      
      return { success: false, error: friendlyError };
    }
    
    // Wait for balance update
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const newBalance = await getTokenBalance(connection, keypair.publicKey, tokenMint);
    const solReceived = await estimateSolReceived(tokensToSell, position.current_price_sol);
    
    // Update position
    if (newBalance <= 0 || sellPercentage === 100) {
      db.updatePosition(positionId, { status: "closed" });
    } else {
      db.updatePosition(positionId, { tokens_remaining: newBalance });
    }
    
    // Record trade
    db.createTradeHistory({
      user_id: userId,
      position_id: positionId,
      token_address: position.token_address,
      token_symbol: position.token_symbol,
      trade_type: "sell",
      amount_sol: solReceived,
      tokens_amount: tokensToSell,
      price_per_token: position.current_price_sol,
      tx_signature: txSignature,
      trigger_reason: reason,
    });
    
    logger.info(`Sold ${sellPercentage}% of ${position.token_symbol || position.token_address.slice(0, 8)} for user ${userId}`);
    
    return { success: true, txSignature };
    
  } catch (error: any) {
    logger.error(`Sell failed for user ${userId}, position ${positionId}: ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function estimateSolReceived(tokensToSell: number, pricePerToken: number): Promise<number> {
  return tokensToSell * pricePerToken * 0.99; // Estimate with 1% fee
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

// Alias for backwards compatibility
export const sellTokens = sellPosition;

export async function getTokenPriceSOL(tokenAddress: string): Promise<number> {
  try {
    // Use DexScreener API to get current price
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    const data = await response.json();
    
    if (data.pairs && data.pairs.length > 0) {
      const pair = data.pairs[0];
      return parseFloat(pair.priceNative) || 0;
    }
    return 0;
  } catch (error) {
    return 0;
  }
}

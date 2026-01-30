import { Keypair } from "@solana/web3.js";
import crypto from "crypto";
import * as db from "../db";
import { logger } from "../utils/logger";
import type { Wallet } from "@shared/schema";

const ENCRYPTION_ALGORITHM = "aes-256-gcm";

function getEncryptionKey(): Buffer {
  const secret = process.env.WALLET_ENCRYPTION_KEY || process.env.SESSION_SECRET || "default-key-change-me";
  return crypto.scryptSync(secret, "salt", 32);
}

export function encryptPrivateKey(privateKey: Uint8Array): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(privateKey)),
    cipher.final(),
  ]);
  
  const authTag = cipher.getAuthTag();
  
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptPrivateKey(encryptedData: string): Uint8Array {
  const key = getEncryptionKey();
  const data = Buffer.from(encryptedData, "base64");
  
  const iv = data.subarray(0, 16);
  const authTag = data.subarray(16, 32);
  const encrypted = data.subarray(32);
  
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);
  
  return new Uint8Array(decrypted);
}

export function generateNewWallet(userId: string): { publicKey: string; wallet: Wallet } {
  const keypair = Keypair.generate();
  const publicKey = keypair.publicKey.toBase58();
  const encryptedPrivateKey = encryptPrivateKey(keypair.secretKey);
  
  const wallet = db.createWallet({
    user_id: userId,
    public_key: publicKey,
    encrypted_private_key: encryptedPrivateKey,
  });
  
  logger.info(`New wallet generated for user ${userId}: ${publicKey.slice(0, 8)}...`);
  
  return { publicKey, wallet };
}

export function importWallet(userId: string, privateKeyInput: string): { publicKey: string; wallet: Wallet } | null {
  try {
    let keypair: Keypair;
    
    if (privateKeyInput.length === 88) {
      keypair = Keypair.fromSecretKey(Buffer.from(privateKeyInput, "base64"));
    } else if (privateKeyInput.length === 128) {
      const bytes = new Uint8Array(64);
      for (let i = 0; i < 64; i++) {
        bytes[i] = parseInt(privateKeyInput.slice(i * 2, i * 2 + 2), 16);
      }
      keypair = Keypair.fromSecretKey(bytes);
    } else if (privateKeyInput.startsWith("[")) {
      const decoded = JSON.parse(privateKeyInput);
      if (Array.isArray(decoded)) {
        keypair = Keypair.fromSecretKey(new Uint8Array(decoded));
      } else {
        throw new Error("Invalid private key format");
      }
    } else {
      throw new Error("Invalid private key format. Use base64, hex, or JSON array format.");
    }
    
    const publicKey = keypair.publicKey.toBase58();
    const encryptedPrivateKey = encryptPrivateKey(keypair.secretKey);
    
    const existingWallet = db.getWallet(userId);
    let wallet: Wallet;
    
    if (existingWallet) {
      db.updateWallet(userId, {
        public_key: publicKey,
        encrypted_private_key: encryptedPrivateKey,
      });
      wallet = db.getWallet(userId)!;
    } else {
      wallet = db.createWallet({
        user_id: userId,
        public_key: publicKey,
        encrypted_private_key: encryptedPrivateKey,
      });
    }
    
    logger.info(`Wallet imported for user ${userId}: ${publicKey.slice(0, 8)}...`);
    
    return { publicKey, wallet };
  } catch (error: any) {
    logger.error(`Failed to import wallet for user ${userId}: ${error.message}`);
    return null;
  }
}

export function getUserKeypair(userId: string): Keypair | null {
  const wallet = db.getWallet(userId);
  if (!wallet) return null;
  
  try {
    const privateKey = decryptPrivateKey(wallet.encrypted_private_key);
    return Keypair.fromSecretKey(privateKey);
  } catch (error: any) {
    logger.error(`Failed to decrypt wallet for user ${userId}: ${error.message}`);
    return null;
  }
}

export function getWalletAddress(userId: string): string | null {
  const wallet = db.getWallet(userId);
  return wallet?.public_key || null;
}

export function exportPrivateKey(userId: string): string | null {
  const wallet = db.getWallet(userId);
  if (!wallet) return null;
  
  try {
    const privateKey = decryptPrivateKey(wallet.encrypted_private_key);
    return JSON.stringify(Array.from(privateKey));
  } catch (error: any) {
    logger.error(`Failed to export wallet for user ${userId}: ${error.message}`);
    return null;
  }
}

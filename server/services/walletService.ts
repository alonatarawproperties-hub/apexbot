import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
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
  
  logger.info(`New wallet generated for user ${userId}: ${publicKey.slice(0, 8)}...`);
  
  return { publicKey, wallet };
}

function keypairFromBytes(bytes: Uint8Array): Keypair {
  if (bytes.length === 64) {
    return Keypair.fromSecretKey(bytes);
  }
  if (bytes.length === 32) {
    return Keypair.fromSeed(bytes);
  }
  throw new Error("Invalid private key length");
}

function decodeHex(input: string): Uint8Array {
  const bytes = new Uint8Array(input.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(input.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function importWallet(userId: string, privateKeyInput: string): { publicKey: string; wallet: Wallet } | null {
  try {
    let keypair: Keypair;
    const trimmedInput = privateKeyInput.trim();
    
    if (trimmedInput.startsWith("[")) {
      const decoded = JSON.parse(trimmedInput);
      if (Array.isArray(decoded)) {
        keypair = keypairFromBytes(new Uint8Array(decoded));
      } else {
        throw new Error("Invalid private key format");
      }
    } else {
      let decodedBytes: Uint8Array | null = null;

      if (/^[0-9a-fA-F]+$/.test(trimmedInput) && trimmedInput.length % 2 === 0) {
        const hexBytes = decodeHex(trimmedInput);
        if (hexBytes.length === 32 || hexBytes.length === 64) {
          decodedBytes = hexBytes;
        }
      }

      if (!decodedBytes && /^[A-Za-z0-9+/=]+$/.test(trimmedInput) && trimmedInput.length % 4 === 0) {
        const base64Bytes = Buffer.from(trimmedInput, "base64");
        if (base64Bytes.length === 32 || base64Bytes.length === 64) {
          decodedBytes = base64Bytes;
        }
      }

      if (!decodedBytes) {
        try {
          decodedBytes = bs58.decode(trimmedInput);
        } catch {
          throw new Error("Invalid private key format. Use base64, base58, hex, or JSON array format.");
        }
      }

      keypair = keypairFromBytes(decodedBytes);
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

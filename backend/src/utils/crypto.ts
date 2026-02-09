import crypto from 'crypto';
import { getConfig } from './env.js';

function deriveKey(secret: string, salt: string): Buffer {
  return crypto.scryptSync(secret, salt, 32);
}

// Simple encryption for storage (stores everything in one field)
// Uses createCipheriv (modern, secure)
export function encryptApiKey(plaintext: string): string {
  const cfg = getConfig();
  const key = deriveKey(cfg.JWT_SECRET, cfg.ENCRYPTION_SALT);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  return iv.toString('hex') + ':' + encrypted;
}

// Modern decrypt: createDecipheriv with explicit IV
function tryDecryptModern(ciphertext: string, secret: string, salt: string): string | null {
  try {
    const key = deriveKey(secret, salt);
    const parts = ciphertext.split(':');
    if (parts.length !== 2) return null;
    const iv = Buffer.from(parts[0], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(parts[1], 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return null;
  }
}

// Legacy decrypt: createDecipher (deprecated, no explicit IV)
// Original code used createCipher/createDecipher which derive IV internally
function tryDecryptLegacy(ciphertext: string, secret: string, salt: string): string | null {
  try {
    const key = deriveKey(secret, salt);
    const parts = ciphertext.split(':');
    if (parts.length !== 2) return null;
    // Legacy: IV was stored but never used — createDecipher derives its own
    const decipher = (crypto as any).createDecipher('aes-256-cbc', key);
    let decrypted = decipher.update(parts[1], 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return null;
  }
}

// All possible secrets that may have been used to encrypt existing keys
function getLegacySecrets(): string[] {
  const cfg = getConfig();
  return [
    cfg.JWT_SECRET,
    'change-me-jwt-secret',
    'change-me',
  ];
}

export function decryptApiKey(ciphertext: string): string {
  const cfg = getConfig();

  // 1. Try modern decrypt with current key (new encryptions)
  const result = tryDecryptModern(ciphertext, cfg.JWT_SECRET, cfg.ENCRYPTION_SALT);
  if (result !== null) return result;

  // 2. Try legacy decrypt (createDecipher) with all possible secrets
  const secrets = getLegacySecrets();
  for (const secret of secrets) {
    const legacyResult = tryDecryptLegacy(ciphertext, secret, 'apikey-salt');
    if (legacyResult !== null) {
      console.log('[crypto] Decrypted with legacy cipher — re-save API keys to migrate');
      return legacyResult;
    }
  }

  // 3. Try modern decrypt with legacy secrets (in case keys were re-saved with old JWT_SECRET)
  for (const secret of secrets) {
    if (secret === cfg.JWT_SECRET) continue; // already tried
    const modernLegacy = tryDecryptModern(ciphertext, secret, 'apikey-salt');
    if (modernLegacy !== null) {
      console.log('[crypto] Decrypted with legacy secret — re-save API keys to migrate');
      return modernLegacy;
    }
  }

  throw new Error('Failed to decrypt — key mismatch (re-enter API keys in Settings)');
}

import crypto from 'crypto';
import { getConfig } from './env.js';

const ALGORITHM = 'aes-256-gcm';

export function encrypt(text: string): { encrypted: string; iv: string; tag: string } {
  const cfg = getConfig();
  const key = crypto.scryptSync(cfg.JWT_SECRET || cfg.APP_API_KEY, 'salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipher(ALGORITHM, key);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const tag = cipher.getAuthTag();
  
  return {
    encrypted,
    iv: iv.toString('hex'),
    tag: tag.toString('hex')
  };
}

export function decrypt(encryptedData: { encrypted: string; iv: string; tag: string }): string {
  const cfg = getConfig();
  const key = crypto.scryptSync(cfg.JWT_SECRET || cfg.APP_API_KEY, 'salt', 32);
  const decipher = crypto.createDecipher(ALGORITHM, key);
  
  decipher.setAuthTag(Buffer.from(encryptedData.tag, 'hex'));
  
  let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

// Simple encryption for storage (stores everything in one field)
export function encryptApiKey(plaintext: string): string {
  const cfg = getConfig();
  const key = crypto.scryptSync(cfg.JWT_SECRET || cfg.APP_API_KEY, 'apikey-salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipher('aes-256-cbc', key);
  
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  return iv.toString('hex') + ':' + encrypted;
}

export function decryptApiKey(ciphertext: string): string {
  const cfg = getConfig();
  const key = crypto.scryptSync(cfg.JWT_SECRET || cfg.APP_API_KEY, 'apikey-salt', 32);
  
  const parts = ciphertext.split(':');
  const iv = Buffer.from(parts[0], 'hex');
  const encrypted = parts[1];
  
  const decipher = crypto.createDecipher('aes-256-cbc', key);
  
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}
import crypto from 'crypto';
import { getConfig } from './env.js';

// Simple encryption for storage (stores everything in one field)
export function encryptApiKey(plaintext: string): string {
  const cfg = getConfig();
  const key = crypto.scryptSync(cfg.JWT_SECRET || cfg.APP_API_KEY, 'apikey-salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  return iv.toString('hex') + ':' + encrypted;
}

export function decryptApiKey(ciphertext: string): string {
  const cfg = getConfig();
  const key = crypto.scryptSync(cfg.JWT_SECRET || cfg.APP_API_KEY, 'apikey-salt', 32);
  
  const parts = ciphertext.split(':');
  if (parts.length !== 2) {
    throw new Error('Invalid encrypted data format');
  }
  
  const iv = Buffer.from(parts[0], 'hex');
  const encrypted = parts[1];
  
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

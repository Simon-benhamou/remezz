/**
 * Database Connection Helper
 * Handles Neon cold starts with automatic retry logic
 */

import { prisma } from './client.js';

interface RetryConfig {
  maxAttempts?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffMultiplier?: number;
}

const DEFAULT_CONFIG: Required<RetryConfig> = {
  maxAttempts: 10,
  initialDelay: 1000, // 1 second
  maxDelay: 30000, // 30 seconds
  backoffMultiplier: 2,
};

/**
 * Wait for database connection with exponential backoff
 * Handles Neon cold starts gracefully
 */
export async function waitForDatabase(config: RetryConfig = {}): Promise<void> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let attempt = 1;
  let delay = cfg.initialDelay;

  while (attempt <= cfg.maxAttempts) {
    try {
      console.log(`[DB] Connection attempt ${attempt}/${cfg.maxAttempts}...`);
      
      // Test connection with timeout
      await Promise.race([
        prisma.$queryRaw`SELECT 1`,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Connection timeout')), 10000)
        ),
      ]);

      console.log('[DB] ✅ Database connected successfully!');
      return;
    } catch (error) {
      const isLastAttempt = attempt >= cfg.maxAttempts;
      
      if (isLastAttempt) {
        console.error(`[DB] ❌ Failed to connect after ${cfg.maxAttempts} attempts`);
        throw new Error(`Database connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }

      console.warn(`[DB] Connection failed (attempt ${attempt}/${cfg.maxAttempts}), retrying in ${delay}ms...`);
      console.warn(`[DB] Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      
      await new Promise(resolve => setTimeout(resolve, delay));
      
      // Exponential backoff with max limit
      delay = Math.min(delay * cfg.backoffMultiplier, cfg.maxDelay);
      attempt++;
    }
  }
}

/**
 * Initialize database connection at server startup
 * Non-blocking - logs warning but doesn't crash if connection fails
 */
export async function initializeDatabaseConnection(critical: boolean = false): Promise<boolean> {
  try {
    await waitForDatabase();
    return true;
  } catch (error) {
    console.error('[DB] Database initialization failed:', error);
    
    if (critical) {
      throw error;
    }
    
    console.warn('[DB] ⚠️ Server starting without database connection');
    console.warn('[DB] Application will retry connecting on first query');
    return false;
  }
}

/**
 * Gracefully disconnect from database
 */
export async function disconnectDatabase(): Promise<void> {
  try {
    await prisma.$disconnect();
    console.log('[DB] Disconnected from database');
  } catch (error) {
    console.error('[DB] Error disconnecting from database:', error);
  }
}

/**
 * Integration Logger - Structured logging for cross-module interactions
 * 
 * Provides consistent logging format across all integration points:
 * - LLM calls
 * - Python predictor invocations
 * - Strategy evaluation
 * - Broker operations
 * - Position management
 * 
 * Log format: [Component/Action] session=X symbol=Y | message | {data}
 */

export interface IntegrationLogContext {
  component: string;
  action: string;
  sessionId?: string;
  symbol?: string;
  userId?: string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class IntegrationLogger {
  constructor(private context: IntegrationLogContext) {}

  debug(message: string, data?: any) {
    this.log('debug', message, data);
  }

  info(message: string, data?: any) {
    this.log('info', message, data);
  }

  warn(message: string, data?: any) {
    this.log('warn', message, data);
  }

  error(message: string, error?: any, data?: any) {
    const errorData = error ? {
      message: error.message,
      code: error.code,
      name: error.name,
      stack: error.stack?.split('\n').slice(0, 3).join(' | '),
      ...data,
    } : data;
    this.log('error', message, errorData);
  }

  /**
   * Log a successful operation with duration tracking
   */
  success(message: string, durationMs?: number, data?: any) {
    const enrichedData = durationMs !== undefined 
      ? { durationMs: Math.round(durationMs), ...data }
      : data;
    this.log('info', `✓ ${message}`, enrichedData);
  }

  /**
   * Log the start of an operation (returns a function to log completion)
   */
  operation(operation: string): () => void {
    const startTime = Date.now();
    this.debug(`Starting: ${operation}`);
    
    return () => {
      const durationMs = Date.now() - startTime;
      this.success(`Completed: ${operation}`, durationMs);
    };
  }

  /**
   * Create a child logger with additional context
   */
  child(additionalContext: Partial<IntegrationLogContext>): IntegrationLogger {
    return new IntegrationLogger({
      ...this.context,
      ...additionalContext,
    });
  }

  private log(level: LogLevel, message: string, data?: any) {
    const timestamp = new Date().toISOString();
    const { component, action, sessionId, symbol, userId } = this.context;
    
    // Build context string
    const contextParts: string[] = [];
    if (sessionId) contextParts.push(`session=${sessionId}`);
    if (symbol) contextParts.push(`symbol=${symbol}`);
    if (userId) contextParts.push(`user=${userId}`);
    const ctx = contextParts.length > 0 ? contextParts.join(' ') : 'N/A';

    const prefix = `[${component}/${action}]`;
    const logMessage = `${timestamp} ${level.toUpperCase().padEnd(5)} ${prefix.padEnd(25)} ${ctx.padEnd(40)} | ${message}`;

    // Determine if we should log based on level and environment
    const shouldLog = this.shouldLog(level);
    if (!shouldLog) return;

    // Log with appropriate console method
    switch (level) {
      case 'error':
        console.error(logMessage, data ? JSON.stringify(data, null, 2) : '');
        break;
      case 'warn':
        console.warn(logMessage, data ? JSON.stringify(data, null, 2) : '');
        break;
      case 'info':
        console.log(logMessage, data ? JSON.stringify(data, null, 2) : '');
        break;
      case 'debug':
        console.log(logMessage, data ? JSON.stringify(data, null, 2) : '');
        break;
    }
  }

  private shouldLog(level: LogLevel): boolean {
    // Always log errors and warnings
    if (level === 'error' || level === 'warn') return true;

    // Check debug flag for debug logs
    if (level === 'debug') {
      return process.env.DEBUG === 'true' || process.env.DEBUG_INTEGRATION === 'true';
    }

    // Info logs always shown unless explicitly disabled
    if (process.env.LOG_LEVEL === 'warn' || process.env.LOG_LEVEL === 'error') {
      return false;
    }

    return true;
  }
}

/**
 * Factory function to create integration loggers
 */
export function createIntegrationLogger(context: IntegrationLogContext): IntegrationLogger {
  return new IntegrationLogger(context);
}

/**
 * Helper to wrap async operations with automatic logging
 */
export async function withLogging<T>(
  logger: IntegrationLogger,
  operation: string,
  fn: () => Promise<T>,
  onError?: (error: any) => T | Promise<T>
): Promise<T> {
  const startTime = Date.now();
  logger.debug(`Starting: ${operation}`);

  try {
    const result = await fn();
    const durationMs = Date.now() - startTime;
    logger.success(`Completed: ${operation}`, durationMs);
    return result;
  } catch (error: any) {
    const durationMs = Date.now() - startTime;
    logger.error(`Failed: ${operation} (after ${durationMs}ms)`, error);
    
    if (onError) {
      logger.info('Attempting error handler/fallback');
      return await onError(error);
    }
    
    throw error;
  }
}

/**
 * Helper for retry logic with logging
 */
export async function withRetry<T>(
  logger: IntegrationLogger,
  operation: string,
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 500
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 1) {
        logger.info(`Retry attempt ${attempt}/${maxRetries} for: ${operation}`);
      }
      return await fn();
    } catch (error: any) {
      const isLastAttempt = attempt === maxRetries;
      const isRetryable = error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET' || error.code === 'ECONNREFUSED';

      if (isLastAttempt || !isRetryable) {
        logger.error(`Failed after ${attempt} attempt(s): ${operation}`, error);
        throw error;
      }

      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      logger.warn(`Retryable error (attempt ${attempt}/${maxRetries}), waiting ${delayMs}ms`, {
        error: error.message,
        code: error.code,
      });
      
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw new Error('Unreachable: withRetry loop exited without return or throw');
}

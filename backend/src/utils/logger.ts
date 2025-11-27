const LEVEL_MAP = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
} as const;

type LogLevel = keyof typeof LEVEL_MAP;

type LogWriter = (...args: unknown[]) => void;

type ScopedLogger = {
  error: LogWriter;
  warn: LogWriter;
  info: LogWriter;
  debug: LogWriter;
};

// ============================================================================
// IN-MEMORY LOG BUFFER - For frontend display
// ============================================================================

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  scope: string;
  message: string;
  symbol?: string;
  kind?: 'tick' | 'signal' | 'entry' | 'exit' | 'market' | 'error' | 'info';
}

const LOG_BUFFER_SIZE = 100;
const logBuffer: LogEntry[] = [];
let logIdCounter = 0;

function extractSymbol(message: string): string | undefined {
  // Extract symbol from log messages like "[ETH/USDT:USDT]" or "[BTC]"
  const match = message.match(/\[([A-Z]+(?:\/USDT:USDT)?)\]/);
  return match ? match[1] : undefined;
}

function extractKind(message: string): LogEntry['kind'] {
  // Order matters: more specific checks first
  if (message.includes('Tick #') || message.includes('🔄')) return 'tick';
  if (message.includes('OPENING') || message.includes('OPENED') || message.includes('🚀') || message.includes('🟢')) return 'entry';
  if (message.includes('CLOSING') || message.includes('CLOSED') || message.includes('EXIT') || message.includes('🔴') || message.includes('🚪')) return 'exit';
  if (message.includes('Market:') || message.includes('📊') || message.includes('favorable_')) return 'market';
  // "No signal" is informational, not an error - check before error detection
  if (message.includes('No signal') || message.includes('SIGNAL') || message.includes('Signal check') || message.includes('🔍')) return 'signal';
  // Only real errors
  if (message.includes('Error') || message.includes('Failed') || message.includes('error:')) return 'error';
  return 'info';
}

function addToBuffer(level: LogLevel, scope: string, args: unknown[]) {
  const message = args.map(arg => 
    typeof arg === 'string' ? arg : JSON.stringify(arg)
  ).join(' ');
  
  const entry: LogEntry = {
    id: `log_${Date.now()}_${++logIdCounter}`,
    timestamp: new Date().toISOString(),
    level,
    scope,
    message,
    symbol: extractSymbol(message),
    kind: extractKind(message),
  };
  
  logBuffer.push(entry);
  
  // Keep buffer size limited
  while (logBuffer.length > LOG_BUFFER_SIZE) {
    logBuffer.shift();
  }
}

/**
 * Get recent logs from buffer
 * @param limit Max number of logs to return
 * @param scope Filter by scope (e.g., 'agent')
 * @param symbol Filter by symbol (e.g., 'ETH/USDT:USDT')
 */
export function getRecentLogs(options?: {
  limit?: number;
  scope?: string;
  symbol?: string;
  level?: LogLevel;
  kind?: LogEntry['kind'];
}): LogEntry[] {
  let logs = [...logBuffer];
  
  if (options?.scope) {
    logs = logs.filter(l => l.scope === options.scope);
  }
  if (options?.symbol) {
    const normalizedSymbol = options.symbol.toUpperCase().replace(/[/:]/g, '');
    logs = logs.filter(l => {
      if (!l.symbol) return false;
      return l.symbol.toUpperCase().replace(/[/:]/g, '').includes(normalizedSymbol) ||
             normalizedSymbol.includes(l.symbol.toUpperCase().replace(/[/:]/g, ''));
    });
  }
  if (options?.level) {
    logs = logs.filter(l => LEVEL_MAP[l.level] <= LEVEL_MAP[options.level!]);
  }
  if (options?.kind) {
    logs = logs.filter(l => l.kind === options.kind);
  }
  
  // Return most recent first
  logs.reverse();
  
  if (options?.limit) {
    logs = logs.slice(0, options.limit);
  }
  
  return logs;
}

/**
 * Clear log buffer
 */
export function clearLogBuffer(): void {
  logBuffer.length = 0;
}

// ============================================================================
// ORIGINAL LOGGER CODE
// ============================================================================

const promotedPatterns: RegExp[] = [
  /^\[(api|batch|trade|orders?|risk|oms|engine|sim|ws|agent|pnl)\b/i,
  /cumulative pnl/i,
  /filled order/i,
  /executed trade/i,
];

const originalConsole = {
  error: console.error.bind(console),
  warn: console.warn.bind(console),
  info: (console.info ?? console.log).bind(console),
  log: console.log.bind(console),
  debug: (console.debug ?? console.log).bind(console),
};

const levelWriters: Record<LogLevel, LogWriter> = {
  error: originalConsole.error,
  warn: originalConsole.log,
  info: originalConsole.info,
  debug: originalConsole.debug,
};

let configured = false;
let currentLevel: LogLevel = resolveInitialLevel();

function resolveInitialLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? '').toLowerCase();
  if (raw && raw in LEVEL_MAP) {
    return raw as LogLevel;
  }
  // Always default to 'info' to see tick processing logs etc.
  // Use LOG_LEVEL=warn in env if you want to reduce logging
  return 'info';
}

function shouldPromote(args: unknown[]): boolean {
  for (const arg of args) {
    if (typeof arg !== 'string') continue;
    for (const pattern of promotedPatterns) {
      if (pattern.test(arg)) {
        return true;
      }
    }
  }
  return false;
}

function emit(level: LogLevel, args: unknown[], writer: LogWriter, scope?: string) {
  const effectiveLevel: LogLevel = level === 'debug' && shouldPromote(args) ? 'info' : level;
  if (LEVEL_MAP[effectiveLevel] > LEVEL_MAP[currentLevel]) {
    return;
  }
  const timestamp = new Date().toISOString();
  const prefix = scope ? `[${timestamp}] [${effectiveLevel.toUpperCase()}] [${scope}]` : `[${timestamp}] [${effectiveLevel.toUpperCase()}]`;
  writer(prefix, ...args);
  
  // Also add to buffer for frontend access (only for scoped logs)
  if (scope) {
    addToBuffer(effectiveLevel, scope, args);
  }
}

function bind(level: LogLevel, writer: LogWriter, scope?: string): LogWriter {
  return (...args: unknown[]) => emit(level, args, writer, scope);
}

export function setLogLevel(level: LogLevel) {
  currentLevel = level;
}

export function configureLogging(level?: LogLevel): LogLevel {
  if (level) {
    setLogLevel(level);
  }
  if (configured) {
    return currentLevel;
  }
  configured = true;
  console.error = bind('error', levelWriters.error);
  console.warn = bind('warn', levelWriters.warn);
  console.info = bind('info', levelWriters.info);
  console.debug = bind('debug', levelWriters.debug);
  console.log = bind('debug', originalConsole.log);
  return currentLevel;
}

export function createLogger(scope: string): ScopedLogger {
  return {
    error: bind('error', levelWriters.error, scope),
    warn: bind('warn', levelWriters.warn, scope),
    info: bind('info', levelWriters.info, scope),
    debug: bind('debug', levelWriters.debug, scope),
  };
}

const defaultLogger = createLogger('agent');

export const log = (...args: unknown[]) => defaultLogger.info(...args);
export const warn = (...args: unknown[]) => defaultLogger.warn(...args);

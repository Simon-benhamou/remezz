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

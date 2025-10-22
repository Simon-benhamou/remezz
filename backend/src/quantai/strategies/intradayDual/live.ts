import { IntradayDualStrategy } from './strategy.js';
import { PreciseDecimal } from '../metaAdaptive/metaAdaptiveAgent.js';
import type { ActivationProfile } from '../../../agent/state/types.js';
import type {
  Timeframe,
  Candle,
  OrderBookSnapshot,
  TickInput,
  RegimeSignal,
  EntrySignal,
  ExitDirective,
  TradeLog,
} from './types.js';
import { getOHLCV, getTicker } from '../../../data/market.js';

const DEFAULT_LIMITS: Record<Timeframe, number> = {
  '1m': 240,
  '5m': 180,
  '15m': 180,
};

function toCandleSeries(raw: number[][]): Candle[] {
  return raw.map(([ts, open, high, low, close, volume]) => ({
    timestamp: Number(ts),
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    volume: Number(volume ?? 0),
  }));
}

async function fetchCandles(
  symbol: string,
  timeframe: Timeframe,
  limit: number,
  userId?: string,
): Promise<Candle[]> {
  const raw = await getOHLCV(symbol, timeframe, limit, userId, { preferWebSocket: true });
  return toCandleSeries(raw).slice(-limit);
}

function resolveEquity(profile?: ActivationProfile | null): PreciseDecimal {
  const equity =
    profile?.capitalAllocationUsd ??
    profile?.startBalanceUsd ??
    (profile?.budgetFraction && profile.startBalanceUsd
      ? profile.budgetFraction * profile.startBalanceUsd
      : null) ??
    10_000;
  return new PreciseDecimal(equity);
}

function resolveExposureBudget(profile?: ActivationProfile | null): number {
  if (!profile) return 1;
  if (typeof profile.budgetFraction === 'number' && profile.budgetFraction > 0) {
    return Math.min(1, Math.max(0, profile.budgetFraction));
  }
  return 1;
}

function resolveSlippageBps(profile?: ActivationProfile | null): number {
  if (!profile?.aggressiveness) return 5;
  switch (profile.aggressiveness) {
    case 'conservative':
      return 8;
    case 'aggressive':
      return 4;
    default:
      return 5;
  }
}

async function buildOrderBookSnapshot(
  symbol: string,
  userId?: string,
): Promise<OrderBookSnapshot | null> {
  try {
    const ticker = await getTicker(symbol, { userId });
    if (!ticker) return null;
    const bid = Number(ticker.bid || ticker.last || 0);
    const ask = Number(ticker.ask || ticker.last || 0);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
      return null;
    }
    const midSize = Number(ticker.baseVolume || ticker.quoteVolume || 0) / 100 || 0;
    const size = Number.isFinite(midSize) && midSize > 0 ? midSize : 1;
    const ts = Number(ticker.timestamp || Date.now());
    return {
      timestamp: ts,
      bids: [{ price: bid, size }],
      asks: [{ price: ask, size }],
    };
  } catch (error) {
    console.warn('⚠️ Failed to fetch ticker for intraday snapshot:', error);
    return null;
  }
}

export type IntradayEvaluationOptions = {
  symbol: string;
  profile?: ActivationProfile | null;
  timestamp?: number;
  candles?: Partial<Record<Timeframe, Candle[]>>;
  orderBook?: OrderBookSnapshot | null;
  price?: number;
  aggression?: { timestamp: number; takerBuy: number; takerSell: number } | null;
};

export type IntradayEvaluationResult = {
  timestamp: number;
  regime: RegimeSignal;
  entry: EntrySignal | null;
  exits: ExitDirective[];
  trades: TradeLog[];
};

export async function evaluateIntradayStrategy(
  options: IntradayEvaluationOptions,
): Promise<IntradayEvaluationResult> {
  const { symbol } = options;
  const profile = options.profile ?? null;
  const userId = profile?.userId;

  const candles: Record<Timeframe, Candle[]> = {
    '1m': options.candles?.['1m'] ?? [],
    '5m': options.candles?.['5m'] ?? [],
    '15m': options.candles?.['15m'] ?? [],
  } as Record<Timeframe, Candle[]>;

  const fetchPromises: Promise<void>[] = [];
  (['1m', '5m', '15m'] as const).forEach((tf) => {
    if (!candles[tf] || candles[tf].length === 0) {
      const limit = DEFAULT_LIMITS[tf];
      fetchPromises.push(
        fetchCandles(symbol, tf, limit, userId)
          .then((series) => {
            candles[tf] = series;
          })
          .catch((error) => {
            throw new Error(`failed_fetch_candles_${tf}:${error instanceof Error ? error.message : String(error)}`);
          }),
      );
    }
  });

  await Promise.all(fetchPromises);

  const last1m = candles['1m'][candles['1m'].length - 1];
  if (!last1m) {
    throw new Error('intraday_missing_1m_candles');
  }
  const tickTs = options.timestamp ?? last1m.timestamp;
  const price = options.price ?? last1m.close;

  const orderBook =
    options.orderBook ??
    (await buildOrderBookSnapshot(symbol, userId).catch(() => null));

  const tick: TickInput = {
    symbol,
    timestamp: tickTs,
    price,
    candles,
    orderBook,
    aggression: options.aggression ?? undefined,
  };

  const strategy = new IntradayDualStrategy();
  const ctx = {
    equityUsd: resolveEquity(profile),
    maxLevInstrument: profile?.maxLeverage ?? 5,
    maxLevGlobal: profile?.maxLeverage ?? 5,
    exposureBudget: resolveExposureBudget(profile),
    slippageBps: resolveSlippageBps(profile),
  };

  const evaluation = strategy.evaluateTick(tick, ctx);
  return {
    timestamp: tickTs,
    regime: evaluation.regime,
    entry: evaluation.entries[0] ?? null,
    exits: evaluation.exits,
    trades: evaluation.trades,
  };
}

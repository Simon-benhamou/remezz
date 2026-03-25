import { prisma } from '../src/db/client.js';
import { MomentumConfig, shouldExitPosition, updatePositionWaterMarks } from '../src/strategies/momentumSimple.js';

type BinanceKline = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
};

type Args = {
  tradeId?: string;
  symbol?: string;
  mode: 'paper' | 'live' | 'all';
  from: Date;
  to: Date;
  pick: 'maxRoi' | 'latest';
  confirmCandles: number;
};

function parseArgs(argv: string[]): Args {
  const map = new Map<string, string>();
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    if (eq === -1) map.set(raw.slice(2), 'true');
    else map.set(raw.slice(2, eq), raw.slice(eq + 1));
  }

  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const from = map.get('from') ? new Date(String(map.get('from'))) : defaultFrom;
  const to = map.get('to') ? new Date(String(map.get('to'))) : now;
  if (!Number.isFinite(from.getTime())) throw new Error(`Invalid --from: ${String(map.get('from'))}`);
  if (!Number.isFinite(to.getTime())) throw new Error(`Invalid --to: ${String(map.get('to'))}`);

  const modeRaw = (map.get('mode') ?? 'paper').toLowerCase();
  const mode: Args['mode'] = modeRaw === 'live' ? 'live' : modeRaw === 'all' ? 'all' : 'paper';

  const pickRaw = (map.get('pick') ?? 'maxRoi').toLowerCase();
  const pick: Args['pick'] = pickRaw === 'latest' ? 'latest' : 'maxRoi';

  const confirmCandles = map.get('confirmCandles')
    ? Number.parseInt(String(map.get('confirmCandles')), 10)
    : Number((MomentumConfig.EXIT as any).REALTIME_APP_EXIT_KLINE_CONFIRM_CANDLES ?? 2);

  return {
    tradeId: map.get('tradeId') ?? undefined,
    symbol: map.get('symbol') ?? undefined,
    mode,
    from,
    to,
    pick,
    confirmCandles: Number.isFinite(confirmCandles) && confirmCandles > 0 ? confirmCandles : 2,
  };
}

function internalSymbolToBinanceFutures(symbol: string): string {
  const upper = symbol.toUpperCase();
  return upper.replace(':USDT', '').replace(':USD', '').replace('/', '');
}

async function fetchBinanceFuturesKlines(params: {
  symbol: string;
  interval: '1m' | '15m';
  startTime: number;
  endTime: number;
}): Promise<BinanceKline[]> {
  const endpoint = 'https://fapi.binance.com/fapi/v1/klines';
  const out: BinanceKline[] = [];
  const limit = 1000;

  let cursor = params.startTime;
  let safety = 0;
  while (cursor < params.endTime) {
    safety += 1;
    if (safety > 5000) throw new Error('Safety break: too many kline loops');

    const url = new URL(endpoint);
    url.searchParams.set('symbol', params.symbol);
    url.searchParams.set('interval', params.interval);
    url.searchParams.set('startTime', String(cursor));
    url.searchParams.set('endTime', String(params.endTime));
    url.searchParams.set('limit', String(limit));

    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Binance klines failed ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as any[];
    if (!Array.isArray(data) || data.length === 0) break;

    for (const k of data) {
      const openTime = Number(k?.[0]);
      const open = Number(k?.[1]);
      const high = Number(k?.[2]);
      const low = Number(k?.[3]);
      const close = Number(k?.[4]);
      const volume = Number(k?.[5]);
      const closeTime = Number(k?.[6]);
      if (![openTime, open, high, low, close, volume, closeTime].every((n) => Number.isFinite(n))) continue;
      out.push({ openTime, open, high, low, close, volume, closeTime });
    }

    const last = out[out.length - 1];
    if (!last) break;
    cursor = last.closeTime + 1;

    await new Promise((r) => setTimeout(r, 120));
    if (data.length < limit) break;
  }

  const map = new Map<number, BinanceKline>();
  for (const c of out) map.set(c.openTime, c);
  return Array.from(map.values()).sort((a, b) => a.openTime - b.openTime);
}

function pnlPct(side: 'long' | 'short', entry: number, exit: number): number {
  return side === 'long' ? ((exit - entry) / entry) * 100 : ((entry - exit) / entry) * 100;
}

type ExitSim = {
  name: string;
  exitTs: number | null;
  exitPrice: number | null;
  reason: string | null;
  roiPct: number | null;
  trailingStopAtExit: number | null;
};

function fmt(n: number | null | undefined, digits = 4): string {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  return n.toFixed(digits);
}

async function simulatePaper15m(trade: any): Promise<ExitSim> {
  const side = (String(trade.positionSide).toLowerCase() === 'short' ? 'short' : 'long') as 'long' | 'short';
  const symbol = String(trade.symbol);
  const binanceSymbol = internalSymbolToBinanceFutures(symbol);

  const entryTs = new Date(trade.entryTs).getTime();
  const horizonMs = entryTs + MomentumConfig.EXIT.HOLD_PERIOD_MAX_MIN * 60_000 + 60 * 60_000;
  const start = entryTs - 30 * 60_000;
  const end = Math.max(horizonMs, new Date(trade.exitTs).getTime() + 30 * 60_000);

  const candles = await fetchBinanceFuturesKlines({ symbol: binanceSymbol, interval: '15m', startTime: start, endTime: end });

  let position: any = {
    side,
    entryPrice: Number(trade.entryPrice),
    entryTime: entryTs,
    stopLossPct: MomentumConfig.EXIT.STOP_LOSS_PCT,
  };

  for (const c of candles) {
    if (c.closeTime <= entryTs) continue;
    position = updatePositionWaterMarks(position, c.close, c.high, c.low);

    const sig = shouldExitPosition(position, c.close, undefined, {
      nowMs: c.openTime,
      priceHigh: c.high,
      priceLow: c.low,
    });

    if (sig?.newStopLoss && Number.isFinite(Number(sig.newStopLoss))) {
      position.appTrailingStop = Number(sig.newStopLoss);
    }

    if (sig?.shouldExit) {
      return {
        name: 'paper_15m_close',
        exitTs: c.closeTime,
        exitPrice: c.close,
        reason: String(sig.reason),
        roiPct: pnlPct(side, Number(trade.entryPrice), c.close),
        trailingStopAtExit: sig.newStopLoss ? Number(sig.newStopLoss) : null,
      };
    }
  }

  return { name: 'paper_15m_close', exitTs: null, exitPrice: null, reason: null, roiPct: null, trailingStopAtExit: null };
}

async function simulateTrailingWick1m(trade: any): Promise<ExitSim> {
  const side = (String(trade.positionSide).toLowerCase() === 'short' ? 'short' : 'long') as 'long' | 'short';
  const symbol = String(trade.symbol);
  const binanceSymbol = internalSymbolToBinanceFutures(symbol);

  const entryTs = new Date(trade.entryTs).getTime();
  const horizonMs = entryTs + MomentumConfig.EXIT.HOLD_PERIOD_MAX_MIN * 60_000 + 60 * 60_000;
  const end = Math.max(horizonMs, new Date(trade.exitTs).getTime() + 30 * 60_000);

  const candles = await fetchBinanceFuturesKlines({ symbol: binanceSymbol, interval: '1m', startTime: entryTs, endTime: end });

  let position: any = {
    side,
    entryPrice: Number(trade.entryPrice),
    entryTime: entryTs,
    stopLossPct: MomentumConfig.EXIT.STOP_LOSS_PCT,
  };

  for (const c of candles) {
    if (c.closeTime <= entryTs) continue;

    // Wick-based evaluation: allow breach via low/high inside the minute candle.
    position = updatePositionWaterMarks(position, c.close, c.high, c.low);

    const sig = shouldExitPosition(position, c.close, undefined, {
      nowMs: c.openTime,
      priceHigh: c.high,
      priceLow: c.low,
    });

    if (sig?.newStopLoss && Number.isFinite(Number(sig.newStopLoss))) {
      position.appTrailingStop = Number(sig.newStopLoss);
    }

    if (sig?.shouldExit && sig.reason === 'trailing') {
      // Approx: fill at stop price when breached
      const exitPrice = sig.newStopLoss ? Number(sig.newStopLoss) : c.close;
      return {
        name: 'rt_trailing_wick_1m',
        exitTs: c.closeTime,
        exitPrice,
        reason: 'trailing',
        roiPct: pnlPct(side, Number(trade.entryPrice), exitPrice),
        trailingStopAtExit: sig.newStopLoss ? Number(sig.newStopLoss) : null,
      };
    }
  }

  return { name: 'rt_trailing_wick_1m', exitTs: null, exitPrice: null, reason: null, roiPct: null, trailingStopAtExit: null };
}

async function simulateTrailing1mCloseConfirm(trade: any, confirmCandles: number): Promise<ExitSim> {
  const side = (String(trade.positionSide).toLowerCase() === 'short' ? 'short' : 'long') as 'long' | 'short';
  const symbol = String(trade.symbol);
  const binanceSymbol = internalSymbolToBinanceFutures(symbol);

  const entryTs = new Date(trade.entryTs).getTime();
  const horizonMs = entryTs + MomentumConfig.EXIT.HOLD_PERIOD_MAX_MIN * 60_000 + 60 * 60_000;
  const end = Math.max(horizonMs, new Date(trade.exitTs).getTime() + 30 * 60_000);

  const candles = await fetchBinanceFuturesKlines({ symbol: binanceSymbol, interval: '1m', startTime: entryTs, endTime: end });

  let position: any = {
    side,
    entryPrice: Number(trade.entryPrice),
    entryTime: entryTs,
    stopLossPct: MomentumConfig.EXIT.STOP_LOSS_PCT,
  };

  let breachCloses = 0;
  let lastStop: number | null = null;

  for (const c of candles) {
    if (c.closeTime <= entryTs) continue;

    // Update watermarks using highs/lows (so stop tracks peaks/troughs),
    // BUT evaluate breach using CLOSE only to ignore wicks.
    position = updatePositionWaterMarks(position, c.close, c.high, c.low);

    const priceHigh = side === 'long' ? c.high : c.close;
    const priceLow = side === 'short' ? c.low : c.close;

    const sig = shouldExitPosition(position, c.close, undefined, {
      nowMs: c.openTime,
      priceHigh,
      priceLow,
    });

    if (sig?.newStopLoss && Number.isFinite(Number(sig.newStopLoss))) {
      lastStop = Number(sig.newStopLoss);
      position.appTrailingStop = lastStop;
    }

    if (sig?.shouldExit && sig.reason === 'trailing') {
      breachCloses += 1;
      if (breachCloses >= confirmCandles) {
        // Close-based exit: execute at close.
        const exitPrice = c.close;
        return {
          name: `rt_trailing_1m_close_x${confirmCandles}`,
          exitTs: c.closeTime,
          exitPrice,
          reason: 'trailing',
          roiPct: pnlPct(side, Number(trade.entryPrice), exitPrice),
          trailingStopAtExit: lastStop,
        };
      }
    } else {
      breachCloses = 0;
    }
  }

  return {
    name: `rt_trailing_1m_close_x${confirmCandles}`,
    exitTs: null,
    exitPrice: null,
    reason: null,
    roiPct: null,
    trailingStopAtExit: null,
  };
}

async function pickTrade(args: Args): Promise<any> {
  if (args.tradeId) {
    const t = await prisma.trade.findUnique({
      where: { id: args.tradeId },
    });
    if (!t) throw new Error(`Trade not found: ${args.tradeId}`);
    return t;
  }

  if (!args.symbol) throw new Error('Provide --tradeId or --symbol');

  const where: any = {
    symbol: args.symbol,
    exitTs: { gte: args.from, lte: args.to },
  };

  if (args.mode !== 'all') {
    where.session = { is: { mode: args.mode } };
  }

  const orderBy = args.pick === 'latest' ? [{ exitTs: 'desc' as const }] : [{ roiPct: 'desc' as const }, { exitTs: 'desc' as const }];

  const t = await prisma.trade.findFirst({
    where,
    orderBy,
    select: {
      id: true,
      sessionId: true,
      symbol: true,
      positionSide: true,
      entryPrice: true,
      exitPrice: true,
      entryTs: true,
      exitTs: true,
      roiPct: true,
      roePct: true,
      exitReason: true,
    },
  });

  if (!t) throw new Error(`No trade found for ${args.symbol} in range`);
  return t;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const trade = await pickTrade(args);

  const side = (String(trade.positionSide).toLowerCase() === 'short' ? 'short' : 'long') as 'long' | 'short';

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('🧪 TRAILING RT MODE SIMULATION (SUI check)');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`Trade: ${trade.id}`);
  console.log(`Symbol: ${trade.symbol} side=${side}`);
  console.log(`Entry: ${new Date(trade.entryTs).toISOString()} @ $${fmt(Number(trade.entryPrice), 6)}`);
  console.log(`DB Exit: ${new Date(trade.exitTs).toISOString()} @ $${fmt(Number(trade.exitPrice), 6)} roiPct=${trade.roiPct ?? 'n/a'} exitReason=${trade.exitReason ?? 'n/a'}`);
  console.log(`Config: trailingActivation=${MomentumConfig.EXIT.TRAILING_ACTIVATION_PCT}% trailingDistance=${MomentumConfig.EXIT.TRAILING_DISTANCE_PCT}% widenAt=${MomentumConfig.EXIT.TRAILING_WIDEN_AT_PCT}% widenDist=${MomentumConfig.EXIT.TRAILING_WIDE_DISTANCE_PCT}%`);
  console.log(`New mode confirmCandles=${args.confirmCandles}`);

  const sims: ExitSim[] = [];
  sims.push(await simulatePaper15m(trade));
  sims.push(await simulateTrailingWick1m(trade));
  sims.push(await simulateTrailing1mCloseConfirm(trade, args.confirmCandles));

  console.log('\nResults:');
  for (const s of sims) {
    console.log(
      `- ${s.name}: exitTs=${s.exitTs ? new Date(s.exitTs).toISOString() : 'n/a'} ` +
        `exit=$${fmt(s.exitPrice, 6)} roi=${s.roiPct == null ? 'n/a' : (s.roiPct >= 0 ? '+' : '') + s.roiPct.toFixed(2) + '%'} ` +
        `stop=$${fmt(s.trailingStopAtExit, 6)}`,
    );
  }

  const closeSim = sims.find((s) => s.name.startsWith('rt_trailing_1m_close_'));
  if (closeSim?.roiPct != null) {
    console.log(`\nΔ vs DB roi: ${(closeSim.roiPct - Number(trade.roiPct ?? 0)).toFixed(2)}% (DB roi assumes your recorded exit price)`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });

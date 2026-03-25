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
  from: Date;
  to: Date;
  limit: number;
  sessionId?: string;
  symbol?: string;
  mode: 'live' | 'paper' | 'all';
  use1m: boolean;
  concurrency: number;
  out?: string;
};

type SimResult = {
  tradeId: string;
  sessionId: string;
  symbol: string;
  side: 'long' | 'short';
  entryTs: number;
  exitTs: number;
  entryPrice: number;
  dbExitPrice: number;

  simulatedReason: 'trailing' | 'stoploss' | 'time' | 'none';
  simulatedExitCandleOpen: number | null;
  simulatedPaperExitTs: number | null;
  simulatedPaperExitPrice: number | null;

  simulatedIntrabarExitTs: number | null;
  simulatedIntrabarExitPrice: number | null;

  // Positive means paper is better than intrabar
  deltaPnlPctPaperMinusIntrabar: number | null;
  delayMinutesPaperMinusIntrabar: number | null;
};

function parseBool(v: string | undefined, defaultValue: boolean): boolean {
  if (v == null) return defaultValue;
  if (v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes') return true;
  if (v === '0' || v.toLowerCase() === 'false' || v.toLowerCase() === 'no') return false;
  return defaultValue;
}

function parseArgs(argv: string[]): Args {
  const map = new Map<string, string>();
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    if (eq === -1) map.set(raw.slice(2), 'true');
    else map.set(raw.slice(2, eq), raw.slice(eq + 1));
  }

  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const from = map.get('from') ? new Date(String(map.get('from'))) : defaultFrom;
  const to = map.get('to') ? new Date(String(map.get('to'))) : now;
  if (!Number.isFinite(from.getTime())) throw new Error(`Invalid --from date: ${String(map.get('from'))}`);
  if (!Number.isFinite(to.getTime())) throw new Error(`Invalid --to date: ${String(map.get('to'))}`);

  const limit = map.get('limit') ? Number.parseInt(String(map.get('limit')), 10) : 200;
  const concurrency = map.get('concurrency') ? Number.parseInt(String(map.get('concurrency')), 10) : 2;

  const modeRaw = (map.get('mode') ?? 'all').toLowerCase();
  const mode: Args['mode'] = modeRaw === 'live' ? 'live' : modeRaw === 'paper' ? 'paper' : 'all';

  return {
    from,
    to,
    limit: Number.isFinite(limit) && limit > 0 ? limit : 200,
    sessionId: map.get('sessionId') ?? undefined,
    symbol: map.get('symbol') ?? undefined,
    mode,
    use1m: parseBool(map.get('use1m'), true),
    concurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 2,
    out: map.get('out') ?? undefined,
  };
}

function internalSymbolToBinanceFutures(symbol: string): string {
  // Accept: BTC/USDT:USDT, BTC/USDT, btc/usdt
  const upper = symbol.toUpperCase();
  const cleaned = upper.replace(':USDT', '').replace(':USD', '').replace('/', '');
  // BTCUSDT
  return cleaned;
}

async function fetchBinanceFuturesKlines(params: {
  symbol: string;
  interval: '15m' | '1m';
  startTime: number;
  endTime: number;
}): Promise<BinanceKline[]> {
  const out: BinanceKline[] = [];
  const endpoint = 'https://fapi.binance.com/fapi/v1/klines';
  const limit = 1000;

  let cursor = params.startTime;
  let safety = 0;

  while (cursor < params.endTime) {
    safety += 1;
    if (safety > 5000) throw new Error('Safety break: too many kline requests/loops');

    const url = new URL(endpoint);
    url.searchParams.set('symbol', params.symbol);
    url.searchParams.set('interval', params.interval);
    url.searchParams.set('startTime', String(cursor));
    url.searchParams.set('endTime', String(params.endTime));
    url.searchParams.set('limit', String(limit));

    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Binance klines failed ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
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

    // Move cursor forward; +1ms avoids repeating the same last candle.
    cursor = last.closeTime + 1;

    // Be gentle with API; analysis is offline but still.
    await new Promise((r) => setTimeout(r, 120));

    // If we got less than limit, likely done.
    if (data.length < limit) break;
  }

  // De-dup and sort
  const map = new Map<number, BinanceKline>();
  for (const c of out) map.set(c.openTime, c);
  return Array.from(map.values()).sort((a, b) => a.openTime - b.openTime);
}

function pnlPct(side: 'long' | 'short', entryPrice: number, exitPrice: number): number {
  if (side === 'long') return ((exitPrice - entryPrice) / entryPrice) * 100;
  return ((entryPrice - exitPrice) / entryPrice) * 100;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });

  await Promise.all(workers);
  return results;
}

async function simulateTrade(args: Args, trade: any): Promise<SimResult> {
  const side = (String(trade.positionSide).toLowerCase() === 'short' ? 'short' : 'long') as 'long' | 'short';
  const symbol = String(trade.symbol);
  const binanceSymbol = internalSymbolToBinanceFutures(symbol);

  const entryTs = new Date(trade.entryTs).getTime();
  const exitTs = new Date(trade.exitTs).getTime();

  // Small padding so we have enough candles around boundaries.
  const padMs = 30 * 60 * 1000;
  const startMs = entryTs - padMs;
  const endMs = exitTs + padMs;

  const candles15m = await fetchBinanceFuturesKlines({
    symbol: binanceSymbol,
    interval: '15m',
    startTime: startMs,
    endTime: endMs,
  });

  // Minimal position object for the exit logic.
  let position: any = {
    side,
    entryPrice: Number(trade.entryPrice),
    entryTime: entryTs,
    stopLossPct: MomentumConfig.EXIT.STOP_LOSS_PCT,
    highWaterMark: undefined,
    lowWaterMark: undefined,
    maxPnlPct: undefined,
  };

  let simulatedReason: SimResult['simulatedReason'] = 'none';
  let simulatedExitCandleOpen: number | null = null;
  let simulatedPaperExitTs: number | null = null;
  let simulatedPaperExitPrice: number | null = null;
  let simulatedIntrabarExitTs: number | null = null;
  let simulatedIntrabarExitPrice: number | null = null;
  let deltaPnlPctPaperMinusIntrabar: number | null = null;
  let delayMinutesPaperMinusIntrabar: number | null = null;

  let positionBeforeExitCandle: any | null = null;
  let exitCandle: BinanceKline | null = null;

  for (const c of candles15m) {
    // Only simulate after entry
    if (c.closeTime <= entryTs) continue;

    const currentPrice = c.close;
    position = updatePositionWaterMarks(position, currentPrice, c.high, c.low);

    const exitSignal = shouldExitPosition(position, currentPrice, undefined, {
      nowMs: c.openTime,
      priceHigh: c.high,
      priceLow: c.low,
    });

    if (exitSignal?.newStopLoss && Number.isFinite(Number(exitSignal.newStopLoss))) {
      position.appTrailingStop = Number(exitSignal.newStopLoss);
    }

    if (exitSignal?.shouldExit) {
      simulatedReason = exitSignal.reason === 'trailing'
        ? 'trailing'
        : exitSignal.reason === 'stoploss'
          ? 'stoploss'
          : exitSignal.reason === 'time'
            ? 'time'
            : 'none';

      simulatedExitCandleOpen = c.openTime;
      simulatedPaperExitTs = c.closeTime;
      simulatedPaperExitPrice = c.close;

      positionBeforeExitCandle = { ...position };
      exitCandle = c;

      // Intrabar approximation: if trailing/stoploss, assume fill at stop price.
      if (simulatedReason === 'trailing' && exitSignal.newStopLoss) {
        simulatedIntrabarExitPrice = Number(exitSignal.newStopLoss);
      } else if (simulatedReason === 'stoploss') {
        const slPct = Number(position.stopLossPct ?? MomentumConfig.EXIT.STOP_LOSS_PCT);
        simulatedIntrabarExitPrice = side === 'long'
          ? position.entryPrice * (1 - slPct / 100)
          : position.entryPrice * (1 + slPct / 100);
      } else {
        simulatedIntrabarExitPrice = c.close;
      }

      // Without 1m refinement, we can only bound time. Keep null unless refined.
      simulatedIntrabarExitTs = null;

      deltaPnlPctPaperMinusIntrabar =
        pnlPct(side, position.entryPrice, simulatedPaperExitPrice) -
        pnlPct(side, position.entryPrice, simulatedIntrabarExitPrice);

      break;
    }
  }

  // Optional 1m refinement: replay the exit candle at 1m resolution to estimate breach time.
  if (
    args.use1m &&
    simulatedReason !== 'none' &&
    simulatedExitCandleOpen != null &&
    simulatedPaperExitTs != null &&
    exitCandle &&
    positionBeforeExitCandle
  ) {
    const oneMin = await fetchBinanceFuturesKlines({
      symbol: binanceSymbol,
      interval: '1m',
      startTime: exitCandle.openTime,
      endTime: exitCandle.closeTime,
    });

    // Re-simulate only within the 15m window using 1m candles.
    // Start from a state that has watermarks up to BEFORE this 15m candle.
    // We approximate by resetting to entry and re-running all 15m candles before the exit candle.
    // (This keeps the 1m replay consistent with watermarks.)

    // If no 1m candles, skip refinement.
    if (oneMin.length > 0) {
      // Rebuild position up to the start of exitCandle.
      let pos: any = {
        side,
        entryPrice: Number(trade.entryPrice),
        entryTime: entryTs,
        stopLossPct: MomentumConfig.EXIT.STOP_LOSS_PCT,
        highWaterMark: undefined,
        lowWaterMark: undefined,
        maxPnlPct: undefined,
      };

      for (const c of candles15m) {
        if (c.openTime >= exitCandle.openTime) break;
        if (c.closeTime <= entryTs) continue;
        pos = updatePositionWaterMarks(pos, c.close, c.high, c.low);
        const sig = shouldExitPosition(pos, c.close, undefined, {
          nowMs: c.openTime,
          priceHigh: c.high,
          priceLow: c.low,
        });
        if (sig?.newStopLoss && Number.isFinite(Number(sig.newStopLoss))) {
          pos.appTrailingStop = Number(sig.newStopLoss);
        }
        if (sig?.shouldExit) {
          // Trade would have exited earlier than our detected exit candle; stop refinement.
          break;
        }
      }

      // Now walk 1m candles inside the breach 15m candle.
      for (const m of oneMin) {
        if (m.closeTime <= entryTs) continue;
        pos = updatePositionWaterMarks(pos, m.close, m.high, m.low);
        const sig = shouldExitPosition(pos, m.close, undefined, {
          nowMs: m.openTime,
          priceHigh: m.high,
          priceLow: m.low,
        });
        if (sig?.newStopLoss && Number.isFinite(Number(sig.newStopLoss))) {
          pos.appTrailingStop = Number(sig.newStopLoss);
        }
        if (sig?.shouldExit) {
          // Breach time estimate: closeTime of the 1m candle that first indicates it.
          simulatedIntrabarExitTs = m.closeTime;
          if (sig.reason === 'trailing' && sig.newStopLoss) {
            simulatedIntrabarExitPrice = Number(sig.newStopLoss);
          } else if (sig.reason === 'stoploss') {
            const slPct = Number(pos.stopLossPct ?? MomentumConfig.EXIT.STOP_LOSS_PCT);
            simulatedIntrabarExitPrice = side === 'long'
              ? pos.entryPrice * (1 - slPct / 100)
              : pos.entryPrice * (1 + slPct / 100);
          } else {
            simulatedIntrabarExitPrice = m.close;
          }
          break;
        }
      }

      if (simulatedIntrabarExitTs != null && simulatedPaperExitTs != null) {
        delayMinutesPaperMinusIntrabar = (simulatedPaperExitTs - simulatedIntrabarExitTs) / 60000;
      }

      if (simulatedPaperExitPrice != null && simulatedIntrabarExitPrice != null) {
        deltaPnlPctPaperMinusIntrabar =
          pnlPct(side, Number(trade.entryPrice), simulatedPaperExitPrice) -
          pnlPct(side, Number(trade.entryPrice), simulatedIntrabarExitPrice);
      }
    }
  }

  return {
    tradeId: String(trade.id),
    sessionId: String(trade.sessionId),
    symbol,
    side,
    entryTs,
    exitTs,
    entryPrice: Number(trade.entryPrice),
    dbExitPrice: Number(trade.exitPrice),
    simulatedReason,
    simulatedExitCandleOpen,
    simulatedPaperExitTs,
    simulatedPaperExitPrice,
    simulatedIntrabarExitTs,
    simulatedIntrabarExitPrice,
    deltaPnlPctPaperMinusIntrabar,
    delayMinutesPaperMinusIntrabar,
  };
}

function fmt(n: number | null | undefined, digits = 4): string {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  return n.toFixed(digits);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('📏 INTRABAR GAP ANALYZER (15m close vs intrabar stop)');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`Range: ${args.from.toISOString()} → ${args.to.toISOString()}`);
  console.log(`Filters: sessionId=${args.sessionId ?? 'any'} symbol=${args.symbol ?? 'any'} mode=${args.mode}`);
  console.log(`Options: use1m=${args.use1m} concurrency=${args.concurrency} limit=${args.limit}`);

  const where: any = {
    exitTs: {
      gte: args.from,
      lte: args.to,
    },
  };
  if (args.sessionId) where.sessionId = args.sessionId;
  if (args.symbol) where.symbol = args.symbol;
  if (args.mode !== 'all') {
    where.session = { is: { mode: args.mode } };
  }

  const trades = await prisma.trade.findMany({
    where,
    orderBy: { exitTs: 'desc' },
    take: args.limit,
    select: {
      id: true,
      sessionId: true,
      symbol: true,
      positionSide: true,
      entryPrice: true,
      exitPrice: true,
      entryTs: true,
      exitTs: true,
    },
  });

  console.log(`\nFound ${trades.length} trades to analyze.`);
  if (trades.length === 0) return;

  const results = await mapWithConcurrency(trades, args.concurrency, async (t, idx) => {
    const prefix = `[${idx + 1}/${trades.length}]`;
    try {
      const r = await simulateTrade(args, t);
      const d = r.deltaPnlPctPaperMinusIntrabar;
      const dStr = d == null ? 'n/a' : `${d >= 0 ? '+' : ''}${d.toFixed(3)}%`;
      const delayStr = r.delayMinutesPaperMinusIntrabar == null ? 'n/a' : `${r.delayMinutesPaperMinusIntrabar.toFixed(1)}m`;
      console.log(`${prefix} ${r.symbol} ${r.side} reason=${r.simulatedReason} Δpnl=${dStr} delay=${delayStr}`);
      return r;
    } catch (e: any) {
      console.log(`${prefix} ${String(t.symbol)} ERROR: ${String(e?.message ?? e)}`);
      return {
        tradeId: String(t.id),
        sessionId: String(t.sessionId),
        symbol: String(t.symbol),
        side: (String(t.positionSide).toLowerCase() === 'short' ? 'short' : 'long') as 'long' | 'short',
        entryTs: new Date(t.entryTs).getTime(),
        exitTs: new Date(t.exitTs).getTime(),
        entryPrice: Number(t.entryPrice),
        dbExitPrice: Number(t.exitPrice),
        simulatedReason: 'none',
        simulatedExitCandleOpen: null,
        simulatedPaperExitTs: null,
        simulatedPaperExitPrice: null,
        simulatedIntrabarExitTs: null,
        simulatedIntrabarExitPrice: null,
        deltaPnlPctPaperMinusIntrabar: null,
        delayMinutesPaperMinusIntrabar: null,
      } satisfies SimResult;
    }
  });

  const valid = results.filter((r) => r.deltaPnlPctPaperMinusIntrabar != null);
  const trailingOnly = valid.filter((r) => r.simulatedReason === 'trailing');
  const slOnly = valid.filter((r) => r.simulatedReason === 'stoploss');

  function summarize(label: string, arr: SimResult[]): void {
    if (arr.length === 0) {
      console.log(`\n${label}: none`);
      return;
    }
    const deltas = arr.map((r) => r.deltaPnlPctPaperMinusIntrabar!).filter((n) => Number.isFinite(n));
    const delays = arr.map((r) => r.delayMinutesPaperMinusIntrabar).filter((n): n is number => n != null && Number.isFinite(n));

    const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const avgDelay = delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : null;
    const better = deltas.filter((d) => d > 0).length;
    const worse = deltas.filter((d) => d < 0).length;

    console.log(`\n${label}:`);
    console.log(`  trades=${arr.length}`);
    console.log(`  avg(Δpnl paper-intrabar)=${avgDelta >= 0 ? '+' : ''}${avgDelta.toFixed(4)}%`);
    console.log(`  paperBetter=${better} paperWorse=${worse}`);
    console.log(`  avg(delay minutes)=${avgDelay == null ? 'n/a' : avgDelay.toFixed(2)}m (only when 1m refinement finds breach)`);

    const biggest = [...arr]
      .filter((r) => r.deltaPnlPctPaperMinusIntrabar != null)
      .sort((a, b) => Math.abs(b.deltaPnlPctPaperMinusIntrabar!) - Math.abs(a.deltaPnlPctPaperMinusIntrabar!))
      .slice(0, 5);

    console.log('  top5(|Δpnl|):');
    for (const r of biggest) {
      console.log(
        `    ${r.symbol} ${r.side} Δ=${r.deltaPnlPctPaperMinusIntrabar! >= 0 ? '+' : ''}${r.deltaPnlPctPaperMinusIntrabar!.toFixed(3)}% ` +
          `paper=$${fmt(r.simulatedPaperExitPrice, 4)} intrabar=$${fmt(r.simulatedIntrabarExitPrice, 4)} delay=${r.delayMinutesPaperMinusIntrabar == null ? 'n/a' : r.delayMinutesPaperMinusIntrabar.toFixed(1) + 'm'}`,
      );
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`Computed deltas for ${valid.length}/${results.length} trades.`);

  summarize('Trailing exits', trailingOnly);
  summarize('Stoploss exits', slOnly);

  if (args.out) {
    const fs = await import('node:fs/promises');
    const header = [
      'tradeId',
      'sessionId',
      'symbol',
      'side',
      'entryTs',
      'exitTs',
      'entryPrice',
      'dbExitPrice',
      'simulatedReason',
      'simulatedPaperExitTs',
      'simulatedPaperExitPrice',
      'simulatedIntrabarExitTs',
      'simulatedIntrabarExitPrice',
      'deltaPnlPctPaperMinusIntrabar',
      'delayMinutesPaperMinusIntrabar',
    ].join(',');

    const lines = results.map((r) => {
      const row = [
        r.tradeId,
        r.sessionId,
        r.symbol,
        r.side,
        String(r.entryTs),
        String(r.exitTs),
        String(r.entryPrice),
        String(r.dbExitPrice),
        r.simulatedReason,
        r.simulatedPaperExitTs == null ? '' : String(r.simulatedPaperExitTs),
        r.simulatedPaperExitPrice == null ? '' : String(r.simulatedPaperExitPrice),
        r.simulatedIntrabarExitTs == null ? '' : String(r.simulatedIntrabarExitTs),
        r.simulatedIntrabarExitPrice == null ? '' : String(r.simulatedIntrabarExitPrice),
        r.deltaPnlPctPaperMinusIntrabar == null ? '' : String(r.deltaPnlPctPaperMinusIntrabar),
        r.delayMinutesPaperMinusIntrabar == null ? '' : String(r.delayMinutesPaperMinusIntrabar),
      ];
      return row.map((s) => (String(s).includes(',') ? JSON.stringify(String(s)) : String(s))).join(',');
    });

    await fs.writeFile(args.out, [header, ...lines].join('\n'), 'utf8');
    console.log(`\nWrote CSV: ${args.out}`);
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

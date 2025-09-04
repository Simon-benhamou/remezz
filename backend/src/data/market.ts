import { exchange, resolveSymbol } from '../exchange/ccxtClient.js';
import { ema, rsi, atr } from './indicators.js';

export async function getTicker(symbol: string) {
  const ex = await exchange();
  const s = await resolveSymbol(symbol);
  return ex.fetchTicker(s);
}

export async function getOHLCV(symbol: string, tf = '1h', limit = 300) {
  const ex = await exchange();
  const s = await resolveSymbol(symbol);
  return ex.fetchOHLCV(s, tf, undefined, limit);
}

export async function computeCoreIndicators(symbol: string) {
  const o = await getOHLCV(symbol, '1h', 200);
  const c = o.map((r: any) => r[4]);
  return {
    ema20: ema(c, 20).at(-1),
    ema50: ema(c, 50).at(-1),
    rsi14: rsi(c, 14).at(-1),
    atr14: atr(o, 14).at(-1),
  };
}
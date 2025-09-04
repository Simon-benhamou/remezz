export function ema(values: number[], period: number) {
  const k = 2 / (period + 1);
  let prev = values[0];
  const out = [prev];
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}
export function rsi(values: number[], period = 14) {
  if (values.length < period + 1) return [];
  const g: number[] = [];
  const l: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    g.push(Math.max(d, 0));
    l.push(Math.max(-d, 0));
  }
  let ag = g.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let al = l.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out: number[] = new Array(period).fill(NaN);
  for (let i = period; i < g.length; i++) {
    ag = (ag * (period - 1) + g[i]) / period;
    al = (al * (period - 1) + l[i]) / period;
    const rs = al === 0 ? 100 : ag / (al || 1e-12);
    out.push(100 - 100 / (1 + rs));
  }
  return out;
}
export function atr(ohlcv: number[][], period = 14) {
  if (ohlcv.length < period + 1) return [];
  const trs: number[] = [];
  for (let i = 1; i < ohlcv.length; i++) {
    const [, o, h, l, ,] = ohlcv[i];
    const [, , ph, pl, pc] = ohlcv[i - 1];
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    trs.push(tr);
  }
  const out: number[] = [
    trs.slice(0, period).reduce((a, b) => a + b, 0) / period,
  ];
  for (let i = period; i < trs.length; i++) {
    out.push((out[out.length - 1] * (period - 1) + trs[i]) / period);
  }
  return out;
}

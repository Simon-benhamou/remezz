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

// Wilder's ADX (Average Directional Index)
export function adx(ohlcv: number[][], period = 14) {
  const n = ohlcv.length;
  if (n < period + 2) return [];

  const trs: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  for (let i = 1; i < n; i++) {
    const [, , high, low] = ohlcv[i];
    const [, , prevHigh, prevLow, prevClose] = ohlcv[i - 1];
    const upMove = high - prevHigh;
    const downMove = prevLow - low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }

  // Wilder's smoothing
  function smooth(arr: number[]) {
    const out: number[] = [];
    let sum = 0;
    for (let i = 0; i < arr.length; i++) {
      if (i < period) {
        sum += arr[i];
        if (i === period - 1) out.push(sum);
      } else {
        const prev = out[out.length - 1];
        out.push(prev - prev / period + arr[i]);
      }
    }
    return out;
  }

  const trN = smooth(trs);
  const plusDMN = smooth(plusDM);
  const minusDMN = smooth(minusDM);
  const out: number[] = new Array(period).fill(NaN);

  for (let i = 0; i < trN.length; i++) {
    const trVal = trN[i];
    const pdi = 100 * (plusDMN[i] / (trVal || 1e-12));
    const mdi = 100 * (minusDMN[i] / (trVal || 1e-12));
    const dx = 100 * (Math.abs(pdi - mdi) / (pdi + mdi || 1e-12));
    out.push(dx);
  }

  // Smooth DX to ADX
  const adxArr: number[] = [];
  const start = out.findIndex((v) => !Number.isNaN(v));
  if (start === -1) return [];
  let avg = 0;
  for (let i = start; i < out.length; i++) {
    if (i === start + period - 1) {
      const seed = out.slice(start, start + period).reduce((a, b) => a + b, 0) / period;
      avg = seed;
      adxArr.push(seed);
    } else if (i > start + period - 1) {
      avg = ((avg * (period - 1)) + out[i]) / period;
      adxArr.push(avg);
    }
  }
  return adxArr;
}

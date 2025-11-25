/**
 * RÉSUMÉ FINAL - COMPARAISON V24 vs V33
 * V24: Ultra Selective (ancienne stratégie)
 * V33: Strong Trend (nouvelle stratégie)
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binance({ 
  enableRateLimit: true,
  options: { defaultType: 'future' }
});

const SYMBOLS = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'];
const TIMEFRAME = '15m';
const DAYS = 120;
const CANDLES_PER_DAY = 96;
const TOTAL_CANDLES = DAYS * CANDLES_PER_DAY;

const INITIAL_CAPITAL = 10000;
const RISK_PER_TRADE = 0.01;

async function fetchAllCandles(symbol) {
  const allCandles = [];
  const now = Date.now();
  const candleDuration = 15 * 60 * 1000;
  let since = now - TOTAL_CANDLES * candleDuration;
  
  while (allCandles.length < TOTAL_CANDLES) {
    const candles = await exchange.fetchOHLCV(symbol, TIMEFRAME, since, 1000);
    if (candles.length === 0) break;
    allCandles.push(...candles);
    since = candles[candles.length - 1][0] + candleDuration;
    await new Promise(r => setTimeout(r, 50));
  }
  
  return allCandles.slice(-TOTAL_CANDLES);
}

// V24 Original Signal (Ultra Selective)
function detectV24Signal(candles, i) {
  if (i < 50) return null;
  
  const c = candles;
  
  // Calculate RSI
  let gains = 0, losses = 0;
  for (let j = i - 14; j < i; j++) {
    const change = c[j][4] - c[j-1][4];
    if (change > 0) gains += change;
    else losses -= change;
  }
  const avgGain = gains / 14;
  const avgLoss = losses / 14;
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));
  
  // Calculate ADX (simplified)
  let trSum = 0, dmPlusSum = 0, dmMinusSum = 0;
  for (let j = i - 14; j < i; j++) {
    const high = c[j][2];
    const low = c[j][3];
    const prevClose = c[j-1][4];
    const prevHigh = c[j-1][2];
    const prevLow = c[j-1][3];
    
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trSum += tr;
    
    const dmPlus = high - prevHigh > prevLow - low ? Math.max(high - prevHigh, 0) : 0;
    const dmMinus = prevLow - low > high - prevHigh ? Math.max(prevLow - low, 0) : 0;
    dmPlusSum += dmPlus;
    dmMinusSum += dmMinus;
  }
  
  const diPlus = (dmPlusSum / trSum) * 100;
  const diMinus = (dmMinusSum / trSum) * 100;
  const adx = Math.abs(diPlus - diMinus) / (diPlus + diMinus) * 100;
  
  // Volume
  const vol = c[i][5];
  const avgVol = c.slice(i-20, i).reduce((s, x) => s + x[5], 0) / 20;
  const volRatio = vol / avgVol;
  
  // ATR for volatility
  let atrSum = 0;
  for (let j = i - 14; j < i; j++) {
    const tr = Math.max(c[j][2] - c[j][3], Math.abs(c[j][2] - c[j-1][4]), Math.abs(c[j][3] - c[j-1][4]));
    atrSum += tr;
  }
  const atr = atrSum / 14;
  const volatility = (atr / c[i][4]) * 100;
  
  // Volatility regime
  let volatilityRegime = 'LOW';
  if (volatility > 0.7) volatilityRegime = 'HIGH';
  else if (volatility > 0.35) volatilityRegime = 'MEDIUM';
  
  // Ultra Selective: HIGH volatility only
  if (volatilityRegime !== 'HIGH') return null;
  
  // Score system
  let score = 0;
  
  // RSI
  if (rsi < 30 || rsi > 70) score += 2;
  else if (rsi < 40 || rsi > 60) score += 1;
  
  // ADX
  if (adx > 35) score += 2;
  else if (adx > 25) score += 1;
  
  // Volume
  if (volRatio > 1.5) score += 2;
  else if (volRatio > 1.2) score += 1;
  
  // Minimum score: 5
  if (score < 5) return null;
  
  // Direction
  if (rsi < 40 && diPlus > diMinus) return 'LONG';
  if (rsi > 60 && diMinus > diPlus) return 'SHORT';
  
  return null;
}

// V33 Signal (Strong Trend)
function detectV33Signal(candles, i) {
  if (i < 15) return null;
  
  const c = candles;
  const vol = c[i][5];
  const avgVol = c.slice(i-20, i).reduce((s, x) => s + x[5], 0) / 20;
  
  if (vol < avgVol * 1.2) return null;
  
  const close = c[i][4];
  const close4 = c[i-4][4];
  const close12 = c[i-12][4];
  
  const trend1 = close > c[i-1][4] ? 'UP' : 'DOWN';
  const trend4 = close > close4 ? 'UP' : 'DOWN';
  const trend12 = close > close12 ? 'UP' : 'DOWN';
  
  if (trend1 === 'UP' && trend4 === 'UP' && trend12 === 'UP') return 'LONG';
  if (trend1 === 'DOWN' && trend4 === 'DOWN' && trend12 === 'DOWN') return 'SHORT';
  
  return null;
}

async function runBacktest(allCandles, detectFn, tpPercent, slPercent) {
  const allSignals = [];
  
  for (const [symbol, candles] of Object.entries(allCandles)) {
    for (let i = 60; i < candles.length - 30; i++) {
      const direction = detectFn(candles, i);
      if (!direction) continue;
      
      allSignals.push({
        symbol, candleIndex: i, timestamp: candles[i][0],
        direction, entry: candles[i][4], candles
      });
    }
  }
  
  allSignals.sort((a, b) => a.timestamp - b.timestamp);
  
  let capital = INITIAL_CAPITAL;
  const monthlyPnL = {};
  let totalWins = 0, totalLosses = 0;
  
  for (const signal of allSignals) {
    const entry = signal.entry;
    const riskAmount = capital * RISK_PER_TRADE;
    const stopDistance = entry * slPercent;
    const positionSize = riskAmount / stopDistance;
    
    const tp = signal.direction === 'LONG' ? entry * (1 + tpPercent) : entry * (1 - tpPercent);
    const sl = signal.direction === 'LONG' ? entry * (1 - slPercent) : entry * (1 + slPercent);
    
    const candles = signal.candles;
    let outcome = null;
    
    for (let j = signal.candleIndex + 1; j < Math.min(signal.candleIndex + 30, candles.length); j++) {
      const high = candles[j][2];
      const low = candles[j][3];
      
      if (signal.direction === 'LONG') {
        if (high >= tp) { outcome = 'WIN'; break; }
        if (low <= sl) { outcome = 'LOSS'; break; }
      } else {
        if (low <= tp) { outcome = 'WIN'; break; }
        if (high >= sl) { outcome = 'LOSS'; break; }
      }
    }
    
    if (!outcome) continue;
    
    const pnlAmount = positionSize * stopDistance * (outcome === 'WIN' ? 1 : -1);
    capital += pnlAmount;
    
    const date = new Date(signal.timestamp);
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    
    if (!monthlyPnL[monthKey]) monthlyPnL[monthKey] = { wins: 0, losses: 0, pnlAmount: 0, startCapital: capital - pnlAmount };
    
    if (outcome === 'WIN') { monthlyPnL[monthKey].wins++; totalWins++; }
    else { monthlyPnL[monthKey].losses++; totalLosses++; }
    monthlyPnL[monthKey].pnlAmount += pnlAmount;
  }
  
  const months = Object.keys(monthlyPnL).sort();
  let positiveMonths = 0;
  for (const m of months) {
    if (monthlyPnL[m].pnlAmount >= 0) positiveMonths++;
  }
  
  return {
    totalTrades: totalWins + totalLosses,
    wins: totalWins,
    winRate: totalWins + totalLosses > 0 ? ((totalWins / (totalWins + totalLosses)) * 100).toFixed(1) : 0,
    totalPnL: capital - INITIAL_CAPITAL,
    positiveMonths,
    totalMonths: months.length,
    monthlyPnL,
    tradesPerDay: ((totalWins + totalLosses) / DAYS).toFixed(1)
  };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('📊 COMPARAISON FINALE: V24 (ULTRA SELECTIVE) vs V33 (STRONG TREND)');
  console.log('═'.repeat(80));
  
  const allCandles = {};
  for (const symbol of SYMBOLS) {
    console.log(`📥 Fetching ${symbol}...`);
    allCandles[symbol] = await fetchAllCandles(symbol);
  }
  
  console.log('\n🔬 Exécution des backtests...\n');
  
  const v24 = await runBacktest(allCandles, detectV24Signal, 0.01, 0.01);
  const v33 = await runBacktest(allCandles, detectV33Signal, 0.01, 0.01);
  
  console.log('═'.repeat(80));
  console.log('📈 RÉSULTATS');
  console.log('═'.repeat(80));
  
  console.log('\n┌─────────────────────┬──────────────────────┬──────────────────────┐');
  console.log('│      Métrique       │   V24 Ultra Select   │   V33 Strong Trend   │');
  console.log('├─────────────────────┼──────────────────────┼──────────────────────┤');
  console.log(`│ Trades totaux       │ ${String(v24.totalTrades).padStart(20)} │ ${String(v33.totalTrades).padStart(20)} │`);
  console.log(`│ Trades/jour         │ ${String(v24.tradesPerDay).padStart(20)} │ ${String(v33.tradesPerDay).padStart(20)} │`);
  console.log(`│ Win Rate            │ ${(v24.winRate + '%').padStart(20)} │ ${(v33.winRate + '%').padStart(20)} │`);
  console.log(`│ P&L Total           │ ${('+' + (v24.totalPnL/INITIAL_CAPITAL*100).toFixed(1) + '%').padStart(20)} │ ${('+' + (v33.totalPnL/INITIAL_CAPITAL*100).toFixed(1) + '%').padStart(20)} │`);
  console.log(`│ Mois Positifs       │ ${(v24.positiveMonths + '/' + v24.totalMonths).padStart(20)} │ ${(v33.positiveMonths + '/' + v33.totalMonths).padStart(20)} │`);
  console.log(`│ OBJECTIF ATTEINT    │ ${(v24.positiveMonths === v24.totalMonths ? '✅ OUI' : '❌ NON').padStart(20)} │ ${(v33.positiveMonths === v33.totalMonths ? '✅ OUI' : '❌ NON').padStart(20)} │`);
  console.log('└─────────────────────┴──────────────────────┴──────────────────────┘');
  
  console.log('\n📅 DÉTAIL MENSUEL V24:');
  console.log('─'.repeat(60));
  for (const [month, m] of Object.entries(v24.monthlyPnL).sort()) {
    const total = m.wins + m.losses;
    const wr = total > 0 ? (m.wins / total * 100).toFixed(1) : 0;
    const pnlPct = (m.pnlAmount / m.startCapital * 100).toFixed(2);
    console.log(`   ${month}: ${String(total).padStart(4)} trades, ${wr.padStart(5)}% WR, ${(m.pnlAmount >= 0 ? '+' : '') + pnlPct.padStart(8)}% ${m.pnlAmount >= 0 ? '✅' : '❌'}`);
  }
  
  console.log('\n📅 DÉTAIL MENSUEL V33:');
  console.log('─'.repeat(60));
  for (const [month, m] of Object.entries(v33.monthlyPnL).sort()) {
    const total = m.wins + m.losses;
    const wr = total > 0 ? (m.wins / total * 100).toFixed(1) : 0;
    const pnlPct = (m.pnlAmount / m.startCapital * 100).toFixed(2);
    console.log(`   ${month}: ${String(total).padStart(4)} trades, ${wr.padStart(5)}% WR, ${(m.pnlAmount >= 0 ? '+' : '') + pnlPct.padStart(8)}% ${m.pnlAmount >= 0 ? '✅' : '❌'}`);
  }
  
  console.log('\n' + '═'.repeat(80));
  console.log('🎯 CONCLUSION');
  console.log('═'.repeat(80));
  
  if (v33.positiveMonths === v33.totalMonths) {
    console.log(`
✅ V33 STRONG TREND ATTEINT L'OBJECTIF DE 5/5 MOIS POSITIFS!

📌 Signal V33:
   - 3 timeframes alignés (1 bougie, 4 bougies, 12 bougies)
   - Volume > 1.2x de la moyenne 20 périodes
   - Direction = sens du trend

📊 Comparaison:
   - V24: ${v24.totalTrades} trades, ${v24.positiveMonths}/${v24.totalMonths} mois positifs, +${(v24.totalPnL/INITIAL_CAPITAL*100).toFixed(0)}%
   - V33: ${v33.totalTrades} trades, ${v33.positiveMonths}/${v33.totalMonths} mois positifs, +${(v33.totalPnL/INITIAL_CAPITAL*100).toFixed(0)}%

⚠️  Points d'attention:
   - V33 génère beaucoup plus de trades (${v33.tradesPerDay}/jour vs ${v24.tradesPerDay}/jour)
   - Nécessite une exécution automatisée
   - Le win rate est modeste (${v33.winRate}%) mais suffisant avec R:R 1:1
`);
  }
}

main().catch(console.error);

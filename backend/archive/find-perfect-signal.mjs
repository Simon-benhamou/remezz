/**
 * RECHERCHE DU SIGNAL PARFAIT - 120 JOURS
 * Objectif: Trouver un signal qui donne 4/4 mois positifs
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
const TOTAL_CANDLES = DAYS * CANDLES_PER_DAY; // 11520

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

async function main() {
  console.log('═'.repeat(80));
  console.log('🎯 RECHERCHE DU SIGNAL PARFAIT - 4/4 MOIS POSITIFS');
  console.log('═'.repeat(80));
  
  // Fetch all data
  const allCandles = {};
  for (const symbol of SYMBOLS) {
    console.log(`📥 Fetching ${symbol} (${TOTAL_CANDLES} candles)...`);
    allCandles[symbol] = await fetchAllCandles(symbol);
    console.log(`   ✅ Got ${allCandles[symbol].length} candles`);
  }
  
  // Date range
  const firstDate = new Date(Object.values(allCandles)[0][0][0]);
  const lastDate = new Date(Object.values(allCandles)[0].slice(-1)[0][0]);
  console.log(`\n📅 Période: ${firstDate.toISOString().split('T')[0]} → ${lastDate.toISOString().split('T')[0]}`);
  
  // Test various signal combinations
  const signalConfigs = [
    { 
      name: 'Breakout 20 + Volume 1.2x',
      detect: (c, i) => {
        const close = c[i][4];
        const vol = c[i][5];
        const avgVol = c.slice(i-20, i).reduce((s, x) => s + x[5], 0) / 20;
        const high20 = Math.max(...c.slice(i-20, i).map(x => x[2]));
        const low20 = Math.min(...c.slice(i-20, i).map(x => x[3]));
        
        if (vol > avgVol * 1.2 && close > high20) return 'LONG';
        if (vol > avgVol * 1.2 && close < low20) return 'SHORT';
        return null;
      }
    },
    {
      name: 'Breakout 50 + Volume 1.5x',
      detect: (c, i) => {
        const close = c[i][4];
        const vol = c[i][5];
        const avgVol = c.slice(i-20, i).reduce((s, x) => s + x[5], 0) / 20;
        const high50 = Math.max(...c.slice(i-50, i).map(x => x[2]));
        const low50 = Math.min(...c.slice(i-50, i).map(x => x[3]));
        
        if (vol > avgVol * 1.5 && close > high50) return 'LONG';
        if (vol > avgVol * 1.5 && close < low50) return 'SHORT';
        return null;
      }
    },
    {
      name: '3 Consec Candles + Volume 1.3x',
      detect: (c, i) => {
        const vol = c[i][5];
        const avgVol = c.slice(i-20, i).reduce((s, x) => s + x[5], 0) / 20;
        if (vol < avgVol * 1.3) return null;
        
        const last3 = c.slice(i-3, i);
        const allUp = last3.every(x => x[4] > x[1]);
        const allDown = last3.every(x => x[4] < x[1]);
        
        if (allUp) return 'LONG';
        if (allDown) return 'SHORT';
        return null;
      }
    },
    {
      name: '4 Consec Candles + Volume 1.5x',
      detect: (c, i) => {
        const vol = c[i][5];
        const avgVol = c.slice(i-20, i).reduce((s, x) => s + x[5], 0) / 20;
        if (vol < avgVol * 1.5) return null;
        
        const last4 = c.slice(i-4, i);
        const allUp = last4.every(x => x[4] > x[1]);
        const allDown = last4.every(x => x[4] < x[1]);
        
        if (allUp) return 'LONG';
        if (allDown) return 'SHORT';
        return null;
      }
    },
    {
      name: 'Breakout 50 + Strong Volume 2x',
      detect: (c, i) => {
        const close = c[i][4];
        const vol = c[i][5];
        const avgVol = c.slice(i-20, i).reduce((s, x) => s + x[5], 0) / 20;
        const high50 = Math.max(...c.slice(i-50, i).map(x => x[2]));
        const low50 = Math.min(...c.slice(i-50, i).map(x => x[3]));
        
        if (vol > avgVol * 2 && close > high50) return 'LONG';
        if (vol > avgVol * 2 && close < low50) return 'SHORT';
        return null;
      }
    },
    {
      name: 'Momentum + Volume (RSI trend)',
      detect: (c, i) => {
        const vol = c[i][5];
        const avgVol = c.slice(i-20, i).reduce((s, x) => s + x[5], 0) / 20;
        if (vol < avgVol * 1.3) return null;
        
        // Simple momentum: price vs 10-period SMA
        const sma10 = c.slice(i-10, i).reduce((s, x) => s + x[4], 0) / 10;
        const sma20 = c.slice(i-20, i).reduce((s, x) => s + x[4], 0) / 20;
        const close = c[i][4];
        
        // Trend alignment
        if (close > sma10 && sma10 > sma20) return 'LONG';
        if (close < sma10 && sma10 < sma20) return 'SHORT';
        return null;
      }
    },
    {
      name: 'EMA Cross + Volume',
      detect: (c, i) => {
        const vol = c[i][5];
        const avgVol = c.slice(i-20, i).reduce((s, x) => s + x[5], 0) / 20;
        if (vol < avgVol * 1.2) return null;
        
        const ema9 = calcEMA(c.slice(0, i+1).map(x => x[4]), 9);
        const ema21 = calcEMA(c.slice(0, i+1).map(x => x[4]), 21);
        const prevEma9 = calcEMA(c.slice(0, i).map(x => x[4]), 9);
        const prevEma21 = calcEMA(c.slice(0, i).map(x => x[4]), 21);
        
        // Cross up
        if (prevEma9 <= prevEma21 && ema9 > ema21) return 'LONG';
        // Cross down
        if (prevEma9 >= prevEma21 && ema9 < ema21) return 'SHORT';
        return null;
      }
    },
    {
      name: 'Strong Trend (all 3 timeframes align)',
      detect: (c, i) => {
        const vol = c[i][5];
        const avgVol = c.slice(i-20, i).reduce((s, x) => s + x[5], 0) / 20;
        
        // 3 timeframes: current, 4 candles ago, 12 candles ago
        const close = c[i][4];
        const close4 = c[i-4] ? c[i-4][4] : close;
        const close12 = c[i-12] ? c[i-12][4] : close;
        
        const trend1 = close > c[i-1][4] ? 'UP' : 'DOWN';
        const trend4 = close > close4 ? 'UP' : 'DOWN';
        const trend12 = close > close12 ? 'UP' : 'DOWN';
        
        if (trend1 === 'UP' && trend4 === 'UP' && trend12 === 'UP' && vol > avgVol * 1.2) return 'LONG';
        if (trend1 === 'DOWN' && trend4 === 'DOWN' && trend12 === 'DOWN' && vol > avgVol * 1.2) return 'SHORT';
        return null;
      }
    },
    {
      name: 'Higher High/Lower Low Structure',
      detect: (c, i) => {
        if (i < 30) return null;
        
        const vol = c[i][5];
        const avgVol = c.slice(i-20, i).reduce((s, x) => s + x[5], 0) / 20;
        if (vol < avgVol * 1.2) return null;
        
        // Find recent swing points
        const highs = [];
        const lows = [];
        for (let j = i - 25; j < i - 2; j++) {
          if (c[j][2] > c[j-1][2] && c[j][2] > c[j+1][2]) highs.push(c[j][2]);
          if (c[j][3] < c[j-1][3] && c[j][3] < c[j+1][3]) lows.push(c[j][3]);
        }
        
        if (highs.length >= 2 && lows.length >= 2) {
          const hh = highs.slice(-2);
          const ll = lows.slice(-2);
          
          // Higher highs and higher lows
          if (hh[1] > hh[0] && ll[1] > ll[0]) return 'LONG';
          // Lower highs and lower lows
          if (hh[1] < hh[0] && ll[1] < ll[0]) return 'SHORT';
        }
        return null;
      }
    },
    {
      name: 'Compression Breakout (narrow range then expand)',
      detect: (c, i) => {
        if (i < 15) return null;
        
        // Range of last 10 candles
        const range10 = c.slice(i-10, i);
        const rangeSize = (Math.max(...range10.map(x => x[2])) - Math.min(...range10.map(x => x[3]))) / c[i][4];
        
        // Current candle size
        const currentSize = Math.abs(c[i][4] - c[i][1]) / c[i][4];
        
        // Compression: range < 2% then current candle > 0.5%
        if (rangeSize < 0.02 && currentSize > 0.005) {
          if (c[i][4] > c[i][1]) return 'LONG';
          if (c[i][4] < c[i][1]) return 'SHORT';
        }
        return null;
      }
    }
  ];
  
  console.log('\n' + '═'.repeat(80));
  console.log('🔬 TEST DE CHAQUE SIGNAL SUR 4 MOIS');
  console.log('═'.repeat(80));
  
  const results = [];
  
  for (const config of signalConfigs) {
    const monthlyResults = {};
    
    for (const [symbol, candles] of Object.entries(allCandles)) {
      for (let i = 60; i < candles.length - 30; i++) {
        const direction = config.detect(candles, i);
        if (!direction) continue;
        
        const date = new Date(candles[i][0]);
        const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        
        if (!monthlyResults[monthKey]) monthlyResults[monthKey] = { wins: 0, losses: 0 };
        
        // Simulate trade
        const entry = candles[i][4];
        const tp = entry * (direction === 'LONG' ? 1.01 : 0.99);
        const sl = entry * (direction === 'LONG' ? 0.99 : 1.01);
        
        let outcome = null;
        for (let j = i + 1; j < Math.min(i + 30, candles.length); j++) {
          const high = candles[j][2];
          const low = candles[j][3];
          
          if (direction === 'LONG') {
            if (high >= tp) { outcome = 'WIN'; break; }
            if (low <= sl) { outcome = 'LOSS'; break; }
          } else {
            if (low <= tp) { outcome = 'WIN'; break; }
            if (high >= sl) { outcome = 'LOSS'; break; }
          }
        }
        
        if (outcome === 'WIN') monthlyResults[monthKey].wins++;
        if (outcome === 'LOSS') monthlyResults[monthKey].losses++;
      }
    }
    
    // Calculate per month
    const months = Object.keys(monthlyResults).sort();
    let positiveMonths = 0;
    let totalTrades = 0;
    let totalWins = 0;
    const monthDetails = [];
    
    for (const month of months) {
      const m = monthlyResults[month];
      const total = m.wins + m.losses;
      const wr = total > 0 ? (m.wins / total * 100) : 0;
      const pnl = m.wins - m.losses;
      
      totalTrades += total;
      totalWins += m.wins;
      
      if (pnl >= 0) positiveMonths++;
      monthDetails.push({ month, total, wr: wr.toFixed(0), pnl, positive: pnl >= 0 });
    }
    
    const avgWR = totalTrades > 0 ? (totalWins / totalTrades * 100).toFixed(1) : 0;
    
    results.push({
      name: config.name,
      positiveMonths,
      totalMonths: months.length,
      trades: totalTrades,
      avgWR,
      monthDetails
    });
  }
  
  // Sort by positive months, then by trades
  results.sort((a, b) => {
    if (b.positiveMonths !== a.positiveMonths) return b.positiveMonths - a.positiveMonths;
    return b.trades - a.trades;
  });
  
  // Display results
  console.log('\n📊 RÉSULTATS CLASSÉS PAR PERFORMANCE:\n');
  
  for (const r of results) {
    const icon = r.positiveMonths >= r.totalMonths ? '🏆' : 
                 r.positiveMonths >= r.totalMonths - 1 ? '🟡' : '❌';
    
    console.log(`${icon} ${r.name}`);
    console.log(`   Mois positifs: ${r.positiveMonths}/${r.totalMonths} | Trades: ${r.trades} | WR: ${r.avgWR}%`);
    
    const monthStr = r.monthDetails.map(m => 
      `${m.month.slice(5)}: ${m.positive ? '✅' : '❌'} ${m.pnl >= 0 ? '+' : ''}${m.pnl} (${m.total})`
    ).join(' | ');
    console.log(`   ${monthStr}\n`);
  }
  
  // Find best combination that achieves 4/4
  console.log('\n' + '═'.repeat(80));
  console.log('🎯 MEILLEUR SIGNAL POUR 4/4 MOIS:');
  console.log('═'.repeat(80));
  
  const best = results.find(r => r.positiveMonths === r.totalMonths);
  if (best) {
    console.log(`\n✅ TROUVÉ: ${best.name}`);
    console.log(`   ${best.trades} trades, ${best.avgWR}% WR`);
    console.log('\n   Détails par mois:');
    for (const m of best.monthDetails) {
      console.log(`   ${m.month}: ${m.total} trades, ${m.wr}% WR, ${m.pnl >= 0 ? '+' : ''}${m.pnl}`);
    }
  } else {
    console.log('\n❌ Aucun signal ne donne 4/4 mois positifs avec ces paramètres.');
    console.log('\n🔄 Meilleur résultat:');
    const nearest = results[0];
    console.log(`   ${nearest.name}: ${nearest.positiveMonths}/${nearest.totalMonths} mois positifs`);
  }
}

function calcEMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1];
  
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b) / period;
  
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  
  return ema;
}

main().catch(console.error);

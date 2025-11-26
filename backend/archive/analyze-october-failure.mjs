/**
 * ANALYSE DÉTAILLÉE DE L'ÉCHEC D'OCTOBRE
 * Pourquoi la combinaison qui marche en Sept échoue en Oct?
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binance({ 
  enableRateLimit: true,
  options: { defaultType: 'future' }
});

const SYMBOLS = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'];
const TIMEFRAME = '15m';

async function main() {
  console.log('═'.repeat(80));
  console.log('🔍 ANALYSE DÉTAILLÉE DE L\'ÉCHEC D\'OCTOBRE');
  console.log('═'.repeat(80));
  
  // Fetch data for each symbol
  const allCandles = {};
  for (const symbol of SYMBOLS) {
    console.log(`📥 Fetching ${symbol}...`);
    const candles = await exchange.fetchOHLCV(symbol, TIMEFRAME, undefined, 1500);
    allCandles[symbol] = candles;
    await new Promise(r => setTimeout(r, 100));
  }
  
  // Analyze October specifically
  const octoberTrades = [];
  const septemberTrades = [];
  const novemberTrades = [];
  
  for (const [symbol, candles] of Object.entries(allCandles)) {
    for (let i = 100; i < candles.length - 10; i++) {
      const date = new Date(candles[i][0]);
      const month = date.getMonth() + 1; // 1-12
      
      if (month < 9 || month > 11) continue;
      
      const signal = detectSignals(candles, i);
      
      if (signal.hasSignal) {
        // Simulate trade
        const entry = candles[i][4]; // Close
        const tp = entry * (signal.direction === 'LONG' ? 1.01 : 0.99);
        const sl = entry * (signal.direction === 'LONG' ? 0.99 : 1.01);
        
        let outcome = null;
        for (let j = i + 1; j < Math.min(i + 30, candles.length); j++) {
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
        
        if (!outcome) outcome = 'TIMEOUT';
        
        const trade = {
          symbol,
          date: date.toISOString(),
          direction: signal.direction,
          signalType: signal.type,
          outcome,
          signals: signal.details
        };
        
        if (month === 9) septemberTrades.push(trade);
        if (month === 10) octoberTrades.push(trade);
        if (month === 11) novemberTrades.push(trade);
      }
    }
  }
  
  // Analyze differences
  console.log('\n' + '═'.repeat(80));
  console.log('📊 COMPARAISON SEPTEMBRE vs OCTOBRE vs NOVEMBRE');
  console.log('═'.repeat(80));
  
  for (const [name, trades] of [['SEPTEMBRE', septemberTrades], ['OCTOBRE', octoberTrades], ['NOVEMBRE', novemberTrades]]) {
    const wins = trades.filter(t => t.outcome === 'WIN').length;
    const losses = trades.filter(t => t.outcome === 'LOSS').length;
    const total = wins + losses;
    const wr = total > 0 ? (wins / total * 100).toFixed(1) : 0;
    
    console.log(`\n📅 ${name}: ${total} trades, ${wr}% WR`);
    
    // Par type de signal
    const byType = {};
    for (const t of trades) {
      if (!byType[t.signalType]) byType[t.signalType] = { wins: 0, losses: 0, timeouts: 0 };
      if (t.outcome === 'WIN') byType[t.signalType].wins++;
      else if (t.outcome === 'LOSS') byType[t.signalType].losses++;
      else byType[t.signalType].timeouts++;
    }
    
    for (const [type, stats] of Object.entries(byType)) {
      const total = stats.wins + stats.losses;
      const wr = total > 0 ? (stats.wins / total * 100).toFixed(0) : 0;
      console.log(`   ${type}: ${total} trades, ${wr}% WR`);
    }
    
    // Par direction
    const longs = trades.filter(t => t.direction === 'LONG');
    const shorts = trades.filter(t => t.direction === 'SHORT');
    const longWins = longs.filter(t => t.outcome === 'WIN').length;
    const shortWins = shorts.filter(t => t.outcome === 'SHORT').length;
    const longTotal = longs.filter(t => t.outcome !== 'TIMEOUT').length;
    const shortTotal = shorts.filter(t => t.outcome !== 'TIMEOUT').length;
    
    console.log(`   LONG: ${longTotal} trades, ${longTotal > 0 ? (longWins/longTotal*100).toFixed(0) : 0}% WR`);
    console.log(`   SHORT: ${shortTotal} trades, ${shortTotal > 0 ? (shortWins/shortTotal*100).toFixed(0) : 0}% WR`);
  }
  
  // Chercher ce qui différencie les trades gagnants d'octobre
  console.log('\n' + '═'.repeat(80));
  console.log('🎯 ANALYSE DES WINNERS VS LOSERS EN OCTOBRE');
  console.log('═'.repeat(80));
  
  const octWins = octoberTrades.filter(t => t.outcome === 'WIN');
  const octLosses = octoberTrades.filter(t => t.outcome === 'LOSS');
  
  console.log(`\n🏆 Winners (${octWins.length}):`);
  const winSignals = {};
  for (const t of octWins) {
    if (!winSignals[t.signalType]) winSignals[t.signalType] = 0;
    winSignals[t.signalType]++;
  }
  console.log('   Par signal:', winSignals);
  
  console.log(`\n💀 Losers (${octLosses.length}):`);
  const lossSignals = {};
  for (const t of octLosses) {
    if (!lossSignals[t.signalType]) lossSignals[t.signalType] = 0;
    lossSignals[t.signalType]++;
  }
  console.log('   Par signal:', lossSignals);
  
  // Test différents filtres
  console.log('\n' + '═'.repeat(80));
  console.log('🔬 TEST DE FILTRES ADDITIONNELS');
  console.log('═'.repeat(80));
  
  // Filtre 1: Volume très élevé seulement
  await testFilter('Volume > 1.5x', allCandles, (c, i) => {
    const vol = c[i][5];
    const avgVol = c.slice(i-20, i).reduce((s, x) => s + x[5], 0) / 20;
    return vol > avgVol * 1.5;
  });
  
  // Filtre 2: Breakout de 50 périodes seulement
  await testFilter('Breakout 50 only', allCandles, (c, i) => {
    const close = c[i][4];
    const high50 = Math.max(...c.slice(i-50, i).map(x => x[2]));
    const low50 = Math.min(...c.slice(i-50, i).map(x => x[3]));
    return close > high50 || close < low50;
  });
  
  // Filtre 3: Trend fort (5 bougies même direction)
  await testFilter('Strong Trend (5 candles)', allCandles, (c, i) => {
    const last5 = c.slice(i-5, i);
    const allUp = last5.every(x => x[4] > x[1]);
    const allDown = last5.every(x => x[4] < x[1]);
    return allUp || allDown;
  });
  
  // Filtre 4: Volume + Breakout 50
  await testFilter('Volume 1.5x + Breakout 50', allCandles, (c, i) => {
    const vol = c[i][5];
    const avgVol = c.slice(i-20, i).reduce((s, x) => s + x[5], 0) / 20;
    const close = c[i][4];
    const high50 = Math.max(...c.slice(i-50, i).map(x => x[2]));
    const low50 = Math.min(...c.slice(i-50, i).map(x => x[3]));
    return (vol > avgVol * 1.5) && (close > high50 || close < low50);
  });
  
  // Filtre 5: Volume + Trend 3 candles
  await testFilter('Volume 1.3x + Trend 3', allCandles, (c, i) => {
    const vol = c[i][5];
    const avgVol = c.slice(i-20, i).reduce((s, x) => s + x[5], 0) / 20;
    const last3 = c.slice(i-3, i);
    const allUp = last3.every(x => x[4] > x[1]);
    const allDown = last3.every(x => x[4] < x[1]);
    return (vol > avgVol * 1.3) && (allUp || allDown);
  });
  
  console.log('\n' + '═'.repeat(80));
}

function detectSignals(candles, i) {
  const c = candles;
  
  // Get indicators
  const close = c[i][4];
  const vol = c[i][5];
  const avgVol = c.slice(i-20, i).reduce((s, x) => s + x[5], 0) / 20;
  const high20 = Math.max(...c.slice(i-20, i).map(x => x[2]));
  const low20 = Math.min(...c.slice(i-20, i).map(x => x[3]));
  
  const details = {
    volumeRatio: vol / avgVol,
    priceVsHigh20: (close - high20) / high20 * 100,
    priceVsLow20: (close - low20) / low20 * 100
  };
  
  // Volume + Breakout
  const volumeSpike = vol > avgVol * 1.2;
  const breakoutUp = close > high20;
  const breakoutDown = close < low20;
  
  if (volumeSpike && breakoutUp) {
    return { hasSignal: true, direction: 'LONG', type: 'Volume+BreakUp', details };
  }
  if (volumeSpike && breakoutDown) {
    return { hasSignal: true, direction: 'SHORT', type: 'Volume+BreakDown', details };
  }
  
  // Three consecutive candles
  const last3 = c.slice(i-3, i);
  const threeUp = last3.every(x => x[4] > x[1]);
  const threeDown = last3.every(x => x[4] < x[1]);
  
  if (threeUp && volumeSpike) {
    return { hasSignal: true, direction: 'LONG', type: 'ThreeUp+Volume', details };
  }
  if (threeDown && volumeSpike) {
    return { hasSignal: true, direction: 'SHORT', type: 'ThreeDown+Volume', details };
  }
  
  return { hasSignal: false, direction: null, type: null, details };
}

async function testFilter(name, allCandles, filterFn) {
  const results = { sept: { wins: 0, losses: 0 }, oct: { wins: 0, losses: 0 }, nov: { wins: 0, losses: 0 } };
  
  for (const [symbol, candles] of Object.entries(allCandles)) {
    for (let i = 100; i < candles.length - 10; i++) {
      const date = new Date(candles[i][0]);
      const month = date.getMonth() + 1;
      
      if (month < 9 || month > 11) continue;
      if (!filterFn(candles, i)) continue;
      
      // Simple direction based on trend
      const last3 = candles.slice(i-3, i);
      const trendUp = last3.every(x => x[4] > x[1]);
      const direction = trendUp ? 'LONG' : 'SHORT';
      
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
      
      if (!outcome) continue;
      
      const key = month === 9 ? 'sept' : month === 10 ? 'oct' : 'nov';
      if (outcome === 'WIN') results[key].wins++;
      else results[key].losses++;
    }
  }
  
  const getStats = (m) => {
    const total = m.wins + m.losses;
    const wr = total > 0 ? (m.wins / total * 100).toFixed(0) : 0;
    const pnl = (m.wins - m.losses);
    return { total, wr, pnl };
  };
  
  const sept = getStats(results.sept);
  const oct = getStats(results.oct);
  const nov = getStats(results.nov);
  const all3 = sept.pnl >= 0 && oct.pnl >= 0 && nov.pnl >= 0;
  
  console.log(`\n${all3 ? '✅' : '❌'} ${name}:`);
  console.log(`   Sept: ${sept.total} trades, ${sept.wr}% WR, ${sept.pnl >= 0 ? '+' : ''}${sept.pnl} ${sept.pnl >= 0 ? '✅' : '❌'}`);
  console.log(`   Oct:  ${oct.total} trades, ${oct.wr}% WR, ${oct.pnl >= 0 ? '+' : ''}${oct.pnl} ${oct.pnl >= 0 ? '✅' : '❌'}`);
  console.log(`   Nov:  ${nov.total} trades, ${nov.wr}% WR, ${nov.pnl >= 0 ? '+' : ''}${nov.pnl} ${nov.pnl >= 0 ? '✅' : '❌'}`);
}

main().catch(console.error);

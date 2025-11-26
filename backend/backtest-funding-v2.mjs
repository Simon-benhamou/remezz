/**
 * 🎯 FUNDING RATE STRATEGY V2 - Less Strict + More Data Sources
 * 
 * V1 had 75% WR but only 8 trades
 * V2: Lower thresholds + combine multiple signals
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binance({ 
  enableRateLimit: true,
  options: { defaultType: 'future' }
});

const INITIAL_CAPITAL = 10000;

// CORRECT FEES
const FEES = {
  round_trip: 0.001 // 0.10% total
};

const LEVERAGE = { BTC: 3, ETH: 4, SOL: 5, XRP: 4 };

async function fetchCandles(symbol, timeframe = '4h', days = 365) {
  try {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const all = [];
    let fetchSince = since;
    
    while (fetchSince < Date.now()) {
      const candles = await exchange.fetchOHLCV(symbol, timeframe, fetchSince, 500);
      if (candles.length === 0) break;
      all.push(...candles);
      fetchSince = candles[candles.length - 1][0] + 1;
      if (candles.length < 500) break;
    }
    return all;
  } catch (e) {
    console.error(`Error ${symbol}:`, e.message);
    return [];
  }
}

async function fetchHistoricalFundingRates(symbol, days = 365) {
  try {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const all = [];
    let fetchSince = since;
    
    while (fetchSince < Date.now()) {
      const rates = await exchange.fetchFundingRateHistory(symbol, fetchSince, 500);
      if (rates.length === 0) break;
      all.push(...rates);
      fetchSince = rates[rates.length - 1].timestamp + 1;
      if (rates.length < 500) break;
    }
    return all;
  } catch (e) {
    console.error(`Error funding ${symbol}:`, e.message);
    return [];
  }
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  const changes = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }
  const recentChanges = changes.slice(-period);
  const gains = recentChanges.filter(c => c > 0);
  const losses = recentChanges.filter(c => c < 0).map(c => Math.abs(c));
  const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / period : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / period : 0;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function calcEMA(data, period) {
  const k = 2 / (period + 1);
  let ema = data[0];
  const result = [ema];
  for (let i = 1; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

async function backtestStrategy(symbol, fundingRates, thresholds) {
  const candles = await fetchCandles(symbol, '4h', 365);
  if (candles.length < 100) return [];
  
  const asset = symbol.split('/')[0];
  const leverage = LEVERAGE[asset] || 3;
  const closes = candles.map(c => c[4]);
  const highs = candles.map(c => c[2]);
  const lows = candles.map(c => c[3]);
  const volumes = candles.map(c => c[5]);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);
  
  // Create funding rate lookup
  const fundingMap = new Map();
  fundingRates.forEach(fr => {
    const key = Math.floor(fr.timestamp / (8 * 60 * 60 * 1000));
    fundingMap.set(key, fr.fundingRate);
  });
  
  const trades = [];
  let position = null;
  
  for (let i = 50; i < candles.length - 1; i++) {
    const ts = candles[i][0];
    const close = closes[i];
    const high = highs[i];
    const low = lows[i];
    const rsi = calcRSI(closes.slice(0, i + 1), 14);
    const ema21Val = ema21[i];
    const ema50Val = ema50[i];
    
    // Volume analysis
    const vol = volumes[i];
    const avgVol = volumes.slice(Math.max(0, i - 20), i).reduce((a, b) => a + b, 0) / 20;
    const volRatio = vol / avgVol;
    
    // Funding rate
    const fundingKey = Math.floor(ts / (8 * 60 * 60 * 1000));
    const fundingRate = fundingMap.get(fundingKey) || fundingMap.get(fundingKey - 1) || 0;
    
    // Signal scoring system
    let longScore = 0;
    let shortScore = 0;
    
    // 1. Funding rate signals
    if (fundingRate < thresholds.funding_negative) longScore += 3;  // Shorts crowded
    if (fundingRate < thresholds.funding_negative * 0.5) longScore += 2; // Very crowded
    if (fundingRate > thresholds.funding_positive) shortScore += 3; // Longs crowded
    if (fundingRate > thresholds.funding_positive * 1.5) shortScore += 2;
    
    // 2. RSI signals
    if (rsi < 30) longScore += 2;
    if (rsi < 25) longScore += 1;
    if (rsi > 70) shortScore += 2;
    if (rsi > 75) shortScore += 1;
    
    // 3. Volume spike
    if (volRatio > 2) {
      if (close < closes[i - 1]) longScore += 1; // Capitulation volume
      if (close > closes[i - 1]) shortScore += 1; // Blow-off volume
    }
    
    // 4. Trend context (weak signal)
    if (close < ema50Val && rsi < 40) longScore += 1; // Oversold in downtrend
    if (close > ema50Val && rsi > 60) shortScore += 1; // Overbought in uptrend
    
    if (!position) {
      // Need minimum score to enter
      if (longScore >= thresholds.min_score) {
        position = {
          side: 'LONG',
          entryPrice: close,
          entryTime: ts,
          score: longScore
        };
      } else if (shortScore >= thresholds.min_score) {
        position = {
          side: 'SHORT',
          entryPrice: close,
          entryTime: ts,
          score: shortScore
        };
      }
    } else {
      // Exit logic - wider targets
      let exitPrice = null;
      let exitReason = '';
      
      const holdingHours = (ts - position.entryTime) / (1000 * 60 * 60);
      
      if (position.side === 'LONG') {
        const pnl = (close - position.entryPrice) / position.entryPrice;
        
        // Dynamic targets based on entry score
        const tpTarget = position.score >= 5 ? 0.05 : 0.03; // 5% if strong signal, 3% otherwise
        const slTarget = -0.025; // 2.5% stop
        
        if (pnl >= tpTarget) { exitPrice = close; exitReason = 'take_profit'; }
        else if (pnl <= slTarget) { exitPrice = close; exitReason = 'stop_loss'; }
        else if (holdingHours >= 72) { exitPrice = close; exitReason = 'time_stop'; }
        else if (rsi > 70 && pnl > 0.01) { exitPrice = close; exitReason = 'rsi_exit'; }
      } else {
        const pnl = (position.entryPrice - close) / position.entryPrice;
        const tpTarget = position.score >= 5 ? 0.05 : 0.03;
        const slTarget = -0.025;
        
        if (pnl >= tpTarget) { exitPrice = close; exitReason = 'take_profit'; }
        else if (pnl <= slTarget) { exitPrice = close; exitReason = 'stop_loss'; }
        else if (holdingHours >= 72) { exitPrice = close; exitReason = 'time_stop'; }
        else if (rsi < 30 && pnl > 0.01) { exitPrice = close; exitReason = 'rsi_exit'; }
      }
      
      if (exitPrice) {
        let pnlPercent;
        if (position.side === 'LONG') {
          pnlPercent = ((exitPrice - position.entryPrice) / position.entryPrice - FEES.round_trip) * 100;
        } else {
          pnlPercent = ((position.entryPrice - exitPrice) / position.entryPrice - FEES.round_trip) * 100;
        }
        
        trades.push({
          symbol,
          side: position.side,
          entryTime: position.entryTime,
          exitTime: ts,
          entryPrice: position.entryPrice,
          exitPrice,
          pnlPercent,
          leverage,
          pnlWithLeverage: pnlPercent * leverage,
          exitReason,
          score: position.score
        });
        
        position = null;
      }
    }
  }
  
  return trades;
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🎯 FUNDING RATE STRATEGY V2 - Multiple Thresholds Test');
  console.log('═'.repeat(80));
  console.log(`\n💰 Capital: $${INITIAL_CAPITAL.toLocaleString()}`);
  console.log('📅 Period: Last 365 days\n');
  
  // Fetch funding rates
  console.log('📥 Fetching data...');
  const symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT'];
  const fundingRatesMap = {};
  
  for (const symbol of symbols) {
    fundingRatesMap[symbol] = await fetchHistoricalFundingRates(symbol, 365);
    console.log(`   ${symbol}: ${fundingRatesMap[symbol].length} funding snapshots`);
  }
  
  // Test different thresholds
  const thresholdConfigs = [
    { 
      name: 'STRICT (original)',
      funding_positive: 0.0005,  // 0.05%
      funding_negative: -0.0003, // -0.03%
      min_score: 5
    },
    { 
      name: 'MEDIUM',
      funding_positive: 0.0003,  // 0.03%
      funding_negative: -0.0002, // -0.02%
      min_score: 4
    },
    { 
      name: 'LOOSE',
      funding_positive: 0.0002,  // 0.02%
      funding_negative: -0.0001, // -0.01%
      min_score: 3
    },
    { 
      name: 'VERY LOOSE',
      funding_positive: 0.0001,  // 0.01%
      funding_negative: -0.00005, // -0.005%
      min_score: 3
    }
  ];
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 RESULTS BY THRESHOLD');
  console.log('═'.repeat(80));
  
  const results = [];
  
  for (const config of thresholdConfigs) {
    console.log(`\n🔧 Testing: ${config.name}...`);
    
    const allTrades = [];
    for (const symbol of symbols) {
      const trades = await backtestStrategy(symbol, fundingRatesMap[symbol], config);
      allTrades.push(...trades);
    }
    
    const totalTrades = allTrades.length;
    const wins = allTrades.filter(t => t.pnlPercent > 0).length;
    const wr = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
    const pnlLev = allTrades.reduce((a, t) => a + t.pnlWithLeverage, 0);
    
    // Monthly analysis
    const byMonth = {};
    allTrades.forEach(t => {
      const month = new Date(t.exitTime).toISOString().slice(0, 7);
      if (!byMonth[month]) byMonth[month] = 0;
      byMonth[month] += t.pnlWithLeverage;
    });
    const positiveMonths = Object.values(byMonth).filter(p => p > 0).length;
    const totalMonths = Object.keys(byMonth).length;
    
    results.push({
      name: config.name,
      trades: totalTrades,
      wr,
      pnlLev,
      positiveMonths,
      totalMonths,
      tradesPerMonth: totalMonths > 0 ? (totalTrades / totalMonths).toFixed(1) : 0
    });
    
    console.log(`   Trades: ${totalTrades} | WR: ${wr.toFixed(1)}% | ROI: ${pnlLev >= 0 ? '+' : ''}${pnlLev.toFixed(1)}%`);
  }
  
  // Summary table
  console.log('\n' + '═'.repeat(80));
  console.log('📊 COMPARISON');
  console.log('═'.repeat(80));
  
  console.log('\n┌─────────────────────┬─────────┬─────────────┬────────────┬─────────────────┐');
  console.log('│ Config              │ Trades  │   Win Rate  │   ROI      │  +ve Months     │');
  console.log('├─────────────────────┼─────────┼─────────────┼────────────┼─────────────────┤');
  
  for (const r of results) {
    console.log(`│ ${r.name.padEnd(19)} │ ${String(r.trades).padStart(7)} │ ${r.wr.toFixed(1).padStart(10)}% │ ${(r.pnlLev >= 0 ? '+' : '') + r.pnlLev.toFixed(1) + '%'}`.padEnd(72) + `│ ${String(r.positiveMonths + '/' + r.totalMonths).padStart(15)} │`);
  }
  
  console.log('└─────────────────────┴─────────┴─────────────┴────────────┴─────────────────┘');
  
  // Find best
  const best = results.reduce((a, b) => b.pnlLev > a.pnlLev ? b : a);
  const bestWR = results.reduce((a, b) => b.wr > a.wr ? b : a);
  
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║ 🏆 MEILLEUR ROI: ${best.name.padEnd(57)}     ║
║    ${best.trades} trades | ${best.wr.toFixed(1)}% WR | ${best.pnlLev >= 0 ? '+' : ''}${best.pnlLev.toFixed(1)}% ROI${' '.repeat(40)}║
╠═══════════════════════════════════════════════════════════════════════════════╣
║ 🎯 MEILLEUR WR: ${bestWR.name.padEnd(58)}    ║
║    ${bestWR.trades} trades | ${bestWR.wr.toFixed(1)}% WR | ${bestWR.pnlLev >= 0 ? '+' : ''}${bestWR.pnlLev.toFixed(1)}% ROI${' '.repeat(40)}║
╚═══════════════════════════════════════════════════════════════════════════════╝
`);

  // Best config detailed analysis
  console.log('\n═'.repeat(80));
  console.log(`📈 DETAILED ANALYSIS: ${best.name}`);
  console.log('═'.repeat(80));
  
  const bestConfig = thresholdConfigs.find(c => c.name === best.name);
  const allBestTrades = [];
  
  for (const symbol of symbols) {
    const trades = await backtestStrategy(symbol, fundingRatesMap[symbol], bestConfig);
    allBestTrades.push(...trades);
    
    if (trades.length > 0) {
      const symbolWins = trades.filter(t => t.pnlPercent > 0).length;
      const symbolWR = (symbolWins / trades.length * 100).toFixed(1);
      const symbolPnl = trades.reduce((a, t) => a + t.pnlWithLeverage, 0);
      console.log(`\n${symbol}: ${trades.length} trades | WR: ${symbolWR}% | P&L: ${symbolPnl >= 0 ? '+' : ''}${symbolPnl.toFixed(1)}%`);
    }
  }
  
  // Monthly breakdown for best config
  console.log('\n📅 Monthly P&L:');
  const byMonth = {};
  allBestTrades.forEach(t => {
    const month = new Date(t.exitTime).toISOString().slice(0, 7);
    if (!byMonth[month]) byMonth[month] = { pnl: 0, trades: 0 };
    byMonth[month].pnl += t.pnlWithLeverage;
    byMonth[month].trades++;
  });
  
  for (const [month, data] of Object.entries(byMonth).sort()) {
    const bar = data.pnl > 0 
      ? '█'.repeat(Math.min(Math.round(data.pnl / 5), 30))
      : '░'.repeat(Math.min(Math.round(Math.abs(data.pnl) / 5), 30));
    console.log(`   ${month}: ${data.pnl >= 0 ? '+' : ''}${data.pnl.toFixed(1)}% (${data.trades} trades) ${data.pnl > 0 ? '🟢' : '🔴'} ${bar}`);
  }
}

main().catch(console.error);

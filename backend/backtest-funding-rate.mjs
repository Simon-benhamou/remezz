/**
 * 🎯 FUNDING RATE STRATEGY + CORRECT FEES
 * 
 * Funding Rate = ce que les traders en futures PAIENT pour garder leurs positions
 * - Funding > 0: Longs paient Shorts (trop de longs → bearish signal)
 * - Funding < 0: Shorts paient Longs (trop de shorts → bullish signal)
 * 
 * C'est de la VRAIE info car les gens PAIENT pour ces positions!
 * 
 * Strategy:
 * - Funding rate EXTREME (> 0.05% ou < -0.05%) = reversal signal
 * - Combine avec RSI pour confirmation
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binance({ 
  enableRateLimit: true,
  options: { defaultType: 'future' }
});

const INITIAL_CAPITAL = 10000;

// CORRECT FEES (0.04% per order, not 0.06%)
const FEES = {
  taker: 0.0004, // 0.04% taker
  slippage: 0.0001, // 0.01% slippage
  round_trip: 0.001 // 0.10% total (entry + exit)
};

const LEVERAGE = {
  BTC: 3,
  ETH: 5,
  SOL: 5
};

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

async function backtestFundingRateStrategy(symbol, fundingRates) {
  console.log(`\n   Processing ${symbol}...`);
  const candles = await fetchCandles(symbol, '4h', 365);
  if (candles.length < 100) return [];
  
  const asset = symbol.split('/')[0];
  const leverage = LEVERAGE[asset] || 3;
  const closes = candles.map(c => c[4]);
  const ema50 = calcEMA(closes, 50);
  
  // Create funding rate lookup (by 8h intervals)
  const fundingMap = new Map();
  fundingRates.forEach(fr => {
    const key = Math.floor(fr.timestamp / (8 * 60 * 60 * 1000)); // 8h interval
    fundingMap.set(key, fr.fundingRate);
  });
  
  const trades = [];
  let position = null;
  
  // Track extreme funding events
  const extremeFundingEvents = [];
  
  for (let i = 50; i < candles.length - 1; i++) {
    const ts = candles[i][0];
    const close = closes[i];
    const rsi = calcRSI(closes.slice(0, i + 1), 14);
    const ema50Val = ema50[i];
    
    // Get funding rate for this timestamp
    const fundingKey = Math.floor(ts / (8 * 60 * 60 * 1000));
    const fundingRate = fundingMap.get(fundingKey) || fundingMap.get(fundingKey - 1) || 0;
    
    // Check for extreme funding
    const isExtremeLong = fundingRate > 0.0005; // > 0.05% = too many longs
    const isExtremeShort = fundingRate < -0.0003; // < -0.03% = too many shorts
    
    if (!position) {
      // LONG entry: Extreme short funding (shorts crowded) + RSI oversold
      if (isExtremeShort && rsi < 40) {
        position = {
          side: 'LONG',
          entryPrice: close,
          entryTime: ts,
          fundingAtEntry: fundingRate
        };
        extremeFundingEvents.push({ type: 'LONG_ENTRY', ts, funding: fundingRate, rsi });
      }
      // SHORT entry: Extreme long funding (longs crowded) + RSI overbought
      else if (isExtremeLong && rsi > 60) {
        position = {
          side: 'SHORT',
          entryPrice: close,
          entryTime: ts,
          fundingAtEntry: fundingRate
        };
        extremeFundingEvents.push({ type: 'SHORT_ENTRY', ts, funding: fundingRate, rsi });
      }
    } else {
      // Exit logic
      let exitPrice = null;
      let exitReason = '';
      
      const holdingHours = (ts - position.entryTime) / (1000 * 60 * 60);
      
      if (position.side === 'LONG') {
        const pnl = (close - position.entryPrice) / position.entryPrice;
        
        // Take profit: +3%
        if (pnl >= 0.03) { exitPrice = close; exitReason = 'take_profit'; }
        // Stop loss: -2%
        else if (pnl <= -0.02) { exitPrice = close; exitReason = 'stop_loss'; }
        // Time stop: 48h max
        else if (holdingHours >= 48) { exitPrice = close; exitReason = 'time_stop'; }
        // RSI overbought exit
        else if (rsi > 70) { exitPrice = close; exitReason = 'rsi_exit'; }
      } else { // SHORT
        const pnl = (position.entryPrice - close) / position.entryPrice;
        
        if (pnl >= 0.03) { exitPrice = close; exitReason = 'take_profit'; }
        else if (pnl <= -0.02) { exitPrice = close; exitReason = 'stop_loss'; }
        else if (holdingHours >= 48) { exitPrice = close; exitReason = 'time_stop'; }
        else if (rsi < 30) { exitPrice = close; exitReason = 'rsi_exit'; }
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
          fundingAtEntry: position.fundingAtEntry,
          pnlPercent,
          leverage,
          pnlWithLeverage: pnlPercent * leverage,
          exitReason,
          holdingHours
        });
        
        position = null;
      }
    }
  }
  
  console.log(`   Found ${extremeFundingEvents.length} extreme funding events`);
  return trades;
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🎯 FUNDING RATE STRATEGY (avec frais corrects 0.08%)');
  console.log('═'.repeat(80));
  console.log(`\n💰 Capital: $${INITIAL_CAPITAL.toLocaleString()}`);
  console.log('📅 Period: Last 365 days');
  console.log('💸 Fees: 0.04% per order (0.10% round trip with slippage)\n');
  
  // Fetch funding rates for all symbols
  console.log('📥 Fetching funding rate history...');
  const btcFunding = await fetchHistoricalFundingRates('BTC/USDT', 365);
  const ethFunding = await fetchHistoricalFundingRates('ETH/USDT', 365);
  const solFunding = await fetchHistoricalFundingRates('SOL/USDT', 365);
  
  console.log(`   BTC: ${btcFunding.length} funding rate snapshots`);
  console.log(`   ETH: ${ethFunding.length} funding rate snapshots`);
  console.log(`   SOL: ${solFunding.length} funding rate snapshots`);
  
  // Analyze funding distribution
  console.log('\n📊 FUNDING RATE DISTRIBUTION:');
  
  const analyzeFunding = (rates, name) => {
    if (rates.length === 0) return;
    const values = rates.map(r => r.fundingRate * 100);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const max = Math.max(...values);
    const min = Math.min(...values);
    const extremePositive = values.filter(v => v > 0.05).length;
    const extremeNegative = values.filter(v => v < -0.03).length;
    
    console.log(`   ${name}: avg=${avg.toFixed(4)}%, range=[${min.toFixed(4)}%, ${max.toFixed(4)}%]`);
    console.log(`      Extreme positive (>0.05%): ${extremePositive} times`);
    console.log(`      Extreme negative (<-0.03%): ${extremeNegative} times`);
  };
  
  analyzeFunding(btcFunding, 'BTC');
  analyzeFunding(ethFunding, 'ETH');
  analyzeFunding(solFunding, 'SOL');
  
  // Backtest
  console.log('\n' + '═'.repeat(80));
  console.log('📈 BACKTEST RESULTS');
  console.log('═'.repeat(80));
  
  const allTrades = [];
  
  const btcTrades = await backtestFundingRateStrategy('BTC/USDT', btcFunding);
  const ethTrades = await backtestFundingRateStrategy('ETH/USDT', ethFunding);
  const solTrades = await backtestFundingRateStrategy('SOL/USDT', solFunding);
  
  allTrades.push(...btcTrades, ...ethTrades, ...solTrades);
  
  // Results by symbol
  for (const [name, trades] of [['BTC', btcTrades], ['ETH', ethTrades], ['SOL', solTrades]]) {
    if (trades.length === 0) {
      console.log(`\n${name}: No trades`);
      continue;
    }
    
    const wins = trades.filter(t => t.pnlPercent > 0).length;
    const wr = (wins / trades.length * 100).toFixed(1);
    const pnl = trades.reduce((a, t) => a + t.pnlPercent, 0);
    const pnlLev = trades.reduce((a, t) => a + t.pnlWithLeverage, 0);
    
    const longs = trades.filter(t => t.side === 'LONG');
    const shorts = trades.filter(t => t.side === 'SHORT');
    
    console.log(`\n📊 ${name}/USDT:`);
    console.log(`   Total: ${trades.length} trades | WR: ${wr}%`);
    console.log(`   LONG: ${longs.length} trades | WR: ${longs.length > 0 ? (longs.filter(t => t.pnlPercent > 0).length / longs.length * 100).toFixed(1) : 0}%`);
    console.log(`   SHORT: ${shorts.length} trades | WR: ${shorts.length > 0 ? (shorts.filter(t => t.pnlPercent > 0).length / shorts.length * 100).toFixed(1) : 0}%`);
    console.log(`   P&L (no lev): ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`);
    console.log(`   P&L (w/ lev): ${pnlLev >= 0 ? '+' : ''}${pnlLev.toFixed(2)}%`);
  }
  
  // Overall results
  const totalTrades = allTrades.length;
  const totalWins = allTrades.filter(t => t.pnlPercent > 0).length;
  const totalPnl = allTrades.reduce((a, t) => a + t.pnlPercent, 0);
  const totalPnlLev = allTrades.reduce((a, t) => a + t.pnlWithLeverage, 0);
  const totalLongs = allTrades.filter(t => t.side === 'LONG');
  const totalShorts = allTrades.filter(t => t.side === 'SHORT');
  
  console.log('\n' + '═'.repeat(80));
  console.log('💰 OVERALL PERFORMANCE');
  console.log('═'.repeat(80));
  
  console.log(`\n🎯 Total Trades: ${totalTrades}`);
  console.log(`✅ Win Rate: ${totalTrades > 0 ? (totalWins / totalTrades * 100).toFixed(1) : 0}%`);
  console.log(`   LONG: ${totalLongs.length} trades | WR: ${totalLongs.length > 0 ? (totalLongs.filter(t => t.pnlPercent > 0).length / totalLongs.length * 100).toFixed(1) : 0}%`);
  console.log(`   SHORT: ${totalShorts.length} trades | WR: ${totalShorts.length > 0 ? (totalShorts.filter(t => t.pnlPercent > 0).length / totalShorts.length * 100).toFixed(1) : 0}%`);
  
  console.log(`\n💵 WITHOUT LEVERAGE: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}%`);
  console.log(`   $${INITIAL_CAPITAL.toLocaleString()} → $${(INITIAL_CAPITAL * (1 + totalPnl / 100)).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`);
  console.log(`\n🚀 WITH LEVERAGE: ${totalPnlLev >= 0 ? '+' : ''}${totalPnlLev.toFixed(2)}%`);
  console.log(`   $${INITIAL_CAPITAL.toLocaleString()} → $${(INITIAL_CAPITAL * (1 + totalPnlLev / 100)).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`);
  
  // By exit reason
  console.log('\n📊 Exit Reasons:');
  const byReason = {};
  allTrades.forEach(t => {
    if (!byReason[t.exitReason]) byReason[t.exitReason] = { count: 0, pnl: 0 };
    byReason[t.exitReason].count++;
    byReason[t.exitReason].pnl += t.pnlWithLeverage;
  });
  
  for (const [reason, data] of Object.entries(byReason)) {
    console.log(`   ${reason}: ${data.count} trades | P&L: ${data.pnl >= 0 ? '+' : ''}${data.pnl.toFixed(1)}%`);
  }
  
  // Monthly breakdown
  console.log('\n📅 Monthly P&L:');
  const byMonth = {};
  for (const t of allTrades) {
    const month = new Date(t.exitTime).toISOString().slice(0, 7);
    if (!byMonth[month]) byMonth[month] = { pnl: 0, trades: 0 };
    byMonth[month].pnl += t.pnlWithLeverage;
    byMonth[month].trades++;
  }
  
  let positiveMonths = 0;
  for (const [month, data] of Object.entries(byMonth).sort()) {
    const bar = data.pnl > 0 
      ? '█'.repeat(Math.min(Math.round(data.pnl / 3), 30))
      : '░'.repeat(Math.min(Math.round(Math.abs(data.pnl) / 3), 30));
    console.log(`   ${month}: ${data.pnl >= 0 ? '+' : ''}${data.pnl.toFixed(1)}% (${data.trades} trades) ${data.pnl > 0 ? '🟢' : '🔴'} ${bar}`);
    if (data.pnl > 0) positiveMonths++;
  }
  
  const totalMonths = Object.keys(byMonth).length;
  console.log(`\n   Positive months: ${positiveMonths}/${totalMonths} (${totalMonths > 0 ? (positiveMonths / totalMonths * 100).toFixed(0) : 0}%)`);
  
  // Comparison
  console.log('\n' + '═'.repeat(80));
  console.log('📊 COMPARISON (Funding Rate vs Previous Strategies)');
  console.log('═'.repeat(80));
  
  console.log('\n┌─────────────────────────────────┬────────────┬───────────┬─────────────────┐');
  console.log('│ Strategy                        │    ROI     │  Trades   │  Positive Mo.   │');
  console.log('├─────────────────────────────────┼────────────┼───────────┼─────────────────┤');
  console.log(`│ 🆕 Funding Rate (w/lev)         │ ${(totalPnlLev >= 0 ? '+' : '') + totalPnlLev.toFixed(1) + '%'}`.padEnd(44) + `│ ${String(totalTrades).padStart(9)} │ ${String(positiveMonths + '/' + totalMonths).padStart(15)} │`);
  console.log('│ Best Reactive (old calc)        │      +5.1% │       299 │            9/12 │');
  console.log('│ BTC Buy & Hold                  │      -9.3% │         1 │             N/A │');
  console.log('└─────────────────────────────────┴────────────┴───────────┴─────────────────┘');
}

main().catch(console.error);

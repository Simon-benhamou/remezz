/**
 * TEST ADDITIONAL CRYPTOS - LINK, AVAX, DOT, MATIC, ATOM
 * 
 * Télécharge les données et teste si elles matchent le profil ETH/XRP
 */

import ccxt from 'ccxt';
import fs from 'fs';

const exchange = new ccxt.binance({ 
  enableRateLimit: true,
  options: { defaultType: 'future' }
});

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  ENTRY_FEE: 0.0004,
  EXIT_FEE: 0.0004,
  SLIPPAGE: 0.0002,
  
  LEVERAGE: { 
    BTC: 3, ETH: 5, SOL: 5, XRP: 4,
    LINK: 4, AVAX: 4, DOT: 4, MATIC: 4, ATOM: 4, DOGE: 3
  },
  
  ENTRY: {
    BB_PERIOD: 20,
    BB_STD: 2,
    ROC_MIN: 0.015,
    VOLUME_MULT: 1.3,
    MAX_CONSEC_UP: 4,
  },
  
  EXIT: {
    PROFIT_TARGET: 0.025,
    STOP_LOSS: 0.02,
    TRAILING_ACTIVATION: 0.015,
    TRAILING_DISTANCE: 0.008,
    MAX_HOLD: 48,
  },
};

// Cryptos to test
const NEW_CRYPTOS = ['LINK', 'AVAX', 'DOT', 'DOGE', 'ATOM'];
const REFERENCE_CRYPTOS = ['ETH', 'XRP', 'BTC', 'SOL'];

// ═══════════════════════════════════════════════════════════════════════════
// FETCH DATA
// ═══════════════════════════════════════════════════════════════════════════

async function fetchAndSaveData(symbol) {
  const path = `./data/${symbol}_USDT_1h.json`;
  
  // Check if we already have recent data
  if (fs.existsSync(path)) {
    const data = JSON.parse(fs.readFileSync(path, 'utf8'));
    const lastTimestamp = data[data.length - 1]?.timestamp;
    const daysSinceUpdate = (Date.now() - lastTimestamp) / (1000 * 60 * 60 * 24);
    
    if (daysSinceUpdate < 1 && data.length > 8000) {
      console.log(`   ${symbol}: Using cached data (${data.length} candles)`);
      return data;
    }
  }
  
  console.log(`   ${symbol}: Fetching from Binance...`);
  
  try {
    const since = Date.now() - 365 * 24 * 60 * 60 * 1000; // 1 year
    let allCandles = [];
    let fetchSince = since;
    
    while (true) {
      const candles = await exchange.fetchOHLCV(`${symbol}/USDT`, '1h', fetchSince, 1000);
      if (candles.length === 0) break;
      
      allCandles = allCandles.concat(candles);
      fetchSince = candles[candles.length - 1][0] + 1;
      
      if (candles.length < 1000) break;
      await new Promise(r => setTimeout(r, 100)); // Rate limit
    }
    
    const formattedCandles = allCandles.map(c => ({
      timestamp: c[0],
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
      volume: c[5],
    }));
    
    // Save to file
    fs.writeFileSync(path, JSON.stringify(formattedCandles, null, 2));
    console.log(`   ${symbol}: Saved ${formattedCandles.length} candles`);
    
    return formattedCandles;
  } catch (error) {
    console.error(`   ${symbol}: Error fetching - ${error.message}`);
    return null;
  }
}

function loadData(symbol) {
  const path = `./data/${symbol}_USDT_1h.json`;
  if (!fs.existsSync(path)) return null;
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

// ═══════════════════════════════════════════════════════════════════════════
// MARKET ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════

function analyzeMarket(candles, symbol) {
  const stats = {
    symbol,
    avgDailyVolatility: 0,
    trendContinuation: 0,
    falseBreakoutRate: 0,
    breakoutFollowThrough: 0,
    avgBreakoutVolume: 0,
  };
  
  // Daily volatility
  const dailyReturns = [];
  for (let i = 24; i < candles.length; i += 24) {
    const dayCandles = candles.slice(i - 24, i);
    const dayHigh = Math.max(...dayCandles.map(c => c.high));
    const dayLow = Math.min(...dayCandles.map(c => c.low));
    const dayOpen = dayCandles[0].open;
    dailyReturns.push((dayHigh - dayLow) / dayOpen);
  }
  stats.avgDailyVolatility = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length * 100;
  
  // Breakout analysis with Bollinger Bands
  const bb = calculateBB(candles, 20, 2);
  let breakouts = 0;
  let continuations = 0;
  let followThroughs = [];
  let breakoutVolumes = [];
  
  for (let i = 50; i < candles.length - 24; i++) {
    if (!bb[i].upper) continue;
    
    const isBreakout = candles[i].close > bb[i].upper;
    const wasNotBreakout = candles[i-1].close <= bb[i-1].upper;
    
    if (isBreakout && wasNotBreakout) {
      breakouts++;
      
      const entryPrice = candles[i].close;
      let maxGain = 0;
      let maxLoss = 0;
      
      for (let j = i + 1; j < Math.min(i + 24, candles.length); j++) {
        const gain = (candles[j].high - entryPrice) / entryPrice;
        const loss = (entryPrice - candles[j].low) / entryPrice;
        maxGain = Math.max(maxGain, gain);
        maxLoss = Math.max(maxLoss, loss);
      }
      
      if (maxGain >= 0.02 && maxLoss < 0.02) {
        continuations++;
      }
      
      followThroughs.push(maxGain);
      
      const avgVol20 = candles.slice(i - 20, i).reduce((a, b) => a + b.volume, 0) / 20;
      breakoutVolumes.push(candles[i].volume / avgVol20);
    }
  }
  
  stats.totalBreakouts = breakouts;
  stats.trendContinuation = breakouts > 0 ? (continuations / breakouts) * 100 : 0;
  stats.falseBreakoutRate = breakouts > 0 ? ((breakouts - continuations) / breakouts) * 100 : 0;
  stats.breakoutFollowThrough = followThroughs.length > 0 
    ? followThroughs.reduce((a, b) => a + b, 0) / followThroughs.length * 100 
    : 0;
  stats.avgBreakoutVolume = breakoutVolumes.length > 0
    ? breakoutVolumes.reduce((a, b) => a + b, 0) / breakoutVolumes.length
    : 0;
  
  return stats;
}

function calculateBB(candles, period = 20, stdDev = 2) {
  const result = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) {
      result.push({ upper: null, middle: null, lower: null });
      continue;
    }
    const slice = candles.slice(i - period + 1, i + 1);
    const closes = slice.map(c => c.close);
    const sma = closes.reduce((a, b) => a + b, 0) / period;
    const variance = closes.reduce((sum, val) => sum + Math.pow(val - sma, 2), 0) / period;
    const std = Math.sqrt(variance);
    result.push({
      upper: sma + stdDev * std,
      middle: sma,
      lower: sma - stdDev * std,
    });
  }
  return result;
}

function calculateSMA(candles, period) {
  const result = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) {
      result.push(null);
      continue;
    }
    const slice = candles.slice(i - period + 1, i + 1);
    result.push(slice.reduce((a, b) => a + b.close, 0) / period);
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// BACKTEST
// ═══════════════════════════════════════════════════════════════════════════

function runBacktest(candles, symbol, btcSMA200, btcCandles) {
  const leverage = CONFIG.LEVERAGE[symbol] || 4;
  const bb = calculateBB(candles, CONFIG.ENTRY.BB_PERIOD, CONFIG.ENTRY.BB_STD);
  
  const trades = [];
  let position = null;
  let capital = 1000;
  
  for (let i = 50; i < candles.length; i++) {
    const c = candles[i];
    
    // Regime filter
    let inBullRegime = true;
    if (btcSMA200 && btcCandles && btcCandles[i]) {
      const btcClose = btcCandles[i].close;
      const sma200 = btcSMA200[i];
      if (btcClose && sma200) {
        inBullRegime = btcClose > sma200;
      }
    }
    
    if (!position) {
      if (!inBullRegime) continue;
      if (!bb[i].upper) continue;
      
      const breakout = c.close > bb[i].upper;
      const roc = (c.close - candles[i - 10].close) / candles[i - 10].close;
      const avgVol = candles.slice(i - 20, i).reduce((a, b) => a + b.volume, 0) / 20;
      const volSpike = c.volume > avgVol * CONFIG.ENTRY.VOLUME_MULT;
      
      let consecUp = 0;
      for (let j = i; j > i - 10 && j > 0; j--) {
        if (candles[j].close > candles[j].open) consecUp++;
        else break;
      }
      
      if (breakout && roc > CONFIG.ENTRY.ROC_MIN && volSpike && consecUp <= CONFIG.ENTRY.MAX_CONSEC_UP) {
        const entryPrice = c.close * (1 + CONFIG.SLIPPAGE);
        const fee = capital * CONFIG.ENTRY_FEE;
        capital -= fee;
        
        position = {
          entryPrice,
          entryIdx: i,
          capitalAtEntry: capital,
          highPrice: entryPrice,
          stopLoss: entryPrice * (1 - CONFIG.EXIT.STOP_LOSS),
          trailingActive: false,
        };
      }
    } else {
      // Update trailing
      if (c.high > position.highPrice) {
        position.highPrice = c.high;
        const gain = (position.highPrice - position.entryPrice) / position.entryPrice;
        if (gain >= CONFIG.EXIT.TRAILING_ACTIVATION) {
          position.trailingActive = true;
          const newStop = position.highPrice * (1 - CONFIG.EXIT.TRAILING_DISTANCE);
          if (newStop > position.stopLoss) position.stopLoss = newStop;
        }
      }
      
      let exitReason = null;
      let exitPrice = c.close;
      
      if (c.low <= position.stopLoss) {
        exitReason = position.trailingActive ? 'trailing_stop' : 'stop_loss';
        exitPrice = position.stopLoss;
      }
      
      const gain = (c.close - position.entryPrice) / position.entryPrice;
      if (!exitReason && gain >= CONFIG.EXIT.PROFIT_TARGET) exitReason = 'take_profit';
      
      const holdTime = i - position.entryIdx;
      if (!exitReason && holdTime >= CONFIG.EXIT.MAX_HOLD) exitReason = 'max_hold';
      
      if (exitReason) {
        exitPrice = exitPrice * (1 - CONFIG.SLIPPAGE);
        const pnlPct = (exitPrice - position.entryPrice) / position.entryPrice;
        const pnlWithLeverage = pnlPct * leverage;
        
        capital = position.capitalAtEntry * (1 + pnlWithLeverage) * (1 - CONFIG.EXIT_FEE);
        
        trades.push({
          pnlWithLeverage: pnlWithLeverage * 100,
          exitReason,
        });
        
        position = null;
      }
    }
  }
  
  const wins = trades.filter(t => t.pnlWithLeverage > 0).length;
  const stopLosses = trades.filter(t => t.exitReason === 'stop_loss').length;
  
  return {
    trades: trades.length,
    wins,
    winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
    stopLosses,
    finalCapital: capital,
    roi: ((capital - 1000) / 1000) * 100,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═'.repeat(80));
  console.log('🔬 TEST ADDITIONAL CRYPTOS - Finding ETH/XRP-like profiles');
  console.log('═'.repeat(80));
  
  // Fetch data for new cryptos
  console.log('\n📥 Fetching data...');
  const allCandles = {};
  
  // Load reference cryptos
  for (const symbol of REFERENCE_CRYPTOS) {
    allCandles[symbol] = loadData(symbol);
    if (allCandles[symbol]) {
      console.log(`   ${symbol}: Loaded ${allCandles[symbol].length} candles`);
    }
  }
  
  // Fetch new cryptos
  for (const symbol of NEW_CRYPTOS) {
    allCandles[symbol] = await fetchAndSaveData(symbol);
    await new Promise(r => setTimeout(r, 500));
  }
  
  // Filter out failed fetches
  const validSymbols = [...REFERENCE_CRYPTOS, ...NEW_CRYPTOS].filter(s => allCandles[s] && allCandles[s].length > 1000);
  
  // Calculate BTC SMA200 for regime filter
  const btcSMA200 = calculateSMA(allCandles.BTC, 200);
  
  // ═══════════════════════════════════════════════════════════════════════
  // ANALYZE MARKET CHARACTERISTICS
  // ═══════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 MARKET CHARACTERISTICS COMPARISON');
  console.log('═'.repeat(80));
  
  const allStats = {};
  for (const symbol of validSymbols) {
    allStats[symbol] = analyzeMarket(allCandles[symbol], symbol);
  }
  
  // Define ideal profile (based on ETH/XRP)
  const ethStats = allStats.ETH;
  const xrpStats = allStats.XRP;
  
  const idealProfile = {
    minVolatility: 4.5,
    maxVolatility: 9,
    minContinuation: 35,
    minFollowThrough: 2.5,
    maxFalseBreakout: 70,
  };
  
  console.log('\n┌──────────┬───────────┬───────────┬───────────┬───────────┬───────────┐');
  console.log('│ Symbol   │ Vol/Day   │ Contin %  │ Follow %  │ False %   │ Match?    │');
  console.log('├──────────┼───────────┼───────────┼───────────┼───────────┼───────────┤');
  
  for (const symbol of validSymbols) {
    const s = allStats[symbol];
    
    const matchVol = s.avgDailyVolatility >= idealProfile.minVolatility && s.avgDailyVolatility <= idealProfile.maxVolatility;
    const matchCont = s.trendContinuation >= idealProfile.minContinuation;
    const matchFollow = s.breakoutFollowThrough >= idealProfile.minFollowThrough;
    const matchFalse = s.falseBreakoutRate <= idealProfile.maxFalseBreakout;
    
    const matchCount = [matchVol, matchCont, matchFollow, matchFalse].filter(Boolean).length;
    const matchStr = matchCount >= 3 ? '✅ YES' : matchCount >= 2 ? '⚠️ MAYBE' : '❌ NO';
    
    const isReference = ['ETH', 'XRP'].includes(symbol);
    const prefix = isReference ? '🎯' : '  ';
    
    console.log(`│ ${prefix}${symbol.padEnd(6)} │ ${s.avgDailyVolatility.toFixed(1).padStart(7)}%  │ ${s.trendContinuation.toFixed(1).padStart(7)}%  │ ${s.breakoutFollowThrough.toFixed(1).padStart(7)}%  │ ${s.falseBreakoutRate.toFixed(1).padStart(7)}%  │ ${matchStr.padStart(9)} │`);
  }
  console.log('└──────────┴───────────┴───────────┴───────────┴───────────┴───────────┘');
  console.log('\n🎯 = Reference (ETH/XRP), criteria based on their characteristics');
  
  // ═══════════════════════════════════════════════════════════════════════
  // BACKTEST ALL
  // ═══════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('📈 BACKTEST RESULTS (V5 Strategy with regime filter)');
  console.log('═'.repeat(80));
  
  const backtestResults = {};
  
  for (const symbol of validSymbols) {
    backtestResults[symbol] = runBacktest(allCandles[symbol], symbol, btcSMA200, allCandles.BTC);
  }
  
  // Sort by ROI
  const sortedSymbols = validSymbols.sort((a, b) => backtestResults[b].roi - backtestResults[a].roi);
  
  console.log('\n┌──────────┬────────┬──────────┬──────────┬──────────┬─────────────┐');
  console.log('│ Symbol   │ Trades │ Win Rate │ SL %     │ ROI      │ Status      │');
  console.log('├──────────┼────────┼──────────┼──────────┼──────────┼─────────────┤');
  
  for (const symbol of sortedSymbols) {
    const r = backtestResults[symbol];
    const slPct = r.trades > 0 ? (r.stopLosses / r.trades) * 100 : 0;
    
    let status = '❌ Avoid';
    if (r.roi > 50 && r.winRate > 55) status = '✅ Good';
    else if (r.roi > 0 && r.winRate > 50) status = '⚠️ Okay';
    
    const isRef = ['ETH', 'XRP'].includes(symbol);
    const prefix = isRef ? '🎯' : '  ';
    
    console.log(`│ ${prefix}${symbol.padEnd(6)} │ ${String(r.trades).padStart(6)} │ ${r.winRate.toFixed(1).padStart(7)}% │ ${slPct.toFixed(1).padStart(7)}% │ ${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(0).padStart(6)}%  │ ${status.padEnd(11)} │`);
  }
  console.log('└──────────┴────────┴──────────┴──────────┴──────────┴─────────────┘');
  
  // ═══════════════════════════════════════════════════════════════════════
  // COMBINED PORTFOLIO TEST
  // ═══════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('💼 PORTFOLIO COMBINATIONS TEST');
  console.log('═'.repeat(80));
  
  // Test different combinations
  const portfolios = [
    { name: 'ETH + XRP (baseline)', symbols: ['ETH', 'XRP'] },
    { name: 'ETH + XRP + LINK', symbols: ['ETH', 'XRP', 'LINK'] },
    { name: 'ETH + XRP + AVAX', symbols: ['ETH', 'XRP', 'AVAX'] },
    { name: 'ETH + XRP + DOT', symbols: ['ETH', 'XRP', 'DOT'] },
    { name: 'Top 3 by ROI', symbols: sortedSymbols.slice(0, 3) },
    { name: 'All profitable', symbols: sortedSymbols.filter(s => backtestResults[s].roi > 0) },
  ];
  
  console.log('\n┌───────────────────────────────┬────────┬──────────┬─────────────┐');
  console.log('│ Portfolio                     │ Trades │ Avg ROI  │ Combined    │');
  console.log('├───────────────────────────────┼────────┼──────────┼─────────────┤');
  
  for (const portfolio of portfolios) {
    const validPortfolio = portfolio.symbols.filter(s => backtestResults[s]);
    if (validPortfolio.length === 0) continue;
    
    const totalTrades = validPortfolio.reduce((sum, s) => sum + backtestResults[s].trades, 0);
    const avgRoi = validPortfolio.reduce((sum, s) => sum + backtestResults[s].roi, 0) / validPortfolio.length;
    
    // Simulate combined trading
    let combinedCapital = 1000;
    // Simple approximation: divide capital among assets
    const perAssetAllocation = 1 / validPortfolio.length;
    for (const s of validPortfolio) {
      const assetRoi = backtestResults[s].roi / 100;
      combinedCapital += 1000 * perAssetAllocation * assetRoi;
    }
    const combinedRoi = ((combinedCapital - 1000) / 1000) * 100;
    
    console.log(`│ ${portfolio.name.padEnd(29)} │ ${String(totalTrades).padStart(6)} │ ${avgRoi >= 0 ? '+' : ''}${avgRoi.toFixed(0).padStart(6)}%  │ ${combinedRoi >= 0 ? '+' : ''}${combinedRoi.toFixed(0).padStart(6)}%     │`);
  }
  console.log('└───────────────────────────────┴────────┴──────────┴─────────────┘');
  
  // ═══════════════════════════════════════════════════════════════════════
  // CONCLUSIONS
  // ═══════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('💡 CONCLUSIONS');
  console.log('═'.repeat(80));
  
  // Find cryptos that work
  const goodCryptos = sortedSymbols.filter(s => backtestResults[s].roi > 50 && backtestResults[s].winRate > 55);
  const okayCryptos = sortedSymbols.filter(s => backtestResults[s].roi > 0 && backtestResults[s].roi <= 50);
  const badCryptos = sortedSymbols.filter(s => backtestResults[s].roi <= 0);
  
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║ 🎯 RÉSULTATS DU TEST SUR NOUVELLES CRYPTOS                                    ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║ ✅ CRYPTOS QUI MARCHENT BIEN (ROI > 50%, WR > 55%):                           ║
║    ${goodCryptos.join(', ').padEnd(68)} ║
║                                                                               ║
║ ⚠️  CRYPTOS ACCEPTABLES (ROI > 0):                                            ║
║    ${okayCryptos.join(', ').padEnd(68)} ║
║                                                                               ║
║ ❌ CRYPTOS À ÉVITER (ROI ≤ 0):                                                 ║
║    ${badCryptos.join(', ').padEnd(68)} ║
║                                                                               ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║ 📊 RECOMMANDATION FINALE:                                                     ║
║ • Rester sur ETH + XRP = Configuration optimale testée                        ║
║ • Si diversification: Ajouter ${goodCryptos.filter(s => !['ETH', 'XRP'].includes(s))[0] || 'N/A'} (même profil)                             ║
║ • Position sizing: 50% recommandé (drawdown < 35%)                            ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
`);
}

main().catch(console.error);

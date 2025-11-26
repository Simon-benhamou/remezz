/**
 * 🔎 TROUVER DES CRYPTOS AVEC LE MÊME PROFIL QUE XRP
 * 
 * Critères de l'edge XRP identifiés:
 * 1. Skewness > 0.5 (distribution asymétrique vers le haut)
 * 2. Découplage BTC > 5% du temps
 * 3. Kurtosis élevé (fat tails = mouvements violents)
 * 4. Extreme ratio > 1 (plus d'extrêmes positifs que négatifs)
 * 
 * On va scanner les top cryptos pour trouver des candidats
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binance({ 
  enableRateLimit: true,
  options: { defaultType: 'future' }
});

// Top cryptos à analyser (en plus des 4 de base)
const CANDIDATES = [
  'BTC', 'ETH', 'SOL', 'XRP',  // Référence
  'DOGE', 'ADA', 'AVAX', 'DOT', 'LINK', 'MATIC',
  'ATOM', 'UNI', 'LTC', 'BCH', 'ETC',
  'FIL', 'APT', 'ARB', 'OP', 'INJ',
  'NEAR', 'TIA', 'SUI', 'SEI', 'PEPE',
  'SHIB', 'WIF', 'BONK', 'FLOKI',  // Meme coins
  'AAVE', 'MKR', 'CRV', 'LDO',  // DeFi
  'RUNE', 'IMX', 'SAND', 'MANA', 'AXS',  // Gaming/Meta
];

const FEES = { entry: 0.0004, exit: 0.0004, slippage: 0.0002 };

// ═══════════════════════════════════════════════════════════════════════════
// INDICATEURS
// ═══════════════════════════════════════════════════════════════════════════

function calcSMA(values, period) {
  if (values.length < period) return values[values.length - 1] || 0;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcBollingerBands(closes, period = 20, mult = 2) {
  const bands = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      bands.push({ upper: closes[i], middle: closes[i], lower: closes[i] });
      continue;
    }
    const slice = closes.slice(i - period + 1, i + 1);
    const middle = slice.reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(slice.reduce((sum, v) => sum + Math.pow(v - middle, 2), 0) / period);
    bands.push({ upper: middle + std * mult, middle, lower: middle - std * mult });
  }
  return bands;
}

function calcROC(closes, period = 10) {
  return closes.map((c, i) => {
    if (i < period) return 0;
    return (c - closes[i - period]) / closes[i - period];
  });
}

function calcCorrelation(arr1, arr2, period = 50) {
  if (arr1.length !== arr2.length || arr1.length < period) return [];
  
  const correlations = [];
  for (let i = 0; i < arr1.length; i++) {
    if (i < period - 1) {
      correlations.push(0);
      continue;
    }
    
    const slice1 = arr1.slice(i - period + 1, i + 1);
    const slice2 = arr2.slice(i - period + 1, i + 1);
    
    const mean1 = slice1.reduce((a, b) => a + b, 0) / period;
    const mean2 = slice2.reduce((a, b) => a + b, 0) / period;
    
    let num = 0, den1 = 0, den2 = 0;
    for (let j = 0; j < period; j++) {
      const d1 = slice1[j] - mean1;
      const d2 = slice2[j] - mean2;
      num += d1 * d2;
      den1 += d1 * d1;
      den2 += d2 * d2;
    }
    
    const denom = Math.sqrt(den1) * Math.sqrt(den2);
    correlations.push(denom > 0 ? num / denom : 0);
  }
  return correlations;
}

function calcVolRatio(volumes, idx) {
  if (idx < 21) return 0;
  const current = volumes[idx];
  const avg = volumes.slice(idx - 20, idx).reduce((a, b) => a + b, 0) / 20;
  return avg > 0 ? current / avg : 0;
}

function countConsecUp(candles, idx) {
  let count = 0;
  for (let i = idx; i >= 0; i--) {
    if (candles[i].close > candles[i].open) count++;
    else break;
  }
  return count;
}

// ═══════════════════════════════════════════════════════════════════════════
// ANALYSE DES CARACTÉRISTIQUES
// ═══════════════════════════════════════════════════════════════════════════

function analyzeCharacteristics(candles, btcReturns) {
  const closes = candles.map(c => c.close);
  const returns = closes.map((c, i) => i > 0 ? (c - closes[i-1]) / closes[i-1] : 0);
  
  // 1. Distribution stats
  const n = returns.length;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / n;
  const std = Math.sqrt(variance);
  
  // Skewness
  const skewness = returns.reduce((sum, r) => sum + Math.pow((r - mean) / std, 3), 0) / n;
  
  // Kurtosis
  const kurtosis = returns.reduce((sum, r) => sum + Math.pow((r - mean) / std, 4), 0) / n - 3;
  
  // Extreme events ratio
  const extremeUp = returns.filter(r => r > mean + 2 * std).length;
  const extremeDown = returns.filter(r => r < mean - 2 * std).length;
  const extremeRatio = extremeDown > 0 ? extremeUp / extremeDown : extremeUp || 1;
  
  // 2. Correlation avec BTC
  const correlations = calcCorrelation(returns, btcReturns, 50);
  const validCorr = correlations.slice(50);
  const avgCorrelation = validCorr.reduce((a, b) => a + b, 0) / validCorr.length;
  const decouplingPct = (validCorr.filter(c => Math.abs(c) < 0.5).length / validCorr.length) * 100;
  
  return {
    skewness,
    kurtosis,
    extremeRatio,
    avgCorrelation,
    decouplingPct,
    volatility: std * 100,
    meanReturn: mean * 100,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// BACKTEST V5 STRATEGY
// ═══════════════════════════════════════════════════════════════════════════

function backtestV5(candles, btcCandles, leverage = 4) {
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const bb = calcBollingerBands(closes);
  const roc = calcROC(closes, 10);
  const btcCloses = btcCandles.map(c => c.close);
  
  const trades = [];
  let position = null;
  let capital = 1000;
  
  for (let i = 200; i < candles.length - 1; i++) {
    const btcSma200 = calcSMA(btcCloses.slice(0, i + 1), 200);
    const btcInBull = btcCloses[i] > btcSma200;
    
    if (!position) {
      // V5 Entry conditions
      const breakout = closes[i] > bb[i].upper;
      const rocOk = roc[i] >= 0.015;
      const volOk = calcVolRatio(volumes, i) >= 1.3;
      const consecOk = countConsecUp(candles, i) <= 4;
      const bullish = candles[i].close > candles[i].open;
      
      if (btcInBull && breakout && rocOk && volOk && consecOk && bullish) {
        const entryPrice = closes[i] * (1 + FEES.slippage);
        capital *= (1 - FEES.entry);
        
        position = {
          entryPrice,
          entryIdx: i,
          capitalAtEntry: capital,
          highWaterMark: entryPrice,
        };
      }
    } else {
      position.highWaterMark = Math.max(position.highWaterMark, candles[i].high);
      
      const pnl = (closes[i] - position.entryPrice) / position.entryPrice;
      const holdHours = (i - position.entryIdx) * (15 / 60);
      
      let exitReason = null;
      
      if (pnl <= -0.02) exitReason = 'stoploss';
      else if (pnl >= 0.025) exitReason = 'take_profit';
      else if (pnl >= 0.015) {
        const trailStop = position.highWaterMark * 0.992;
        if (closes[i] < trailStop) exitReason = 'trailing';
      }
      else if (holdHours >= 48) exitReason = 'time';
      
      if (exitReason) {
        const exitPrice = closes[i] * (1 - FEES.slippage);
        const pnlFinal = (exitPrice - position.entryPrice) / position.entryPrice;
        const pnlLev = pnlFinal * leverage;
        
        capital = position.capitalAtEntry * (1 + pnlLev);
        capital *= (1 - FEES.exit);
        
        trades.push({
          pnl: pnlFinal * 100,
          pnlLev: pnlLev * 100,
          exitReason,
          win: pnlLev > 0,
        });
        
        position = null;
      }
    }
  }
  
  const wins = trades.filter(t => t.win).length;
  return {
    trades: trades.length,
    wins,
    winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
    roi: ((capital / 1000) - 1) * 100,
    finalCapital: capital,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═'.repeat(90));
  console.log('🔎 RECHERCHE DE CRYPTOS AVEC PROFIL "XRP-LIKE"');
  console.log('═'.repeat(90));
  console.log('\nCritères recherchés (basés sur XRP):');
  console.log('   • Skewness > 0.5 (XRP = 0.88)');
  console.log('   • Découplage BTC > 5% (XRP = 9.2%)');
  console.log('   • Extreme ratio > 1.0 (XRP = 1.09)');
  console.log('   • Kurtosis élevé (XRP = 81.6)');
  console.log('\n📊 Fetching data for all candidates...\n');
  
  const now = Date.now();
  const oneYearAgo = now - 365 * 24 * 60 * 60 * 1000;
  
  // Fetch BTC first
  console.log('   Fetching BTC (reference)...');
  let btcCandles = [];
  let since = oneYearAgo;
  while (since < now) {
    const ohlcv = await exchange.fetchOHLCV('BTC/USDT:USDT', '15m', since, 1000);
    if (ohlcv.length === 0) break;
    btcCandles = btcCandles.concat(ohlcv.map(c => ({
      timestamp: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5],
    })));
    since = ohlcv[ohlcv.length - 1][0] + 1;
    await new Promise(r => setTimeout(r, 50));
  }
  console.log(`   BTC: ${btcCandles.length} candles`);
  
  const btcCloses = btcCandles.map(c => c.close);
  const btcReturns = btcCloses.map((c, i) => i > 0 ? (c - btcCloses[i-1]) / btcCloses[i-1] : 0);
  
  const results = [];
  
  for (const symbol of CANDIDATES) {
    if (symbol === 'BTC') continue; // Skip BTC itself
    
    try {
      process.stdout.write(`   Analyzing ${symbol}...`);
      
      const ccxtSymbol = `${symbol}/USDT:USDT`;
      let candles = [];
      since = oneYearAgo;
      
      while (since < now) {
        const ohlcv = await exchange.fetchOHLCV(ccxtSymbol, '15m', since, 1000);
        if (ohlcv.length === 0) break;
        candles = candles.concat(ohlcv.map(c => ({
          timestamp: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5],
        })));
        since = ohlcv[ohlcv.length - 1][0] + 1;
        await new Promise(r => setTimeout(r, 50));
      }
      
      if (candles.length < 1000) {
        console.log(` ❌ (insufficient data: ${candles.length})`);
        continue;
      }
      
      // Sync lengths
      const minLen = Math.min(candles.length, btcCandles.length);
      const syncedCandles = candles.slice(-minLen);
      const syncedBtcCandles = btcCandles.slice(-minLen);
      const syncedBtcReturns = btcReturns.slice(-minLen);
      
      // Analyze characteristics
      const chars = analyzeCharacteristics(syncedCandles, syncedBtcReturns);
      
      // Backtest
      const backtest = backtestV5(syncedCandles, syncedBtcCandles, 4);
      
      // Score based on XRP-like criteria
      let score = 0;
      if (chars.skewness > 0.5) score += 25;
      else if (chars.skewness > 0.3) score += 15;
      else if (chars.skewness > 0) score += 5;
      
      if (chars.decouplingPct > 8) score += 25;
      else if (chars.decouplingPct > 5) score += 15;
      else if (chars.decouplingPct > 3) score += 5;
      
      if (chars.extremeRatio > 1.1) score += 25;
      else if (chars.extremeRatio > 1.0) score += 15;
      else if (chars.extremeRatio > 0.9) score += 5;
      
      if (chars.kurtosis > 50) score += 25;
      else if (chars.kurtosis > 30) score += 15;
      else if (chars.kurtosis > 10) score += 5;
      
      results.push({
        symbol,
        ...chars,
        ...backtest,
        score,
        candles: candles.length,
      });
      
      console.log(` ✅ Score: ${score}, ROI: ${backtest.roi >= 0 ? '+' : ''}${backtest.roi.toFixed(1)}%`);
      
    } catch (error) {
      console.log(` ❌ Error: ${error.message}`);
    }
  }
  
  // Sort by score
  results.sort((a, b) => b.score - a.score);
  
  // Display results
  console.log('\n\n' + '═'.repeat(90));
  console.log('📊 RÉSULTATS: CRYPTOS CLASSÉES PAR SIMILARITÉ AVEC XRP');
  console.log('═'.repeat(90));
  
  console.log('\n┌──────────┬───────┬──────────┬───────────┬───────────┬──────────┬────────┬──────────┐');
  console.log('│ Symbol   │ Score │ Skewness │ Decoupl.  │ Ext.Ratio │ Kurtosis │ Trades │ ROI V5   │');
  console.log('├──────────┼───────┼──────────┼───────────┼───────────┼──────────┼────────┼──────────┤');
  
  for (const r of results) {
    const roiStr = r.roi >= 0 ? `+${r.roi.toFixed(1)}%` : `${r.roi.toFixed(1)}%`;
    const highlight = r.score >= 75 ? '🔥' : r.score >= 50 ? '⭐' : '  ';
    console.log(`│ ${highlight}${r.symbol.padEnd(6)} │ ${String(r.score).padStart(5)} │ ${r.skewness.toFixed(2).padStart(8)} │ ${r.decouplingPct.toFixed(1).padStart(8)}% │ ${r.extremeRatio.toFixed(2).padStart(9)} │ ${r.kurtosis.toFixed(1).padStart(8)} │ ${String(r.trades).padStart(6)} │ ${roiStr.padStart(8)} │`);
  }
  console.log('└──────────┴───────┴──────────┴───────────┴───────────┴──────────┴────────┴──────────┘');
  
  // Find XRP-like candidates
  console.log('\n\n' + '═'.repeat(90));
  console.log('🎯 CANDIDATS XRP-LIKE (Score ≥ 50 ET ROI > 0)');
  console.log('═'.repeat(90));
  
  const xrpLike = results.filter(r => r.score >= 50 && r.roi > 0);
  
  if (xrpLike.length === 0) {
    console.log('\n❌ Aucun candidat ne remplit tous les critères!');
    console.log('   XRP reste unique dans son profil.');
  } else {
    console.log(`\n✅ ${xrpLike.length} candidat(s) trouvé(s):\n`);
    
    for (const r of xrpLike) {
      console.log(`╔══════════════════════════════════════════════════════════════════════════════════════╗`);
      console.log(`║ 🏆 ${r.symbol.padEnd(6)}                                                                        ║`);
      console.log(`╠══════════════════════════════════════════════════════════════════════════════════════╣`);
      console.log(`║ Score XRP-like: ${String(r.score).padStart(3)}/100                                                        ║`);
      console.log(`║                                                                                      ║`);
      console.log(`║ Caractéristiques:                                                                    ║`);
      console.log(`║   • Skewness:     ${r.skewness.toFixed(2).padStart(6)} ${r.skewness > 0.5 ? '✅' : '⚠️'}  (XRP = 0.88)                                   ║`);
      console.log(`║   • Découplage:   ${r.decouplingPct.toFixed(1).padStart(5)}% ${r.decouplingPct > 5 ? '✅' : '⚠️'}  (XRP = 9.2%)                                   ║`);
      console.log(`║   • Ext. Ratio:   ${r.extremeRatio.toFixed(2).padStart(5)}x ${r.extremeRatio > 1 ? '✅' : '⚠️'}  (XRP = 1.09x)                                   ║`);
      console.log(`║   • Kurtosis:     ${r.kurtosis.toFixed(1).padStart(6)} ${r.kurtosis > 30 ? '✅' : '⚠️'}  (XRP = 81.6)                                    ║`);
      console.log(`║                                                                                      ║`);
      console.log(`║ Backtest V5:                                                                         ║`);
      console.log(`║   • Trades:       ${String(r.trades).padStart(6)}                                                        ║`);
      console.log(`║   • Win Rate:     ${r.winRate.toFixed(1).padStart(5)}%                                                        ║`);
      console.log(`║   • ROI:          ${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(1).padStart(5)}% ${r.roi > 30 ? '🔥' : r.roi > 0 ? '✅' : '❌'}                                                    ║`);
      console.log(`╚══════════════════════════════════════════════════════════════════════════════════════╝\n`);
    }
  }
  
  // Correlation between characteristics and performance
  console.log('\n' + '═'.repeat(90));
  console.log('📈 CORRÉLATION ENTRE CARACTÉRISTIQUES ET PERFORMANCE');
  console.log('═'.repeat(90));
  
  // Calculate correlations
  const validResults = results.filter(r => r.trades > 10);
  
  if (validResults.length > 5) {
    const corrs = {
      'Skewness vs ROI': calcPearson(validResults.map(r => r.skewness), validResults.map(r => r.roi)),
      'Découplage vs ROI': calcPearson(validResults.map(r => r.decouplingPct), validResults.map(r => r.roi)),
      'Ext.Ratio vs ROI': calcPearson(validResults.map(r => r.extremeRatio), validResults.map(r => r.roi)),
      'Kurtosis vs ROI': calcPearson(validResults.map(r => r.kurtosis), validResults.map(r => r.roi)),
      'Score vs ROI': calcPearson(validResults.map(r => r.score), validResults.map(r => r.roi)),
    };
    
    console.log('\n   Corrélations avec le ROI de la stratégie V5:\n');
    for (const [name, corr] of Object.entries(corrs)) {
      const bar = '█'.repeat(Math.abs(Math.round(corr * 20)));
      const indicator = corr > 0.3 ? '✅ FORT' : corr > 0.1 ? '⚠️ Modéré' : '❌ Faible';
      console.log(`   ${name.padEnd(20)} : ${corr >= 0 ? '+' : ''}${corr.toFixed(2)} ${bar.padEnd(20)} ${indicator}`);
    }
  }
  
  // Final conclusion
  console.log('\n\n' + '═'.repeat(90));
  console.log('💡 CONCLUSION');
  console.log('═'.repeat(90));
  
  const profitable = results.filter(r => r.roi > 0);
  const xrpResult = results.find(r => r.symbol === 'XRP');
  const bestNonXrp = results.filter(r => r.symbol !== 'XRP' && r.roi > 0).sort((a, b) => b.roi - a.roi)[0];
  
  console.log(`
╔══════════════════════════════════════════════════════════════════════════════════════════╗
║ RÉSUMÉ DE L'ANALYSE                                                                      ║
╠══════════════════════════════════════════════════════════════════════════════════════════╣
║                                                                                          ║
║ Cryptos analysées:      ${String(results.length).padStart(3)}                                                          ║
║ Cryptos profitables:    ${String(profitable.length).padStart(3)} (${((profitable.length/results.length)*100).toFixed(0)}%)                                                    ║
║ Cryptos XRP-like:       ${String(xrpLike.length).padStart(3)}                                                          ║
║                                                                                          ║
║ XRP Performance:        ${xrpResult ? `${xrpResult.roi >= 0 ? '+' : ''}${xrpResult.roi.toFixed(1)}%` : 'N/A'} ROI (référence)                                   ║
${bestNonXrp ? `║ Meilleur alternatif:    ${bestNonXrp.symbol} avec ${bestNonXrp.roi >= 0 ? '+' : ''}${bestNonXrp.roi.toFixed(1)}% ROI                                       ║` : ''}
║                                                                                          ║
║ ${xrpLike.length > 0 ? '✅ VALIDATION: L\'edge XRP est REPRODUCTIBLE sur d\'autres cryptos!' : '⚠️ L\'edge XRP semble UNIQUE - prudence avec d\'autres assets'}${' '.repeat(Math.max(0, 25 - (xrpLike.length > 0 ? 55 : 58)))}║
║                                                                                          ║
╚══════════════════════════════════════════════════════════════════════════════════════════╝
`);

  process.exit(0);
}

function calcPearson(x, y) {
  const n = x.length;
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;
  
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  
  const den = Math.sqrt(denX) * Math.sqrt(denY);
  return den > 0 ? num / den : 0;
}

main().catch(console.error);

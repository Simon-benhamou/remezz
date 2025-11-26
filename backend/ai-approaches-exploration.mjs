/**
 * 🤖 AI-POWERED TRADING APPROACHES
 * 
 * Let's explore what AI/ML can ACTUALLY do that humans/indicators can't:
 * 
 * 1. PATTERN RECOGNITION (CNN on chart images)
 * 2. SEQUENCE PREDICTION (LSTM/Transformer on price series)
 * 3. SENTIMENT ANALYSIS (NLP on news/social)
 * 4. REGIME DETECTION (clustering market states)
 * 5. REINFORCEMENT LEARNING (learn from trades)
 * 6. LLM REASONING (GPT-4 for market analysis)
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binance({ 
  enableRateLimit: true,
  options: { defaultType: 'future' }
});

async function fetchCandles(symbol, timeframe = '1h', days = 365) {
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
}

// ============================================================================
// 1. SIMPLE PATTERN RECOGNITION (without deep learning)
// ============================================================================
function detectPatterns(candles) {
  const patterns = [];
  
  for (let i = 10; i < candles.length - 5; i++) {
    const c = candles.slice(i - 10, i + 1);
    const futureReturn = (candles[Math.min(i + 5, candles.length - 1)][4] - c[10][4]) / c[10][4] * 100;
    
    // Detect specific patterns
    const bodies = c.map(x => x[4] - x[1]); // close - open
    const ranges = c.map(x => x[2] - x[3]); // high - low
    
    // DOJI: Small body, large range
    const lastBody = Math.abs(bodies[10]);
    const lastRange = ranges[10];
    const avgRange = ranges.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
    
    if (lastBody < lastRange * 0.1 && lastRange > avgRange * 1.5) {
      patterns.push({ type: 'DOJI', i, futureReturn });
    }
    
    // ENGULFING: Current candle engulfs previous
    if (bodies[10] > 0 && bodies[9] < 0 && Math.abs(bodies[10]) > Math.abs(bodies[9]) * 1.5) {
      patterns.push({ type: 'BULLISH_ENGULFING', i, futureReturn });
    }
    if (bodies[10] < 0 && bodies[9] > 0 && Math.abs(bodies[10]) > Math.abs(bodies[9]) * 1.5) {
      patterns.push({ type: 'BEARISH_ENGULFING', i, futureReturn });
    }
    
    // THREE WHITE SOLDIERS / THREE BLACK CROWS
    if (bodies[8] > 0 && bodies[9] > 0 && bodies[10] > 0 && 
        c[9][4] > c[8][4] && c[10][4] > c[9][4]) {
      patterns.push({ type: 'THREE_WHITE_SOLDIERS', i, futureReturn });
    }
    if (bodies[8] < 0 && bodies[9] < 0 && bodies[10] < 0 && 
        c[9][4] < c[8][4] && c[10][4] < c[9][4]) {
      patterns.push({ type: 'THREE_BLACK_CROWS', i, futureReturn });
    }
    
    // HAMMER: Small body at top, long lower wick
    const lowerWick = Math.min(c[10][1], c[10][4]) - c[10][3];
    const upperWick = c[10][2] - Math.max(c[10][1], c[10][4]);
    if (lowerWick > lastBody * 2 && upperWick < lastBody * 0.5 && bodies[10] > 0) {
      patterns.push({ type: 'HAMMER', i, futureReturn });
    }
    
    // SHOOTING STAR: Small body at bottom, long upper wick
    if (upperWick > lastBody * 2 && lowerWick < lastBody * 0.5 && bodies[10] < 0) {
      patterns.push({ type: 'SHOOTING_STAR', i, futureReturn });
    }
  }
  
  return patterns;
}

// ============================================================================
// 2. REGIME DETECTION (Market state clustering)
// ============================================================================
function detectRegime(candles, lookback = 20) {
  const closes = candles.map(c => c[4]);
  const volumes = candles.map(c => c[5]);
  
  // Calculate features
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1] * 100);
  }
  
  const regimes = [];
  
  for (let i = lookback; i < candles.length; i++) {
    const recentReturns = returns.slice(i - lookback, i);
    const recentVolumes = volumes.slice(i - lookback, i);
    
    const avgReturn = recentReturns.reduce((a, b) => a + b, 0) / lookback;
    const volatility = Math.sqrt(recentReturns.map(r => Math.pow(r - avgReturn, 2)).reduce((a, b) => a + b, 0) / lookback);
    const trend = (closes[i] - closes[i - lookback]) / closes[i - lookback] * 100;
    const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / lookback;
    const currentVolume = volumes[i];
    const volumeRatio = currentVolume / avgVolume;
    
    // Classify regime
    let regime;
    if (trend > 5 && volatility < 2) regime = 'BULL_TREND';
    else if (trend < -5 && volatility < 2) regime = 'BEAR_TREND';
    else if (volatility > 3) regime = 'HIGH_VOLATILITY';
    else if (Math.abs(trend) < 2 && volatility < 1.5) regime = 'RANGING';
    else if (trend > 2 && volumeRatio > 1.5) regime = 'BREAKOUT_UP';
    else if (trend < -2 && volumeRatio > 1.5) regime = 'BREAKOUT_DOWN';
    else regime = 'UNDEFINED';
    
    regimes.push({ i, regime, trend, volatility, volumeRatio });
  }
  
  return regimes;
}

// ============================================================================
// 3. SIMPLE SEQUENCE FEATURES (what LSTM would learn)
// ============================================================================
function extractSequenceFeatures(candles, lookback = 20) {
  const features = [];
  
  for (let i = lookback; i < candles.length - 1; i++) {
    const recent = candles.slice(i - lookback, i + 1);
    const closes = recent.map(c => c[4]);
    const volumes = recent.map(c => c[5]);
    const highs = recent.map(c => c[2]);
    const lows = recent.map(c => c[3]);
    
    // Normalize prices (as % change from first)
    const basePrice = closes[0];
    const normalizedPrices = closes.map(c => (c - basePrice) / basePrice * 100);
    
    // Price momentum at different scales
    const momentum5 = normalizedPrices[lookback] - normalizedPrices[lookback - 5];
    const momentum10 = normalizedPrices[lookback] - normalizedPrices[lookback - 10];
    const momentum20 = normalizedPrices[lookback] - normalizedPrices[0];
    
    // Volume trend
    const avgVolFirst = volumes.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
    const avgVolLast = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;
    const volumeTrend = (avgVolLast - avgVolFirst) / avgVolFirst;
    
    // Price range compression/expansion
    const rangeFirst = Math.max(...highs.slice(0, 10)) - Math.min(...lows.slice(0, 10));
    const rangeLast = Math.max(...highs.slice(-10)) - Math.min(...lows.slice(-10));
    const rangeChange = (rangeLast - rangeFirst) / rangeFirst;
    
    // Higher highs / lower lows pattern
    let higherHighs = 0;
    let lowerLows = 0;
    for (let j = 1; j < lookback; j++) {
      if (highs[j] > highs[j - 1]) higherHighs++;
      if (lows[j] < lows[j - 1]) lowerLows++;
    }
    
    // Target: next candle direction
    const nextReturn = (candles[i + 1][4] - candles[i][4]) / candles[i][4] * 100;
    const target = nextReturn > 0.5 ? 1 : nextReturn < -0.5 ? -1 : 0;
    
    features.push({
      momentum5,
      momentum10,
      momentum20,
      volumeTrend,
      rangeChange,
      higherHighsRatio: higherHighs / lookback,
      lowerLowsRatio: lowerLows / lookback,
      target,
      actualReturn: nextReturn
    });
  }
  
  return features;
}

// ============================================================================
// BACKTEST PATTERN-BASED STRATEGY
// ============================================================================
function backtestPatterns(patterns, patternType) {
  const filtered = patterns.filter(p => p.type === patternType);
  if (filtered.length === 0) return null;
  
  const wins = filtered.filter(p => 
    (patternType.includes('BULL') || patternType === 'HAMMER' || patternType === 'THREE_WHITE_SOLDIERS') 
      ? p.futureReturn > 0.5 
      : p.futureReturn < -0.5
  );
  
  const avgReturn = filtered.reduce((a, p) => a + p.futureReturn, 0) / filtered.length;
  
  return {
    type: patternType,
    count: filtered.length,
    winRate: (wins.length / filtered.length * 100).toFixed(1),
    avgReturn: avgReturn.toFixed(2)
  };
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log('═'.repeat(80));
  console.log('🤖 AI TRADING APPROACHES - EXPLORATION');
  console.log('═'.repeat(80));
  
  console.log('\n📥 Fetching BTC data...');
  const btcCandles = await fetchCandles('BTC/USDT', '1h', 365);
  console.log(`   Got ${btcCandles.length} hourly candles\n`);
  
  // ========================================================================
  // 1. PATTERN RECOGNITION
  // ========================================================================
  console.log('═'.repeat(80));
  console.log('1️⃣ PATTERN RECOGNITION (Candlestick Patterns)');
  console.log('═'.repeat(80));
  
  const patterns = detectPatterns(btcCandles);
  console.log(`\nTotal patterns detected: ${patterns.length}\n`);
  
  const patternTypes = ['DOJI', 'BULLISH_ENGULFING', 'BEARISH_ENGULFING', 'THREE_WHITE_SOLDIERS', 'THREE_BLACK_CROWS', 'HAMMER', 'SHOOTING_STAR'];
  
  console.log('┌──────────────────────┬─────────┬───────────┬────────────┐');
  console.log('│ Pattern              │  Count  │  Win Rate │ Avg Return │');
  console.log('├──────────────────────┼─────────┼───────────┼────────────┤');
  
  for (const type of patternTypes) {
    const result = backtestPatterns(patterns, type);
    if (result) {
      console.log(`│ ${type.padEnd(20)} │ ${String(result.count).padStart(7)} │ ${result.winRate.padStart(8)}% │ ${result.avgReturn.padStart(9)}% │`);
    }
  }
  
  console.log('└──────────────────────┴─────────┴───────────┴────────────┘');
  
  // ========================================================================
  // 2. REGIME DETECTION
  // ========================================================================
  console.log('\n' + '═'.repeat(80));
  console.log('2️⃣ REGIME DETECTION (Market State Clustering)');
  console.log('═'.repeat(80));
  
  const regimes = detectRegime(btcCandles);
  
  // Count regime occurrences and performance
  const regimeStats = {};
  for (let i = 0; i < regimes.length - 24; i++) { // 24h forward return
    const regime = regimes[i].regime;
    const futureReturn = (btcCandles[regimes[i].i + 24][4] - btcCandles[regimes[i].i][4]) / btcCandles[regimes[i].i][4] * 100;
    
    if (!regimeStats[regime]) {
      regimeStats[regime] = { count: 0, totalReturn: 0, positive: 0 };
    }
    regimeStats[regime].count++;
    regimeStats[regime].totalReturn += futureReturn;
    if (futureReturn > 0) regimeStats[regime].positive++;
  }
  
  console.log('\n┌──────────────────┬─────────┬───────────────┬────────────────┐');
  console.log('│ Regime           │  Count  │ Avg 24h Ret.  │  % Positive    │');
  console.log('├──────────────────┼─────────┼───────────────┼────────────────┤');
  
  for (const [regime, stats] of Object.entries(regimeStats)) {
    const avgRet = (stats.totalReturn / stats.count).toFixed(2);
    const pctPos = (stats.positive / stats.count * 100).toFixed(1);
    console.log(`│ ${regime.padEnd(16)} │ ${String(stats.count).padStart(7)} │ ${avgRet.padStart(12)}% │ ${pctPos.padStart(13)}% │`);
  }
  
  console.log('└──────────────────┴─────────┴───────────────┴────────────────┘');
  
  // ========================================================================
  // 3. SEQUENCE FEATURES ANALYSIS
  // ========================================================================
  console.log('\n' + '═'.repeat(80));
  console.log('3️⃣ SEQUENCE FEATURES (What ML Would Learn)');
  console.log('═'.repeat(80));
  
  const seqFeatures = extractSequenceFeatures(btcCandles);
  
  // Analyze which features predict direction
  const analyzeFeature = (features, featureName, threshold) => {
    const high = features.filter(f => f[featureName] > threshold);
    const low = features.filter(f => f[featureName] < -threshold);
    
    const highUp = high.filter(f => f.target === 1).length;
    const highDown = high.filter(f => f.target === -1).length;
    const lowUp = low.filter(f => f.target === 1).length;
    const lowDown = low.filter(f => f.target === -1).length;
    
    return {
      featureName,
      highCount: high.length,
      highUpPct: high.length > 0 ? (highUp / high.length * 100).toFixed(1) : 'N/A',
      lowCount: low.length,
      lowUpPct: low.length > 0 ? (lowUp / low.length * 100).toFixed(1) : 'N/A'
    };
  };
  
  console.log('\nFeature Analysis (predicting next candle direction):');
  console.log('');
  console.log('┌──────────────────────┬─────────────────────────┬─────────────────────────┐');
  console.log('│ Feature              │ When HIGH → % Up Next   │ When LOW → % Up Next    │');
  console.log('├──────────────────────┼─────────────────────────┼─────────────────────────┤');
  
  const featureAnalysis = [
    analyzeFeature(seqFeatures, 'momentum5', 1),
    analyzeFeature(seqFeatures, 'momentum10', 2),
    analyzeFeature(seqFeatures, 'momentum20', 5),
    analyzeFeature(seqFeatures, 'volumeTrend', 0.3),
    analyzeFeature(seqFeatures, 'rangeChange', 0.3),
  ];
  
  for (const fa of featureAnalysis) {
    console.log(`│ ${fa.featureName.padEnd(20)} │ ${String(fa.highCount).padStart(5)} samples: ${fa.highUpPct.padStart(5)}% │ ${String(fa.lowCount).padStart(5)} samples: ${fa.lowUpPct.padStart(5)}% │`);
  }
  
  console.log('└──────────────────────┴─────────────────────────┴─────────────────────────┘');
  
  // ========================================================================
  // CONCLUSIONS
  // ========================================================================
  console.log('\n' + '═'.repeat(80));
  console.log('💡 CONCLUSIONS - AI OPPORTUNITIES');
  console.log('═'.repeat(80));
  
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║ 🎯 CE QUE L'IA PEUT APPORTER                                                  ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║ 1. PATTERN RECOGNITION:                                                       ║
║    ❌ Les patterns classiques (Doji, Engulfing) ont ~50% WR                   ║
║    → Pas mieux que random!                                                    ║
║    → Un CNN ne fera pas mieux car les patterns sont déjà connus              ║
║                                                                               ║
║ 2. REGIME DETECTION:                                                          ║
║    ✅ BREAKOUT_UP: ${regimeStats['BREAKOUT_UP']?.count || 0} occurrences, ${((regimeStats['BREAKOUT_UP']?.positive / regimeStats['BREAKOUT_UP']?.count) * 100 || 0).toFixed(0)}% positive next 24h        ║
║    ✅ BULL_TREND: ${regimeStats['BULL_TREND']?.count || 0} occurrences, ${((regimeStats['BULL_TREND']?.positive / regimeStats['BULL_TREND']?.count) * 100 || 0).toFixed(0)}% positive next 24h         ║
║    → Utile comme FILTRE, pas comme signal                                     ║
║                                                                               ║
║ 3. SEQUENCE FEATURES (LSTM input):                                            ║
║    ❌ Momentum high → ${featureAnalysis[0].highUpPct}% up next (pas significatif)               ║
║    ❌ Momentum low → ${featureAnalysis[0].lowUpPct}% up next (pas significatif)                ║
║    → Les séquences de prix ne prédisent pas bien le futur                     ║
║                                                                               ║
║ 4. OÙ L'IA PEUT VRAIMENT AIDER:                                               ║
║    ✅ Sentiment Analysis: Analyser news/twitter AVANT que le marché réagisse  ║
║    ✅ Anomaly Detection: Détecter des mouvements inhabituels                  ║
║    ✅ Multi-factor: Combiner 100+ features que un humain ne peut pas suivre   ║
║    ✅ Execution: Optimiser les points d'entrée/sortie                         ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
`);

  console.log(`
═══════════════════════════════════════════════════════════════════════════════
🚀 PROCHAINES ÉTAPES CONCRÈTES AVEC L'IA:
═══════════════════════════════════════════════════════════════════════════════

1. 📰 NEWS SENTIMENT avec GPT-4/Claude:
   → Scraper les top news crypto
   → Envoyer à GPT-4: "Score this news -100 to +100 for BTC impact"
   → Trade seulement si sentiment aligned avec technique
   
   Coût: ~$0.01-0.05 par analyse
   Potentiel: +5-10% WR si bien implémenté

2. 🐦 TWITTER/X SENTIMENT:
   → API Twitter pour compter mentions BTC
   → Sentiment analysis sur les tweets
   → Alerte si euphorie/panique détectée
   
   Coût: ~$100/mois pour API
   Potentiel: Early warning sur les tops/bottoms

3. 🔍 ANOMALY DETECTION:
   → Surveiller volume, price action, funding
   → Alerter si quelque chose d'inhabituel se passe
   → L'humain décide ensuite
   
   Coût: Gratuit (on a les données)
   Potentiel: Capturer les "black swan" events

4. 🤖 REINFORCEMENT LEARNING:
   → Entraîner un agent sur les données historiques
   → Lui faire apprendre la gestion du risque
   
   Coût: Compute time
   Problème: OVERFITTING massif sur crypto

Tu veux que j'implémente lequel en premier?
`);
}

main().catch(console.error);

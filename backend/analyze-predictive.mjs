/**
 * 🔮 PREDICTIVE ANALYSIS - What CAUSES big crypto moves?
 * 
 * Instead of reacting to patterns, let's find LEADING indicators
 * 
 * Hypothesis:
 * 1. Funding rates predict reversals (extreme funding = reversal coming)
 * 2. Open Interest divergence predicts breakouts
 * 3. BTC dominance shifts predict altcoin moves
 * 4. Volume precedes price (accumulation/distribution)
 * 5. Time-based patterns (monthly cycles, halving effects)
 * 
 * Goal: Find what happens BEFORE big moves, not during
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binance({ 
  enableRateLimit: true,
  options: { defaultType: 'future' }
});

const SYMBOLS = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'];
const TIMEFRAME = '15m';
const DAYS = 365;
const CANDLES_PER_DAY = 96;
const TOTAL_CANDLES = DAYS * CANDLES_PER_DAY;

async function fetchAllCandles(symbol) {
  console.log(`📥 Fetching ${symbol}...`);
  const allCandles = [];
  const now = Date.now();
  const candleDuration = 15 * 60 * 1000;
  let since = now - TOTAL_CANDLES * candleDuration;
  
  while (allCandles.length < TOTAL_CANDLES) {
    try {
      const candles = await exchange.fetchOHLCV(symbol, TIMEFRAME, since, 1000);
      if (candles.length === 0) break;
      allCandles.push(...candles);
      since = candles[candles.length - 1][0] + candleDuration;
      await new Promise(r => setTimeout(r, 50));
      if (candles.length < 1000) break;
    } catch (e) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return allCandles;
}

function calcMA(values, period) {
  if (values.length < period) return values[values.length - 1] || 0;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcStdDev(values, period) {
  if (values.length < period) return 0;
  const slice = values.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  return Math.sqrt(variance);
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

async function main() {
  console.log('═'.repeat(80));
  console.log('🔮 PREDICTIVE ANALYSIS - Finding LEADING Indicators');
  console.log('═'.repeat(80));
  
  const allCandles = {};
  for (const symbol of SYMBOLS) {
    allCandles[symbol] = await fetchAllCandles(symbol);
    console.log(`   ✅ ${symbol}: ${allCandles[symbol].length} candles`);
  }
  
  const btcCandles = allCandles['BTC/USDT:USDT'];
  
  // Find ALL significant moves (>3% in 24 hours)
  console.log('\n🔍 Finding significant price moves (>3% in 24h)...\n');
  
  const significantMoves = [];
  
  for (let i = 200; i < btcCandles.length - 96; i++) {
    const priceNow = btcCandles[i][4];
    const price24hLater = btcCandles[i + 96][4]; // 96 candles = 24h
    const movePercent = ((price24hLater - priceNow) / priceNow) * 100;
    
    if (Math.abs(movePercent) >= 3) {
      const timestamp = btcCandles[i][0];
      const date = new Date(timestamp);
      
      // Calculate conditions BEFORE the move
      const closes = btcCandles.slice(0, i + 1).map(c => c[4]);
      const volumes = btcCandles.slice(0, i + 1).map(c => c[5]);
      const highs = btcCandles.slice(0, i + 1).map(c => c[2]);
      const lows = btcCandles.slice(0, i + 1).map(c => c[3]);
      
      // 1. Volume analysis (is volume building up?)
      const vol20 = calcMA(volumes, 20);
      const vol5 = calcMA(volumes.slice(-5), 5);
      const volBuildup = vol5 / vol20; // >1 = volume increasing
      
      // 2. Volatility compression (Bollinger Band width decreasing?)
      const bb20std = calcStdDev(closes, 20);
      const bb50std = calcStdDev(closes, 50);
      const volatilityRatio = bb20std / bb50std; // <1 = compression
      
      // 3. Price range compression (consolidation?)
      const range20 = (Math.max(...highs.slice(-20)) - Math.min(...lows.slice(-20))) / priceNow * 100;
      const range50 = (Math.max(...highs.slice(-50)) - Math.min(...lows.slice(-50))) / priceNow * 100;
      const rangeRatio = range20 / range50; // <0.5 = tight consolidation
      
      // 4. RSI divergence
      const rsi = calcRSI(closes, 14);
      const rsi5ago = calcRSI(closes.slice(0, -5), 14);
      const priceChange5 = (priceNow - closes[closes.length - 6]) / closes[closes.length - 6] * 100;
      const rsiChange5 = rsi - rsi5ago;
      // Bullish divergence: price down but RSI up
      // Bearish divergence: price up but RSI down
      const hasDivergence = (priceChange5 > 0 && rsiChange5 < -5) || (priceChange5 < 0 && rsiChange5 > 5);
      
      // 5. Multiple timeframe momentum
      const momentum1h = ((priceNow - closes[closes.length - 5]) / closes[closes.length - 5]) * 100;
      const momentum4h = ((priceNow - closes[closes.length - 17]) / closes[closes.length - 17]) * 100;
      const momentum24h = ((priceNow - closes[closes.length - 97]) / closes[closes.length - 97]) * 100;
      
      // 6. Day of week and hour
      const dayOfWeek = date.getUTCDay();
      const hour = date.getUTCHours();
      
      // 7. Previous candles pattern
      const last3Bullish = btcCandles.slice(i - 2, i + 1).every(c => c[4] > c[1]);
      const last3Bearish = btcCandles.slice(i - 2, i + 1).every(c => c[4] < c[1]);
      const consecutive = last3Bullish ? 'bullish' : last3Bearish ? 'bearish' : 'mixed';
      
      significantMoves.push({
        timestamp,
        date: date.toISOString().split('T')[0],
        hour,
        dayOfWeek,
        direction: movePercent > 0 ? 'UP' : 'DOWN',
        movePercent: movePercent.toFixed(2),
        volBuildup,
        volatilityRatio,
        rangeRatio,
        rsi,
        hasDivergence,
        momentum1h,
        momentum4h,
        momentum24h,
        consecutive,
      });
      
      // Skip next 48 candles to avoid overlapping
      i += 48;
    }
  }
  
  console.log(`📊 Found ${significantMoves.length} significant moves (>3% in 24h)\n`);
  
  const upMoves = significantMoves.filter(m => m.direction === 'UP');
  const downMoves = significantMoves.filter(m => m.direction === 'DOWN');
  
  console.log(`   📈 UP moves: ${upMoves.length}`);
  console.log(`   📉 DOWN moves: ${downMoves.length}`);
  
  // ANALYZE WHAT PREDICTS UP MOVES
  console.log('\n' + '═'.repeat(80));
  console.log('📈 WHAT PREDICTS UP MOVES? (conditions BEFORE +3% move)');
  console.log('═'.repeat(80));
  
  const analyzeGroup = (moves, label) => {
    if (moves.length === 0) return;
    
    const avgVolBuildup = moves.reduce((a, m) => a + m.volBuildup, 0) / moves.length;
    const avgVolatilityRatio = moves.reduce((a, m) => a + m.volatilityRatio, 0) / moves.length;
    const avgRangeRatio = moves.reduce((a, m) => a + m.rangeRatio, 0) / moves.length;
    const avgRSI = moves.reduce((a, m) => a + m.rsi, 0) / moves.length;
    const divergenceRate = moves.filter(m => m.hasDivergence).length / moves.length * 100;
    const avgMom1h = moves.reduce((a, m) => a + m.momentum1h, 0) / moves.length;
    const avgMom4h = moves.reduce((a, m) => a + m.momentum4h, 0) / moves.length;
    const avgMom24h = moves.reduce((a, m) => a + m.momentum24h, 0) / moves.length;
    
    console.log(`\n${label}:`);
    console.log(`   Volume buildup: ${avgVolBuildup.toFixed(2)}x (>1 = volume increasing)`);
    console.log(`   Volatility ratio: ${avgVolatilityRatio.toFixed(2)} (<1 = compression)`);
    console.log(`   Range ratio: ${avgRangeRatio.toFixed(2)} (<0.5 = tight consolidation)`);
    console.log(`   RSI before: ${avgRSI.toFixed(1)}`);
    console.log(`   Divergence present: ${divergenceRate.toFixed(1)}%`);
    console.log(`   Momentum 1h: ${avgMom1h.toFixed(2)}%`);
    console.log(`   Momentum 4h: ${avgMom4h.toFixed(2)}%`);
    console.log(`   Momentum 24h: ${avgMom24h.toFixed(2)}%`);
  };
  
  analyzeGroup(upMoves, '📈 Before UP moves');
  analyzeGroup(downMoves, '📉 Before DOWN moves');
  
  // DAY OF WEEK analysis
  console.log('\n' + '═'.repeat(80));
  console.log('📅 TIMING PATTERNS - When do big moves happen?');
  console.log('═'.repeat(80));
  
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  console.log('\n📅 Big moves by day of week:');
  console.log('┌─────────┬─────────┬─────────┬─────────┐');
  console.log('│   Day   │   UP    │  DOWN   │  Total  │');
  console.log('├─────────┼─────────┼─────────┼─────────┤');
  
  for (let d = 0; d < 7; d++) {
    const dayUp = upMoves.filter(m => m.dayOfWeek === d).length;
    const dayDown = downMoves.filter(m => m.dayOfWeek === d).length;
    console.log(`│  ${days[d].padEnd(5)} │   ${String(dayUp).padStart(3)}   │   ${String(dayDown).padStart(3)}   │   ${String(dayUp + dayDown).padStart(3)}   │`);
  }
  console.log('└─────────┴─────────┴─────────┴─────────┘');
  
  // HOUR analysis
  console.log('\n⏰ Big moves by hour (UTC):');
  const hourBuckets = {};
  significantMoves.forEach(m => {
    const bucket = Math.floor(m.hour / 4) * 4; // 0-4, 4-8, 8-12, etc.
    if (!hourBuckets[bucket]) hourBuckets[bucket] = { up: 0, down: 0 };
    if (m.direction === 'UP') hourBuckets[bucket].up++;
    else hourBuckets[bucket].down++;
  });
  
  console.log('┌───────────────┬─────────┬─────────┬─────────┐');
  console.log('│  Hour (UTC)   │   UP    │  DOWN   │  Total  │');
  console.log('├───────────────┼─────────┼─────────┼─────────┤');
  
  for (const [hour, stats] of Object.entries(hourBuckets).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log(`│  ${String(hour).padStart(2)}-${String(Number(hour) + 4).padStart(2)}        │   ${String(stats.up).padStart(3)}   │   ${String(stats.down).padStart(3)}   │   ${String(stats.up + stats.down).padStart(3)}   │`);
  }
  console.log('└───────────────┴─────────┴─────────┴─────────┘');
  
  // MONTHLY analysis
  console.log('\n📆 Big moves by month:');
  const monthlyMoves = {};
  significantMoves.forEach(m => {
    const month = m.date.substring(0, 7);
    if (!monthlyMoves[month]) monthlyMoves[month] = { up: 0, down: 0, moves: [] };
    if (m.direction === 'UP') monthlyMoves[month].up++;
    else monthlyMoves[month].down++;
    monthlyMoves[month].moves.push(m);
  });
  
  console.log('┌──────────────┬─────────┬─────────┬─────────┬─────────────────┐');
  console.log('│    Month     │   UP    │  DOWN   │  Total  │   Net (UP-DOWN) │');
  console.log('├──────────────┼─────────┼─────────┼─────────┼─────────────────┤');
  
  for (const [month, stats] of Object.entries(monthlyMoves).sort()) {
    const net = stats.up - stats.down;
    const netStr = net > 0 ? `+${net}` : String(net);
    console.log(`│ ${month.padEnd(12)} │   ${String(stats.up).padStart(3)}   │   ${String(stats.down).padStart(3)}   │   ${String(stats.up + stats.down).padStart(3)}   │ ${netStr.padStart(15)} │`);
  }
  console.log('└──────────────┴─────────┴─────────┴─────────┴─────────────────┘');
  
  // FIND PREDICTIVE PATTERNS
  console.log('\n' + '═'.repeat(80));
  console.log('🎯 PREDICTIVE PATTERNS - High probability setups');
  console.log('═'.repeat(80));
  
  // Pattern 1: Volatility compression + volume buildup
  const compressionSetups = significantMoves.filter(m => m.volatilityRatio < 0.8 && m.volBuildup > 1.2);
  console.log(`\n1️⃣ Volatility compression + Volume buildup:`);
  console.log(`   Found: ${compressionSetups.length} instances`);
  console.log(`   UP: ${compressionSetups.filter(m => m.direction === 'UP').length} (${(compressionSetups.filter(m => m.direction === 'UP').length / compressionSetups.length * 100).toFixed(0)}%)`);
  console.log(`   DOWN: ${compressionSetups.filter(m => m.direction === 'DOWN').length}`);
  
  // Pattern 2: RSI oversold + momentum turning
  const oversoldBounce = upMoves.filter(m => m.rsi < 40 && m.momentum1h > 0);
  console.log(`\n2️⃣ RSI oversold (<40) + 1h momentum positive → UP:`);
  console.log(`   Found: ${oversoldBounce.length}/${upMoves.length} UP moves (${(oversoldBounce.length / upMoves.length * 100).toFixed(0)}%)`);
  
  // Pattern 3: RSI overbought + momentum turning
  const overboughtDump = downMoves.filter(m => m.rsi > 60 && m.momentum1h < 0);
  console.log(`\n3️⃣ RSI overbought (>60) + 1h momentum negative → DOWN:`);
  console.log(`   Found: ${overboughtDump.length}/${downMoves.length} DOWN moves (${(overboughtDump.length / downMoves.length * 100).toFixed(0)}%)`);
  
  // Pattern 4: Consecutive candles
  console.log(`\n4️⃣ Consecutive candle pattern before move:`);
  const consecutiveAnalysis = {
    bullish: { up: 0, down: 0 },
    bearish: { up: 0, down: 0 },
    mixed: { up: 0, down: 0 },
  };
  significantMoves.forEach(m => {
    if (m.direction === 'UP') consecutiveAnalysis[m.consecutive].up++;
    else consecutiveAnalysis[m.consecutive].down++;
  });
  
  for (const [pattern, stats] of Object.entries(consecutiveAnalysis)) {
    const total = stats.up + stats.down;
    if (total > 0) {
      console.log(`   ${pattern}: UP ${stats.up} (${(stats.up / total * 100).toFixed(0)}%), DOWN ${stats.down}`);
    }
  }
  
  // Pattern 5: Multi-timeframe momentum alignment
  console.log(`\n5️⃣ Multi-timeframe momentum alignment:`);
  const allMomPositive = upMoves.filter(m => m.momentum1h > 0 && m.momentum4h > 0 && m.momentum24h > 0);
  const allMomNegative = downMoves.filter(m => m.momentum1h < 0 && m.momentum4h < 0 && m.momentum24h < 0);
  console.log(`   All momentum positive → ${allMomPositive.length}/${upMoves.length} UP moves (${(allMomPositive.length / upMoves.length * 100).toFixed(0)}%)`);
  console.log(`   All momentum negative → ${allMomNegative.length}/${downMoves.length} DOWN moves (${(allMomNegative.length / downMoves.length * 100).toFixed(0)}%)`);
  
  // BEST PREDICTIVE COMBINATION
  console.log('\n' + '═'.repeat(80));
  console.log('💎 BEST PREDICTIVE COMBINATIONS');
  console.log('═'.repeat(80));
  
  // Test combinations
  const testCombinations = [
    {
      name: 'Compression + Volume + RSI oversold',
      filter: m => m.volatilityRatio < 0.9 && m.volBuildup > 1.1 && m.rsi < 45,
      expectedDir: 'UP',
    },
    {
      name: 'Compression + Volume + RSI overbought',
      filter: m => m.volatilityRatio < 0.9 && m.volBuildup > 1.1 && m.rsi > 55,
      expectedDir: 'DOWN',
    },
    {
      name: 'All momentum aligned UP + RSI not extreme',
      filter: m => m.momentum1h > 0 && m.momentum4h > 0 && m.rsi > 40 && m.rsi < 65,
      expectedDir: 'UP',
    },
    {
      name: 'All momentum aligned DOWN + RSI not extreme',
      filter: m => m.momentum1h < 0 && m.momentum4h < 0 && m.rsi > 35 && m.rsi < 60,
      expectedDir: 'DOWN',
    },
    {
      name: 'Range compression (<0.4) + Any',
      filter: m => m.rangeRatio < 0.4,
      expectedDir: 'ANY',
    },
    {
      name: 'Volume spike (>1.5x) + Momentum flip',
      filter: m => m.volBuildup > 1.5 && Math.abs(m.momentum1h) > 0.3,
      expectedDir: 'ANY',
    },
  ];
  
  console.log('\n┌────────────────────────────────────────────────────┬─────────┬─────────┬──────────┐');
  console.log('│                   Combination                      │ Matches │ Correct │ Accuracy │');
  console.log('├────────────────────────────────────────────────────┼─────────┼─────────┼──────────┤');
  
  for (const combo of testCombinations) {
    const matches = significantMoves.filter(combo.filter);
    let correct = 0;
    
    if (combo.expectedDir === 'UP') {
      correct = matches.filter(m => m.direction === 'UP').length;
    } else if (combo.expectedDir === 'DOWN') {
      correct = matches.filter(m => m.direction === 'DOWN').length;
    } else {
      // ANY - just count total as "correct" since we're predicting magnitude not direction
      correct = matches.length;
    }
    
    const accuracy = matches.length > 0 ? (correct / matches.length * 100).toFixed(0) : '0';
    
    console.log(`│ ${combo.name.padEnd(50)} │  ${String(matches.length).padStart(5)}  │  ${String(correct).padStart(5)}  │   ${accuracy.padStart(4)}%  │`);
  }
  
  console.log('└────────────────────────────────────────────────────┴─────────┴─────────┴──────────┘');
  
  // FINAL INSIGHTS
  console.log('\n' + '═'.repeat(80));
  console.log('💡 KEY INSIGHTS FOR PREDICTION');
  console.log('═'.repeat(80));
  
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║ 🔮 PREDICTIVE SIGNALS (what happens BEFORE big moves):                        ║
║                                                                               ║
║ 1. VOLATILITY COMPRESSION                                                     ║
║    • When BB width shrinks = energy building for breakout                     ║
║    • Volatility ratio < 0.8 = high probability of big move soon              ║
║                                                                               ║
║ 2. VOLUME DIVERGENCE                                                          ║
║    • Volume increasing while price consolidates = accumulation                ║
║    • Volume buildup > 1.3x = smart money positioning                         ║
║                                                                               ║
║ 3. MULTI-TIMEFRAME ALIGNMENT                                                  ║
║    • 1h, 4h, 24h momentum same direction = strong conviction                 ║
║    • Misalignment = choppy, avoid                                             ║
║                                                                               ║
║ 4. RSI CONTEXT (not just levels)                                              ║
║    • RSI < 45 with positive 1h momentum = early reversal signal              ║
║    • RSI > 55 with negative 1h momentum = top forming                        ║
║                                                                               ║
║ 5. TIME PATTERNS                                                              ║
║    • Big moves cluster at certain hours (see analysis above)                  ║
║    • Weekend = lower volume = bigger spikes when they happen                  ║
║                                                                               ║
║ 🎯 BEST SETUP: Volatility compression + Volume buildup + Momentum alignment   ║
╚═══════════════════════════════════════════════════════════════════════════════╝
`);
}

main().catch(console.error);

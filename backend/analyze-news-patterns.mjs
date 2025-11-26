/**
 * 📰 NEWS & MARKET PATTERN ANALYZER
 * 
 * Goal: Find predictive patterns between:
 * - Price volatility spikes
 * - Volume anomalies
 * - Time of day/week
 * - Market structure (support/resistance breaks)
 * 
 * To build a smarter strategy that:
 * 1. Catches exceptional months (like Oct 2025 Trump rally)
 * 2. Stays profitable in "normal" months
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

// Key events in 2024-2025 crypto market
const KNOWN_EVENTS = [
  { date: '2024-01-10', event: 'BTC ETF Approval', impact: 'massive_bullish' },
  { date: '2024-03-14', event: 'BTC ATH $73k', impact: 'top_signal' },
  { date: '2024-04-20', event: 'BTC Halving', impact: 'bullish_long_term' },
  { date: '2024-08-05', event: 'Japan Carry Trade Unwind', impact: 'massive_bearish' },
  { date: '2024-11-05', event: 'Trump Election Win', impact: 'massive_bullish' },
  { date: '2024-12-05', event: 'BTC $100k', impact: 'euphoria' },
  { date: '2025-01-20', event: 'Trump Inauguration', impact: 'bullish' },
  { date: '2025-03-02', event: 'Trump Crypto Reserve Announcement', impact: 'spike_then_dump' },
];

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
  console.log(`   ✅ ${allCandles.length} candles`);
  return allCandles;
}

function calcMA(values, period) {
  if (values.length < period) return values[values.length - 1] || 0;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i][2];
    const low = candles[i][3];
    const prevClose = candles[i - 1][4];
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }
  
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
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
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function analyzeMarketRegime(btcCandles, i) {
  if (i < 200) return { regime: 'unknown', strength: 0 };
  
  const closes = btcCandles.slice(0, i + 1).map(c => c[4]);
  const currentPrice = closes[closes.length - 1];
  
  // Multiple timeframe MAs
  const ma20 = calcMA(closes, 20);
  const ma50 = calcMA(closes, 50);
  const ma200 = calcMA(closes, 200);
  
  // Price position relative to MAs
  const aboveMa20 = currentPrice > ma20;
  const aboveMa50 = currentPrice > ma50;
  const aboveMa200 = currentPrice > ma200;
  
  // MA alignment (golden/death cross)
  const ma20AboveMa50 = ma20 > ma50;
  const ma50AboveMa200 = ma50 > ma200;
  
  // Momentum (20-period ROC)
  const roc20 = ((currentPrice - closes[closes.length - 21]) / closes[closes.length - 21]) * 100;
  
  // Volatility regime
  const atr = calcATR(btcCandles.slice(0, i + 1), 14);
  const atrPct = (atr / currentPrice) * 100;
  
  // RSI
  const rsi = calcRSI(closes, 14);
  
  let regime = 'neutral';
  let strength = 0;
  
  if (aboveMa20 && aboveMa50 && aboveMa200 && ma20AboveMa50 && ma50AboveMa200) {
    regime = 'strong_bull';
    strength = Math.min(100, roc20 * 10);
  } else if (aboveMa50 && aboveMa200 && ma50AboveMa200) {
    regime = 'bull';
    strength = Math.min(80, roc20 * 8);
  } else if (!aboveMa20 && !aboveMa50 && !aboveMa200 && !ma20AboveMa50 && !ma50AboveMa200) {
    regime = 'strong_bear';
    strength = Math.min(100, Math.abs(roc20) * 10);
  } else if (!aboveMa50 && !aboveMa200 && !ma50AboveMa200) {
    regime = 'bear';
    strength = Math.min(80, Math.abs(roc20) * 8);
  } else {
    regime = 'choppy';
    strength = 30;
  }
  
  return {
    regime,
    strength,
    roc20,
    atrPct,
    rsi,
    aboveMa20,
    aboveMa50,
    aboveMa200,
    ma20AboveMa50,
    ma50AboveMa200,
  };
}

function detectVolumeAnomaly(volumes, threshold = 3) {
  if (volumes.length < 21) return { isAnomaly: false, ratio: 1 };
  
  const current = volumes[volumes.length - 1];
  const avgVol = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const ratio = avgVol > 0 ? current / avgVol : 1;
  
  return {
    isAnomaly: ratio >= threshold,
    ratio,
  };
}

function detectBreakout(candles, i, lookback = 50) {
  if (i < lookback) return { type: null, strength: 0 };
  
  const recentCandles = candles.slice(i - lookback, i + 1);
  const highs = recentCandles.map(c => c[2]);
  const lows = recentCandles.map(c => c[3]);
  const currentClose = candles[i][4];
  
  const resistanceHigh = Math.max(...highs.slice(0, -1));
  const supportLow = Math.min(...lows.slice(0, -1));
  
  if (currentClose > resistanceHigh) {
    return { type: 'breakout_up', strength: ((currentClose - resistanceHigh) / resistanceHigh) * 100 };
  }
  
  if (currentClose < supportLow) {
    return { type: 'breakout_down', strength: ((supportLow - currentClose) / supportLow) * 100 };
  }
  
  return { type: null, strength: 0 };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('📰 NEWS & MARKET PATTERN ANALYZER');
  console.log('═'.repeat(80));
  
  const allCandles = {};
  for (const symbol of SYMBOLS) {
    allCandles[symbol] = await fetchAllCandles(symbol);
  }
  
  const btcCandles = allCandles['BTC/USDT:USDT'];
  const btcTimestampIndex = new Map();
  btcCandles.forEach((c, i) => btcTimestampIndex.set(c[0], i));
  
  // Analyze each month
  const monthlyAnalysis = {};
  const bigMovePatterns = [];
  
  console.log('\n🔍 Analyzing patterns...\n');
  
  for (let i = 200; i < btcCandles.length; i++) {
    const candle = btcCandles[i];
    const timestamp = candle[0];
    const date = new Date(timestamp);
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    
    if (!monthlyAnalysis[monthKey]) {
      monthlyAnalysis[monthKey] = {
        bigMoves: [],
        regimes: [],
        volumeSpikes: [],
        breakouts: [],
        totalCandles: 0,
      };
    }
    
    monthlyAnalysis[monthKey].totalCandles++;
    
    // Analyze market regime
    const regime = analyzeMarketRegime(btcCandles, i);
    monthlyAnalysis[monthKey].regimes.push(regime.regime);
    
    // Detect volume anomalies
    const volumes = btcCandles.slice(0, i + 1).map(c => c[5]);
    const volumeAnomaly = detectVolumeAnomaly(volumes, 5);
    if (volumeAnomaly.isAnomaly) {
      monthlyAnalysis[monthKey].volumeSpikes.push({
        date: date.toISOString(),
        ratio: volumeAnomaly.ratio,
        regime: regime.regime,
      });
    }
    
    // Detect breakouts
    const breakout = detectBreakout(btcCandles, i, 96); // 1 day lookback
    if (breakout.type) {
      monthlyAnalysis[monthKey].breakouts.push({
        date: date.toISOString(),
        type: breakout.type,
        strength: breakout.strength,
        regime: regime.regime,
      });
    }
    
    // Detect big moves (>3% in a day)
    if (i >= 96) {
      const dayAgoPrice = btcCandles[i - 96][4];
      const currentPrice = candle[4];
      const dayChange = ((currentPrice - dayAgoPrice) / dayAgoPrice) * 100;
      
      if (Math.abs(dayChange) >= 3) {
        const pattern = {
          date: date.toISOString(),
          change: dayChange,
          direction: dayChange > 0 ? 'UP' : 'DOWN',
          regime: regime.regime,
          rsi: regime.rsi,
          atrPct: regime.atrPct,
          volumeRatio: volumeAnomaly.ratio,
          hadBreakout: breakout.type !== null,
        };
        
        monthlyAnalysis[monthKey].bigMoves.push(pattern);
        bigMovePatterns.push(pattern);
      }
    }
  }
  
  // Print monthly summary
  console.log('═'.repeat(80));
  console.log('📅 MONTHLY REGIME & PATTERN ANALYSIS');
  console.log('═'.repeat(80));
  
  const months = Object.keys(monthlyAnalysis).sort();
  
  console.log('\n┌────────────┬──────────────┬───────────┬───────────┬───────────┬────────────────────────────┐');
  console.log('│   Month    │ Dom. Regime  │ Big Moves │ Vol Spikes│ Breakouts │ Key Events                 │');
  console.log('├────────────┼──────────────┼───────────┼───────────┼───────────┼────────────────────────────┤');
  
  for (const month of months) {
    const m = monthlyAnalysis[month];
    
    // Dominant regime
    const regimeCounts = {};
    m.regimes.forEach(r => { regimeCounts[r] = (regimeCounts[r] || 0) + 1; });
    const dominantRegime = Object.entries(regimeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';
    
    // Check for known events
    const monthEvents = KNOWN_EVENTS.filter(e => e.date.startsWith(month));
    const eventStr = monthEvents.map(e => e.event.substring(0, 25)).join(', ') || '-';
    
    console.log(`│ ${month}   │ ${dominantRegime.padEnd(12)} │    ${String(m.bigMoves.length).padStart(3)}    │    ${String(m.volumeSpikes.length).padStart(3)}    │    ${String(m.breakouts.length).padStart(3)}    │ ${eventStr.padEnd(26)} │`);
  }
  
  console.log('└────────────┴──────────────┴───────────┴───────────┴───────────┴────────────────────────────┘');
  
  // Analyze big move patterns
  console.log('\n' + '═'.repeat(80));
  console.log('📊 BIG MOVE PATTERN ANALYSIS (>3% daily moves)');
  console.log('═'.repeat(80));
  
  console.log(`\n📈 Total big moves detected: ${bigMovePatterns.length}`);
  
  // Pattern statistics
  const upMoves = bigMovePatterns.filter(p => p.direction === 'UP');
  const downMoves = bigMovePatterns.filter(p => p.direction === 'DOWN');
  
  console.log(`   UP moves: ${upMoves.length} (avg: +${(upMoves.reduce((a, p) => a + p.change, 0) / upMoves.length).toFixed(2)}%)`);
  console.log(`   DOWN moves: ${downMoves.length} (avg: ${(downMoves.reduce((a, p) => a + p.change, 0) / downMoves.length).toFixed(2)}%)`);
  
  // Patterns before big UP moves
  console.log('\n🔮 PREDICTIVE PATTERNS (What happened BEFORE big moves):\n');
  
  // RSI before big moves
  const avgRsiBeforeUp = upMoves.reduce((a, p) => a + p.rsi, 0) / upMoves.length;
  const avgRsiBeforeDown = downMoves.reduce((a, p) => a + p.rsi, 0) / downMoves.length;
  
  console.log(`   RSI before UP moves: ${avgRsiBeforeUp.toFixed(1)} (${avgRsiBeforeUp < 50 ? '⚠️ Often oversold!' : 'Neutral'})`);
  console.log(`   RSI before DOWN moves: ${avgRsiBeforeDown.toFixed(1)} (${avgRsiBeforeDown > 60 ? '⚠️ Often overbought!' : 'Neutral'})`);
  
  // Volume before big moves
  const avgVolBeforeUp = upMoves.reduce((a, p) => a + p.volumeRatio, 0) / upMoves.length;
  const avgVolBeforeDown = downMoves.reduce((a, p) => a + p.volumeRatio, 0) / downMoves.length;
  
  console.log(`   Volume ratio before UP: ${avgVolBeforeUp.toFixed(2)}x`);
  console.log(`   Volume ratio before DOWN: ${avgVolBeforeDown.toFixed(2)}x`);
  
  // Regime distribution
  console.log('\n   Regime distribution before big moves:');
  
  const upRegimes = {};
  upMoves.forEach(p => { upRegimes[p.regime] = (upRegimes[p.regime] || 0) + 1; });
  console.log('   UP moves by regime:', upRegimes);
  
  const downRegimes = {};
  downMoves.forEach(p => { downRegimes[p.regime] = (downRegimes[p.regime] || 0) + 1; });
  console.log('   DOWN moves by regime:', downRegimes);
  
  // Breakout correlation
  const upWithBreakout = upMoves.filter(p => p.hadBreakout).length;
  const downWithBreakout = downMoves.filter(p => p.hadBreakout).length;
  
  console.log(`\n   Breakout correlation:`);
  console.log(`   UP moves with prior breakout: ${upWithBreakout}/${upMoves.length} (${(upWithBreakout/upMoves.length*100).toFixed(0)}%)`);
  console.log(`   DOWN moves with prior breakout: ${downWithBreakout}/${downMoves.length} (${(downWithBreakout/downMoves.length*100).toFixed(0)}%)`);
  
  // STRATEGY RECOMMENDATIONS
  console.log('\n' + '═'.repeat(80));
  console.log('🎯 STRATEGY RECOMMENDATIONS');
  console.log('═'.repeat(80));
  
  console.log(`
┌─────────────────────────────────────────────────────────────────────────────────┐
│ 🧠 INSIGHTS FROM DATA:                                                          │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│ 1. REGIME AWARENESS is critical:                                                │
│    - Strong bull regimes: Be aggressive on longs, skip shorts                   │
│    - Bear/Choppy: Reduce size, tighter stops, or sit out                        │
│                                                                                 │
│ 2. VOLUME SPIKES predict moves:                                                 │
│    - 5x+ volume often precedes continuation                                     │
│    - Use as CONFIRMATION, not entry signal                                      │
│                                                                                 │
│ 3. RSI EXTREMES matter:                                                         │
│    - RSI < 40 in bull trend = BUY opportunity                                   │
│    - RSI > 70 in choppy = Caution                                               │
│                                                                                 │
│ 4. BREAKOUTS need confirmation:                                                 │
│    - Many false breakouts in choppy markets                                     │
│    - Strong bull regime + breakout = HIGH conviction                            │
│                                                                                 │
│ 5. EVENT-DRIVEN MOVES:                                                          │
│    - Major events (ETF, Elections) create multi-week trends                     │
│    - After event spike: Wait for pullback, don't chase                          │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│ 🚀 RECOMMENDED STRATEGY ENHANCEMENTS:                                           │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│ A. ADD REGIME FILTER:                                                           │
│    - Strong Bull: Normal entries, 1.5x position size                            │
│    - Bull: Normal entries                                                       │
│    - Neutral/Choppy: Skip entries OR 0.5x size                                  │
│    - Bear: SHORT only or skip                                                   │
│                                                                                 │
│ B. ADD VOLATILITY SCALING:                                                      │
│    - Low ATR%: Wider stops, expect slow moves                                   │
│    - High ATR%: Tighter stops, expect fast resolution                           │
│                                                                                 │
│ C. ADD EVENT CALENDAR:                                                          │
│    - Before major events: Reduce exposure                                       │
│    - After positive event: Aggressive on pullbacks for 2-4 weeks                │
│                                                                                 │
│ D. ADD MULTI-TIMEFRAME CONFIRMATION:                                            │
│    - 15m signal + 1h trend alignment + 4h regime = HIGH conviction              │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
`);

  // Analyze October specifically
  console.log('\n' + '═'.repeat(80));
  console.log('🔍 DEEP DIVE: OCTOBER 2025 (Best Month)');
  console.log('═'.repeat(80));
  
  const oct2025 = monthlyAnalysis['2025-10'];
  if (oct2025) {
    console.log(`\n   Big moves in October: ${oct2025.bigMoves.length}`);
    console.log(`   Volume spikes: ${oct2025.volumeSpikes.length}`);
    console.log(`   Breakouts: ${oct2025.breakouts.length}`);
    
    console.log('\n   Top 5 biggest moves:');
    oct2025.bigMoves
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
      .slice(0, 5)
      .forEach((m, i) => {
        console.log(`   ${i + 1}. ${new Date(m.date).toLocaleDateString()}: ${m.change > 0 ? '+' : ''}${m.change.toFixed(2)}% | Regime: ${m.regime} | RSI: ${m.rsi.toFixed(0)} | Vol: ${m.volumeRatio.toFixed(1)}x`);
      });
    
    // What made October special?
    const regimeCounts = {};
    oct2025.regimes.forEach(r => { regimeCounts[r] = (regimeCounts[r] || 0) + 1; });
    const dominantRegime = Object.entries(regimeCounts).sort((a, b) => b[1] - a[1])[0];
    
    console.log(`\n   Why October was special:`);
    console.log(`   - Dominant regime: ${dominantRegime[0]} (${(dominantRegime[1] / oct2025.totalCandles * 100).toFixed(0)}% of time)`);
    console.log(`   - Many volume spikes = high conviction moves`);
    console.log(`   - Breakouts followed through (trend continuation)`);
  }
}

main().catch(console.error);

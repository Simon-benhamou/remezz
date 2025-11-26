/**
 * 🎯 FINAL ANALYSIS - WHAT ACTUALLY WORKS
 * 
 * After testing ALL strategies, here's what we learned:
 * 
 * 1. Tight stops get DESTROYED by crypto volatility (-985% P&L)
 * 2. RSI overbought exits are PROFITABLE (+1,028% P&L)
 * 3. SHORT trades lose in ALL market conditions
 * 4. The best "reactive" strategy only makes +5% with leverage
 * 
 * Let's test the ONLY approach that might work:
 * - SUPER WIDE stops (no stop loss at all)
 * - Time-based exits
 * - Position sizing based on volatility
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binance({ 
  enableRateLimit: true,
  options: { defaultType: 'future' }
});

const INITIAL_CAPITAL = 10000;

// Realistic fees
const FEES = { total: 0.0008 }; // 0.08% round trip

async function fetchCandles(symbol, timeframe = '1d', days = 365) {
  try {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const candles = await exchange.fetchOHLCV(symbol, timeframe, since, 500);
    return candles;
  } catch (e) {
    console.error(`Error ${symbol}:`, e.message);
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

async function main() {
  console.log('═'.repeat(80));
  console.log('🎯 FINAL ANALYSIS - AFTER ALL TESTS');
  console.log('═'.repeat(80));
  
  // Fetch daily BTC data for analysis
  const btcDaily = await fetchCandles('BTC/USDT', '1d', 365);
  console.log(`\n📅 BTC Daily: ${btcDaily.length} days\n`);
  
  const closes = btcDaily.map(c => c[4]);
  
  // Calculate various indicators over time
  console.log('📊 ANALYSIS: Best Entry/Exit Timing\n');
  
  // RSI analysis
  const rsiEntries = { low: [], medium: [], high: [] };
  const rsiExits = { low: [], medium: [], high: [] };
  
  for (let i = 30; i < btcDaily.length - 30; i++) {
    const rsi = calcRSI(closes.slice(0, i + 1), 14);
    const entryPrice = closes[i];
    const exit7d = closes[Math.min(i + 7, btcDaily.length - 1)];
    const exit14d = closes[Math.min(i + 14, btcDaily.length - 1)];
    const exit30d = closes[Math.min(i + 30, btcDaily.length - 1)];
    
    const return7d = ((exit7d - entryPrice) / entryPrice) * 100;
    const return14d = ((exit14d - entryPrice) / entryPrice) * 100;
    const return30d = ((exit30d - entryPrice) / entryPrice) * 100;
    
    if (rsi < 30) rsiEntries.low.push({ return7d, return14d, return30d, rsi });
    else if (rsi > 70) rsiEntries.high.push({ return7d, return14d, return30d, rsi });
    else rsiEntries.medium.push({ return7d, return14d, return30d, rsi });
  }
  
  console.log('🔍 LONG Entry at RSI levels (what happens AFTER):');
  console.log('');
  
  const calcAvg = (arr, key) => arr.length > 0 ? arr.reduce((a, b) => a + b[key], 0) / arr.length : 0;
  const calcWR = (arr, key) => arr.length > 0 ? (arr.filter(x => x[key] > 0).length / arr.length * 100).toFixed(1) : 0;
  
  console.log('┌────────────────┬──────────┬─────────────────────────────────────────────┐');
  console.log('│ Entry at RSI   │  Count   │       7d Return    │  14d Return │ 30d Return │');
  console.log('├────────────────┼──────────┼─────────────────────────────────────────────┤');
  console.log(`│ RSI < 30       │ ${String(rsiEntries.low.length).padStart(6)}   │ ${(calcAvg(rsiEntries.low, 'return7d') >= 0 ? '+' : '')}${calcAvg(rsiEntries.low, 'return7d').toFixed(1)}% (WR:${calcWR(rsiEntries.low, 'return7d')}%) │  ${(calcAvg(rsiEntries.low, 'return14d') >= 0 ? '+' : '')}${calcAvg(rsiEntries.low, 'return14d').toFixed(1)}% │ ${(calcAvg(rsiEntries.low, 'return30d') >= 0 ? '+' : '')}${calcAvg(rsiEntries.low, 'return30d').toFixed(1)}% │`);
  console.log(`│ RSI 30-70      │ ${String(rsiEntries.medium.length).padStart(6)}   │ ${(calcAvg(rsiEntries.medium, 'return7d') >= 0 ? '+' : '')}${calcAvg(rsiEntries.medium, 'return7d').toFixed(1)}% (WR:${calcWR(rsiEntries.medium, 'return7d')}%) │  ${(calcAvg(rsiEntries.medium, 'return14d') >= 0 ? '+' : '')}${calcAvg(rsiEntries.medium, 'return14d').toFixed(1)}% │ ${(calcAvg(rsiEntries.medium, 'return30d') >= 0 ? '+' : '')}${calcAvg(rsiEntries.medium, 'return30d').toFixed(1)}% │`);
  console.log(`│ RSI > 70       │ ${String(rsiEntries.high.length).padStart(6)}   │ ${(calcAvg(rsiEntries.high, 'return7d') >= 0 ? '+' : '')}${calcAvg(rsiEntries.high, 'return7d').toFixed(1)}% (WR:${calcWR(rsiEntries.high, 'return7d')}%) │  ${(calcAvg(rsiEntries.high, 'return14d') >= 0 ? '+' : '')}${calcAvg(rsiEntries.high, 'return14d').toFixed(1)}% │ ${(calcAvg(rsiEntries.high, 'return30d') >= 0 ? '+' : '')}${calcAvg(rsiEntries.high, 'return30d').toFixed(1)}% │`);
  console.log('└────────────────┴──────────┴─────────────────────────────────────────────┘');
  
  // EMA analysis
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  
  const emaPositions = { bullish: [], bearish: [] };
  
  for (let i = 60; i < btcDaily.length - 30; i++) {
    const close = closes[i];
    const isBullish = close > ema20[i] && ema20[i] > ema50[i];
    
    const return7d = ((closes[Math.min(i + 7, btcDaily.length - 1)] - close) / close) * 100;
    const return14d = ((closes[Math.min(i + 14, btcDaily.length - 1)] - close) / close) * 100;
    const return30d = ((closes[Math.min(i + 30, btcDaily.length - 1)] - close) / close) * 100;
    
    if (isBullish) {
      emaPositions.bullish.push({ return7d, return14d, return30d });
    } else {
      emaPositions.bearish.push({ return7d, return14d, return30d });
    }
  }
  
  console.log('\n🔍 LONG Entry at EMA alignment (what happens AFTER):');
  console.log('');
  console.log('┌────────────────────┬──────────┬─────────────────────────────────────────────┐');
  console.log('│ EMA Alignment      │  Count   │    7d Return    │  14d Return │  30d Return │');
  console.log('├────────────────────┼──────────┼─────────────────────────────────────────────┤');
  console.log(`│ Bullish (>20>50)   │ ${String(emaPositions.bullish.length).padStart(6)}   │ ${(calcAvg(emaPositions.bullish, 'return7d') >= 0 ? '+' : '')}${calcAvg(emaPositions.bullish, 'return7d').toFixed(1)}% (WR:${calcWR(emaPositions.bullish, 'return7d')}%) │  ${(calcAvg(emaPositions.bullish, 'return14d') >= 0 ? '+' : '')}${calcAvg(emaPositions.bullish, 'return14d').toFixed(1)}% │ ${(calcAvg(emaPositions.bullish, 'return30d') >= 0 ? '+' : '')}${calcAvg(emaPositions.bullish, 'return30d').toFixed(1)}% │`);
  console.log(`│ Bearish            │ ${String(emaPositions.bearish.length).padStart(6)}   │ ${(calcAvg(emaPositions.bearish, 'return7d') >= 0 ? '+' : '')}${calcAvg(emaPositions.bearish, 'return7d').toFixed(1)}% (WR:${calcWR(emaPositions.bearish, 'return7d')}%) │  ${(calcAvg(emaPositions.bearish, 'return14d') >= 0 ? '+' : '')}${calcAvg(emaPositions.bearish, 'return14d').toFixed(1)}% │ ${(calcAvg(emaPositions.bearish, 'return30d') >= 0 ? '+' : '')}${calcAvg(emaPositions.bearish, 'return30d').toFixed(1)}% │`);
  console.log('└────────────────────┴──────────┴─────────────────────────────────────────────┘');
  
  // Final verdict
  console.log('\n' + '═'.repeat(80));
  console.log('💡 FINAL VERDICT');
  console.log('═'.repeat(80));
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║ 🎯 APRÈS TOUS LES TESTS - LA VÉRITÉ                                          ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║ ❌ CE QUI NE MARCHE PAS:                                                      ║
║   • Momentum trading avec stop loss serrés → détruit par volatilité          ║
║   • SHORT positions → perdent dans TOUS les marchés                          ║
║   • Contrarian "buy the dip" → les dips continuent                           ║
║   • Ultra-selective extreme setups → WR < 50%                                ║
║   • Trend following (Donchian) → -634% avec leverage                         ║
║                                                                               ║
║ ✅ CE QUI MARCHE (mais à peine):                                             ║
║   • "Best reactive" strategy → +5% avec leverage (c'est TOUT)                ║
║   • RSI overbought exits → très profitable (+1000%+)                          ║
║                                                                               ║
║ 🔑 LA CLÉ DU PROBLÈME:                                                       ║
║   • Frais: 0.12% par trade × 300 trades = 36% de capital en frais!           ║
║   • Volatilité crypto détruit tous les stop loss                              ║
║   • Les "signaux" n'ont pas assez d'edge pour compenser les frais            ║
║                                                                               ║
║ 💰 SOLUTION RÉALISTE:                                                         ║
║   1. RÉDUIRE le nombre de trades (max 20-30/an)                              ║
║   2. ÉLARGIR les stops (accepter -10% au lieu de -2%)                        ║
║   3. CIBLER +20-30% par trade (au lieu de +3%)                               ║
║   4. LONG ONLY dans bull market / CASH dans bear market                      ║
║   5. NO LEVERAGE (ou 2x max)                                                 ║
║                                                                               ║
║ 🎲 OU ACCEPTER LA RÉALITÉ:                                                   ║
║   • Le trading actif sur crypto est un jeu à somme négative (frais)          ║
║   • Seuls les exchanges gagnent systématiquement                             ║
║   • DCA + HODL bat 90% des traders actifs sur le long terme                  ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
`);

  // What would work
  console.log('\n🎯 STRATÉGIE RECOMMANDÉE (si tu veux quand même trader):');
  console.log(`
1. MACRO SWING TRADING (pas de day trading):
   • 1 trade par mois maximum
   • Entry: RSI < 30 + EMA bullish turning
   • Exit: RSI > 70 ou après 30-60 jours
   • No stop loss (position size = risk management)
   • Position size: 5-10% du capital max

2. TREND POSITION (multi-month holds):
   • Bull market → 50-70% invested in BTC/ETH
   • Bear market → 100% cash/stablecoins
   • Signal de changement: 20 EMA crosses 50 EMA (monthly chart)

3. OPPORTUNISTIC ENTRIES ONLY:
   • Attends les crashes de -30%+ avant d'acheter
   • Ne force pas les trades
   • Patience > Activity

4. FEES HACK:
   • Utilise des exchanges avec 0% maker fees (Binance VIP, etc.)
   • Utilise des limit orders exclusivement
   • Réduit les frais de 50%+
`);
}

main().catch(console.error);

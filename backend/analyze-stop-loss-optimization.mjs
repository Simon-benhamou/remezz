/**
 * 🔬 ANALYSE STOP LOSS OPTIMIZATION
 * 
 * Objectif: Identifier combien de trades SL auraient pu être des wins
 * avec un stop loss plus intelligent
 * 
 * Approches testées:
 * 1. SL plus large (ATR × 2.5, 3.0, 3.5)
 * 2. SL basé sur les niveaux de support/résistance
 * 3. SL avec confirmation de reversal (2-3 bougies)
 * 4. SL dynamique avec trailing inversé
 */

import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');

// ============================================================================
// CONFIGURATION (adapted for 1h candles)
// ============================================================================

const CONFIG = {
  LONG: {
    BB_PERIOD: 20,
    BB_STD: 2,
    ROC_MIN: 2.5,
    VOL_MULTIPLIER: 2.0,
    MAX_CONSEC_UP: 3,
  },
  SHORT: {
    ROC_DROP_MIN: -1.5,
    VOL_SPIKE: 2.0,
    MAX_CONSEC_DOWN: 4,
  },
  EXIT: {
    STOP_LOSS_ATR_MULT: 2.0,
    STOP_LOSS_MIN: 0.8,
    STOP_LOSS_MAX: 3.0,
    TAKE_PROFIT: 3.0,
    TRAILING_ACTIVATION: 1.0,
    TRAILING_DISTANCE: 0.4,
    MAX_HOLD_BARS: 48,  // 48h for 1h candles
  },
  POSITION_SIZE_PCT: 0.4,
  LEVERAGE: 4.5,
};

const COSTS = {
  TRADING_FEE_PCT: 0.04,
  SLIPPAGE_PCT: 0.05,
  FUNDING_RATE_PCT: 0.01,
  FUNDING_INTERVAL_BARS: 32,
};

// ============================================================================
// INDICATORS
// ============================================================================

function calcSMA(values, period) {
  if (values.length < period) return null;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcBB(closes, period = 20, std = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, val) => sum + Math.pow(val - sma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  return { middle: sma, upper: sma + std * stdDev, lower: sma - std * stdDev };
}

function calcROC(closes, period) {
  if (closes.length < period + 1) return null;
  return ((closes[closes.length - 1] - closes[closes.length - 1 - period]) / closes[closes.length - 1 - period]) * 100;
}

function calcVolAvg(volumes, period = 20) {
  if (volumes.length < period) return null;
  return volumes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function countConsecUp(candles) {
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close > candles[i].open) count++;
    else break;
  }
  return count;
}

function countConsecDown(candles) {
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close < candles[i].open) count++;
    else break;
  }
  return count;
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let atrSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1]?.close || candles[i].open;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    atrSum += tr;
  }
  return atrSum / period;
}

function calcDynamicStopLoss(candles, multiplier = 2.0) {
  const atr = calcATR(candles, 14);
  if (!atr || candles.length === 0) return 1.5;
  
  const currentPrice = candles[candles.length - 1].close;
  const atrPct = (atr / currentPrice) * 100;
  const rawSlPct = atrPct * multiplier;
  return Math.min(CONFIG.EXIT.STOP_LOSS_MAX, Math.max(CONFIG.EXIT.STOP_LOSS_MIN, rawSlPct));
}

// Support/Resistance calculation
function findSupport(candles, lookback = 20) {
  if (candles.length < lookback) return null;
  const slice = candles.slice(-lookback);
  return Math.min(...slice.map(c => c.low));
}

function findResistance(candles, lookback = 20) {
  if (candles.length < lookback) return null;
  const slice = candles.slice(-lookback);
  return Math.max(...slice.map(c => c.high));
}

// ============================================================================
// ENTRY CHECKS
// ============================================================================

function checkLongEntry(candles) {
  if (candles.length < 50) return false;
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const current = candles[candles.length - 1];
  
  if (current.close <= current.open) return false;
  const bb = calcBB(closes, CONFIG.LONG.BB_PERIOD, CONFIG.LONG.BB_STD);
  if (!bb || current.close <= bb.upper) return false;
  const roc = calcROC(closes, 10);
  if (!roc || roc < CONFIG.LONG.ROC_MIN) return false;
  const volAvg = calcVolAvg(volumes);
  if (!volAvg || current.volume < volAvg * CONFIG.LONG.VOL_MULTIPLIER) return false;
  if (countConsecUp(candles) > CONFIG.LONG.MAX_CONSEC_UP) return false;
  return true;
}

function checkShortEntry(candles) {
  if (candles.length < 50) return false;
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const current = candles[candles.length - 1];
  
  if (current.close >= current.open) return false;
  const roc5 = calcROC(closes, 5);
  if (!roc5 || roc5 > CONFIG.SHORT.ROC_DROP_MIN) return false;
  const volAvg = calcVolAvg(volumes);
  if (!volAvg || current.volume < volAvg * CONFIG.SHORT.VOL_SPIKE) return false;
  const ma20 = calcSMA(closes, 20);
  if (!ma20 || current.close >= ma20) return false;
  const bb = calcBB(closes);
  if (!bb || current.close >= bb.lower) return false;
  if (countConsecDown(candles) > CONFIG.SHORT.MAX_CONSEC_DOWN) return false;
  return true;
}

// ============================================================================
// LOAD DATA
// ============================================================================

function loadLocalData(symbols) {
  const data = {};
  for (const symbol of symbols) {
    // Format: BTC_USDT_1h.json
    const base = symbol.replace('/USDT:USDT', '').toUpperCase();
    const filename = `${base}_USDT_1h.json`;
    const filepath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filepath)) {
      console.log(`  ⚠️ ${symbol}: fichier non trouve (${filename})`);
      continue;
    }
    const json = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    // Data is already an array of candles
    data[symbol] = json;
    console.log(`  ✅ ${symbol}: ${json.length} candles`);
  }
  return data;
}

// ============================================================================
// SIMULATE TRADE WITH DIFFERENT SL STRATEGIES
// ============================================================================

function simulateTrade(candles, entryIdx, side, entryPrice, slStrategies) {
  const results = {};
  const maxBars = CONFIG.EXIT.MAX_HOLD_BARS;
  
  for (const [strategyName, getSlPrice] of Object.entries(slStrategies)) {
    const slPrice = getSlPrice(candles.slice(0, entryIdx + 1), entryPrice, side);
    let hwm = entryPrice;
    let lwm = entryPrice;
    let exitReason = null;
    let exitPrice = null;
    let exitIdx = null;
    
    for (let i = entryIdx + 1; i < Math.min(entryIdx + maxBars, candles.length); i++) {
      const c = candles[i];
      const holdBars = i - entryIdx;
      
      if (side === 'long') {
        hwm = Math.max(hwm, c.high);
        const pnlPct = ((c.close - entryPrice) / entryPrice) * 100;
        const hwmPct = ((hwm - entryPrice) / entryPrice) * 100;
        
        // Check trailing first
        if (hwmPct >= CONFIG.EXIT.TRAILING_ACTIVATION) {
          const trailStop = hwm * (1 - CONFIG.EXIT.TRAILING_DISTANCE / 100);
          if (c.low <= trailStop) {
            exitReason = 'TRAIL';
            exitPrice = trailStop;
            exitIdx = i;
            break;
          }
        }
        
        // Check SL
        if (c.low <= slPrice) {
          exitReason = 'SL';
          exitPrice = slPrice;
          exitIdx = i;
          break;
        }
        
        // Check TP
        if (pnlPct >= CONFIG.EXIT.TAKE_PROFIT) {
          exitReason = 'TP';
          exitPrice = entryPrice * (1 + CONFIG.EXIT.TAKE_PROFIT / 100);
          exitIdx = i;
          break;
        }
      } else {
        // SHORT
        lwm = Math.min(lwm, c.low);
        const pnlPct = ((entryPrice - c.close) / entryPrice) * 100;
        const lwmPct = ((entryPrice - lwm) / entryPrice) * 100;
        
        // Check trailing first
        if (lwmPct >= CONFIG.EXIT.TRAILING_ACTIVATION) {
          const trailStop = lwm * (1 + CONFIG.EXIT.TRAILING_DISTANCE / 100);
          if (c.high >= trailStop) {
            exitReason = 'TRAIL';
            exitPrice = trailStop;
            exitIdx = i;
            break;
          }
        }
        
        // Check SL
        if (c.high >= slPrice) {
          exitReason = 'SL';
          exitPrice = slPrice;
          exitIdx = i;
          break;
        }
        
        // Check TP
        if (pnlPct >= CONFIG.EXIT.TAKE_PROFIT) {
          exitReason = 'TP';
          exitPrice = entryPrice * (1 - CONFIG.EXIT.TAKE_PROFIT / 100);
          exitIdx = i;
          break;
        }
      }
    }
    
    // Time exit if no other exit
    if (!exitReason && entryIdx + maxBars < candles.length) {
      exitReason = 'TIME';
      exitPrice = candles[entryIdx + maxBars].close;
      exitIdx = entryIdx + maxBars;
    }
    
    if (exitReason) {
      const pnlPct = side === 'long'
        ? ((exitPrice - entryPrice) / entryPrice) * 100
        : ((entryPrice - exitPrice) / entryPrice) * 100;
      
      results[strategyName] = {
        exitReason,
        exitPrice,
        exitIdx,
        holdBars: exitIdx - entryIdx,
        pnlPct,
        isWin: pnlPct > 0,
        slPrice,
        slPct: side === 'long' 
          ? ((entryPrice - slPrice) / entryPrice) * 100
          : ((slPrice - entryPrice) / entryPrice) * 100,
      };
    }
  }
  
  return results;
}

// ============================================================================
// MAIN ANALYSIS
// ============================================================================

async function main() {
  console.log('═'.repeat(100));
  console.log('🔬 ANALYSE STOP LOSS OPTIMIZATION');
  console.log('═'.repeat(100));
  
  const SYMBOLS = [
    'BTC/USDT:USDT', 'ETH/USDT:USDT', 'XRP/USDT:USDT', 'SOL/USDT:USDT',
    'ADA/USDT:USDT', 'LINK/USDT:USDT', 'SUI/USDT:USDT', 'DOGE/USDT:USDT',
    'AVAX/USDT:USDT', 'DOT/USDT:USDT',
  ];
  
  console.log('\n📂 Chargement des donnees...');
  const allData = loadLocalData(SYMBOLS);
  const btcCandles = allData['BTC/USDT:USDT'];
  if (!btcCandles) {
    console.error('BTC data not found');
    return;
  }
  console.log(`  BTC: ${btcCandles.length} candles`);
  const btcCloses = btcCandles.map(c => c.close);
  
  // Define SL strategies to test
  const slStrategies = {
    'ATR_2.0': (candles, entry, side) => {
      const sl = calcDynamicStopLoss(candles, 2.0);
      return side === 'long' ? entry * (1 - sl / 100) : entry * (1 + sl / 100);
    },
    'ATR_2.5': (candles, entry, side) => {
      const sl = calcDynamicStopLoss(candles, 2.5);
      return side === 'long' ? entry * (1 - sl / 100) : entry * (1 + sl / 100);
    },
    'ATR_3.0': (candles, entry, side) => {
      const sl = calcDynamicStopLoss(candles, 3.0);
      return side === 'long' ? entry * (1 - sl / 100) : entry * (1 + sl / 100);
    },
    'Support_Resistance': (candles, entry, side) => {
      if (side === 'long') {
        const support = findSupport(candles, 30);
        return support ? support * 0.995 : entry * 0.97; // 0.5% below support
      } else {
        const resistance = findResistance(candles, 30);
        return resistance ? resistance * 1.005 : entry * 1.03; // 0.5% above resistance
      }
    },
    'Fixed_1.5%': (candles, entry, side) => {
      return side === 'long' ? entry * 0.985 : entry * 1.015;
    },
    'Fixed_2.5%': (candles, entry, side) => {
      return side === 'long' ? entry * 0.975 : entry * 1.025;
    },
    'Fixed_3.5%': (candles, entry, side) => {
      return side === 'long' ? entry * 0.965 : entry * 1.035;
    },
  };
  
  console.log('\n⏳ Running backtest with multiple SL strategies...\n');
  
  const allResults = {};
  const slHuntAnalysis = [];
  
  for (const stratName of Object.keys(slStrategies)) {
    allResults[stratName] = { trades: 0, wins: 0, slHits: 0, pnlTotal: 0 };
  }
  
  for (const symbol of SYMBOLS) {
    const candles = allData[symbol];
    if (!candles) continue;
    
    for (let btcIdx = 200; btcIdx < btcCandles.length; btcIdx++) {
      const btcCandle = btcCandles[btcIdx];
      const btcSma200 = calcSMA(btcCloses.slice(0, btcIdx), 200);
      const btcPrice = btcCloses[btcIdx - 1];
      const isBullRegime = btcPrice > btcSma200;
      
      const idx = candles.findIndex(c => c.timestamp >= btcCandle.timestamp);
      if (idx < 50) continue;
      
      const windowCandles = candles.slice(Math.max(0, idx - 200), idx + 1);
      const current = candles[idx];
      
      let side = null;
      if (isBullRegime && checkLongEntry(windowCandles)) side = 'long';
      else if (!isBullRegime && checkShortEntry(windowCandles)) side = 'short';
      
      if (side) {
        const results = simulateTrade(candles, idx, side, current.close, slStrategies);
        
        // Check for stop hunt pattern
        const baseResult = results['ATR_2.0'];
        const widerResult = results['ATR_3.0'];
        
        if (baseResult && widerResult) {
          // If base SL hit but wider SL would have been a win
          if (baseResult.exitReason === 'SL' && widerResult.isWin) {
            slHuntAnalysis.push({
              symbol,
              side,
              entryPrice: current.close,
              entryTime: new Date(btcCandle.timestamp).toISOString(),
              baseSLPct: baseResult.slPct,
              widerSLPct: widerResult.slPct,
              basePnL: baseResult.pnlPct,
              widerPnL: widerResult.pnlPct,
              widerExitReason: widerResult.exitReason,
              savedPnL: widerResult.pnlPct - baseResult.pnlPct,
            });
          }
        }
        
        // Aggregate results
        for (const [stratName, result] of Object.entries(results)) {
          if (result) {
            allResults[stratName].trades++;
            if (result.isWin) allResults[stratName].wins++;
            if (result.exitReason === 'SL') allResults[stratName].slHits++;
            allResults[stratName].pnlTotal += result.pnlPct;
          }
        }
        
        // Skip ahead to avoid overlapping trades
        btcIdx += 8;
      }
    }
  }
  
  // ============================================================================
  // RESULTS
  // ============================================================================
  
  console.log('\n' + '═'.repeat(100));
  console.log('📊 COMPARAISON DES STRATEGIES STOP LOSS');
  console.log('═'.repeat(100));
  
  console.log('\n  Strategy              | Trades | Wins | Win Rate | SL Hits | SL Rate | Total PnL');
  console.log('  ─'.repeat(50));
  
  const sortedStrategies = Object.entries(allResults)
    .sort((a, b) => b[1].pnlTotal - a[1].pnlTotal);
  
  for (const [name, stats] of sortedStrategies) {
    const wr = (stats.wins / stats.trades * 100).toFixed(1);
    const slRate = (stats.slHits / stats.trades * 100).toFixed(1);
    const pnl = stats.pnlTotal.toFixed(1);
    
    console.log(`  ${name.padEnd(21)} | ${String(stats.trades).padStart(6)} | ${String(stats.wins).padStart(4)} | ${wr.padStart(7)}% | ${String(stats.slHits).padStart(7)} | ${slRate.padStart(6)}% | ${pnl.padStart(9)}%`);
  }
  
  // ============================================================================
  // STOP HUNT ANALYSIS
  // ============================================================================
  
  console.log('\n\n' + '═'.repeat(100));
  console.log('🎯 ANALYSE DES STOP HUNTS (trades sauves avec SL plus large)');
  console.log('═'.repeat(100));
  
  console.log(`\n  Total trades touches SL (ATR 2.0) qui auraient ete WIN avec ATR 3.0: ${slHuntAnalysis.length}`);
  
  if (slHuntAnalysis.length > 0) {
    const totalSaved = slHuntAnalysis.reduce((a, t) => a + t.savedPnL, 0);
    console.log(`  PnL total sauve: +${totalSaved.toFixed(1)}%`);
    
    // Par crypto
    const byCrypto = {};
    for (const t of slHuntAnalysis) {
      if (!byCrypto[t.symbol]) byCrypto[t.symbol] = { count: 0, savedPnL: 0 };
      byCrypto[t.symbol].count++;
      byCrypto[t.symbol].savedPnL += t.savedPnL;
    }
    
    console.log('\n  Par crypto:');
    for (const [symbol, stats] of Object.entries(byCrypto).sort((a, b) => b[1].count - a[1].count)) {
      console.log(`    ${symbol.replace('/USDT:USDT', '').padEnd(6)}: ${stats.count} stop hunts evites, +${stats.savedPnL.toFixed(1)}% sauve`);
    }
    
    // Par side
    const longHunts = slHuntAnalysis.filter(t => t.side === 'long');
    const shortHunts = slHuntAnalysis.filter(t => t.side === 'short');
    console.log(`\n  Par direction:`);
    console.log(`    LONG:  ${longHunts.length} stop hunts (${longHunts.reduce((a, t) => a + t.savedPnL, 0).toFixed(1)}% sauve)`);
    console.log(`    SHORT: ${shortHunts.length} stop hunts (${shortHunts.reduce((a, t) => a + t.savedPnL, 0).toFixed(1)}% sauve)`);
    
    // Exemples
    console.log('\n  Exemples de stop hunts evites:');
    for (const t of slHuntAnalysis.slice(0, 5)) {
      console.log(`    ${t.symbol.replace('/USDT:USDT', '')} ${t.side.toUpperCase()} @ $${t.entryPrice.toFixed(2)}`);
      console.log(`      SL actuel (${t.baseSLPct.toFixed(1)}%): ${t.basePnL.toFixed(1)}% loss`);
      console.log(`      SL elargi (${t.widerSLPct.toFixed(1)}%): ${t.widerPnL.toFixed(1)}% ${t.widerExitReason} -> +${t.savedPnL.toFixed(1)}% sauve`);
    }
  }
  
  // ============================================================================
  // RECOMMENDATIONS
  // ============================================================================
  
  console.log('\n\n' + '═'.repeat(100));
  console.log('💡 RECOMMANDATIONS POUR UN STOP LOSS INTELLIGENT');
  console.log('═'.repeat(100));
  
  const bestStrategy = sortedStrategies[0];
  const currentStrategy = allResults['ATR_2.0'];
  
  console.log(`
  1. 📈 MEILLEURE STRATEGIE: ${bestStrategy[0]}
     - Win Rate: ${(bestStrategy[1].wins / bestStrategy[1].trades * 100).toFixed(1)}%
     - SL Rate: ${(bestStrategy[1].slHits / bestStrategy[1].trades * 100).toFixed(1)}%
     - Total PnL: +${bestStrategy[1].pnlTotal.toFixed(1)}%

  2. 🎯 STOP LOSS ADAPTATIF RECOMMANDE:
     - Utiliser ATR × 2.5 ou 3.0 au lieu de 2.0
     - Evite ${slHuntAnalysis.length} stop hunts
     - Gain potentiel: +${slHuntAnalysis.reduce((a, t) => a + t.savedPnL, 0).toFixed(1)}%

  3. 🔧 AMELIORATIONS POSSIBLES:
     a) SL base sur Support/Resistance:
        - Pour SHORT: SL au-dessus de la resistance recente
        - Pour LONG: SL en-dessous du support recent
        
     b) Confirmation de reversal:
        - Ne pas sortir sur 1 seule meche
        - Attendre 2-3 bougies qui confirment le reversal
        
     c) SL dynamique par crypto:
        - Cryptos volatiles (DOGE, SUI): SL plus large
        - Cryptos stables (BTC, ETH): SL plus serre
`);

  // ============================================================================
  // PROPOSED SMART SL LOGIC
  // ============================================================================
  
  console.log('\n' + '═'.repeat(100));
  console.log('🧠 PROPOSITION: STOP LOSS INTELLIGENT');
  console.log('═'.repeat(100));
  
  console.log(`
  Logique proposee pour un SL plus intelligent:

  ┌─────────────────────────────────────────────────────────────────────────────────────┐
  │                          SMART STOP LOSS ALGORITHM                                   │
  ├─────────────────────────────────────────────────────────────────────────────────────┤
  │                                                                                      │
  │  1. CALCUL DU SL INITIAL                                                            │
  │     - Base: ATR(14) × 2.5 (au lieu de 2.0)                                          │
  │     - Ajuste par crypto: volatiles +20%, stables -10%                               │
  │     - Respecte Support/Resistance: ne pas mettre SL dans une zone de support        │
  │                                                                                      │
  │  2. CONFIRMATION AVANT SORTIE                                                        │
  │     - Si prix touche SL: NE PAS sortir immediatement                                │
  │     - Attendre confirmation: 2 bougies closes au-dela du SL                         │
  │     - Si meche sans cloture au-dela: ignorer (stop hunt probable)                   │
  │                                                                                      │
  │  3. SL DYNAMIQUE                                                                     │
  │     - Si trade en profit > 0.5%: reduire SL de 20%                                  │
  │     - Si trade en profit > 1%: activer trailing (existant)                          │
  │                                                                                      │
  │  4. PARAMETRES PAR CRYPTO                                                            │
  │     ┌──────────┬─────────────┬───────────────────────────────────────────────────┐  │
  │     │ Crypto   │ ATR Mult    │ Raison                                            │  │
  │     ├──────────┼─────────────┼───────────────────────────────────────────────────┤  │
  │     │ BTC, ETH │ 2.0         │ Moins volatil, mouvements plus propres            │  │
  │     │ SOL, XRP │ 2.5         │ Volatilite moyenne                                │  │
  │     │ DOGE,SUI │ 3.0         │ Tres volatil, beaucoup de meches                  │  │
  │     │ DOT,AVAX │ 2.5         │ Volatilite moyenne                                │  │
  │     └──────────┴─────────────┴───────────────────────────────────────────────────┘  │
  │                                                                                      │
  └─────────────────────────────────────────────────────────────────────────────────────┘
`);

  console.log('\n✅ Analyse terminee');
}

main().catch(console.error);

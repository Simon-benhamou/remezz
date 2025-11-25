#!/usr/bin/env node
/**
 * 🔬 ANALYSE DES PATTERNS PRÉDICTIFS
 * 
 * Méthode: Identifier les GROS MOVES (+3% en 4h) et analyser 
 * ce qui s'est passé AVANT pour trouver les vrais prédicteurs
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binance({ enableRateLimit: true });
const SYMBOLS = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'];

async function fetchCandles(symbol, days = 120) {
  const limit = days * 96; // 15min candles
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  
  let allCandles = [];
  let fetchSince = since;
  
  while (allCandles.length < limit) {
    const candles = await exchange.fetchOHLCV(symbol, '15m', fetchSince, 1000);
    if (candles.length === 0) break;
    allCandles = allCandles.concat(candles);
    fetchSince = candles[candles.length - 1][0] + 1;
    if (candles.length < 1000) break;
  }
  
  return allCandles.slice(0, limit);
}

// Analyser ce qui s'est passé AVANT un move
function analyzeBeforeMove(candles, moveIndex) {
  if (moveIndex < 100) return null;
  
  // Données des 100 dernières bougies avant le move
  const lookback = candles.slice(moveIndex - 100, moveIndex + 1);
  const current = lookback[lookback.length - 1];
  
  const closes = lookback.map(c => c[4]);
  const highs = lookback.map(c => c[2]);
  const lows = lookback.map(c => c[3]);
  const volumes = lookback.map(c => c[5]);
  const opens = lookback.map(c => c[1]);
  
  // === INDICATEURS DE BASE ===
  
  // Volume
  const avgVol20 = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const avgVol50 = volumes.slice(-51, -1).reduce((a, b) => a + b, 0) / 50;
  const volRatio = volumes[volumes.length - 1] / avgVol20;
  const volTrend = avgVol20 / avgVol50; // Volume croissant?
  
  // Prix / MAs
  const ma5 = closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const ma10 = closes.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const ma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
  
  const close = closes[closes.length - 1];
  const priceAboveMa5 = close > ma5;
  const priceAboveMa20 = close > ma20;
  const priceAboveMa50 = close > ma50;
  const ma5AboveMa20 = ma5 > ma20;
  const ma20AboveMa50 = ma20 > ma50;
  
  // Distance au MA20 (%)
  const distanceToMa20 = (close - ma20) / ma20 * 100;
  
  // RSI
  let gains = 0, losses = 0;
  for (let j = closes.length - 14; j < closes.length; j++) {
    const change = closes[j] - closes[j - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  const rsi = 100 - (100 / (1 + gains / (losses || 0.0001)));
  
  // ATR (Average True Range)
  let atrSum = 0;
  for (let j = lookback.length - 14; j < lookback.length; j++) {
    const tr = Math.max(
      highs[j] - lows[j],
      Math.abs(highs[j] - closes[j - 1]),
      Math.abs(lows[j] - closes[j - 1])
    );
    atrSum += tr;
  }
  const atr = atrSum / 14;
  const atrPct = atr / close * 100;
  
  // Volatilité récente vs historique
  const recentVol = closes.slice(-10).map((c, i, arr) => i > 0 ? Math.abs(c - arr[i-1]) / arr[i-1] * 100 : 0).slice(1).reduce((a, b) => a + b, 0) / 9;
  const historicVol = closes.slice(-50, -10).map((c, i, arr) => i > 0 ? Math.abs(c - arr[i-1]) / arr[i-1] * 100 : 0).slice(1).reduce((a, b) => a + b, 0) / 39;
  const volExpansion = recentVol / (historicVol || 0.01);
  
  // Bollinger Bands
  const std20 = Math.sqrt(closes.slice(-20).map(c => Math.pow(c - ma20, 2)).reduce((a, b) => a + b, 0) / 20);
  const bbUpper = ma20 + 2 * std20;
  const bbLower = ma20 - 2 * std20;
  const bbWidth = (bbUpper - bbLower) / ma20 * 100;
  const bbPosition = (close - bbLower) / (bbUpper - bbLower); // 0-1
  
  // Candle patterns
  const open = opens[opens.length - 1];
  const high = highs[highs.length - 1];
  const low = lows[lows.length - 1];
  const body = close - open;
  const bodyPct = Math.abs(body) / close * 100;
  const upperWick = high - Math.max(open, close);
  const lowerWick = Math.min(open, close) - low;
  const wickRatio = (upperWick + lowerWick) / (Math.abs(body) || 0.0001);
  
  // Momentum
  const momentum1h = (close - closes[closes.length - 5]) / closes[closes.length - 5] * 100;
  const momentum4h = (close - closes[closes.length - 17]) / closes[closes.length - 17] * 100;
  const momentum1d = (close - closes[closes.length - 97]) / closes[closes.length - 97] * 100;
  
  // Consecutive candles
  let consecutiveUp = 0, consecutiveDown = 0;
  for (let j = lookback.length - 2; j >= 0; j--) {
    if (closes[j + 1] > closes[j]) {
      if (consecutiveDown > 0) break;
      consecutiveUp++;
    } else {
      if (consecutiveUp > 0) break;
      consecutiveDown++;
    }
  }
  
  // Breakout levels
  const highest20 = Math.max(...highs.slice(-21, -1));
  const lowest20 = Math.min(...lows.slice(-21, -1));
  const highest50 = Math.max(...highs.slice(-51, -1));
  const lowest50 = Math.min(...lows.slice(-51, -1));
  
  const nearResistance20 = close >= highest20 * 0.995;
  const nearSupport20 = close <= lowest20 * 1.005;
  const breakoutUp20 = close > highest20;
  const breakoutUp50 = close > highest50;
  
  // Volume patterns
  const volIncreasing = volumes[volumes.length - 1] > volumes[volumes.length - 2] && 
                        volumes[volumes.length - 2] > volumes[volumes.length - 3];
  const volSpike = volRatio > 2;
  const volExtremeSpike = volRatio > 4;
  
  // Price compression (squeeze)
  const rangeRecent = Math.max(...highs.slice(-10)) - Math.min(...lows.slice(-10));
  const rangeHistoric = Math.max(...highs.slice(-50)) - Math.min(...lows.slice(-50));
  const compression = rangeRecent / rangeHistoric;
  const isSqueezing = compression < 0.3;
  
  // Higher lows / Higher highs pattern
  const recentLows = [];
  const recentHighs = [];
  for (let j = 0; j < 5; j++) {
    recentLows.push(Math.min(...lows.slice(-20 - j * 4, -16 - j * 4)));
    recentHighs.push(Math.max(...highs.slice(-20 - j * 4, -16 - j * 4)));
  }
  const higherLows = recentLows.every((l, i, arr) => i === 0 || l >= arr[i - 1] * 0.99);
  const higherHighs = recentHighs.every((h, i, arr) => i === 0 || h >= arr[i - 1] * 0.99);
  
  return {
    // Volume
    volRatio: Math.round(volRatio * 10) / 10,
    volTrend: Math.round(volTrend * 10) / 10,
    volSpike,
    volExtremeSpike,
    volIncreasing,
    
    // Trend
    priceAboveMa5,
    priceAboveMa20,
    priceAboveMa50,
    ma5AboveMa20,
    ma20AboveMa50,
    allMaAligned: priceAboveMa5 && ma5AboveMa20 && ma20AboveMa50,
    distanceToMa20: Math.round(distanceToMa20 * 10) / 10,
    
    // Oscillateurs
    rsi: Math.round(rsi),
    rsiOversold: rsi < 30,
    rsiNeutral: rsi >= 40 && rsi <= 60,
    rsiOverbought: rsi > 70,
    
    // Volatilité
    atrPct: Math.round(atrPct * 100) / 100,
    bbWidth: Math.round(bbWidth * 10) / 10,
    bbPosition: Math.round(bbPosition * 100) / 100,
    volExpansion: Math.round(volExpansion * 10) / 10,
    isSqueezing,
    compression: Math.round(compression * 100) / 100,
    
    // Candle
    bodyPct: Math.round(bodyPct * 100) / 100,
    wickRatio: Math.round(wickRatio * 10) / 10,
    isBullishCandle: close > open,
    
    // Momentum
    momentum1h: Math.round(momentum1h * 100) / 100,
    momentum4h: Math.round(momentum4h * 100) / 100,
    momentum1d: Math.round(momentum1d * 100) / 100,
    consecutiveUp,
    consecutiveDown,
    
    // Breakout
    nearResistance20,
    nearSupport20,
    breakoutUp20,
    breakoutUp50,
    
    // Structure
    higherLows,
    higherHighs,
    bullishStructure: higherLows && higherHighs,
  };
}

// Trouver les gros moves
function findBigMoves(candles, minMove = 3, lookForward = 16) {
  const moves = [];
  
  for (let i = 100; i < candles.length - lookForward; i++) {
    const entryPrice = candles[i][4];
    
    // Chercher le max move dans les prochaines 4h (16 x 15min)
    let maxUp = 0, maxDown = 0;
    for (let j = 1; j <= lookForward; j++) {
      const high = candles[i + j][2];
      const low = candles[i + j][3];
      const upMove = (high - entryPrice) / entryPrice * 100;
      const downMove = (entryPrice - low) / entryPrice * 100;
      maxUp = Math.max(maxUp, upMove);
      maxDown = Math.max(maxDown, downMove);
    }
    
    if (maxUp >= minMove) {
      moves.push({
        index: i,
        direction: 'UP',
        magnitude: maxUp,
        timestamp: candles[i][0],
      });
    } else if (maxDown >= minMove) {
      moves.push({
        index: i,
        direction: 'DOWN',
        magnitude: maxDown,
        timestamp: candles[i][0],
      });
    }
  }
  
  return moves;
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🔬 ANALYSE DES PATTERNS PRÉDICTIFS - Qu\'est-ce qui précède un GROS MOVE?');
  console.log('═'.repeat(80));
  
  // Fetch data
  const allCandles = {};
  for (const symbol of SYMBOLS) {
    console.log(`\n📥 Fetching ${symbol}...`);
    allCandles[symbol] = await fetchCandles(symbol, 120);
    console.log(`   ✅ ${allCandles[symbol].length} candles`);
  }
  
  // Trouver tous les gros moves
  const bigMoves = [];
  const normalMoves = [];
  
  for (const symbol of SYMBOLS) {
    const candles = allCandles[symbol];
    const moves = findBigMoves(candles, 3, 16); // +3% dans les 4h
    
    console.log(`\n📊 ${symbol}: ${moves.length} gros moves (+3% en 4h)`);
    
    for (const move of moves) {
      const features = analyzeBeforeMove(candles, move.index);
      if (features) {
        bigMoves.push({ symbol, ...move, features });
      }
    }
    
    // Échantillon de moments "normaux" (pas de gros move)
    const moveIndices = new Set(moves.map(m => m.index));
    for (let i = 100; i < candles.length - 100; i += 20) {
      if (!moveIndices.has(i)) {
        const features = analyzeBeforeMove(candles, i);
        if (features) {
          normalMoves.push({ symbol, index: i, features });
        }
      }
    }
  }
  
  console.log(`\n📈 Total: ${bigMoves.length} gros moves à analyser`);
  console.log(`📉 Référence: ${normalMoves.length} moments normaux`);
  
  // Comparer les caractéristiques
  console.log('\n' + '═'.repeat(80));
  console.log('🔍 COMPARAISON: Avant gros move UP vs Moments normaux');
  console.log('═'.repeat(80));
  
  const upMoves = bigMoves.filter(m => m.direction === 'UP');
  
  // Calculer les moyennes pour chaque feature
  const features = Object.keys(upMoves[0]?.features || {});
  const comparison = {};
  
  for (const feature of features) {
    const upValues = upMoves.map(m => m.features[feature]).filter(v => typeof v === 'number');
    const normalValues = normalMoves.map(m => m.features[feature]).filter(v => typeof v === 'number');
    const upBoolTrue = upMoves.filter(m => m.features[feature] === true).length / upMoves.length * 100;
    const normalBoolTrue = normalMoves.filter(m => m.features[feature] === true).length / normalMoves.length * 100;
    
    if (upValues.length > 0) {
      const upAvg = upValues.reduce((a, b) => a + b, 0) / upValues.length;
      const normalAvg = normalValues.reduce((a, b) => a + b, 0) / normalValues.length;
      const diff = upAvg - normalAvg;
      const diffPct = normalAvg !== 0 ? (diff / Math.abs(normalAvg)) * 100 : 0;
      
      comparison[feature] = {
        type: 'number',
        upAvg: Math.round(upAvg * 100) / 100,
        normalAvg: Math.round(normalAvg * 100) / 100,
        diff: Math.round(diff * 100) / 100,
        diffPct: Math.round(diffPct),
        significant: Math.abs(diffPct) > 20,
      };
    } else {
      comparison[feature] = {
        type: 'boolean',
        upTrue: Math.round(upBoolTrue),
        normalTrue: Math.round(normalBoolTrue),
        diff: Math.round(upBoolTrue - normalBoolTrue),
        significant: Math.abs(upBoolTrue - normalBoolTrue) > 10,
      };
    }
  }
  
  // Afficher les différences significatives
  console.log('\n🎯 FEATURES DIFFÉRENCIATRICES (>20% de différence):');
  console.log('─'.repeat(80));
  
  const significant = Object.entries(comparison)
    .filter(([_, v]) => v.significant)
    .sort((a, b) => Math.abs(b[1].diff) - Math.abs(a[1].diff));
  
  console.log('\n┌────────────────────────┬────────────────┬────────────────┬────────────────┐');
  console.log('│        Feature         │  Avant Move UP │    Normal      │   Différence   │');
  console.log('├────────────────────────┼────────────────┼────────────────┼────────────────┤');
  
  for (const [feature, data] of significant.slice(0, 20)) {
    const name = feature.padEnd(22).slice(0, 22);
    if (data.type === 'number') {
      const up = String(data.upAvg).padStart(12);
      const normal = String(data.normalAvg).padStart(12);
      const diff = (data.diffPct >= 0 ? '+' : '') + data.diffPct + '%';
      console.log(`│ ${name} │ ${up}   │ ${normal}   │ ${diff.padStart(12)}   │`);
    } else {
      const up = (data.upTrue + '%').padStart(12);
      const normal = (data.normalTrue + '%').padStart(12);
      const diff = (data.diff >= 0 ? '+' : '') + data.diff + '%';
      console.log(`│ ${name} │ ${up}   │ ${normal}   │ ${diff.padStart(12)}   │`);
    }
  }
  
  console.log('└────────────────────────┴────────────────┴────────────────┴────────────────┘');
  
  // Créer des règles de prédiction
  console.log('\n' + '═'.repeat(80));
  console.log('🧪 TEST DE COMBINAISONS PRÉDICTIVES');
  console.log('═'.repeat(80));
  
  // Définir des règles basées sur les features significatives
  const rules = [
    {
      name: 'Vol Spike + MA Aligned',
      test: (f) => f.volSpike && f.allMaAligned,
    },
    {
      name: 'Vol Spike + Bullish Structure',
      test: (f) => f.volSpike && f.bullishStructure,
    },
    {
      name: 'Squeeze + Vol Spike',
      test: (f) => f.isSqueezing && f.volSpike,
    },
    {
      name: 'Momentum + Vol + MA',
      test: (f) => f.momentum1h > 0.5 && f.volRatio > 1.5 && f.priceAboveMa20,
    },
    {
      name: 'RSI Neutral + Vol Spike + Breakout',
      test: (f) => f.rsiNeutral && f.volSpike && f.breakoutUp20,
    },
    {
      name: 'Higher Lows + Vol Increasing',
      test: (f) => f.higherLows && f.volIncreasing,
    },
    {
      name: 'Compression + Vol Extreme',
      test: (f) => f.compression < 0.4 && f.volExtremeSpike,
    },
    {
      name: 'BB Lower + Vol Spike + Bullish',
      test: (f) => f.bbPosition < 0.3 && f.volSpike && f.isBullishCandle,
    },
    {
      name: 'Consecutive Up + Vol + MA',
      test: (f) => f.consecutiveUp >= 3 && f.volRatio > 1.5 && f.priceAboveMa20,
    },
    {
      name: 'All Aligned (Strong)',
      test: (f) => f.allMaAligned && f.volSpike && f.momentum1h > 0 && f.bullishStructure,
    },
    {
      name: 'Breakout50 + Vol',
      test: (f) => f.breakoutUp50 && f.volRatio > 2,
    },
    {
      name: 'Near Resistance + Vol Extreme',
      test: (f) => f.nearResistance20 && f.volExtremeSpike,
    },
  ];
  
  console.log('\n┌────────────────────────────────────┬──────────┬──────────┬─────────────┬──────────┐');
  console.log('│              Règle                 │ Hit Move │ Hit Norm │  Precision  │  Lift    │');
  console.log('├────────────────────────────────────┼──────────┼──────────┼─────────────┼──────────┤');
  
  const ruleResults = [];
  
  for (const rule of rules) {
    const hitsMove = upMoves.filter(m => rule.test(m.features)).length;
    const hitsNormal = normalMoves.filter(m => rule.test(m.features)).length;
    const precision = hitsMove / (hitsMove + hitsNormal) * 100 || 0;
    const baseRate = upMoves.length / (upMoves.length + normalMoves.length) * 100;
    const lift = precision / baseRate;
    
    ruleResults.push({
      name: rule.name,
      hitsMove,
      hitsNormal,
      precision,
      lift,
      recall: hitsMove / upMoves.length * 100,
    });
    
    const name = rule.name.padEnd(34).slice(0, 34);
    const hitM = String(hitsMove).padStart(6);
    const hitN = String(hitsNormal).padStart(6);
    const prec = (precision.toFixed(1) + '%').padStart(10);
    const liftStr = lift.toFixed(2) + 'x';
    const status = precision > 60 ? '✅' : (precision > 40 ? '⚠️' : '❌');
    
    console.log(`│ ${name} │ ${hitM}   │ ${hitN}   │ ${prec}  │ ${liftStr.padStart(6)}   │ ${status}`);
  }
  
  console.log('└────────────────────────────────────┴──────────┴──────────┴─────────────┴──────────┘');
  
  // Top règles
  ruleResults.sort((a, b) => b.precision - a.precision);
  
  console.log('\n' + '═'.repeat(80));
  console.log('🏆 MEILLEURES RÈGLES PRÉDICTIVES');
  console.log('═'.repeat(80));
  
  for (const r of ruleResults.slice(0, 5)) {
    if (r.precision > 40) {
      console.log(`\n✅ ${r.name}`);
      console.log(`   Precision: ${r.precision.toFixed(1)}% (${r.hitsMove} gros moves / ${r.hitsMove + r.hitsNormal} signaux)`);
      console.log(`   Recall: ${r.recall.toFixed(1)}% des gros moves capturés`);
      console.log(`   Lift: ${r.lift.toFixed(2)}x meilleur que le hasard`);
    }
  }
  
  // Maintenant tester ces règles comme stratégie de trading
  console.log('\n' + '═'.repeat(80));
  console.log('💰 BACKTEST DES MEILLEURES RÈGLES (avec frais)');
  console.log('═'.repeat(80));
  
  const CAPITAL = 10000;
  const RISK = 0.01;
  const FEES = 0.0006;
  
  // Prendre les 3 meilleures règles
  const topRules = ruleResults.filter(r => r.precision > 40).slice(0, 5);
  
  for (const ruleResult of topRules) {
    const rule = rules.find(r => r.name === ruleResult.name);
    if (!rule) continue;
    
    console.log(`\n📊 Test: ${rule.name}`);
    
    const trades = [];
    const monthlyPnL = {};
    
    for (const symbol of SYMBOLS) {
      const candles = allCandles[symbol];
      
      for (let i = 100; i < candles.length - 20; i++) {
        const features = analyzeBeforeMove(candles, i);
        if (!features || !rule.test(features)) continue;
        
        // Simuler trade avec R:R 3:1
        const entry = candles[i][4];
        const tp = entry * 1.03; // TP 3%
        const sl = entry * 0.99; // SL 1%
        
        let result = null;
        for (let j = 1; j <= 20; j++) {
          const high = candles[i + j][2];
          const low = candles[i + j][3];
          
          if (low <= sl) {
            result = { win: false, pnl: -1 };
            break;
          }
          if (high >= tp) {
            result = { win: true, pnl: 3 };
            break;
          }
        }
        
        if (!result) {
          const exitPrice = candles[i + 20][4];
          result = { win: exitPrice > entry, pnl: (exitPrice - entry) / entry * 100 };
        }
        
        const date = new Date(candles[i][0]);
        const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        
        const posSize = CAPITAL * RISK / 0.01;
        const fees = posSize * FEES;
        const netPnl = posSize * (result.pnl / 100) - fees;
        
        trades.push({ month, ...result, netPnl });
        
        if (!monthlyPnL[month]) monthlyPnL[month] = 0;
        monthlyPnL[month] += netPnl;
        
        i += 4; // Skip
      }
    }
    
    if (trades.length === 0) {
      console.log('   ❌ Aucun trade');
      continue;
    }
    
    const wins = trades.filter(t => t.win).length;
    const totalPnL = trades.reduce((sum, t) => sum + t.netPnl, 0);
    const months = Object.keys(monthlyPnL).sort();
    const positiveMonths = months.filter(m => monthlyPnL[m] > 0).length;
    
    console.log(`   Trades: ${trades.length} | WR: ${(wins/trades.length*100).toFixed(1)}%`);
    console.log(`   P&L: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(0)} | Mois positifs: ${positiveMonths}/${months.length}`);
    
    if (positiveMonths >= months.length * 0.7) {
      console.log('   🎯 PROMETEUR!');
    }
  }
}

main().catch(console.error);

/**
 * ADAPTIVE FILTER PER ASSET
 * Test si des filtres différents par asset améliorent les résultats
 */

import { readFileSync } from 'fs';

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP'];
const LEVERAGE = { BTC: 3, ETH: 5, SOL: 5, XRP: 4 };
const FEES = 0.0004; // 0.04% per trade

function loadData(symbol) {
    const raw = readFileSync(`./data/${symbol}_USDT_1h.json`, 'utf-8');
    return JSON.parse(raw);
}

function calculateIndicators(candles) {
    const result = [];
    
    for (let i = 50; i < candles.length; i++) {
        const slice = candles.slice(0, i + 1);
        const closes = slice.map(c => c.close);
        const highs = slice.map(c => c.high);
        const lows = slice.map(c => c.low);
        const volumes = slice.map(c => c.volume);
        
        // EMAs
        const ema20 = calcEMA(closes, 20);
        const ema50 = calcEMA(closes, 50);
        
        // ATR
        const atr = calcATR(highs, lows, closes, 14);
        const atrPercent = atr / closes[closes.length - 1];
        
        // RSI
        const rsi = calcRSI(closes, 14);
        
        // ROC
        const roc5 = (closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6];
        const roc10 = (closes[closes.length - 1] - closes[closes.length - 11]) / closes[closes.length - 11];
        
        // Volume
        const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const volRatio = volumes[volumes.length - 1] / avgVol;
        
        // Momentum
        const momentum = closes.slice(-5).every((v, i, arr) => i === 0 || v >= arr[i-1]);
        
        // Consecutive up candles
        let consecutiveUp = 0;
        for (let j = closes.length - 1; j > 0; j--) {
            if (closes[j] > closes[j-1]) consecutiveUp++;
            else break;
        }
        
        result.push({
            ...candles[i],
            ema20,
            ema50,
            atr,
            atrPercent,
            rsi,
            roc5,
            roc10,
            volRatio,
            momentum,
            consecutiveUp
        });
    }
    
    return result;
}

function calcEMA(data, period) {
    const k = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < data.length; i++) {
        ema = data[i] * k + ema * (1 - k);
    }
    return ema;
}

function calcATR(highs, lows, closes, period) {
    const trs = [];
    for (let i = 1; i < highs.length; i++) {
        const tr = Math.max(
            highs[i] - lows[i],
            Math.abs(highs[i] - closes[i-1]),
            Math.abs(lows[i] - closes[i-1])
        );
        trs.push(tr);
    }
    return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcRSI(closes, period) {
    const changes = [];
    for (let i = 1; i < closes.length; i++) {
        changes.push(closes[i] - closes[i-1]);
    }
    const gains = changes.slice(-period).filter(c => c > 0);
    const losses = changes.slice(-period).filter(c => c < 0).map(c => Math.abs(c));
    const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / period : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / period : 0.001;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

// Strategy V3 avec filtres configurables
function runStrategy(data, symbol, filters = {}) {
    const leverage = LEVERAGE[symbol];
    let position = null;
    const trades = [];
    
    for (let i = 1; i < data.length; i++) {
        const curr = data[i];
        const prev = data[i - 1];
        
        // Exit logic
        if (position) {
            const holdTime = i - position.entryIndex;
            const pnlPercent = (curr.close - position.entryPrice) / position.entryPrice;
            const pnlWithLeverage = pnlPercent * leverage;
            
            // Calculate momentum
            const momentumFading = curr.close < prev.close && prev.rsi > 65;
            const volumeDrying = curr.volRatio < 1.0 && pnlPercent > 0.01;
            
            let exitReason = null;
            
            // Stop loss -2%
            if (pnlPercent <= -0.02) {
                exitReason = 'stop_loss';
            }
            // Momentum fade exit
            else if (momentumFading && pnlPercent > 0.015 && holdTime >= 2) {
                exitReason = 'momentum_fade';
            }
            // Volume dry up exit
            else if (volumeDrying && holdTime >= 3) {
                exitReason = 'volume_dry_up';
            }
            // Time exit after 6 hours
            else if (holdTime >= 6 && pnlPercent > 0.01) {
                exitReason = 'time_exit';
            }
            // Profit lock at 4%
            else if (pnlPercent >= 0.04) {
                exitReason = 'profit_lock';
            }
            // Max hold 24h
            else if (holdTime >= 24) {
                exitReason = 'max_hold';
            }
            
            if (exitReason) {
                const fees = FEES * 2;
                const netPnl = pnlWithLeverage - fees;
                
                trades.push({
                    symbol,
                    entryPrice: position.entryPrice,
                    exitPrice: curr.close,
                    pnlPercent,
                    pnlWithLeverage,
                    netPnl,
                    exitReason,
                    holdTime,
                    entryRsi: position.entryRsi,
                    entryAtr: position.entryAtr,
                    entryConsecUp: position.entryConsecUp,
                    entryVolRatio: position.entryVolRatio,
                    entryRoc5: position.entryRoc5
                });
                
                position = null;
            }
        }
        
        // Entry logic with filters
        if (!position) {
            const breakoutCondition = curr.close > prev.ema20 && prev.close <= prev.ema20;
            const momentumConfirm = curr.rsi > 55 && curr.close > prev.close;
            
            if (breakoutCondition && momentumConfirm) {
                // Apply filters
                let passFilters = true;
                
                if (filters.maxRsi && curr.rsi > filters.maxRsi) passFilters = false;
                if (filters.maxAtrPercent && curr.atrPercent > filters.maxAtrPercent) passFilters = false;
                if (filters.maxConsecUp && curr.consecutiveUp > filters.maxConsecUp) passFilters = false;
                if (filters.minVolRatio && curr.volRatio < filters.minVolRatio) passFilters = false;
                if (filters.maxRoc5 && curr.roc5 > filters.maxRoc5) passFilters = false;
                
                if (passFilters) {
                    position = {
                        entryPrice: curr.close,
                        entryIndex: i,
                        entryRsi: curr.rsi,
                        entryAtr: curr.atrPercent,
                        entryConsecUp: curr.consecutiveUp,
                        entryVolRatio: curr.volRatio,
                        entryRoc5: curr.roc5
                    };
                }
            }
        }
    }
    
    return trades;
}

// Test tous les filtres possibles pour un asset
function findBestFilters(data, symbol) {
    const filterOptions = {
        maxRsi: [null, 75, 72, 70, 68, 65],
        maxAtrPercent: [null, 0.03, 0.025, 0.02, 0.015],
        maxConsecUp: [null, 6, 5, 4, 3],
        minVolRatio: [null, 1.0, 1.5, 2.0],
        maxRoc5: [null, 0.06, 0.05, 0.04, 0.03]
    };
    
    let bestConfig = null;
    let bestPnl = -Infinity;
    let bestStats = null;
    
    // Test toutes les combinaisons
    for (const maxRsi of filterOptions.maxRsi) {
        for (const maxAtrPercent of filterOptions.maxAtrPercent) {
            for (const maxConsecUp of filterOptions.maxConsecUp) {
                for (const minVolRatio of filterOptions.minVolRatio) {
                    for (const maxRoc5 of filterOptions.maxRoc5) {
                        const filters = { maxRsi, maxAtrPercent, maxConsecUp, minVolRatio, maxRoc5 };
                        const trades = runStrategy(data, symbol, filters);
                        
                        if (trades.length < 10) continue; // Minimum trades
                        
                        const totalPnl = trades.reduce((sum, t) => sum + t.netPnl, 0) * 100;
                        const winRate = trades.filter(t => t.netPnl > 0).length / trades.length;
                        const stopLosses = trades.filter(t => t.exitReason === 'stop_loss').length;
                        
                        // Score = PnL avec bonus pour moins de stop losses
                        const score = totalPnl - (stopLosses * 5);
                        
                        if (score > bestPnl) {
                            bestPnl = score;
                            bestConfig = filters;
                            bestStats = {
                                trades: trades.length,
                                winRate,
                                totalPnl,
                                stopLosses,
                                avgPnl: totalPnl / trades.length
                            };
                        }
                    }
                }
            }
        }
    }
    
    return { config: bestConfig, stats: bestStats };
}

// Main
console.log('═'.repeat(80));
console.log('🎯 ADAPTIVE FILTER PER ASSET');
console.log('═'.repeat(80));

const baselineResults = {};
const optimizedResults = {};
const bestFilters = {};

// Test baseline et trouve meilleur filtre par asset
for (const symbol of SYMBOLS) {
    console.log(`\n📊 Processing ${symbol}...`);
    const rawData = loadData(symbol);
    const data = calculateIndicators(rawData);
    
    // Baseline sans filtre
    const baselineTrades = runStrategy(data, symbol, {});
    baselineResults[symbol] = {
        trades: baselineTrades.length,
        winRate: baselineTrades.filter(t => t.netPnl > 0).length / baselineTrades.length,
        totalPnl: baselineTrades.reduce((sum, t) => sum + t.netPnl, 0) * 100,
        stopLosses: baselineTrades.filter(t => t.exitReason === 'stop_loss').length
    };
    
    // Trouve meilleurs filtres
    const best = findBestFilters(data, symbol);
    bestFilters[symbol] = best.config;
    optimizedResults[symbol] = best.stats;
}

// Affichage résultats
console.log('\n' + '═'.repeat(80));
console.log('📊 BASELINE vs OPTIMIZED PER ASSET');
console.log('═'.repeat(80));

console.log('\n┌────────┬──────────────────────────────┬──────────────────────────────┐');
console.log('│ Asset  │ BASELINE                     │ OPTIMIZED                    │');
console.log('├────────┼──────────────────────────────┼──────────────────────────────┤');

let totalBasePnl = 0;
let totalOptPnl = 0;

for (const symbol of SYMBOLS) {
    const base = baselineResults[symbol];
    const opt = optimizedResults[symbol];
    
    totalBasePnl += base.totalPnl;
    totalOptPnl += opt.totalPnl;
    
    const baseSummary = `${base.trades}t ${(base.winRate*100).toFixed(0)}%WR ${base.totalPnl.toFixed(0)}% ${base.stopLosses}SL`;
    const optSummary = `${opt.trades}t ${(opt.winRate*100).toFixed(0)}%WR ${opt.totalPnl.toFixed(0)}% ${opt.stopLosses}SL`;
    
    console.log(`│ ${symbol.padEnd(6)} │ ${baseSummary.padEnd(28)} │ ${optSummary.padEnd(28)} │`);
}

console.log('├────────┼──────────────────────────────┼──────────────────────────────┤');
console.log(`│ TOTAL  │ ${totalBasePnl.toFixed(0).padStart(26)}% │ ${totalOptPnl.toFixed(0).padStart(26)}% │`);
console.log('└────────┴──────────────────────────────┴──────────────────────────────┘');

console.log('\n' + '═'.repeat(80));
console.log('🎯 BEST FILTERS PER ASSET');
console.log('═'.repeat(80));

for (const symbol of SYMBOLS) {
    const filters = bestFilters[symbol];
    const activeFilters = Object.entries(filters)
        .filter(([k, v]) => v !== null)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
    
    console.log(`\n${symbol}: ${activeFilters || 'No filters'}`);
    console.log(`   Improvement: ${baselineResults[symbol].totalPnl.toFixed(0)}% → ${optimizedResults[symbol].totalPnl.toFixed(0)}%`);
}

// Test global avec filtres adaptatifs
console.log('\n' + '═'.repeat(80));
console.log('🔬 TESTING ALTERNATIVE APPROACHES');
console.log('═'.repeat(80));

// Approche 1: Seulement ETH + XRP (les meilleurs assets)
console.log('\n📈 APPROACH 1: ETH + XRP only (no filters)');
const ethXrpPnl = baselineResults['ETH'].totalPnl + baselineResults['XRP'].totalPnl;
const ethXrpTrades = baselineResults['ETH'].trades + baselineResults['XRP'].trades;
console.log(`   Trades: ${ethXrpTrades}, PnL: ${ethXrpPnl.toFixed(0)}%`);

// Approche 2: ETH + XRP avec filtres optimisés
console.log('\n📈 APPROACH 2: ETH + XRP with optimized filters');
const ethXrpOptPnl = optimizedResults['ETH'].totalPnl + optimizedResults['XRP'].totalPnl;
const ethXrpOptTrades = optimizedResults['ETH'].trades + optimizedResults['XRP'].trades;
console.log(`   Trades: ${ethXrpOptTrades}, PnL: ${ethXrpOptPnl.toFixed(0)}%`);

// Approche 3: Tous les assets avec filtres sélectifs
console.log('\n📈 APPROACH 3: All assets, but skip SOL (worst)');
const noSolPnl = baselineResults['BTC'].totalPnl + baselineResults['ETH'].totalPnl + baselineResults['XRP'].totalPnl;
const noSolTrades = baselineResults['BTC'].trades + baselineResults['ETH'].trades + baselineResults['XRP'].trades;
console.log(`   Trades: ${noSolTrades}, PnL: ${noSolPnl.toFixed(0)}%`);

// Approche 4: Test retirer complètement SOL et BTC, garder seulement ETH et XRP avec optimisation
console.log('\n' + '═'.repeat(80));
console.log('🏆 FINAL RECOMMENDATION');
console.log('═'.repeat(80));

const recommendations = [
    { name: 'All 4 assets, no filters', pnl: totalBasePnl },
    { name: 'All 4 assets, adaptive filters', pnl: totalOptPnl },
    { name: 'ETH + XRP only, no filters', pnl: ethXrpPnl },
    { name: 'ETH + XRP only, adaptive filters', pnl: ethXrpOptPnl },
    { name: 'BTC + ETH + XRP (no SOL), no filters', pnl: noSolPnl }
];

recommendations.sort((a, b) => b.pnl - a.pnl);

console.log('\nRanking by PnL:');
recommendations.forEach((r, i) => {
    console.log(`   ${i + 1}. ${r.name}: ${r.pnl.toFixed(0)}%`);
});

// Insight final
console.log('\n' + '═'.repeat(80));
console.log('💡 KEY INSIGHT');
console.log('═'.repeat(80));
console.log(`
Le vrai problème n'est PAS les filtres d'entrée, mais:

1. ASSET SELECTION est CRUCIAL:
   - ETH: ${baselineResults['ETH'].totalPnl.toFixed(0)}% (${baselineResults['ETH'].stopLosses} SL)
   - XRP: ${baselineResults['XRP'].totalPnl.toFixed(0)}% (${baselineResults['XRP'].stopLosses} SL)
   - BTC: ${baselineResults['BTC'].totalPnl.toFixed(0)}% (${baselineResults['BTC'].stopLosses} SL)
   - SOL: ${baselineResults['SOL'].totalPnl.toFixed(0)}% (${baselineResults['SOL'].stopLosses} SL)

2. Les stop losses sur SOL coûtent énormément (${baselineResults['SOL'].stopLosses} trades)

3. SOLUTION SIMPLE: Trader seulement ETH + XRP = ${ethXrpPnl.toFixed(0)}% PnL
   vs tous les 4 assets = ${totalBasePnl.toFixed(0)}% PnL
`);

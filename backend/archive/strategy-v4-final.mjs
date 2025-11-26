/**
 * STRATEGY V4 FINAL - V3 + ENTRY FILTERS
 * 
 * Objectif: Réduire les 158 stop losses qui coûtent -1510% de PnL
 * 
 * Approche:
 * 1. Utiliser la vraie entrée V3 (breakout + ROC + volume)
 * 2. Ajouter des filtres d'entrée pour éviter les trades qui finissent en stop loss
 * 3. Tester sur ETH + XRP (meilleurs assets)
 */

import fs from 'fs';

function loadData(symbol) {
    const filename = `./data/${symbol.replace('/', '_')}_1h.json`;
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

const CONFIG = {
    ENTRY_FEE: 0.0004,
    EXIT_FEE: 0.0004,
    SLIPPAGE: 0.0002,
    LEVERAGE: { BTC: 3, ETH: 5, SOL: 5, XRP: 4 },
};

// ═══════════════════════════════════════════════════════════════════════════
// INDICATORS (exact copy from V3)
// ═══════════════════════════════════════════════════════════════════════════

function calculateATR(candles, period = 14) {
    const atrs = [];
    for (let i = 0; i < candles.length; i++) {
        if (i === 0) { atrs.push(candles[i].high - candles[i].low); continue; }
        const tr = Math.max(
            candles[i].high - candles[i].low,
            Math.abs(candles[i].high - candles[i-1].close),
            Math.abs(candles[i].low - candles[i-1].close)
        );
        if (i < period) atrs.push(tr);
        else atrs.push((atrs[i-1] * (period - 1) + tr) / period);
    }
    return atrs;
}

function calculateROC(prices, period) {
    return prices.map((p, i) => i < period ? 0 : (p - prices[i - period]) / prices[i - period]);
}

function calculateVolSMA(volumes, period) {
    return volumes.map((v, i) => {
        if (i < period) return v;
        return volumes.slice(i - period, i).reduce((a, b) => a + b, 0) / period;
    });
}

function calculateRSI(candles, period = 14) {
    const rsis = [];
    let avgGain = 0, avgLoss = 0;
    for (let i = 0; i < candles.length; i++) {
        if (i === 0) { rsis.push(50); continue; }
        const change = candles[i].close - candles[i-1].close;
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? -change : 0;
        if (i < period) {
            avgGain = (avgGain * (i - 1) + gain) / i;
            avgLoss = (avgLoss * (i - 1) + loss) / i;
        } else {
            avgGain = (avgGain * (period - 1) + gain) / period;
            avgLoss = (avgLoss * (period - 1) + loss) / period;
        }
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        rsis.push(100 - (100 / (1 + rs)));
    }
    return rsis;
}

function prepareData(symbol) {
    const candles = loadData(symbol);
    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);
    
    return {
        candles,
        closes,
        atr: calculateATR(candles, 14),
        roc5: calculateROC(closes, 5),
        roc10: calculateROC(closes, 10),
        volSMA20: calculateVolSMA(volumes, 20),
        rsi: calculateRSI(candles, 14),
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// V3 ENTRY + OPTIONAL FILTERS
// ═══════════════════════════════════════════════════════════════════════════

function shouldEnter(i, data, filters = {}) {
    if (i < 30) return null;
    
    const close = data.candles[i].close;
    
    // Calculate breakout level
    let highest = 0, lowest = Infinity;
    for (let j = i - 20; j < i; j++) {
        if (data.candles[j].high > highest) highest = data.candles[j].high;
        if (data.candles[j].low < lowest) lowest = data.candles[j].low;
    }
    
    const range = highest - lowest;
    const breakoutUp = highest + range * 0.02;
    
    const roc5 = data.roc5[i];
    const rsi = data.rsi[i];
    const vol = data.candles[i].volume;
    const volAvg = data.volSMA20[i];
    const atrPercent = data.atr[i] / close;
    
    // V3 base entry condition
    if (close > breakoutUp && roc5 > 0.015 && vol > volAvg * 1.3) {
        
        // Apply filters if specified
        if (filters.maxRsi && rsi > filters.maxRsi) return null;
        if (filters.maxAtrPercent && atrPercent > filters.maxAtrPercent) return null;
        if (filters.maxRoc5 && roc5 > filters.maxRoc5) return null;
        if (filters.minVolRatio && vol / volAvg < filters.minVolRatio) return null;
        
        // Consecutive up candles filter
        if (filters.maxConsecUp) {
            let consecUp = 0;
            for (let j = i; j > 0; j--) {
                if (data.candles[j].close > data.candles[j-1].close) consecUp++;
                else break;
            }
            if (consecUp > filters.maxConsecUp) return null;
        }
        
        return { 
            type: 'long',
            entryRsi: rsi,
            entryAtr: atrPercent,
            entryRoc5: roc5,
            entryVolRatio: vol / volAvg
        };
    }
    
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// V3 EXITS (exact copy)
// ═══════════════════════════════════════════════════════════════════════════

function shouldExit(i, data, position) {
    const roc5 = data.roc5[i];
    const roc10 = data.roc10[i];
    const rsi = data.rsi[i];
    const pnl = (data.candles[i].close - position.entryPrice) / position.entryPrice;
    const vol = data.candles[i].volume;
    const volAvg = data.volSMA20[i];
    const holdingHours = i - position.entryIdx;
    
    // Track max PnL
    const maxPnl = position.maxPnl || 0;
    position.maxPnl = Math.max(maxPnl, pnl);
    
    // 1. Momentum fade profit (100% WR)
    if (pnl > 0.02 && roc5 < 0.005) {
        return { reason: 'momentum_fade_profit' };
    }
    
    // 2. Volume dry-up exit
    if (pnl > 0.005 && vol < volAvg * 0.5 && roc5 < 0) {
        return { reason: 'volume_dry_up' };
    }
    
    // 3. Multi-signal reversal
    let exitSignals = 0;
    if (roc5 < 0) exitSignals++;
    if (roc10 < roc5) exitSignals++;
    if (rsi > 70) exitSignals++;
    if (vol < volAvg * 0.7) exitSignals++;
    
    if (pnl > 0.01 && exitSignals >= 3) {
        return { reason: 'multi_signal_exit' };
    }
    
    // 4. Strong reversal signal
    if (pnl > 0.005 && roc5 < -0.01 && rsi > 65) {
        return { reason: 'strong_reversal' };
    }
    
    // 5. Time-based exit (6h) with any profit
    if (holdingHours >= 6 && pnl > 0.002) {
        return { reason: 'time_exit_6h' };
    }
    
    // 6. Profit lock at 4%
    if (pnl > 0.04) {
        return { reason: 'profit_lock' };
    }
    
    // 7. Breakeven stop after reaching 1.5% profit
    if (position.maxPnl > 0.015 && pnl <= 0.002) {
        return { reason: 'breakeven_stop' };
    }
    
    // 8. Time-based exit (24h) - close position
    if (holdingHours >= 24) {
        return { reason: 'time_exit_24h' };
    }
    
    // 9. Adaptive stop loss (-2%)
    if (pnl < -0.02) {
        return { reason: 'adaptive_stop_loss' };
    }
    
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// BACKTESTER
// ═══════════════════════════════════════════════════════════════════════════

function runBacktest(symbol, filters = {}) {
    const data = prepareData(symbol);
    const leverage = CONFIG.LEVERAGE[symbol.replace('/USDT', '')];
    const trades = [];
    let position = null;
    
    for (let i = 30; i < data.candles.length; i++) {
        if (position) {
            const exit = shouldExit(i, data, position);
            if (exit) {
                const pnl = (data.candles[i].close - position.entryPrice) / position.entryPrice;
                const totalFees = CONFIG.ENTRY_FEE + CONFIG.EXIT_FEE + CONFIG.SLIPPAGE;
                const netPnl = (pnl * leverage) - totalFees;
                
                trades.push({
                    symbol,
                    entryIdx: position.entryIdx,
                    exitIdx: i,
                    entryPrice: position.entryPrice,
                    exitPrice: data.candles[i].close,
                    pnlRaw: pnl,
                    pnlWithLeverage: pnl * leverage,
                    netPnl,
                    exitReason: exit.reason,
                    holdingHours: i - position.entryIdx,
                    entryRsi: position.entryRsi,
                    entryAtr: position.entryAtr,
                    entryRoc5: position.entryRoc5
                });
                
                position = null;
            }
        }
        
        if (!position) {
            const entry = shouldEnter(i, data, filters);
            if (entry) {
                position = {
                    entryPrice: data.candles[i].close,
                    entryIdx: i,
                    entryRsi: entry.entryRsi,
                    entryAtr: entry.entryAtr,
                    entryRoc5: entry.entryRoc5
                };
            }
        }
    }
    
    return trades;
}

// ═══════════════════════════════════════════════════════════════════════════
// ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════

function analyzeResults(trades, label) {
    const wins = trades.filter(t => t.netPnl > 0).length;
    const stopLosses = trades.filter(t => t.exitReason === 'adaptive_stop_loss').length;
    const totalPnl = trades.reduce((sum, t) => sum + t.netPnl, 0) * 100;
    const avgPnl = trades.length > 0 ? totalPnl / trades.length : 0;
    
    return {
        label,
        trades: trades.length,
        winRate: trades.length > 0 ? (wins / trades.length * 100) : 0,
        totalPnl,
        avgPnl,
        stopLosses,
        slPercent: trades.length > 0 ? (stopLosses / trades.length * 100) : 0
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

console.log('═'.repeat(80));
console.log('🎯 STRATEGY V4 - V3 + ENTRY FILTERS');
console.log('═'.repeat(80));

const SYMBOLS = ['ETH/USDT', 'XRP/USDT']; // Focus sur les meilleurs

// Test different filter combinations
const filterConfigs = [
    { name: 'V3 Original (no filter)', filters: {} },
    { name: 'RSI < 75', filters: { maxRsi: 75 } },
    { name: 'RSI < 72', filters: { maxRsi: 72 } },
    { name: 'RSI < 70', filters: { maxRsi: 70 } },
    { name: 'ATR% < 3%', filters: { maxAtrPercent: 0.03 } },
    { name: 'ATR% < 2.5%', filters: { maxAtrPercent: 0.025 } },
    { name: 'ROC5 < 6%', filters: { maxRoc5: 0.06 } },
    { name: 'ROC5 < 5%', filters: { maxRoc5: 0.05 } },
    { name: 'ConsecUp < 5', filters: { maxConsecUp: 5 } },
    { name: 'ConsecUp < 4', filters: { maxConsecUp: 4 } },
    { name: 'VolRatio > 1.5', filters: { minVolRatio: 1.5 } },
    { name: 'RSI<72 + ATR<2.5%', filters: { maxRsi: 72, maxAtrPercent: 0.025 } },
    { name: 'RSI<75 + ROC5<5%', filters: { maxRsi: 75, maxRoc5: 0.05 } },
    { name: 'RSI<72 + ConsecUp<5', filters: { maxRsi: 72, maxConsecUp: 5 } },
    { name: 'ATR<2.5% + ROC5<5%', filters: { maxAtrPercent: 0.025, maxRoc5: 0.05 } },
    { name: 'SAFE: RSI<70 + ATR<2.5%', filters: { maxRsi: 70, maxAtrPercent: 0.025 } },
    { name: 'MODERATE: RSI<72 + ATR<3%', filters: { maxRsi: 72, maxAtrPercent: 0.03 } },
];

console.log('\n📊 Testing filters on ETH + XRP...\n');

const results = [];

for (const config of filterConfigs) {
    let allTrades = [];
    
    for (const symbol of SYMBOLS) {
        const trades = runBacktest(symbol, config.filters);
        allTrades = allTrades.concat(trades);
    }
    
    const analysis = analyzeResults(allTrades, config.name);
    results.push(analysis);
}

// Sort by PnL
results.sort((a, b) => b.totalPnl - a.totalPnl);

// Display results
console.log('┌─────────────────────────────┬────────┬────────┬──────────┬──────────┬──────────┐');
console.log('│ Filter                      │ Trades │ WinRate│ PnL      │ StopLoss │ SL%      │');
console.log('├─────────────────────────────┼────────┼────────┼──────────┼──────────┼──────────┤');

for (const r of results) {
    const pnlStr = r.totalPnl >= 0 ? `+${r.totalPnl.toFixed(0)}%` : `${r.totalPnl.toFixed(0)}%`;
    const isBaseline = r.label === 'V3 Original (no filter)';
    const prefix = isBaseline ? '📈' : (r.totalPnl > results.find(x => x.label === 'V3 Original (no filter)').totalPnl ? '✅' : '❌');
    
    console.log(`│${prefix}${r.label.substring(0, 26).padEnd(27)} │ ${r.trades.toString().padStart(6)} │ ${r.winRate.toFixed(1).padStart(5)}% │ ${pnlStr.padStart(8)} │ ${r.stopLosses.toString().padStart(8)} │ ${r.slPercent.toFixed(1).padStart(6)}% │`);
}

console.log('└─────────────────────────────┴────────┴────────┴──────────┴──────────┴──────────┘');

// Find best filter
const baseline = results.find(r => r.label === 'V3 Original (no filter)');
const betterThanBaseline = results.filter(r => r.totalPnl > baseline.totalPnl && r.label !== 'V3 Original (no filter)');

console.log('\n' + '═'.repeat(80));
console.log('🏆 ANALYSIS');
console.log('═'.repeat(80));

if (betterThanBaseline.length > 0) {
    console.log(`\n✅ ${betterThanBaseline.length} filter(s) beat the baseline:`);
    for (const r of betterThanBaseline) {
        const improvement = r.totalPnl - baseline.totalPnl;
        console.log(`   • ${r.label}: +${improvement.toFixed(0)}% improvement`);
        console.log(`     - Trades: ${baseline.trades} → ${r.trades} (-${baseline.trades - r.trades})`);
        console.log(`     - Stop Losses: ${baseline.stopLosses} → ${r.stopLosses} (-${baseline.stopLosses - r.stopLosses})`);
    }
} else {
    console.log('\n❌ No filter beats the baseline. V3 original is optimal.');
}

// Analyze stop loss characteristics
console.log('\n' + '═'.repeat(80));
console.log('🔬 STOP LOSS ANALYSIS');
console.log('═'.repeat(80));

let allStopLossTrades = [];
let allWinningTrades = [];

for (const symbol of SYMBOLS) {
    const trades = runBacktest(symbol, {});
    allStopLossTrades = allStopLossTrades.concat(trades.filter(t => t.exitReason === 'adaptive_stop_loss'));
    allWinningTrades = allWinningTrades.concat(trades.filter(t => t.netPnl > 0));
}

const avgSlRsi = allStopLossTrades.reduce((sum, t) => sum + t.entryRsi, 0) / allStopLossTrades.length;
const avgWinRsi = allWinningTrades.reduce((sum, t) => sum + t.entryRsi, 0) / allWinningTrades.length;
const avgSlAtr = allStopLossTrades.reduce((sum, t) => sum + t.entryAtr, 0) / allStopLossTrades.length * 100;
const avgWinAtr = allWinningTrades.reduce((sum, t) => sum + t.entryAtr, 0) / allWinningTrades.length * 100;
const avgSlRoc = allStopLossTrades.reduce((sum, t) => sum + t.entryRoc5, 0) / allStopLossTrades.length * 100;
const avgWinRoc = allWinningTrades.reduce((sum, t) => sum + t.entryRoc5, 0) / allWinningTrades.length * 100;

console.log(`
Entry characteristics at trade initiation:

┌─────────────┬───────────────────┬───────────────────┬───────────┐
│ Metric      │ Stop Loss trades  │ Winning trades    │ Diff      │
├─────────────┼───────────────────┼───────────────────┼───────────┤
│ RSI         │ ${avgSlRsi.toFixed(1).padStart(10)}        │ ${avgWinRsi.toFixed(1).padStart(10)}        │ ${(avgSlRsi - avgWinRsi).toFixed(1).padStart(6)}    │
│ ATR%        │ ${avgSlAtr.toFixed(2).padStart(10)}%       │ ${avgWinAtr.toFixed(2).padStart(10)}%       │ ${(avgSlAtr - avgWinAtr).toFixed(2).padStart(5)}%   │
│ ROC5%       │ ${avgSlRoc.toFixed(2).padStart(10)}%       │ ${avgWinRoc.toFixed(2).padStart(10)}%       │ ${(avgSlRoc - avgWinRoc).toFixed(2).padStart(5)}%   │
│ Count       │ ${allStopLossTrades.length.toString().padStart(10)}        │ ${allWinningTrades.length.toString().padStart(10)}        │           │
└─────────────┴───────────────────┴───────────────────┴───────────┘

💡 Insight: Les différences sont ${Math.abs(avgSlRsi - avgWinRsi) < 3 ? 'MINIMES' : 'SIGNIFICATIVES'} entre SL et Winners.
   → ${Math.abs(avgSlRsi - avgWinRsi) < 3 ? "Les filtres d'entrée ne peuvent PAS distinguer les trades perdants" : "Il y a une opportunité de filtrage"}.
`);

// Final recommendation
console.log('═'.repeat(80));
console.log('📋 FINAL RECOMMENDATION');
console.log('═'.repeat(80));

const best = results[0];
console.log(`
🏆 MEILLEURE CONFIGURATION: ${best.label}

   Performance:
   • Trades: ${best.trades}
   • Win Rate: ${best.winRate.toFixed(1)}%
   • Total PnL: ${best.totalPnl >= 0 ? '+' : ''}${best.totalPnl.toFixed(0)}%
   • Stop Losses: ${best.stopLosses} (${best.slPercent.toFixed(1)}%)

   vs Baseline (V3 Original):
   • Trades: ${baseline.trades} → ${best.trades} (${best.trades - baseline.trades >= 0 ? '+' : ''}${best.trades - baseline.trades})
   • PnL: ${baseline.totalPnl.toFixed(0)}% → ${best.totalPnl.toFixed(0)}% (${best.totalPnl - baseline.totalPnl >= 0 ? '+' : ''}${(best.totalPnl - baseline.totalPnl).toFixed(0)}%)
   • Stop Losses: ${baseline.stopLosses} → ${best.stopLosses} (${best.stopLosses - baseline.stopLosses >= 0 ? '+' : ''}${best.stopLosses - baseline.stopLosses})

🔑 CONCLUSION:
   ${best.totalPnl > baseline.totalPnl ? 
     `Le filtre "${best.label}" améliore la performance de +${(best.totalPnl - baseline.totalPnl).toFixed(0)}%` :
     `Aucun filtre n'améliore significativement V3. Garder la version originale.`}
`);

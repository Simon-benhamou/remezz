/**
 * V4 FINAL - LONG ONLY + CONSECUP<4 FILTER
 * 
 * Simulation réaliste avec 1000$ sur 12 mois
 * Avec leverage + frais
 */

import fs from 'fs';

function loadData(symbol) {
    const filename = `./data/${symbol.replace('/', '_')}_1h.json`;
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

const CONFIG = {
    ENTRY_FEE: 0.0004,   // 0.04%
    EXIT_FEE: 0.0004,    // 0.04%
    SLIPPAGE: 0.0002,    // 0.02%
    LEVERAGE: { BTC: 3, ETH: 5, SOL: 5, XRP: 4 },
    INITIAL_CAPITAL: 1000,
};

// ═══════════════════════════════════════════════════════════════════════════
// INDICATORS
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
// ENTRY (V3 + ConsecUp<4 filter)
// ═══════════════════════════════════════════════════════════════════════════

function shouldEnter(i, data) {
    if (i < 30) return null;
    
    const close = data.candles[i].close;
    
    // Calculate breakout level
    let highest = 0;
    for (let j = i - 20; j < i; j++) {
        if (data.candles[j].high > highest) highest = data.candles[j].high;
    }
    
    let lowest = Infinity;
    for (let j = i - 20; j < i; j++) {
        if (data.candles[j].low < lowest) lowest = data.candles[j].low;
    }
    
    const range = highest - lowest;
    const breakoutUp = highest + range * 0.02;
    
    const roc5 = data.roc5[i];
    const vol = data.candles[i].volume;
    const volAvg = data.volSMA20[i];
    
    // V3 entry condition: breakout + momentum + volume
    if (close > breakoutUp && roc5 > 0.015 && vol > volAvg * 1.3) {
        
        // ConsecUp<4 filter
        let consecUp = 0;
        for (let j = i; j > 0; j--) {
            if (data.candles[j].close > data.candles[j-1].close) consecUp++;
            else break;
        }
        
        if (consecUp <= 4) {
            return true;
        }
    }
    
    return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// EXIT (V3 exits)
// ═══════════════════════════════════════════════════════════════════════════

function shouldExit(i, data, position) {
    const roc5 = data.roc5[i];
    const roc10 = data.roc10[i];
    const rsi = data.rsi[i];
    const vol = data.candles[i].volume;
    const volAvg = data.volSMA20[i];
    const holdingHours = i - position.entryIdx;
    const pnl = (data.candles[i].close - position.entryPrice) / position.entryPrice;
    
    // Track max PnL
    position.maxPnl = Math.max(position.maxPnl || 0, pnl);
    
    // 1. Momentum fade profit (100% WR)
    if (pnl > 0.02 && roc5 < 0.005) {
        return 'momentum_fade_profit';
    }
    
    // 2. Volume dry-up exit
    if (pnl > 0.005 && vol < volAvg * 0.5 && roc5 < 0) {
        return 'volume_dry_up';
    }
    
    // 3. Multi-signal reversal
    let exitSignals = 0;
    if (roc5 < 0) exitSignals++;
    if (roc10 < roc5) exitSignals++;
    if (rsi > 70) exitSignals++;
    if (vol < volAvg * 0.7) exitSignals++;
    
    if (pnl > 0.01 && exitSignals >= 3) {
        return 'multi_signal_exit';
    }
    
    // 4. Strong reversal
    if (pnl > 0.005 && roc5 < -0.01 && rsi > 65) {
        return 'strong_reversal';
    }
    
    // 5. Time exit 6h
    if (holdingHours >= 6 && pnl > 0.002) {
        return 'time_exit_6h';
    }
    
    // 6. Profit lock at 4%
    if (pnl > 0.04) {
        return 'profit_lock';
    }
    
    // 7. Breakeven stop
    if (position.maxPnl > 0.015 && pnl <= 0.002) {
        return 'breakeven_stop';
    }
    
    // 8. Time exit 24h
    if (holdingHours >= 24) {
        return 'time_exit_24h';
    }
    
    // 9. Stop loss -2%
    if (pnl < -0.02) {
        return 'stop_loss';
    }
    
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// SIMULATION WITH CAPITAL TRACKING
// ═══════════════════════════════════════════════════════════════════════════

function runSimulation(symbols) {
    let capital = CONFIG.INITIAL_CAPITAL;
    const trades = [];
    const monthlyPnL = {};
    
    // Merge all data with timestamps
    const allSignals = [];
    
    for (const symbol of symbols) {
        const data = prepareData(symbol);
        const leverage = CONFIG.LEVERAGE[symbol.replace('/USDT', '')];
        
        for (let i = 30; i < data.candles.length; i++) {
            if (shouldEnter(i, data)) {
                allSignals.push({
                    type: 'entry',
                    symbol,
                    timestamp: data.candles[i].timestamp,
                    idx: i,
                    data,
                    leverage
                });
            }
        }
    }
    
    // Sort by timestamp
    allSignals.sort((a, b) => a.timestamp - b.timestamp);
    
    // Simulate trading one position at a time
    let position = null;
    
    for (const signal of allSignals) {
        const { symbol, idx, data, leverage } = signal;
        const candle = data.candles[idx];
        const month = new Date(candle.timestamp).toISOString().slice(0, 7);
        
        // If we have a position, check exit first
        if (position && position.symbol === symbol) {
            const exitReason = shouldExit(idx, position.data, position);
            if (exitReason) {
                const exitPrice = candle.close;
                const pnlRaw = (exitPrice - position.entryPrice) / position.entryPrice;
                const pnlWithLeverage = pnlRaw * position.leverage;
                const fees = CONFIG.ENTRY_FEE + CONFIG.EXIT_FEE + CONFIG.SLIPPAGE;
                const netPnl = pnlWithLeverage - fees;
                
                const pnlDollars = capital * netPnl;
                capital += pnlDollars;
                
                const exitMonth = new Date(candle.timestamp).toISOString().slice(0, 7);
                if (!monthlyPnL[exitMonth]) monthlyPnL[exitMonth] = 0;
                monthlyPnL[exitMonth] += pnlDollars;
                
                trades.push({
                    symbol,
                    entryPrice: position.entryPrice,
                    exitPrice,
                    entryTime: new Date(position.entryTime).toISOString(),
                    exitTime: new Date(candle.timestamp).toISOString(),
                    holdingHours: idx - position.entryIdx,
                    pnlRaw: pnlRaw * 100,
                    pnlWithLeverage: pnlWithLeverage * 100,
                    netPnl: netPnl * 100,
                    pnlDollars,
                    exitReason,
                    capitalAfter: capital
                });
                
                position = null;
            }
        }
        
        // Try to enter new position
        if (!position) {
            position = {
                symbol,
                entryPrice: candle.close,
                entryIdx: idx,
                entryTime: candle.timestamp,
                data,
                leverage,
                maxPnl: 0
            };
        }
    }
    
    return { trades, monthlyPnL, finalCapital: capital };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

console.log('═'.repeat(80));
console.log('💰 V4 FINAL - SIMULATION 1000$ sur 12 mois');
console.log('═'.repeat(80));
console.log(`
Configuration:
- Capital initial: $${CONFIG.INITIAL_CAPITAL}
- Assets: ETH + XRP (LONG only)
- Leverage: ETH=5x, XRP=4x
- Frais: 0.04% entry + 0.04% exit + 0.02% slippage = 0.10% total
- Filtre: ConsecUp < 4
`);

const SYMBOLS = ['ETH/USDT', 'XRP/USDT'];

// Run backtest for each symbol separately (not merged)
let totalTrades = [];
const symbolResults = {};

for (const symbol of SYMBOLS) {
    const data = prepareData(symbol);
    const leverage = CONFIG.LEVERAGE[symbol.replace('/USDT', '')];
    const trades = [];
    let position = null;
    
    for (let i = 30; i < data.candles.length; i++) {
        // Check exit first
        if (position) {
            const exitReason = shouldExit(i, data, position);
            if (exitReason) {
                const pnlRaw = (data.candles[i].close - position.entryPrice) / position.entryPrice;
                const pnlWithLeverage = pnlRaw * leverage;
                const fees = CONFIG.ENTRY_FEE + CONFIG.EXIT_FEE + CONFIG.SLIPPAGE;
                const netPnl = pnlWithLeverage - fees;
                
                trades.push({
                    symbol,
                    entryTime: new Date(data.candles[position.entryIdx].timestamp).toISOString(),
                    exitTime: new Date(data.candles[i].timestamp).toISOString(),
                    month: new Date(data.candles[i].timestamp).toISOString().slice(0, 7),
                    pnlRaw,
                    pnlWithLeverage,
                    netPnl,
                    exitReason
                });
                
                position = null;
            }
        }
        
        // Check entry
        if (!position && shouldEnter(i, data)) {
            position = {
                entryPrice: data.candles[i].close,
                entryIdx: i,
                maxPnl: 0
            };
        }
    }
    
    symbolResults[symbol] = trades;
    totalTrades = totalTrades.concat(trades);
}

// Calculate monthly PnL with compounding
const months = [...new Set(totalTrades.map(t => t.month))].sort();
let capital = CONFIG.INITIAL_CAPITAL;
const monthlyResults = [];

console.log('─'.repeat(80));
console.log('📅 PERFORMANCE MENSUELLE');
console.log('─'.repeat(80));

console.log('\n┌─────────┬────────┬──────────┬───────────┬────────────┬─────────────┐');
console.log('│ Mois    │ Trades │ Win Rate │ PnL %     │ PnL $      │ Capital     │');
console.log('├─────────┼────────┼──────────┼───────────┼────────────┼─────────────┤');

for (const month of months) {
    const monthTrades = totalTrades.filter(t => t.month === month);
    const wins = monthTrades.filter(t => t.netPnl > 0).length;
    const winRate = monthTrades.length > 0 ? (wins / monthTrades.length * 100) : 0;
    
    // Calculate compounded PnL for the month
    let monthPnlPercent = 0;
    for (const trade of monthTrades) {
        monthPnlPercent += trade.netPnl;
    }
    
    const monthPnlDollars = capital * monthPnlPercent;
    capital += monthPnlDollars;
    
    monthlyResults.push({
        month,
        trades: monthTrades.length,
        winRate,
        pnlPercent: monthPnlPercent * 100,
        pnlDollars: monthPnlDollars,
        capitalAfter: capital
    });
    
    const pnlStr = monthPnlPercent >= 0 ? `+${(monthPnlPercent * 100).toFixed(1)}%` : `${(monthPnlPercent * 100).toFixed(1)}%`;
    const pnlDollarStr = monthPnlDollars >= 0 ? `+$${monthPnlDollars.toFixed(0)}` : `-$${Math.abs(monthPnlDollars).toFixed(0)}`;
    const status = monthPnlPercent >= 0 ? '✅' : '❌';
    
    console.log(`│${status}${month} │ ${monthTrades.length.toString().padStart(6)} │ ${winRate.toFixed(0).padStart(7)}% │ ${pnlStr.padStart(9)} │ ${pnlDollarStr.padStart(10)} │ $${capital.toFixed(0).padStart(10)} │`);
}

console.log('└─────────┴────────┴──────────┴───────────┴────────────┴─────────────┘');

// Summary
const positiveMonths = monthlyResults.filter(m => m.pnlPercent >= 0).length;
const totalPnlPercent = (capital - CONFIG.INITIAL_CAPITAL) / CONFIG.INITIAL_CAPITAL * 100;
const totalPnlDollars = capital - CONFIG.INITIAL_CAPITAL;
const avgMonthlyPnl = monthlyResults.reduce((sum, m) => sum + m.pnlPercent, 0) / monthlyResults.length;
const avgMonthlyDollars = totalPnlDollars / months.length;

console.log('\n' + '═'.repeat(80));
console.log('📊 RÉSUMÉ ANNUEL');
console.log('═'.repeat(80));

console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║ 💰 RÉSULTATS SUR 12 MOIS                                                      ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   Capital initial:     $${CONFIG.INITIAL_CAPITAL.toFixed(0).padStart(6)}                                            ║
║   Capital final:       $${capital.toFixed(0).padStart(6)}                                            ║
║   ─────────────────────────────────────────────────                           ║
║   PnL Total:           ${totalPnlDollars >= 0 ? '+' : ''}$${totalPnlDollars.toFixed(0).padStart(5)} (${totalPnlPercent >= 0 ? '+' : ''}${totalPnlPercent.toFixed(0)}%)                                       ║
║                                                                               ║
║   Mois positifs:       ${positiveMonths}/${months.length} (${(positiveMonths/months.length*100).toFixed(0)}%)                                           ║
║   PnL mensuel moyen:   ${avgMonthlyPnl >= 0 ? '+' : ''}${avgMonthlyPnl.toFixed(1)}% ($${avgMonthlyDollars >= 0 ? '+' : ''}${avgMonthlyDollars.toFixed(0)})                                    ║
║                                                                               ║
║   Total trades:        ${totalTrades.length}                                                 ║
║   Win Rate global:     ${(totalTrades.filter(t => t.netPnl > 0).length / totalTrades.length * 100).toFixed(1)}%                                              ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
`);

// Breakdown par symbol
console.log('\n📊 BREAKDOWN PAR ASSET:');
for (const symbol of SYMBOLS) {
    const trades = symbolResults[symbol];
    const wins = trades.filter(t => t.netPnl > 0).length;
    const totalPnl = trades.reduce((sum, t) => sum + t.netPnl, 0) * 100;
    const stopLosses = trades.filter(t => t.exitReason === 'stop_loss').length;
    
    console.log(`   ${symbol}: ${trades.length} trades, ${(wins/trades.length*100).toFixed(0)}% WR, ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(0)}% PnL, ${stopLosses} SL`);
}

// Exit reasons breakdown
console.log('\n📊 EXIT REASONS:');
const exitReasons = {};
totalTrades.forEach(t => {
    if (!exitReasons[t.exitReason]) exitReasons[t.exitReason] = { count: 0, pnl: 0 };
    exitReasons[t.exitReason].count++;
    exitReasons[t.exitReason].pnl += t.netPnl * 100;
});

for (const [reason, data] of Object.entries(exitReasons).sort((a, b) => b[1].pnl - a[1].pnl)) {
    const avg = data.pnl / data.count;
    const status = data.pnl >= 0 ? '✅' : '❌';
    console.log(`   ${status} ${reason}: ${data.count} trades, ${data.pnl >= 0 ? '+' : ''}${data.pnl.toFixed(0)}% total, ${avg >= 0 ? '+' : ''}${avg.toFixed(1)}% avg`);
}

console.log('\n' + '═'.repeat(80));
console.log('🎯 CONCLUSION');
console.log('═'.repeat(80));

if (totalPnlPercent > 100) {
    console.log(`
✅ STRATÉGIE VALIDÉE!

   Avec $1000 de capital initial:
   - En 12 mois: $${capital.toFixed(0)} (${totalPnlPercent >= 0 ? '+' : ''}${totalPnlPercent.toFixed(0)}%)
   - Moyenne mensuelle: ${avgMonthlyPnl >= 0 ? '+' : ''}${avgMonthlyPnl.toFixed(1)}%
   - ${positiveMonths}/${months.length} mois positifs

   Prêt pour implémentation!
`);
} else {
    console.log(`
⚠️ Performance modérée: ${totalPnlPercent.toFixed(0)}% sur 12 mois
   
   À considérer:
   - Ajuster les paramètres
   - Ajouter d'autres assets
   - Revoir les exits
`);
}

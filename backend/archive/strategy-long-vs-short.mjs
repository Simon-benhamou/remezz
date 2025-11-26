/**
 * STRATEGY V4 - TEST LONG + SHORT
 * 
 * Question: Le filtre ConsecUp < 4 fonctionne-t-il aussi pour SHORT?
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
// ENTRY (LONG + SHORT)
// ═══════════════════════════════════════════════════════════════════════════

function shouldEnter(i, data, filters = {}, allowShort = false) {
    if (i < 30) return null;
    
    const close = data.candles[i].close;
    
    // Calculate breakout levels
    let highest = 0, lowest = Infinity;
    for (let j = i - 20; j < i; j++) {
        if (data.candles[j].high > highest) highest = data.candles[j].high;
        if (data.candles[j].low < lowest) lowest = data.candles[j].low;
    }
    
    const range = highest - lowest;
    const breakoutUp = highest + range * 0.02;
    const breakoutDown = lowest - range * 0.02;
    
    const roc5 = data.roc5[i];
    const rsi = data.rsi[i];
    const vol = data.candles[i].volume;
    const volAvg = data.volSMA20[i];
    
    // Consecutive candles count
    let consecUp = 0, consecDown = 0;
    for (let j = i; j > 0; j--) {
        if (data.candles[j].close > data.candles[j-1].close) {
            consecUp++;
            if (consecDown > 0) break;
        } else {
            consecDown++;
            if (consecUp > 0) break;
        }
    }
    
    // LONG entry
    if (close > breakoutUp && roc5 > 0.015 && vol > volAvg * 1.3) {
        // Apply ConsecUp filter
        if (filters.maxConsecUp && consecUp > filters.maxConsecUp) return null;
        return { type: 'long', consecUp };
    }
    
    // SHORT entry (mirror of long)
    if (allowShort && close < breakoutDown && roc5 < -0.015 && vol > volAvg * 1.3) {
        // Apply ConsecDown filter (same logic as ConsecUp for shorts)
        if (filters.maxConsecDown && consecDown > filters.maxConsecDown) return null;
        return { type: 'short', consecDown };
    }
    
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// EXITS (LONG + SHORT)
// ═══════════════════════════════════════════════════════════════════════════

function shouldExit(i, data, position) {
    const roc5 = data.roc5[i];
    const roc10 = data.roc10[i];
    const rsi = data.rsi[i];
    const vol = data.candles[i].volume;
    const volAvg = data.volSMA20[i];
    const holdingHours = i - position.entryIdx;
    
    let pnl;
    if (position.side === 'long') {
        pnl = (data.candles[i].close - position.entryPrice) / position.entryPrice;
    } else {
        pnl = (position.entryPrice - data.candles[i].close) / position.entryPrice;
    }
    
    // Track max PnL
    const maxPnl = position.maxPnl || 0;
    position.maxPnl = Math.max(maxPnl, pnl);
    
    // === LONG EXITS ===
    if (position.side === 'long') {
        // Momentum fade profit
        if (pnl > 0.02 && roc5 < 0.005) {
            return { reason: 'momentum_fade_profit' };
        }
        
        // Volume dry-up exit
        if (pnl > 0.005 && vol < volAvg * 0.5 && roc5 < 0) {
            return { reason: 'volume_dry_up' };
        }
        
        // Multi-signal reversal
        let exitSignals = 0;
        if (roc5 < 0) exitSignals++;
        if (roc10 < roc5) exitSignals++;
        if (rsi > 70) exitSignals++;
        if (vol < volAvg * 0.7) exitSignals++;
        
        if (pnl > 0.01 && exitSignals >= 3) {
            return { reason: 'multi_signal_exit' };
        }
        
        // Strong reversal
        if (pnl > 0.005 && roc5 < -0.01 && rsi > 65) {
            return { reason: 'strong_reversal' };
        }
        
        // Time exit 6h
        if (holdingHours >= 6 && pnl > 0.002) {
            return { reason: 'time_exit_6h' };
        }
        
        // Profit lock
        if (pnl > 0.04) {
            return { reason: 'profit_lock' };
        }
        
        // Breakeven stop
        if (position.maxPnl > 0.015 && pnl <= 0.002) {
            return { reason: 'breakeven_stop' };
        }
        
        // Time exit 24h
        if (holdingHours >= 24) {
            return { reason: 'time_exit_24h' };
        }
        
        // Stop loss -2%
        if (pnl < -0.02) {
            return { reason: 'stop_loss' };
        }
    }
    
    // === SHORT EXITS (mirror of long) ===
    if (position.side === 'short') {
        // Momentum fade profit (for short: price going up = bad)
        if (pnl > 0.02 && roc5 > -0.005) {
            return { reason: 'momentum_fade_profit' };
        }
        
        // Volume dry-up exit
        if (pnl > 0.005 && vol < volAvg * 0.5 && roc5 > 0) {
            return { reason: 'volume_dry_up' };
        }
        
        // Multi-signal reversal (for short: looking for bullish signals)
        let exitSignals = 0;
        if (roc5 > 0) exitSignals++;
        if (roc10 > roc5) exitSignals++;
        if (rsi < 30) exitSignals++;
        if (vol < volAvg * 0.7) exitSignals++;
        
        if (pnl > 0.01 && exitSignals >= 3) {
            return { reason: 'multi_signal_exit' };
        }
        
        // Strong reversal (for short: bullish signal)
        if (pnl > 0.005 && roc5 > 0.01 && rsi < 35) {
            return { reason: 'strong_reversal' };
        }
        
        // Time exit 6h
        if (holdingHours >= 6 && pnl > 0.002) {
            return { reason: 'time_exit_6h' };
        }
        
        // Profit lock
        if (pnl > 0.04) {
            return { reason: 'profit_lock' };
        }
        
        // Breakeven stop
        if (position.maxPnl > 0.015 && pnl <= 0.002) {
            return { reason: 'breakeven_stop' };
        }
        
        // Time exit 24h
        if (holdingHours >= 24) {
            return { reason: 'time_exit_24h' };
        }
        
        // Stop loss -2%
        if (pnl < -0.02) {
            return { reason: 'stop_loss' };
        }
    }
    
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// BACKTESTER
// ═══════════════════════════════════════════════════════════════════════════

function runBacktest(symbol, filters = {}, allowShort = false) {
    const data = prepareData(symbol);
    const leverage = CONFIG.LEVERAGE[symbol.replace('/USDT', '')];
    const trades = [];
    let position = null;
    
    for (let i = 30; i < data.candles.length; i++) {
        if (position) {
            const exit = shouldExit(i, data, position);
            if (exit) {
                let pnl;
                if (position.side === 'long') {
                    pnl = (data.candles[i].close - position.entryPrice) / position.entryPrice;
                } else {
                    pnl = (position.entryPrice - data.candles[i].close) / position.entryPrice;
                }
                const totalFees = CONFIG.ENTRY_FEE + CONFIG.EXIT_FEE + CONFIG.SLIPPAGE;
                const netPnl = (pnl * leverage) - totalFees;
                
                trades.push({
                    symbol,
                    side: position.side,
                    entryIdx: position.entryIdx,
                    exitIdx: i,
                    entryPrice: position.entryPrice,
                    exitPrice: data.candles[i].close,
                    pnlRaw: pnl,
                    pnlWithLeverage: pnl * leverage,
                    netPnl,
                    exitReason: exit.reason,
                    holdingHours: i - position.entryIdx
                });
                
                position = null;
            }
        }
        
        if (!position) {
            const entry = shouldEnter(i, data, filters, allowShort);
            if (entry) {
                position = {
                    side: entry.type,
                    entryPrice: data.candles[i].close,
                    entryIdx: i
                };
            }
        }
    }
    
    return trades;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

console.log('═'.repeat(80));
console.log('🎯 V4 - LONG vs LONG+SHORT COMPARISON');
console.log('═'.repeat(80));

const SYMBOLS = ['ETH/USDT', 'XRP/USDT'];

// Test configurations
const configs = [
    { name: 'LONG only (no filter)', filters: {}, allowShort: false },
    { name: 'LONG only + ConsecUp<4', filters: { maxConsecUp: 4 }, allowShort: false },
    { name: 'LONG+SHORT (no filter)', filters: {}, allowShort: true },
    { name: 'LONG+SHORT + Consec<4', filters: { maxConsecUp: 4, maxConsecDown: 4 }, allowShort: true },
];

console.log('\n');

for (const config of configs) {
    let allTrades = [];
    let longTrades = [];
    let shortTrades = [];
    
    for (const symbol of SYMBOLS) {
        const trades = runBacktest(symbol, config.filters, config.allowShort);
        allTrades = allTrades.concat(trades);
        longTrades = longTrades.concat(trades.filter(t => t.side === 'long'));
        shortTrades = shortTrades.concat(trades.filter(t => t.side === 'short'));
    }
    
    const totalPnl = allTrades.reduce((sum, t) => sum + t.netPnl, 0) * 100;
    const winRate = allTrades.filter(t => t.netPnl > 0).length / allTrades.length * 100;
    const stopLosses = allTrades.filter(t => t.exitReason === 'stop_loss').length;
    
    const longPnl = longTrades.reduce((sum, t) => sum + t.netPnl, 0) * 100;
    const longWR = longTrades.length > 0 ? longTrades.filter(t => t.netPnl > 0).length / longTrades.length * 100 : 0;
    const longSL = longTrades.filter(t => t.exitReason === 'stop_loss').length;
    
    const shortPnl = shortTrades.reduce((sum, t) => sum + t.netPnl, 0) * 100;
    const shortWR = shortTrades.length > 0 ? shortTrades.filter(t => t.netPnl > 0).length / shortTrades.length * 100 : 0;
    const shortSL = shortTrades.filter(t => t.exitReason === 'stop_loss').length;
    
    console.log('─'.repeat(80));
    console.log(`📊 ${config.name}`);
    console.log('─'.repeat(80));
    console.log(`
   TOTAL:  ${allTrades.length} trades, ${winRate.toFixed(1)}% WR, ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(0)}% PnL, ${stopLosses} SL
   
   LONG:   ${longTrades.length} trades, ${longWR.toFixed(1)}% WR, ${longPnl >= 0 ? '+' : ''}${longPnl.toFixed(0)}% PnL, ${longSL} SL
   SHORT:  ${shortTrades.length} trades, ${shortWR.toFixed(1)}% WR, ${shortPnl >= 0 ? '+' : ''}${shortPnl.toFixed(0)}% PnL, ${shortSL} SL
`);
    
    // Breakdown by exit reason for shorts
    if (shortTrades.length > 0) {
        const exitReasons = {};
        shortTrades.forEach(t => {
            if (!exitReasons[t.exitReason]) {
                exitReasons[t.exitReason] = { count: 0, pnl: 0 };
            }
            exitReasons[t.exitReason].count++;
            exitReasons[t.exitReason].pnl += t.netPnl * 100;
        });
        
        console.log('   SHORT Exit breakdown:');
        for (const [reason, data] of Object.entries(exitReasons).sort((a, b) => b[1].pnl - a[1].pnl)) {
            const avgPnl = data.pnl / data.count;
            console.log(`      ${reason}: ${data.count} trades, ${data.pnl >= 0 ? '+' : ''}${data.pnl.toFixed(0)}% total, ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(1)}% avg`);
        }
    }
}

// Summary
console.log('\n' + '═'.repeat(80));
console.log('🏆 CONCLUSION');
console.log('═'.repeat(80));
console.log(`
┌─────────────────────────────────┬─────────┬─────────┬───────────┐
│ Configuration                   │ Trades  │ WinRate │ PnL       │
├─────────────────────────────────┼─────────┼─────────┼───────────┤`);

for (const config of configs) {
    let allTrades = [];
    for (const symbol of SYMBOLS) {
        const trades = runBacktest(symbol, config.filters, config.allowShort);
        allTrades = allTrades.concat(trades);
    }
    const totalPnl = allTrades.reduce((sum, t) => sum + t.netPnl, 0) * 100;
    const winRate = allTrades.filter(t => t.netPnl > 0).length / allTrades.length * 100;
    
    const pnlStr = totalPnl >= 0 ? `+${totalPnl.toFixed(0)}%` : `${totalPnl.toFixed(0)}%`;
    console.log(`│ ${config.name.padEnd(31)} │ ${allTrades.length.toString().padStart(7)} │ ${winRate.toFixed(1).padStart(6)}% │ ${pnlStr.padStart(9)} │`);
}

console.log('└─────────────────────────────────┴─────────┴─────────┴───────────┘');

console.log(`
💡 INSIGHT:
   - Si SHORT détruit la performance → Rester LONG only
   - Si SHORT est profitable → Le filtre ConsecDown<4 aide-t-il ?
`);

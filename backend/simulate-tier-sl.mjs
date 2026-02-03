/**
 * V5.85 Tier-Based SL Simulation
 * Compare old SL (1.5% for all) vs new tier-based SL
 */

import fs from 'fs';

// Config V5.85
const CONFIG = {
  // Old config (V5.81-84)
  OLD: {
    LOW_VOL_SL: 1.5,
    MED_VOL_SL: 2.0,
    HIGH_VOL_SL: 2.5
  },
  // New config (V5.85)
  NEW: {
    TIER1: { // BTC, ETH
      LOW_VOL_SL: 1.5,
      MED_VOL_SL: 2.0,
      HIGH_VOL_SL: 2.5
    },
    TIER2: { // SOL, SEI, DOGE, etc.
      LOW_VOL_SL: 2.0,
      MED_VOL_SL: 2.5,
      HIGH_VOL_SL: 3.0
    },
    TIER3: { // IMX, OP, FTM
      LOW_VOL_SL: 2.5,
      MED_VOL_SL: 3.0,
      HIGH_VOL_SL: 3.5
    }
  },
  TIER1_SYMBOLS: ['BTC', 'ETH'],
  TIER2_SYMBOLS: ['SOL', 'SEI', 'DOGE', 'AVAX', 'XRP', 'LINK', 'ADA', 'ATOM', 'DOT', 'ARB', 'NEAR', 'SUI', 'APT'],
  TIER3_SYMBOLS: ['IMX', 'OP', 'FTM']
};

function getTier(symbol) {
  const base = symbol.split('/')[0].split(':')[0];
  if (CONFIG.TIER1_SYMBOLS.includes(base)) return 'TIER1';
  if (CONFIG.TIER3_SYMBOLS.includes(base)) return 'TIER3';
  return 'TIER2';
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;

  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }

  const recentTRs = trs.slice(-period);
  return recentTRs.reduce((a, b) => a + b, 0) / recentTRs.length;
}

function getVolatilityRegime(atrPct) {
  if (atrPct < 2) return 'LOW';
  if (atrPct > 3.5) return 'HIGH';
  return 'MED';
}

function simulateTrade(candles, entryIdx, side, slPct) {
  const entryCandle = candles[entryIdx];
  const entryPrice = entryCandle.close;

  let maxPnl = 0;
  let exitReason = null;
  let exitIdx = entryIdx;
  let exitPrice = entryPrice;

  // Simulate holding the position
  for (let i = entryIdx + 1; i < Math.min(entryIdx + 200, candles.length); i++) {
    const candle = candles[i];

    // Calculate P&L on wick
    let wickPnl, closePnl;
    if (side === 'long') {
      wickPnl = ((candle.high - entryPrice) / entryPrice) * 100;
      closePnl = ((candle.close - entryPrice) / entryPrice) * 100;
      maxPnl = Math.max(maxPnl, wickPnl);

      // Check SL
      const slPrice = entryPrice * (1 - slPct / 100);
      if (candle.low <= slPrice) {
        exitReason = 'stoploss';
        exitIdx = i;
        exitPrice = slPrice;
        break;
      }
    } else {
      wickPnl = ((entryPrice - candle.low) / entryPrice) * 100;
      closePnl = ((entryPrice - candle.close) / entryPrice) * 100;
      maxPnl = Math.max(maxPnl, wickPnl);

      // Check SL
      const slPrice = entryPrice * (1 + slPct / 100);
      if (candle.high >= slPrice) {
        exitReason = 'stoploss';
        exitIdx = i;
        exitPrice = slPrice;
        break;
      }
    }

    // Trailing stop activation
    if (maxPnl >= 0.8 && !exitReason) {
      const trailDist = maxPnl >= 3.0 ? 0.8 : 0.5;
      const trailPnl = maxPnl - trailDist;

      if (closePnl <= trailPnl) {
        exitReason = 'trailing_stop';
        exitIdx = i;
        exitPrice = candle.close;
        break;
      }
    }

    // Max hold time (48h = 192 candles of 15m)
    if (i - entryIdx >= 192) {
      exitReason = 'max_hold';
      exitIdx = i;
      exitPrice = candle.close;
      break;
    }
  }

  // Calculate final P&L
  let pnl;
  if (side === 'long') {
    pnl = ((exitPrice - entryPrice) / entryPrice) * 100;
  } else {
    pnl = ((entryPrice - exitPrice) / entryPrice) * 100;
  }

  return {
    exitReason: exitReason || 'end_of_data',
    exitIdx,
    pnl,
    maxPnl,
    holdBars: exitIdx - entryIdx
  };
}

async function main() {
  console.log('='.repeat(100));
  console.log('V5.85 TIER-BASED SL SIMULATION');
  console.log('Comparing OLD (flat 1.5%) vs NEW (tier-based) SL');
  console.log('='.repeat(100));

  const symbols = ['SOL', 'SEI', 'BTC', 'ETH', 'DOGE', 'IMX'];
  const results = { OLD: { wins: 0, losses: 0, totalPnl: 0 }, NEW: { wins: 0, losses: 0, totalPnl: 0 } };

  for (const sym of symbols) {
    try {
      const data = JSON.parse(fs.readFileSync(`data/${sym}_USDT_15m.json`, 'utf8'));
      const candles = data.candles || data;

      if (candles.length < 500) continue;

      const tier = getTier(sym);
      console.log(`\n${'─'.repeat(80)}`);
      console.log(`${sym} (${tier})`);
      console.log(`${'─'.repeat(80)}`);

      // Sample trades: every 100 candles, alternate long/short
      const sampleIdxs = [];
      for (let i = 100; i < candles.length - 200; i += 100) {
        sampleIdxs.push(i);
      }

      let symOldWins = 0, symOldLosses = 0, symOldPnl = 0;
      let symNewWins = 0, symNewLosses = 0, symNewPnl = 0;

      for (let j = 0; j < Math.min(sampleIdxs.length, 50); j++) {
        const entryIdx = sampleIdxs[j];
        const side = j % 2 === 0 ? 'long' : 'short';

        // Calculate ATR for volatility regime
        const windowCandles = candles.slice(Math.max(0, entryIdx - 14), entryIdx + 1);
        const atr = calcATR(windowCandles);
        const price = candles[entryIdx].close;
        const atrPct = atr ? (atr / price) * 100 : 1.5;
        const volRegime = getVolatilityRegime(atrPct);

        // OLD SL (flat by volatility)
        const oldSL = volRegime === 'LOW' ? CONFIG.OLD.LOW_VOL_SL :
                      volRegime === 'HIGH' ? CONFIG.OLD.HIGH_VOL_SL : CONFIG.OLD.MED_VOL_SL;

        // NEW SL (tier + volatility)
        const tierConfig = CONFIG.NEW[tier];
        const newSL = volRegime === 'LOW' ? tierConfig.LOW_VOL_SL :
                      volRegime === 'HIGH' ? tierConfig.HIGH_VOL_SL : tierConfig.MED_VOL_SL;

        // Simulate with OLD SL
        const oldResult = simulateTrade(candles, entryIdx, side, oldSL);
        if (oldResult.pnl > 0) {
          symOldWins++;
          results.OLD.wins++;
        } else {
          symOldLosses++;
          results.OLD.losses++;
        }
        symOldPnl += oldResult.pnl;
        results.OLD.totalPnl += oldResult.pnl;

        // Simulate with NEW SL
        const newResult = simulateTrade(candles, entryIdx, side, newSL);
        if (newResult.pnl > 0) {
          symNewWins++;
          results.NEW.wins++;
        } else {
          symNewLosses++;
          results.NEW.losses++;
        }
        symNewPnl += newResult.pnl;
        results.NEW.totalPnl += newResult.pnl;
      }

      const trades = Math.min(sampleIdxs.length, 50);
      console.log(`  Trades simulated: ${trades}`);
      console.log(`  OLD SL: WR=${(symOldWins/trades*100).toFixed(1)}% | PnL=${symOldPnl.toFixed(2)}% | Avg=${(symOldPnl/trades).toFixed(3)}%`);
      console.log(`  NEW SL: WR=${(symNewWins/trades*100).toFixed(1)}% | PnL=${symNewPnl.toFixed(2)}% | Avg=${(symNewPnl/trades).toFixed(3)}%`);
      console.log(`  Delta:  PnL=${(symNewPnl - symOldPnl).toFixed(2)}% ${symNewPnl > symOldPnl ? '✅ BETTER' : symNewPnl < symOldPnl ? '❌ WORSE' : '➖ SAME'}`);

    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
  }

  console.log('\n' + '='.repeat(100));
  console.log('OVERALL RESULTS');
  console.log('='.repeat(100));

  const oldTrades = results.OLD.wins + results.OLD.losses;
  const newTrades = results.NEW.wins + results.NEW.losses;

  console.log(`\nOLD SL (V5.84):`);
  console.log(`  Trades: ${oldTrades}`);
  console.log(`  Wins: ${results.OLD.wins} | Losses: ${results.OLD.losses}`);
  console.log(`  Win Rate: ${(results.OLD.wins/oldTrades*100).toFixed(1)}%`);
  console.log(`  Total PnL: ${results.OLD.totalPnl.toFixed(2)}%`);
  console.log(`  Avg PnL: ${(results.OLD.totalPnl/oldTrades).toFixed(3)}%`);

  console.log(`\nNEW SL (V5.85 Tier-Based):`);
  console.log(`  Trades: ${newTrades}`);
  console.log(`  Wins: ${results.NEW.wins} | Losses: ${results.NEW.losses}`);
  console.log(`  Win Rate: ${(results.NEW.wins/newTrades*100).toFixed(1)}%`);
  console.log(`  Total PnL: ${results.NEW.totalPnl.toFixed(2)}%`);
  console.log(`  Avg PnL: ${(results.NEW.totalPnl/newTrades).toFixed(3)}%`);

  console.log(`\n${'─'.repeat(50)}`);
  const pnlDelta = results.NEW.totalPnl - results.OLD.totalPnl;
  const wrDelta = (results.NEW.wins/newTrades*100) - (results.OLD.wins/oldTrades*100);
  console.log(`DELTA:`);
  console.log(`  Win Rate: ${wrDelta >= 0 ? '+' : ''}${wrDelta.toFixed(1)}pp`);
  console.log(`  Total PnL: ${pnlDelta >= 0 ? '+' : ''}${pnlDelta.toFixed(2)}%`);
  console.log(`  Verdict: ${pnlDelta > 0 ? '✅ V5.85 IS BETTER' : pnlDelta < 0 ? '❌ V5.84 WAS BETTER' : '➖ NO DIFFERENCE'}`);
  console.log('='.repeat(100));
}

main().catch(console.error);

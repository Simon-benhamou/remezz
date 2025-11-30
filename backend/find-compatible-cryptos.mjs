#!/usr/bin/env node
/**
 * 🔍 Find New Compatible Cryptos for V5.4 Strategy
 * 
 * This script tests multiple crypto pairs against our momentum strategy
 * to find new candidates that show similar patterns to SEI/XRP.
 * 
 * What makes a crypto compatible with our strategy:
 * 1. Enough volatility to generate breakout signals
 * 2. Volume spikes correlated with price moves
 * 3. Good ROI in backtest (not necessarily highest, but positive)
 * 4. Sufficient liquidity (>$50M daily volume)
 * 5. "Decorrelation" from BTC (has its own momentum)
 * 
 * Run: node find-compatible-cryptos.mjs
 */

import ccxt from 'ccxt';

// ============================================================================
// CONFIGURATION
// ============================================================================

const STRATEGY_CONFIG = {
  // Entry LONG (Bull Market)
  ENTRY_LONG: {
    ROC_MIN: 0.025,         // ROC 10 > 2.5%
    VOL_MULTIPLIER: 2.0,    // Volume > 2x average
    MAX_CONSEC_UP: 3,
  },
  // Entry SHORT (Bear Market)
  ENTRY_SHORT: {
    ROC_DROP_MIN: -0.015,   // ROC 5 < -1.5%
    VOL_SPIKE: 2.0,         // Volume > 2x
    MAX_CONSEC_DOWN: 5,
  },
  // Exit
  EXIT: {
    STOP_LOSS_PCT: 1.5,
    PROFIT_TARGET_PCT: 3.0,
    TRAILING_ACTIVATION_PCT: 1.0,
    TRAILING_DISTANCE_PCT: 0.4,
  },
  // Backtest params
  BACKTEST_DAYS: 180,  // Extended to 6 months
  LEVERAGE: 4.5,
};

// Cryptos to test (Binance USDT perpetuals)
const CANDIDATES = [
  // Already known compatible - for reference baseline
  'SEI/USDT:USDT',    // Should show +ROI
  'XRP/USDT:USDT',    // Should show +ROI
  'IMX/USDT:USDT',    // Should show +ROI
  'ETH/USDT:USDT',    // Reference
  
  // High volume candidates (>$50M daily)
  'SUI/USDT:USDT',    // SUI - Layer 1, similar to SEI
  'APT/USDT:USDT',    // Aptos - Layer 1
  'TIA/USDT:USDT',    // Celestia
  'FTM/USDT:USDT',    // Fantom
  'NEAR/USDT:USDT',   // NEAR Protocol
  'AAVE/USDT:USDT',   // DeFi
  'WIF/USDT:USDT',    // Meme
  'AGIX/USDT:USDT',   // AI
  'OCEAN/USDT:USDT',  // AI
  
  // Additional high volume (lower threshold to $30M)
  'DOGE/USDT:USDT',   // Known bad but verify
  'SOL/USDT:USDT',    // Known bad but verify
  'LINK/USDT:USDT',   // Known bad but verify
  'ADA/USDT:USDT',    // Known bad but verify
  'AVAX/USDT:USDT',   // Known bad but verify
  'DOT/USDT:USDT',    // Known as compatible
  
  // New candidates with potentially good patterns
  'BNB/USDT:USDT',    // Major
  'TRX/USDT:USDT',    // Tron
  'TON/USDT:USDT',    // TON
  'HBAR/USDT:USDT',   // Hedera
  'FIL/USDT:USDT',    // Filecoin
  'ATOM/USDT:USDT',   // Cosmos
  'ICP/USDT:USDT',    // Internet Computer
  'ETC/USDT:USDT',    // Ethereum Classic
  'LTC/USDT:USDT',    // Litecoin
  'BCH/USDT:USDT',    // Bitcoin Cash
  'EOS/USDT:USDT',    // EOS
  'XLM/USDT:USDT',    // Stellar
  'VET/USDT:USDT',    // VeChain
  'THETA/USDT:USDT',  // Theta
  'EGLD/USDT:USDT',   // Elrond/MultiversX
  'AXS/USDT:USDT',    // Gaming
  'GALA/USDT:USDT',   // Gaming
  'FET/USDT:USDT',    // AI
  'RENDER/USDT:USDT', // AI/GPU
  'ARB/USDT:USDT',    // L2
  'OP/USDT:USDT',     // L2
  'INJ/USDT:USDT',    // DeFi
  'POL/USDT:USDT',    // ex-MATIC
  'PEPE1000/USDT:USDT', // Meme
  '1000BONK/USDT:USDT', // Meme
  '1000PEPE/USDT:USDT', // Meme
  'WLD/USDT:USDT',    // Worldcoin
  'ORDI/USDT:USDT',   // BRC-20
  'STX/USDT:USDT',    // Stacks
  'RUNE/USDT:USDT',   // THORChain
  'PENDLE/USDT:USDT', // DeFi Yield
  'JUP/USDT:USDT',    // Solana DEX
  'MKR/USDT:USDT',    // DeFi
  'LDO/USDT:USDT',    // Lido
  'UNI/USDT:USDT',    // Uniswap
  'CRV/USDT:USDT',    // Curve
];

// ============================================================================
// INDICATORS
// ============================================================================

function calcMA(values, period) {
  if (values.length < period) return values[values.length - 1] || 0;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcVolRatio(volumes) {
  if (volumes.length < 21) return 0;
  const current = volumes[volumes.length - 1];
  const avgVol = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  return avgVol > 0 ? current / avgVol : 0;
}

function calcBollingerBands(closes, period = 20, stdMultiplier = 2) {
  if (closes.length < period) {
    const last = closes[closes.length - 1] || 0;
    return { upper: last, middle: last, lower: last };
  }
  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, val) => sum + Math.pow(val - middle, 2), 0) / period;
  const std = Math.sqrt(variance);
  return {
    upper: middle + std * stdMultiplier,
    middle,
    lower: middle - std * stdMultiplier,
  };
}

function calcROC(closes, period = 10) {
  if (closes.length < period + 1) return 0;
  const current = closes[closes.length - 1];
  const past = closes[closes.length - period - 1];
  return past > 0 ? (current - past) / past : 0;
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

// ============================================================================
// SIGNAL CHECK (simplified version of V5.4)
// ============================================================================

function checkSignal(candles, btcCandles) {
  if (candles.length < 50 || btcCandles.length < 200) return null;
  
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const btcCloses = btcCandles.map(c => c.close);
  
  const current = candles[candles.length - 1];
  const btcSma200 = calcMA(btcCloses, 200);
  const btcNow = btcCloses[btcCloses.length - 1];
  const btcInBull = btcNow > btcSma200;
  
  const volRatio = calcVolRatio(volumes);
  const ma20 = calcMA(closes, 20);
  const bb = calcBollingerBands(closes, 20, 2);
  const roc10 = calcROC(closes, 10);
  const roc5 = calcROC(closes, 5);
  const consecUp = countConsecUp(candles);
  const consecDown = countConsecDown(candles);
  
  const isBullish = current.close > current.open;
  const isBearish = current.close < current.open;
  
  // LONG signal (bull regime)
  if (btcInBull) {
    const breakoutOk = current.close > bb.upper;
    const rocOk = roc10 >= STRATEGY_CONFIG.ENTRY_LONG.ROC_MIN;
    const volOk = volRatio >= STRATEGY_CONFIG.ENTRY_LONG.VOL_MULTIPLIER;
    const consecOk = consecUp <= STRATEGY_CONFIG.ENTRY_LONG.MAX_CONSEC_UP;
    
    if (isBullish && breakoutOk && rocOk && volOk && consecOk) {
      return { side: 'long', confidence: Math.min(1, volRatio / 3 * 0.5 + roc10 / 0.04 * 0.5) };
    }
  }
  
  // SHORT signal (bear regime)
  if (!btcInBull) {
    const dropOk = roc5 <= STRATEGY_CONFIG.ENTRY_SHORT.ROC_DROP_MIN;
    const volSpikeOk = volRatio >= STRATEGY_CONFIG.ENTRY_SHORT.VOL_SPIKE;
    const priceBelowMa20 = current.close < ma20;
    const priceBelowBB = current.close < bb.lower;
    const consecOk = consecDown <= STRATEGY_CONFIG.ENTRY_SHORT.MAX_CONSEC_DOWN;
    
    if (isBearish && dropOk && volSpikeOk && priceBelowMa20 && priceBelowBB && consecOk) {
      return { side: 'short', confidence: Math.min(1, volRatio / 4 * 0.5 + Math.abs(roc5) / 0.04 * 0.5) };
    }
  }
  
  return null;
}

// ============================================================================
// BACKTEST
// ============================================================================

function backtest(candles, btcCandles, symbol) {
  const results = {
    symbol,
    trades: [],
    totalPnl: 0,
    winRate: 0,
    avgTrade: 0,
    maxDrawdown: 0,
    signalCount: 0,
    longTrades: 0,
    shortTrades: 0,
  };
  
  if (candles.length < 300) return results;
  
  let position = null;
  let equity = 1000;
  let peak = equity;
  let maxDD = 0;
  
  // Walk through candles
  for (let i = 200; i < candles.length; i++) {
    const windowCandles = candles.slice(i - 100, i + 1);
    const btcWindow = btcCandles.slice(Math.max(0, i - 200), i + 1);
    const currentPrice = candles[i].close;
    
    // Check exit if in position
    if (position) {
      let pnlPct;
      if (position.side === 'long') {
        pnlPct = ((currentPrice - position.entry) / position.entry) * 100;
      } else {
        pnlPct = ((position.entry - currentPrice) / position.entry) * 100;
      }
      
      const holdBars = i - position.entryIndex;
      const shouldExit = 
        pnlPct <= -STRATEGY_CONFIG.EXIT.STOP_LOSS_PCT ||
        pnlPct >= STRATEGY_CONFIG.EXIT.PROFIT_TARGET_PCT ||
        holdBars >= 192; // 48h at 15m candles
      
      if (shouldExit) {
        const pnlUsd = equity * 0.4 * STRATEGY_CONFIG.LEVERAGE * (pnlPct / 100);
        equity += pnlUsd;
        
        results.trades.push({
          side: position.side,
          entry: position.entry,
          exit: currentPrice,
          pnlPct,
          pnlUsd,
        });
        
        if (position.side === 'long') results.longTrades++;
        else results.shortTrades++;
        
        position = null;
      }
    }
    
    // Check entry if no position
    if (!position) {
      const signal = checkSignal(windowCandles, btcWindow);
      if (signal) {
        results.signalCount++;
        position = {
          side: signal.side,
          entry: currentPrice,
          entryIndex: i,
        };
      }
    }
    
    // Track drawdown
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  }
  
  // Close any remaining position
  if (position) {
    const currentPrice = candles[candles.length - 1].close;
    let pnlPct;
    if (position.side === 'long') {
      pnlPct = ((currentPrice - position.entry) / position.entry) * 100;
    } else {
      pnlPct = ((position.entry - currentPrice) / position.entry) * 100;
    }
    const pnlUsd = equity * 0.4 * STRATEGY_CONFIG.LEVERAGE * (pnlPct / 100);
    equity += pnlUsd;
    results.trades.push({
      side: position.side,
      entry: position.entry,
      exit: currentPrice,
      pnlPct,
      pnlUsd,
    });
  }
  
  // Calculate stats
  results.totalPnl = equity - 1000;
  results.roi = ((equity - 1000) / 1000) * 100;
  results.maxDrawdown = maxDD;
  
  const wins = results.trades.filter(t => t.pnlPct > 0).length;
  results.winRate = results.trades.length > 0 ? (wins / results.trades.length) * 100 : 0;
  results.avgTrade = results.trades.length > 0 
    ? results.trades.reduce((s, t) => s + t.pnlPct, 0) / results.trades.length 
    : 0;
  
  return results;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('🔍 Finding Compatible Cryptos for V5.4 Strategy');
  console.log('═'.repeat(60));
  console.log(`Testing ${CANDIDATES.length} candidates over ${STRATEGY_CONFIG.BACKTEST_DAYS} days\n`);
  
  const exchange = new ccxt.binanceusdm({
    enableRateLimit: true,
  });
  
  // Fetch BTC candles first (needed for all tests)
  console.log('📊 Fetching BTC historical data...');
  const btcOhlcv = await exchange.fetchOHLCV(
    'BTC/USDT:USDT', 
    '15m', 
    Date.now() - STRATEGY_CONFIG.BACKTEST_DAYS * 24 * 60 * 60 * 1000,
    2000
  );
  const btcCandles = btcOhlcv.map(c => ({
    timestamp: c[0],
    open: c[1],
    high: c[2],
    low: c[3],
    close: c[4],
    volume: c[5],
  }));
  console.log(`✅ BTC: ${btcCandles.length} candles\n`);
  
  // Fetch 24h tickers for volume info
  console.log('📊 Fetching 24h volumes...');
  const tickers = await exchange.fetchTickers();
  
  const results = [];
  
  for (const symbol of CANDIDATES) {
    try {
      process.stdout.write(`Testing ${symbol.padEnd(20)}... `);
      
      // Check if symbol exists and has volume
      const ticker = tickers[symbol];
      if (!ticker) {
        console.log('❌ Not found');
        continue;
      }
      
      const volume24h = ticker.quoteVolume || 0;
      if (volume24h < 20_000_000) {  // Lowered threshold to $20M
        console.log(`⚠️  Low volume ($${(volume24h/1e6).toFixed(1)}M)`);
        continue;
      }
      
      // Fetch candles
      const ohlcv = await exchange.fetchOHLCV(
        symbol, 
        '15m', 
        Date.now() - STRATEGY_CONFIG.BACKTEST_DAYS * 24 * 60 * 60 * 1000,
        2000
      );
      
      if (ohlcv.length < 500) {
        console.log(`⚠️  Not enough data (${ohlcv.length} candles)`);
        continue;
      }
      
      const candles = ohlcv.map(c => ({
        timestamp: c[0],
        open: c[1],
        high: c[2],
        low: c[3],
        close: c[4],
        volume: c[5],
      }));
      
      // Run backtest
      const result = backtest(candles, btcCandles, symbol);
      result.volume24h = volume24h;
      
      const emoji = result.roi > 20 ? '🏆' : result.roi > 0 ? '✅' : '❌';
      console.log(`${emoji} ROI: ${result.roi.toFixed(1)}% | WR: ${result.winRate.toFixed(1)}% | Trades: ${result.trades.length} | Vol: $${(volume24h/1e6).toFixed(0)}M`);
      
      results.push(result);
      
      // Rate limit
      await new Promise(r => setTimeout(r, 200));
      
    } catch (err) {
      console.log(`❌ Error: ${err.message}`);
    }
  }
  
  // Sort by ROI
  results.sort((a, b) => b.roi - a.roi);
  
  console.log('\n' + '═'.repeat(60));
  console.log('📊 RESULTS SUMMARY (sorted by ROI)');
  console.log('═'.repeat(60));
  
  console.log('\n🏆 TOP PERFORMERS (ROI > 20%):');
  console.log('-'.repeat(60));
  results
    .filter(r => r.roi > 20)
    .forEach((r, i) => {
      console.log(`${i + 1}. ${r.symbol.padEnd(20)} ROI: ${r.roi.toFixed(1).padStart(7)}% | WR: ${r.winRate.toFixed(1)}% | DD: ${r.maxDrawdown.toFixed(1)}% | Trades: ${r.trades.length}`);
    });
  
  console.log('\n✅ COMPATIBLE (ROI 0-20%):');
  console.log('-'.repeat(60));
  results
    .filter(r => r.roi >= 0 && r.roi <= 20)
    .forEach((r, i) => {
      console.log(`${i + 1}. ${r.symbol.padEnd(20)} ROI: ${r.roi.toFixed(1).padStart(7)}% | WR: ${r.winRate.toFixed(1)}% | DD: ${r.maxDrawdown.toFixed(1)}% | Trades: ${r.trades.length}`);
    });
  
  console.log('\n❌ NOT COMPATIBLE (ROI < 0):');
  console.log('-'.repeat(60));
  results
    .filter(r => r.roi < 0)
    .forEach((r, i) => {
      console.log(`${i + 1}. ${r.symbol.padEnd(20)} ROI: ${r.roi.toFixed(1).padStart(7)}% | WR: ${r.winRate.toFixed(1)}% | DD: ${r.maxDrawdown.toFixed(1)}% | Trades: ${r.trades.length}`);
    });
  
  // Recommendations
  const recommended = results.filter(r => r.roi > 20 && r.winRate > 45 && r.trades.length >= 10);
  
  console.log('\n' + '═'.repeat(60));
  console.log('💡 RECOMMENDATIONS FOR LIVE TRADING:');
  console.log('═'.repeat(60));
  
  if (recommended.length > 0) {
    console.log('\nAdd these to MomentumConfig.SYMBOLS:');
    recommended.forEach(r => {
      console.log(`  '${r.symbol}',   // ROI: +${r.roi.toFixed(1)}%, WR: ${r.winRate.toFixed(1)}%, Vol: $${(r.volume24h/1e6).toFixed(0)}M`);
    });
    
    console.log('\nAdd to MomentumConfig.LEVERAGE:');
    recommended.forEach(r => {
      console.log(`  '${r.symbol}': 4.5,`);
    });
  } else {
    console.log('\n⚠️  No new cryptos meet all criteria (ROI > 20%, WR > 45%, trades >= 10)');
    console.log('Consider adjusting parameters or extending backtest period.');
  }
  
  console.log('\n✅ Done!');
}

main().catch(console.error);

/**
 * Concrete example to understand trailing stop gap
 */

import * as ccxt from 'ccxt';

async function main() {
  console.log('='.repeat(80));
  console.log('CONCRETE TRAILING STOP EXAMPLE');
  console.log('='.repeat(80));

  // Fetch real candles for SUI around Jan 18-19
  const exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  await exchange.loadMarkets();

  const since = new Date('2026-01-18T22:00:00Z').getTime();
  const ohlcv = await exchange.fetchOHLCV('SUI/USDT:USDT', '15m', since, 20);

  console.log('\n=== SUI 15m CANDLES around Jan 18-19 ===\n');
  console.log('Timestamp            | Open     | High     | Low      | Close    | Change');
  console.log('-'.repeat(85));

  for (const c of ohlcv) {
    const ts = new Date(c[0]).toISOString().slice(0, 19);
    const open = c[1] as number;
    const high = c[2] as number;
    const low = c[3] as number;
    const close = c[4] as number;
    const change = ((close - open) / open * 100).toFixed(2);
    console.log(`${ts} | $${open.toFixed(4)} | $${high.toFixed(4)} | $${low.toFixed(4)} | $${close.toFixed(4)} | ${change}%`);
  }

  // Now simulate a trailing stop scenario
  console.log('\n' + '='.repeat(80));
  console.log('SIMULATION: SHORT position entered at 23:15');
  console.log('='.repeat(80));

  // Find the entry candle (23:15)
  const entryCandle = ohlcv.find(c => new Date(c[0]).toISOString().includes('23:15'));
  if (!entryCandle) {
    console.log('Entry candle not found');
    return;
  }

  const entryPrice = entryCandle[4] as number; // Close of entry candle
  console.log(`\nEntry price: $${entryPrice.toFixed(4)} (close of 23:15 candle)`);

  // Simulate position with trailing
  const TRAILING_ACTIVATION_PCT = 0.8;
  const TRAILING_DISTANCE_PCT = 0.8;
  const leverage = 5;

  let lowWaterMark = entryPrice; // For SHORT, we track LWM
  let trailingActive = false;
  let trailingStopPrice = 0;
  let breachCount = 0;

  console.log('\n=== CANDLE BY CANDLE SIMULATION ===\n');

  for (let i = 0; i < ohlcv.length; i++) {
    const c = ohlcv[i];
    const ts = new Date(c[0]).toISOString().slice(11, 19);
    const high = c[2] as number;
    const low = c[3] as number;
    const close = c[4] as number;

    // Skip candles before entry
    if (c[0] <= entryCandle[0]) continue;

    // Update LWM (for SHORT)
    if (low < lowWaterMark) {
      lowWaterMark = low;
    }

    // Calculate PnL
    const pnlPct = ((entryPrice - close) / entryPrice) * 100;

    // Check trailing activation
    if (!trailingActive && pnlPct >= TRAILING_ACTIVATION_PCT) {
      trailingActive = true;
      console.log(`[${ts}] 🟢 TRAILING ACTIVATED at PnL ${pnlPct.toFixed(2)}%`);
    }

    if (trailingActive) {
      // Calculate trailing stop (for SHORT: LWM × (1 + distance))
      trailingStopPrice = lowWaterMark * (1 + TRAILING_DISTANCE_PCT / 100);

      // Check if breached (for SHORT: close > trailing stop)
      const breached = close >= trailingStopPrice;

      console.log(`[${ts}] Close=$${close.toFixed(4)} | LWM=$${lowWaterMark.toFixed(4)} | Trail=$${trailingStopPrice.toFixed(4)} | PnL=${pnlPct.toFixed(2)}% | Breach=${breached ? '⚠️ YES' : 'no'}`);

      if (breached) {
        breachCount++;
        if (breachCount >= 2) {
          console.log(`\n🔴 EXIT TRIGGERED after ${breachCount} consecutive breaches!`);

          // Calculate PnL with different exit prices
          const exitAtTrailStop = trailingStopPrice;
          const exitAtClose = close;

          const pnlAtTrailStop = ((entryPrice - exitAtTrailStop) / entryPrice) * 100 * leverage;
          const pnlAtClose = ((entryPrice - exitAtClose) / entryPrice) * 100 * leverage;

          console.log('\n=== EXIT PRICE COMPARISON ===');
          console.log(`Entry price:        $${entryPrice.toFixed(4)}`);
          console.log(`Low Water Mark:     $${lowWaterMark.toFixed(4)}`);
          console.log(`Trailing Stop:      $${exitAtTrailStop.toFixed(4)} (LWM × 1.008)`);
          console.log(`Candle Close:       $${exitAtClose.toFixed(4)}`);
          console.log('');
          console.log(`Price gap:          $${(exitAtClose - exitAtTrailStop).toFixed(4)} (${((exitAtClose - exitAtTrailStop) / exitAtTrailStop * 100).toFixed(2)}%)`);
          console.log('');
          console.log(`PnL at Trail Stop:  ${pnlAtTrailStop.toFixed(2)}% (theoretical)`);
          console.log(`PnL at Close:       ${pnlAtClose.toFixed(2)}% (realistic)`);
          console.log(`PnL DIFFERENCE:     ${(pnlAtTrailStop - pnlAtClose).toFixed(2)}%`);

          // Show what happens in a WINNING trade
          console.log('\n=== IMPACT ON A WINNING TRADE ===');
          console.log('If trail stop was $1.52 and close was $1.595:');
          const trailExample = 1.52;
          const closeExample = 1.595;
          const entryExample = 1.7339;
          const pnlTrail = ((entryExample - trailExample) / entryExample) * 100 * 5;
          const pnlClose = ((entryExample - closeExample) / entryExample) * 100 * 5;
          console.log(`PnL at $${trailExample}: ${pnlTrail.toFixed(2)}%`);
          console.log(`PnL at $${closeExample}: ${pnlClose.toFixed(2)}%`);
          console.log(`Difference: ${(pnlTrail - pnlClose).toFixed(2)}%`);

          break;
        }
      } else {
        breachCount = 0;
      }
    } else {
      console.log(`[${ts}] Close=$${close.toFixed(4)} | PnL=${pnlPct.toFixed(2)}% | Waiting for trailing activation...`);
    }
  }

  // THE REAL PROBLEM
  console.log('\n' + '='.repeat(80));
  console.log('THE REAL PROBLEM');
  console.log('='.repeat(80));
  console.log(`
When the 2-candle confirmation triggers:
1. First breach candle: close is BELOW trailing stop (triggers count=1)
2. Second breach candle: close is STILL BELOW trailing stop (triggers count=2)

At the moment of exit (end of 2nd breach candle):
- Trailing stop is at LWM × 1.008 (the BEST price during the trade + 0.8%)
- Candle close could be MUCH higher (for SHORT) because:
  - The price has been recovering for 2 full candles (30 minutes!)
  - Each candle close is above the trailing stop (that's why it's a breach)

Example:
- LWM = $1.50 (lowest point)
- Trailing stop = $1.512 (LWM × 1.008)
- After 2 candles of breach, close might be $1.60 (price recovered significantly)

This creates a GAP of 5.8% on price × 5 leverage = 29% difference in PnL!
`);

  console.log('\n=== OPTIONS TO FIX THIS ===\n');
  console.log('1. USE EXCHANGE TRAILING STOP');
  console.log('   - Binance executes automatically at trailing level');
  console.log('   - No 2-candle delay');
  console.log('   - Risk: wicks can trigger premature exit');
  console.log('');
  console.log('2. EXIT ON FIRST BREACH (not 2-candle confirmation)');
  console.log('   - Less gap because we exit earlier');
  console.log('   - Risk: more false positives (fakeouts)');
  console.log('');
  console.log('3. USE LIMIT ORDER AT TRAILING STOP LEVEL');
  console.log('   - When trailing activates, place LIMIT order at stop level');
  console.log('   - If price touches it, we exit at exact level');
  console.log('   - More complex to manage');
  console.log('');
  console.log('4. BACKTEST WITH MORE REALISTIC EXIT PRICE');
  console.log('   - Use the HIGH of the breach candle (for SHORT) instead of close');
  console.log('   - This is closer to what a limit order would get');
  console.log('   - Still optimistic but more realistic than theoretical stop');
}

main().catch(console.error);

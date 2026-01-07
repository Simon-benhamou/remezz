import ccxt from 'ccxt';
const exchange = new ccxt.binance({ enableRateLimit: true });

// Check candle at 14:15 and 14:30 for SEI
const ts1415 = new Date('2026-01-07T14:15:00.000Z').getTime();
const ts1430 = new Date('2026-01-07T14:30:00.000Z').getTime();

const candles = await exchange.fetchOHLCV('SEI/USDT', '15m', ts1415 - 60*60*1000, 20);

console.log('SEI 15m Candles around entry time:');
console.log('Timestamp            | Open     | High     | Low      | Close');
console.log('─'.repeat(70));

for (const c of candles) {
  if (c[0] >= ts1415 - 30*60*1000 && c[0] <= ts1430 + 30*60*1000) {
    const ts = new Date(c[0]).toISOString();
    console.log(`${ts} | $${c[1].toFixed(5)} | $${c[2].toFixed(5)} | $${c[3].toFixed(5)} | $${c[4].toFixed(5)}`);
  }
}

console.log('\n📍 Live trade entry price: $0.1245');
console.log('📍 Which candle has CLOSE = $0.1245?');
const matchingCandle = candles.find(c => Math.abs(c[4] - 0.1245) < 0.0001);
if (matchingCandle) {
  console.log(`   → Found at ${new Date(matchingCandle[0]).toISOString()}`);
} else {
  console.log('   → No exact match found!');
  const closest = candles.reduce((best, c) => 
    Math.abs(c[4] - 0.1245) < Math.abs(best[4] - 0.1245) ? c : best
  );
  console.log(`   → Closest: ${new Date(closest[0]).toISOString()} with close $${closest[4].toFixed(5)}`);
}

console.log('\n📍 Checking candle 14:15 close (what backtest would enter at):');
const c1415 = candles.find(c => c[0] === ts1415);
if (c1415) {
  console.log(`   Candle 14:15 close: $${c1415[4].toFixed(5)}`);
}

console.log('\n📍 Checking candle 14:30:');
const c1430 = candles.find(c => c[0] === ts1430);
if (c1430) {
  console.log(`   Candle 14:30 close: $${c1430[4].toFixed(5)}`);
  console.log(`   Candle 14:30 open: $${c1430[1].toFixed(5)}`);
  console.log(`   Candle 14:30 low: $${c1430[3].toFixed(5)}`);
}

console.log('\n📍 ANALYSIS:');
console.log('   Live entry price $0.1245 is close to:');
if (c1415) console.log(`   - Candle 14:15 open: $${c1415[1].toFixed(5)}`);
if (c1430) console.log(`   - Candle 14:30 open: $${c1430[1].toFixed(5)}`);
if (c1430) console.log(`   - Candle 14:30 low: $${c1430[3].toFixed(5)}`);

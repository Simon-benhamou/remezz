import { readFileSync } from 'fs';

// Load SEI candle data - format is [timestamp, open, high, low, close, volume]
const raw = JSON.parse(readFileSync('./data/SEI_USDT_15m.json', 'utf-8'));
const data = raw.candles.map(c => ({
  openTime: c[0],
  open: c[1],
  high: c[2],
  low: c[3],
  close: c[4],
  volume: c[5],
  closeTime: c[0] + 15 * 60 * 1000 - 1 // 15min candle
}));

// Find candles around 14:30 on Jan 7 2026
const targetTime = new Date('2026-01-07T14:00:00Z').getTime();
const relevantCandles = data.filter(c => {
  const time = c.openTime;
  return time >= targetTime - 3600000 && time <= targetTime + 7200000;
});

console.log('SEI Candles around entry time:\n');
console.log('Candle Open Time       | Open     | High     | Low      | Close    | CloseTime');
console.log('─'.repeat(85));

for (const c of relevantCandles.slice(0, 12)) {
  const openTime = new Date(c.openTime).toISOString().substring(11, 19);
  const closeTime = new Date(c.closeTime).toISOString().substring(11, 19);
  console.log(
    openTime.padEnd(22) + ' | ' +
    c.open.toFixed(5).padEnd(8) + ' | ' +
    c.high.toFixed(5).padEnd(8) + ' | ' +
    c.low.toFixed(5).padEnd(8) + ' | ' +
    c.close.toFixed(5).padEnd(8) + ' | ' +
    closeTime
  );
}

console.log('\n\n=== CRITICAL: Entry at 14:30:07-14 ===');
console.log('DB Entry Price: $0.1245');

// Find the candle that was "last closed" at 14:30
const candle1415 = relevantCandles.find(c => {
  const openTime = new Date(c.openTime);
  return openTime.getUTCHours() === 14 && openTime.getUTCMinutes() === 15;
});

if (candle1415) {
  console.log('\nCandle 14:15 (closes at 14:30):');
  console.log('  - Open:  $' + candle1415.open.toFixed(5));
  console.log('  - High:  $' + candle1415.high.toFixed(5));
  console.log('  - Low:   $' + candle1415.low.toFixed(5) + (candle1415.low === 0.1245 ? ' <<<< MATCHES ENTRY!' : ''));
  console.log('  - Close: $' + candle1415.close.toFixed(5));
}

// Also check candle 14:30
const candle1430 = relevantCandles.find(c => {
  const openTime = new Date(c.openTime);
  return openTime.getUTCHours() === 14 && openTime.getUTCMinutes() === 30;
});

if (candle1430) {
  console.log('\nCandle 14:30 (opens at 14:30):');
  console.log('  - Open:  $' + candle1430.open.toFixed(5) + (candle1430.open === 0.1245 ? ' <<<< MATCHES ENTRY!' : ''));
  console.log('  - High:  $' + candle1430.high.toFixed(5));
  console.log('  - Low:   $' + candle1430.low.toFixed(5));
  console.log('  - Close: $' + candle1430.close.toFixed(5));
}

console.log('\n\n=== ANALYSIS ===');
if (candle1415) {
  const lowMatch = candle1415.low === 0.1245;
  const closeMatch = candle1415.close === 0.1245;
  
  if (lowMatch && !closeMatch) {
    console.log('❌ PROBLEM: Entry price $0.1245 = candle LOW, not CLOSE');
    console.log('   Expected: Entry should be at CLOSE $' + candle1415.close.toFixed(5));
    console.log('   Actual:   Entry is at LOW $' + candle1415.low.toFixed(5));
  } else if (closeMatch) {
    console.log('✅ Entry price matches candle CLOSE - correct behavior');
  }
}

if (candle1430) {
  const openMatch = candle1430.open === 0.1245;
  if (openMatch) {
    console.log('ℹ️  Note: Entry also matches candle 14:30 OPEN');
  }
}

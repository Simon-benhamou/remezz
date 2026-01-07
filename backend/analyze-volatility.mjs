import fs from 'fs';

// Analyser la volatilité réelle des candles 15min
const symbols = ['BTC', 'SOL', 'XRP', 'DOGE', 'SUI', 'LINK', 'ADA'];

console.log('=== VOLATILITÉ RÉELLE DES CANDLES 15MIN ===\n');

for (const sym of symbols) {
  try {
    const raw = JSON.parse(fs.readFileSync(`./data/${sym}_USDT_15m.json`));
    // Format: { symbol, timeframe, candles: [[ts, open, high, low, close, volume], ...] }
    const rawCandles = raw.candles || raw;
    const candles = rawCandles.slice(-500).map(c => ({
      timestamp: c[0],
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
      volume: c[5]
    }));
    
    // Calculer la volatilité moyenne par candle
    const moves = [];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i];
      const prev = candles[i-1];
      
      // Mouvement en % depuis le close précédent
      const moveFromClose = Math.abs((c.close - prev.close) / prev.close) * 100;
      
      // Range intra-candle (high-low)
      const range = ((c.high - c.low) / c.low) * 100;
      
      moves.push({ moveFromClose, range });
    }
    
    // Stats 1 candle
    const avgMove = moves.reduce((a,b) => a + b.moveFromClose, 0) / moves.length;
    const sorted = moves.map(m => m.moveFromClose).sort((a,b) => a-b);
    const p90 = sorted[Math.floor(sorted.length * 0.90)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const maxMove = Math.max(...moves.map(m => m.moveFromClose));
    const avgRange = moves.reduce((a,b) => a + b.range, 0) / moves.length;
    
    // En 2 candles (30 min) - ce qu'on perd avec 2-close confirmation
    const twoCandle = [];
    for (let i = 2; i < candles.length; i++) {
      const move2 = Math.abs((candles[i].close - candles[i-2].close) / candles[i-2].close) * 100;
      twoCandle.push(move2);
    }
    const avg2Candle = twoCandle.reduce((a,b) => a+b, 0) / twoCandle.length;
    const sorted2 = [...twoCandle].sort((a,b) => a-b);
    const p90_2 = sorted2[Math.floor(sorted2.length * 0.90)];
    const max2Candle = Math.max(...twoCandle);
    
    console.log(`${sym}:`);
    console.log(`  1 candle (15m): avg=${avgMove.toFixed(2)}% | p90=${p90.toFixed(2)}% | p95=${p95.toFixed(2)}% | max=${maxMove.toFixed(2)}%`);
    console.log(`  2 candles (30m): avg=${avg2Candle.toFixed(2)}% | p90=${p90_2.toFixed(2)}% | max=${max2Candle.toFixed(2)}%`);
    console.log(`  Avg intra-candle range: ${avgRange.toFixed(2)}%`);
    console.log('');
  } catch(e) {
    console.log(`${sym}: Error - ${e.message}`);
  }
}

console.log('\n=== IMPACT SUR LE TRAILING ===\n');
console.log('Trailing distance actuel: 0.5% (tight) / 0.8% (wide)');
console.log('Avec 2-close confirmation, tu attends ~30 min après le breach.');
console.log('');
console.log('Scénario typique:');
console.log('  - Tu as +3% de profit, trailing stop à +2.5%');
console.log('  - Prix casse le trailing, 1ère confirmation');
console.log('  - 15 min plus tard, 2ème confirmation');
console.log('  - Exit au close de la 2ème candle');
console.log('');
console.log('Giveback moyen (2 candles): ~0.5-1% sur altcoins');
console.log('Giveback P90 (worst case): ~1.5-2.5%');
console.log('');
console.log('→ En pratique, avec trailing 0.5% + 2 confirmations,');
console.log('  tu sors souvent ~1-1.5% sous le peak.');
console.log('  Sur un trade +3%, tu gardes +1.5-2%.');

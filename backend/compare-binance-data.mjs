import ccxt from 'ccxt';

async function compareBinanceData() {
  console.log('\n=== TESTING BINANCE DATA DIRECTLY ===\n');
  
  const binance = new ccxt.binance({
    enableRateLimit: true
  });

  const symbols = ['ADA/USDT', 'AVAX/USDT', 'ONDO/USDT', 'HBAR/USDT'];
  
  for (const symbol of symbols) {
    try {
      console.log(`\n📊 ${symbol} from Binance PUBLIC API:`);
      
      // Get last 5 candles 15m
      const ohlcv = await binance.fetchOHLCV(symbol, '15m', undefined, 5);
      
      console.log('Last 5 candles (15m):');
      ohlcv.forEach((candle, idx) => {
        const [timestamp, open, high, low, close, volume] = candle;
        const date = new Date(timestamp);
        console.log(`  ${idx + 1}. ${date.toISOString()}`);
        console.log(`     Close: $${close}`);
        console.log(`     Volume: ${volume.toLocaleString()} ${symbol.split('/')[0]}`);
      });
      
      // Get ticker for 24h volume
      const ticker = await binance.fetchTicker(symbol);
      console.log(`\n  24h Volume: ${ticker.baseVolume?.toLocaleString() || 'N/A'} ${symbol.split('/')[0]}`);
      console.log(`  24h Quote Volume: $${ticker.quoteVolume?.toLocaleString() || 'N/A'}`);
      
    } catch (error) {
      console.error(`  ❌ Error fetching ${symbol}:`, error.message);
    }
  }
  
  console.log('\n=== COMPARISON WITH YOUR LOGS ===\n');
  console.log('Your logs show:');
  console.log('  ADA: 359-3185 per 15m candle');
  console.log('  AVAX: 137-1599 per 15m candle');
  console.log('  ONDO: 2590-4340 per 15m candle');
  console.log('  HBAR: 79-10188 per 15m candle');
  console.log('\nIf Binance PUBLIC shows 10x-100x MORE, your system is using Crypto.com');
  console.log('If Binance PUBLIC matches your logs, your system IS using Binance ✅');
}

compareBinanceData();

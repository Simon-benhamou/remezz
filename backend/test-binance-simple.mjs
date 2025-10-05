import ccxt from 'ccxt';

async function testBinanceSimple() {
  console.log('\n🔐 Testing Binance API Key from Screenshot\n');
  
  // Using the API key from your screenshot
  const apiKey = 'I2lWNLXpr3OuVHwGiU8PsDsS2ddedrlkc4giXfgJyc03dgZlzTdFGRTLL0cCDVtm';
  
  console.log('⚠️  Note: I cannot test with secret key (it\'s hidden)\n');
  console.log('Testing public endpoints that don\'t require auth...\n');
  
  const binance = new ccxt.binance({
    enableRateLimit: true,
    options: {
      defaultType: 'spot'
    }
  });
  
  // Test public endpoint
  console.log('Test 1: Fetching ADA/USDT ticker (public, no auth)...');
  try {
    const ticker = await binance.fetchTicker('ADA/USDT');
    console.log('✅ Ticker fetch SUCCESS');
    console.log(`   ADA/USDT Price: $${ticker.last}`);
    console.log(`   24h Volume: ${ticker.baseVolume?.toLocaleString()} ADA`);
  } catch (error) {
    console.log('❌ Ticker fetch FAILED:', error.message);
  }
  
  console.log('\n📝 To test authenticated endpoints:');
  console.log('   You need to test from your PRODUCTION server (208.77.244.15)');
  console.log('   Or restart your backend there and check the logs\n');
  
  console.log('🔧 Your Binance API Configuration:');
  console.log('   ✅ Enable Reading: ON');
  console.log('   ✅ Enable Spot & Margin Trading: ON');
  console.log('   ⚠️  Enable Futures: ON (not needed for our system)');
  console.log('   ⚠️  Permits Universal Transfer: ON (not needed)');
  console.log('   ✅ IP Whitelist: 208.77.244.15, 62.90.85.110');
  console.log('\n   Recommendation: Keep only Reading + Spot Trading for security');
}

testBinanceSimple();

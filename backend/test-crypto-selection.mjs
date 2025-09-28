import { getOptimizedCryptoList } from './src/services/intelligentAgent.ts';

async function testCryptoSelection() {
  console.log('🚀 Testing crypto selection logic...\n');

  try {
    const topCryptos = await getOptimizedCryptoList();

    console.log('🎯 TOP 20 CRYPTOS SELECTED FOR TRADING:\n');

    topCryptos.slice(0, 20).forEach((crypto, index) => {
      console.log(`${(index + 1).toString().padStart(2, ' ')}. ${crypto}`);
    });

    console.log(`\n✅ Found ${topCryptos.length} eligible cryptos for trading`);
    console.log('\n📊 Selection Criteria:');
    console.log('   • Bidirectional 24h price variation (gains & losses)');
    console.log('   • Minimum $200K USD trading volume');
    console.log('   • Blacklist filtering for micro-cap tokens');
    console.log('   • Scoring: 60% price change + 40% volume');

  } catch (error) {
    console.error('❌ Error testing crypto selection:', error);
  }
}

testCryptoSelection();
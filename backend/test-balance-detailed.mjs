import 'dotenv/config';
import { getUserCredentials } from './src/services/userCredentials.ts';
import ccxt from 'ccxt';

async function testDetailedBalanceRetrieval() {
  console.log('🔍 Testing detailed Binance balance retrieval for user "simon"\n');

  try {
    // Get user credentials
    const userId = 'cmftkdhxr0000jilspwd7kwge'; // simon's user ID
    const credentials = await getUserCredentials(userId, 'binance');

    if (!credentials) {
      console.log('❌ No Binance credentials found for user');
      return;
    }

    console.log('✅ Credentials retrieved successfully');
    console.log(`Exchange: ${credentials.exchange}`);
    console.log(`API Key: ${credentials.apiKey.substring(0, 10)}...\n`);

    // Test with Futures API (where trading happens)
    console.log('🟢 Testing Futures Account Balance (where trading happens)...');
    const futuresExchange = new ccxt.binance({
      apiKey: credentials.apiKey,
      secret: credentials.apiSecret,
      enableRateLimit: true,
      options: { defaultType: 'future' }
    });

    try {
      console.log('📡 Fetching futures balance...');
      const futuresBalance = await futuresExchange.fetchBalance();
      console.log('📊 RAW FUTURES BALANCE RESPONSE:');
      console.log(JSON.stringify(futuresBalance, null, 2));
      console.log('\n');

      // Check USDT specifically
      const usdtTotal = futuresBalance.total?.USDT || 0;
      const usdtFree = futuresBalance.free?.USDT || 0;
      const usdtUsed = futuresBalance.used?.USDT || 0;

      console.log(`💰 USDT in Futures Account:`);
      console.log(`   Total: ${usdtTotal} USDT`);
      console.log(`   Free: ${usdtFree} USDT`);
      console.log(`   Used: ${usdtUsed} USDT`);

      // Check USD specifically
      const usdTotal = futuresBalance.total?.USD || 0;
      const usdFree = futuresBalance.free?.USD || 0;
      const usdUsed = futuresBalance.used?.USD || 0;

      console.log(`💵 USD in Futures Account:`);
      console.log(`   Total: ${usdTotal} USD`);
      console.log(`   Free: ${usdFree} USD`);
      console.log(`   Used: ${usdUsed} USD`);

      // Show all non-zero assets in futures
      const futuresAssets = Object.entries(futuresBalance.total || {})
        .filter(([_, amount]) => (amount || 0) > 0)
        .sort((a, b) => (b[1] || 0) - (a[1] || 0));

      console.log(`\n📋 All assets in Futures Account (${futuresAssets.length} assets):`);
      if (futuresAssets.length > 0) {
        futuresAssets.forEach(([asset, amount]) => {
          const free = futuresBalance.free?.[asset] || 0;
          const used = futuresBalance.used?.[asset] || 0;
          console.log(`   ${asset}: ${amount} total (${free} free, ${used} used)`);
        });
      } else {
        console.log('   ❌ No assets found in futures account');
      }

    } catch (error) {
      console.log('❌ Futures balance fetch failed:', error.message);
    }

    console.log('\n' + '='.repeat(50) + '\n');

    // Test with Portfolio Margin API (where funds might be located)
    console.log('🟢 Testing Portfolio Margin Account Balance...');
    const marginExchange = new ccxt.binance({
      apiKey: credentials.apiKey,
      secret: credentials.apiSecret,
      enableRateLimit: true,
      options: { defaultType: 'margin' }
    });

    try {
      console.log('📡 Fetching portfolio margin balance...');
      const marginBalance = await marginExchange.fetchBalance();
      console.log('📊 RAW PORTFOLIO MARGIN BALANCE RESPONSE:');
      console.log(JSON.stringify(marginBalance, null, 2));
      console.log('\n');

      // Check USDT specifically
      const usdtTotal = marginBalance.total?.USDT || 0;
      const usdtFree = marginBalance.free?.USDT || 0;
      const usdtUsed = marginBalance.used?.USDT || 0;

      console.log(`💰 USDT in Portfolio Margin Account:`);
      console.log(`   Total: ${usdtTotal} USDT`);
      console.log(`   Free: ${usdtFree} USDT`);
      console.log(`   Used: ${usdtUsed} USDT`);

      // Check USD specifically
      const usdTotal = marginBalance.total?.USD || 0;
      const usdFree = marginBalance.free?.USD || 0;
      const usdUsed = marginBalance.used?.USD || 0;

      console.log(`💵 USD in Portfolio Margin Account:`);
      console.log(`   Total: ${usdTotal} USD`);
      console.log(`   Free: ${usdFree} USD`);
      console.log(`   Used: ${usdUsed} USD`);

      // Show all non-zero assets in portfolio margin
      const marginAssets = Object.entries(marginBalance.total || {})
        .filter(([_, amount]) => (amount || 0) > 0)
        .sort((a, b) => (b[1] || 0) - (a[1] || 0));

      console.log(`\n📋 All assets in Portfolio Margin Account (${marginAssets.length} assets):`);
      if (marginAssets.length > 0) {
        marginAssets.forEach(([asset, amount]) => {
          const free = marginBalance.free?.[asset] || 0;
          const used = marginBalance.used?.[asset] || 0;
          console.log(`   ${asset}: ${amount} total (${free} free, ${used} used)`);
        });
      } else {
        console.log('   ❌ No assets found in portfolio margin account');
      }

    } catch (error) {
      console.log('❌ Portfolio margin balance fetch failed:', error.message);
    }

    console.log('\n' + '='.repeat(50) + '\n');
    console.log('🟢 Testing Spot Account Balance (where deposits usually go)...');
    const spotExchange = new ccxt.binance({
      apiKey: credentials.apiKey,
      secret: credentials.apiSecret,
      enableRateLimit: true,
      options: { defaultType: 'spot' }
    });

    try {
      console.log('📡 Fetching spot balance...');
      const spotBalance = await spotExchange.fetchBalance();
      console.log('📊 RAW SPOT BALANCE RESPONSE:');
      console.log(JSON.stringify(spotBalance, null, 2));
      console.log('\n');

      // Check USDT specifically
      const usdtTotal = spotBalance.total?.USDT || 0;
      const usdtFree = spotBalance.free?.USDT || 0;
      const usdtUsed = spotBalance.used?.USDT || 0;

      console.log(`💰 USDT in Spot Account:`);
      console.log(`   Total: ${usdtTotal} USDT`);
      console.log(`   Free: ${usdtFree} USDT`);
      console.log(`   Used: ${usdtUsed} USDT`);

      // Check USD specifically
      const usdTotal = spotBalance.total?.USD || 0;
      const usdFree = spotBalance.free?.USD || 0;
      const usdUsed = spotBalance.used?.USD || 0;

      console.log(`💵 USD in Spot Account:`);
      console.log(`   Total: ${usdTotal} USD`);
      console.log(`   Free: ${usdFree} USD`);
      console.log(`   Used: ${usdUsed} USD`);

      // Show all non-zero assets in spot
      const spotAssets = Object.entries(spotBalance.total || {})
        .filter(([_, amount]) => (amount || 0) > 0)
        .sort((a, b) => (b[1] || 0) - (a[1] || 0));

      console.log(`\n📋 All assets in Spot Account (${spotAssets.length} assets):`);
      if (spotAssets.length > 0) {
        spotAssets.forEach(([asset, amount]) => {
          const free = spotBalance.free?.[asset] || 0;
          const used = spotBalance.used?.[asset] || 0;
          console.log(`   ${asset}: ${amount} total (${free} free, ${used} used)`);
        });
      } else {
        console.log('   ❌ No assets found in spot account');
      }

    } catch (error) {
      console.log('❌ Spot balance fetch failed:', error.message);
    }

    console.log('\n' + '='.repeat(50) + '\n');

    // Summary and recommendations
    console.log('📝 SUMMARY:');
    console.log('If you see your funds in SPOT but not in FUTURES:');
    console.log('   → You need to transfer funds from Spot to Futures account on Binance');
    console.log('   → Go to Binance → Futures → Transfer → Move USDT from Spot to Futures');
    console.log('');
    console.log('If you see your funds in PORTFOLIO MARGIN but not in FUTURES:');
    console.log('   → Portfolio Margin funds need to be transferred to COIN-M Futures');
    console.log('   → Go to Binance → Portfolio Margin → Transfer → Move to COIN-M Futures');
    console.log('');
    console.log('If you don\'t see your funds anywhere:');
    console.log('   → Check if the API key has correct permissions');
    console.log('   → Verify the API key/secret are correct');
    console.log('   → Check if funds are in a different account type');

  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

testDetailedBalanceRetrieval();
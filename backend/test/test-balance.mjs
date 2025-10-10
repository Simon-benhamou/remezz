import 'dotenv/config';
import { getUserCredentials } from '../src/services/userCredentials.ts';
import { getBalanceFromWebSocket, subscribeToUserData } from '../src/services/binanceWebSocket.ts';
import ccxt from 'ccxt';

async function testBalanceRetrieval() {
  console.log('🔑 Testing Binance balance retrieval for user "simon"\n');

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
    console.log(`API Key: ${credentials.apiKey.substring(0, 10)}...`);
    console.log(`API Secret: ${credentials.apiSecret.substring(0, 10)}...\n`);

    // Test WebSocket balance retrieval
    console.log('🟢 Testing WebSocket balance retrieval...');
    try {
      await subscribeToUserData(userId, credentials.apiKey, credentials.apiSecret);
      let wsBalance = await getBalanceFromWebSocket(userId, 'USDT');
      if (!wsBalance || wsBalance.total === 0) {
        // Try USD if USDT is empty (Binance sometimes uses USD for futures)
        wsBalance = await getBalanceFromWebSocket(userId, 'USD');
      }

      if (wsBalance && wsBalance.total > 0) {
        console.log('✅ WebSocket balance retrieved successfully:');
        console.log(`   ${wsBalance.asset} Total: ${wsBalance.total}`);
        console.log(`   ${wsBalance.asset} Free: ${wsBalance.free}`);
        console.log(`   ${wsBalance.asset} Locked: ${wsBalance.locked}`);
      } else {
        console.log('⚠️ WebSocket balance returned null or zero, trying REST API...');

        // Fallback to REST API
        const exchange = new ccxt.binance({
          apiKey: credentials.apiKey,
          secret: credentials.apiSecret,
          enableRateLimit: true,
          options: { defaultType: 'future' } // Futures for perpetuals
        });

        const balance = await exchange.fetchBalance();
        console.log('✅ REST API balance retrieved successfully:');

        // Prefer USDT, fallback to USD if USDT is zero
        let asset = 'USDT';
        let total = balance.total?.USDT || 0;
        let free = balance.free?.USDT || 0;
        let used = balance.used?.USDT || 0;
        if (total === 0) {
          asset = 'USD';
          total = balance.total?.USD || 0;
          free = balance.free?.USD || 0;
          used = balance.used?.USD || 0;
        }

        // If still zero, check if there are any assets at all
        if (total === 0) {
          const allAssets = Object.entries(balance.total || {})
            .filter(([_, amt]) => (amt || 0) > 0)
            .sort((a, b) => (b[1] || 0) - (a[1] || 0));

          if (allAssets.length > 0) {
            const [topAsset, topAmount] = allAssets[0];
            console.log(`⚠️ No USDT/USD in futures account, but found ${topAmount} ${topAsset}`);
            console.log('💡 You may need to transfer funds from spot to futures account on Binance');
            asset = topAsset;
            total = topAmount || 0;
            free = balance.free?.[topAsset] || 0;
            used = balance.used?.[topAsset] || 0;
          } else {
            console.log('⚠️ No assets found in futures account');
            console.log('💡 You need to deposit funds to your Binance futures account');
            console.log('   1. Go to Binance website/app');
            console.log('   2. Navigate to Futures section');
            console.log('   3. Transfer funds from Spot to Futures');
          }
        }

        console.log(`   ${asset} Total: ${total}`);
        console.log(`   ${asset} Free: ${free}`);
        console.log(`   ${asset} Used: ${used}`);

        // Show other assets
        const assets = Object.entries(balance.total || {})
          .filter(([_, amount]) => amount > 0)
          .filter(([a]) => a !== asset)
          .slice(0, 5);

        if (assets.length > 0) {
          console.log('   Other assets:');
          assets.forEach(([a, amount]) => {
            console.log(`     ${a}: ${amount}`);
          });
        }
      }
    } catch (error) {
      console.log('❌ Balance retrieval failed:');
      console.log(`   Error: ${error.message}`);

      if (error.message.includes('API-key')) {
        console.log('   → API key issue');
      } else if (error.message.includes('signature')) {
        console.log('   → Signature/API secret issue');
      } else if (error.message.includes('IP')) {
        console.log('   → IP whitelist issue');
      } else if (error.message.includes('Permission')) {
        console.log('   → Insufficient permissions');
      }
    }

  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

testBalanceRetrieval();
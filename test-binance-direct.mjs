import { getUserCredentials } from './backend/src/services/userCredentials.ts';

async function testBinanceKeys() {
  console.log('🔑 Testing Binance API keys for user "simon"\n');

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

    // Test direct API call to Binance
    console.log('🟢 Testing direct Binance API call...');

    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const crypto = await import('crypto');
    const signature = crypto
      .createHmac('sha256', credentials.apiSecret)
      .update(queryString)
      .digest('hex');

    const url = `https://fapi.binance.com/fapi/v2/account?${queryString}&signature=${signature}`;

    console.log('📡 Making request to:', url.replace(credentials.apiSecret, '***'));

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-MBX-APIKEY': credentials.apiKey
      }
    });

    if (response.ok) {
      const data = await response.json();
      console.log('✅ Binance API call successful!');
      console.log('Account data:');
      console.log(`- Total wallet balance: ${data.totalWalletBalance}`);
      console.log(`- Available balance: ${data.availableBalance}`);
      console.log(`- Positions count: ${data.positions?.length || 0}`);

      // Check assets
      const assets = data.assets || [];
      console.log('\n💰 Assets:');
      assets.forEach(asset => {
        if (parseFloat(asset.walletBalance) > 0) {
          console.log(`  ${asset.asset}: ${asset.walletBalance} (available: ${asset.availableBalance})`);
        }
      });

    } else {
      const error = await response.text();
      console.log('❌ Binance API call failed:');
      console.log(`Status: ${response.status}`);
      console.log(`Error: ${error}`);
    }

  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

testBinanceKeys();
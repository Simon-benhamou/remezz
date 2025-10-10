import 'dotenv/config';
import { getUserCredentials } from '../src/services/userCredentials.js';
import ccxt from 'ccxt';

async function testPortfolioMarginAccess() {
  console.log('🔍 Testing Portfolio Margin account access...\n');

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

    // Test different account types and exchanges
    const accountTypes = [
      { type: 'spot (binance)', exchange: 'binance', method: 'fetchBalance', options: { defaultType: 'spot' } },
      { type: 'futures (binance)', exchange: 'binance', method: 'fetchBalance', options: { defaultType: 'future' } },
      { type: 'coin-m (binancecoinm)', exchange: 'binancecoinm', method: 'fetchBalance', options: { defaultType: 'delivery' } },
      { type: 'portfolio-margin (binance)', exchange: 'binance', method: 'fetchBalance', options: { defaultType: 'margin' } }
    ];

    for (const account of accountTypes) {
      try {
        console.log(`Testing ${account.type} account...`);
        const ExchangeClass = ccxt[account.exchange];
        const exchange = new ExchangeClass({
          apiKey: credentials.apiKey,
          secret: credentials.apiSecret,
          enableRateLimit: true,
          options: account.options
        });

        const balance = await exchange[account.method]();

        // Check for USDT, USD, and USDC balances
        const usdtBalance = balance.USDT?.total || 0;
        const usdBalance = balance.USD?.total || 0;
        const usdcBalance = balance.USDC?.total || 0;
        
        console.log(`  ${account.type}: USDT=${usdtBalance}, USD=${usdBalance}, USDC=${usdcBalance}`);

        if (usdtBalance > 0 || usdBalance > 0 || usdcBalance > 0) {
          console.log(`  ✅ Found funds in ${account.type} account!`);
        }

      } catch (error) {
        console.log(`  ❌ ${account.type} failed: ${error.message}`);
      }
    }

    // Try to get account info from different exchanges
    const exchangesToTest = [
      { name: 'binance (spot)', exchange: 'binance' },
      { name: 'binancecoinm (coin-m)', exchange: 'binancecoinm' }
    ];

    for (const exchangeType of exchangesToTest) {
      console.log(`\n📋 Getting account information from ${exchangeType.name}...`);
      try {
        const ExchangeClass = ccxt[exchangeType.exchange];
        const exchange = new ExchangeClass({
          apiKey: credentials.apiKey,
          secret: credentials.apiSecret,
          enableRateLimit: true
        });
        const accountInfo = await exchange.privateGetAccount();
        console.log('Account type:', accountInfo.accountType);
        console.log('Permissions:', accountInfo.permissions);
        if (accountInfo.balances) {
          const usdtBalance = accountInfo.balances.find(b => b.asset === 'USDT');
          const usdBalance = accountInfo.balances.find(b => b.asset === 'USD');
          const usdcBalance = accountInfo.balances.find(b => b.asset === 'USDC');
          
          console.log('USDT balance:', usdtBalance);
          console.log('USD balance:', usdBalance);
          console.log('USDC balance:', usdcBalance);
          
          // Show all non-zero balances
          const nonZeroBalances = accountInfo.balances.filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);
          console.log('Non-zero balances:', nonZeroBalances);
        }
      } catch (error) {
        console.log(`${exchangeType.name} account info failed:`, error.message);
      }
    }

  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

testPortfolioMarginAccess();
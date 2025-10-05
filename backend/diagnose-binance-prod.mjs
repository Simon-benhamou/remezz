#!/usr/bin/env node
import { PrismaClient } from '@prisma/client';
import ccxt from 'ccxt';
import crypto from 'crypto';

const prisma = new PrismaClient();

// Load environment variables from process.env (should be set in production)
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

function decrypt(encryptedData) {
  if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64) {
    throw new Error('ENCRYPTION_KEY not set or invalid in environment');
  }
  
  const parts = encryptedData.split(':');
  const iv = Buffer.from(parts[0], 'hex');
  const encryptedText = Buffer.from(parts[1], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

async function diagnose() {
  console.log('\n========================================');
  console.log('🔍 PRODUCTION BINANCE DIAGNOSTIC');
  console.log('========================================\n');

  try {
    // Step 1: Check API keys in database
    console.log('📋 STEP 1: Checking Database\n');
    
    const apiKeys = await prisma.userApiKey.findMany({
      include: { user: { select: { email: true } } },
      orderBy: { updatedAt: 'desc' }
    });

    if (apiKeys.length === 0) {
      console.log('❌ NO API KEYS FOUND IN DATABASE!');
      await prisma.$disconnect();
      return;
    }

    console.log(`Found ${apiKeys.length} API key(s):\n`);
    apiKeys.forEach((key, idx) => {
      const status = key.isActive ? '✅ ACTIVE' : '⭕ Inactive';
      console.log(`${idx + 1}. ${status} - ${key.exchange.toUpperCase()} (${key.user.email})`);
    });

    const activeKey = apiKeys.find(k => k.isActive);
    if (!activeKey) {
      console.log('\n❌ NO ACTIVE API KEY FOUND!');
      console.log('   Please activate one via the frontend toggle.');
      await prisma.$disconnect();
      return;
    }

    console.log(`\n🎯 Active Exchange: ${activeKey.exchange.toUpperCase()}\n`);

    // Step 2: Check encryption key
    console.log('🔐 STEP 2: Checking Encryption\n');
    
    if (!ENCRYPTION_KEY) {
      console.log('❌ ENCRYPTION_KEY not set in environment!');
      console.log('   This is required to decrypt API credentials.');
      await prisma.$disconnect();
      return;
    }
    
    console.log(`✅ ENCRYPTION_KEY found (length: ${ENCRYPTION_KEY.length})\n`);

    // Step 3: Decrypt and test
    console.log('🔓 STEP 3: Decrypting Credentials\n');
    
    let decryptedApiKey, decryptedApiSecret;
    try {
      decryptedApiKey = decrypt(activeKey.apiKey);
      decryptedApiSecret = decrypt(activeKey.apiSecret);
      console.log(`✅ Decryption successful`);
      console.log(`   API Key: ${decryptedApiKey.substring(0, 15)}...${decryptedApiKey.slice(-5)}`);
      console.log(`   Secret: ${decryptedApiSecret.substring(0, 15)}...${decryptedApiSecret.slice(-5)}\n`);
    } catch (error) {
      console.log(`❌ Decryption failed: ${error.message}`);
      await prisma.$disconnect();
      return;
    }

    // Step 4: Test Binance API
    console.log('📡 STEP 4: Testing Binance API Connection\n');
    
    const exchangeIdMap = {
      'crypto.com': 'cryptocom',
      'binance': 'binance'
    };
    
    const exchangeId = exchangeIdMap[activeKey.exchange] || activeKey.exchange;
    
    const exchange = new ccxt[exchangeId]({
      apiKey: decryptedApiKey,
      secret: decryptedApiSecret,
      enableRateLimit: true,
      options: {
        defaultType: 'spot'
      }
    });

    // Test 4.1: Fetch Balance
    console.log('Test 4.1: Fetching account balance...');
    try {
      const balance = await exchange.fetchBalance();
      console.log('✅ Balance fetch SUCCESS!');
      
      const nonZero = Object.entries(balance.total)
        .filter(([_, amount]) => amount > 0);
      
      console.log(`   Assets with balance: ${nonZero.length}`);
      if (nonZero.length > 0) {
        console.log('   Sample balances:');
        nonZero.slice(0, 5).forEach(([coin, amount]) => {
          console.log(`     ${coin}: ${amount}`);
        });
      }
      console.log('');
    } catch (error) {
      console.log('❌ Balance fetch FAILED!');
      console.log(`   Error: ${error.message}\n`);
      
      if (error.message.includes('IP') || error.message.includes('ip')) {
        console.log('⚠️  IP WHITELIST ISSUE');
        console.log('   Your server IP is not whitelisted on Binance');
        console.log('   Add your production IP to Binance API restrictions\n');
      }
      
      if (error.message.includes('Invalid API-key')) {
        console.log('⚠️  INVALID API KEY');
        console.log('   The API key or secret is incorrect');
        console.log('   Re-check your keys in Binance dashboard\n');
      }
      
      if (error.message.includes('Signature')) {
        console.log('⚠️  SIGNATURE ERROR');
        console.log('   The API secret might be wrong or timestamp issue\n');
      }
    }

    // Test 4.2: Fetch Market Data
    console.log('Test 4.2: Fetching market data (ADA/USDT)...');
    try {
      const ticker = await exchange.fetchTicker('ADA/USDT');
      console.log('✅ Market data fetch SUCCESS!');
      console.log(`   ADA/USDT Price: $${ticker.last}`);
      console.log(`   24h Volume: ${ticker.baseVolume?.toLocaleString()} ADA\n`);
    } catch (error) {
      console.log(`❌ Market data fetch FAILED: ${error.message}\n`);
    }

    // Step 5: Summary
    console.log('========================================');
    console.log('📊 SUMMARY');
    console.log('========================================\n');
    console.log(`Active Exchange: ${activeKey.exchange.toUpperCase()}`);
    console.log(`User: ${activeKey.user.email}`);
    console.log('\nIf balance fetch succeeded:');
    console.log('  ✅ Your Binance API is working correctly!');
    console.log('\nIf balance fetch failed:');
    console.log('  ❌ Check the error details above');
    console.log('  ❌ Verify IP whitelist on Binance');
    console.log('  ❌ Verify API key permissions (Reading + Spot Trading)');
    console.log('\n========================================\n');

  } catch (error) {
    console.error('\n❌ DIAGNOSTIC ERROR:', error.message);
    console.error(error);
  } finally {
    await prisma.$disconnect();
  }
}

diagnose();

import { PrismaClient } from '@prisma/client';
import ccxt from 'ccxt';
import crypto from 'crypto';
import dotenv from 'dotenv';

// Load .env
dotenv.config();

const prisma = new PrismaClient();

async function decrypt(encryptedData) {
  const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
  if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64) {
    throw new Error('Invalid ENCRYPTION_KEY');
  }
  
  const parts = encryptedData.split(':');
  const iv = Buffer.from(parts[0], 'hex');
  const encryptedText = Buffer.from(parts[1], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

async function testBinanceAuth() {
  console.log('\n🔐 Testing Binance API Authentication\n');
  
  // Get Binance API key
  const apiKey = await prisma.userApiKey.findFirst({
    where: { exchange: 'binance', isActive: true },
    include: { user: { select: { email: true } } }
  });
  
  if (!apiKey) {
    console.log('❌ No active Binance API key found');
    await prisma.$disconnect();
    return;
  }
  
  console.log(`User: ${apiKey.user.email}`);
  console.log(`Exchange: ${apiKey.exchange}`);
  console.log(`Active: ${apiKey.isActive}\n`);
  
  try {
    // Decrypt credentials
    const decryptedApiKey = await decrypt(apiKey.apiKey);
    const decryptedApiSecret = await decrypt(apiKey.apiSecret);
    
    console.log(`API Key: ${decryptedApiKey.substring(0, 15)}...${decryptedApiKey.substring(decryptedApiKey.length - 5)}`);
    console.log(`API Secret: ${decryptedApiSecret.substring(0, 15)}...${decryptedApiSecret.substring(decryptedApiSecret.length - 5)}\n`);
    
    // Test Binance connection
    console.log('Testing Binance API connection...\n');
    
    const binance = new ccxt.binance({
      apiKey: decryptedApiKey,
      secret: decryptedApiSecret,
      enableRateLimit: true,
      options: {
        defaultType: 'spot'
      }
    });
    
    // Test 1: Fetch balance
    console.log('Test 1: Fetching account balance...');
    try {
      const balance = await binance.fetchBalance();
      console.log('✅ Balance fetch SUCCESS');
      console.log(`   Total assets: ${Object.keys(balance.total).filter(k => balance.total[k] > 0).length}`);
      
      // Show some balances
      const nonZero = Object.entries(balance.total)
        .filter(([_, amount]) => amount > 0)
        .slice(0, 5);
      
      if (nonZero.length > 0) {
        console.log('   Sample balances:');
        nonZero.forEach(([coin, amount]) => {
          console.log(`     ${coin}: ${amount}`);
        });
      }
    } catch (error) {
      console.log('❌ Balance fetch FAILED');
      console.log(`   Error: ${error.message}`);
      
      if (error.message.includes('IP') || error.message.includes('ip')) {
        console.log('\n⚠️  IP WHITELIST ISSUE:');
        console.log(`   Your current IP (62.90.85.110) is not whitelisted on Binance`);
        console.log('   You whitelisted 208.77.244.15 but testing from different IP');
        console.log('\n   Solutions:');
        console.log('   1. Add 62.90.85.110 to Binance whitelist for local testing');
        console.log('   2. OR deploy to production (208.77.244.15) and test there');
        console.log('   3. OR temporarily remove IP restrictions on Binance');
      }
      
      if (error.message.includes('Invalid API-key')) {
        console.log('\n⚠️  API KEY ISSUE:');
        console.log('   The API key or secret is incorrect');
        console.log('   Double-check the keys in Binance dashboard');
      }
      
      if (error.message.includes('Signature')) {
        console.log('\n⚠️  SIGNATURE ISSUE:');
        console.log('   The API secret might be incorrect');
        console.log('   Or timestamp sync issue');
      }
    }
    
    // Test 2: Fetch markets (public endpoint, no auth needed)
    console.log('\nTest 2: Fetching markets (public)...');
    try {
      const markets = await binance.loadMarkets();
      console.log(`✅ Markets loaded: ${Object.keys(markets).length} pairs`);
    } catch (error) {
      console.log(`❌ Markets fetch failed: ${error.message}`);
    }
    
  } catch (error) {
    console.log('❌ Error during test:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
  }
  
  await prisma.$disconnect();
}

testBinanceAuth();

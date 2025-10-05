import ccxt from 'ccxt';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function testWhichExchange() {
  console.log('\n========================================');
  console.log('🔍 DIAGNOSTIC: Which Exchange Is Active?');
  console.log('========================================\n');

  // 1. Check database
  console.log('📋 STEP 1: Checking Database API Keys\n');
  const apiKeys = await prisma.userApiKey.findMany({
    include: { user: { select: { email: true } } },
    orderBy: { updatedAt: 'desc' }
  });

  apiKeys.forEach((key, idx) => {
    const status = key.isActive ? '✅ ACTIVE' : '⭕ Inactive';
    console.log(`${status} - ${key.exchange.toUpperCase()} (${key.user.email})`);
  });

  const activeKey = apiKeys.find(k => k.isActive);
  if (!activeKey) {
    console.log('\n❌ NO ACTIVE API KEY FOUND!');
    await prisma.$disconnect();
    return;
  }

  console.log(`\n🎯 Active Exchange: ${activeKey.exchange.toUpperCase()}\n`);

  // 2. Compare real data
  console.log('📊 STEP 2: Comparing Real Exchange Data\n');
  
  const symbol = 'ADA/USDT';
  
  // Binance data
  const binance = new ccxt.binance({ enableRateLimit: true });
  const binanceOHLCV = await binance.fetchOHLCV(symbol, '15m', undefined, 3);
  const binanceLastCandle = binanceOHLCV[binanceOHLCV.length - 1];
  const binanceVolume = binanceLastCandle[5];
  
  console.log(`Binance ${symbol} (latest 15m candle):`);
  console.log(`  Volume: ${binanceVolume.toLocaleString()} ADA`);
  console.log(`  Price: $${binanceLastCandle[4]}`);
  
  // Crypto.com data
  const cryptocom = new ccxt.cryptocom({ enableRateLimit: true });
  const cryptocomOHLCV = await cryptocom.fetchOHLCV(symbol, '15m', undefined, 3);
  const cryptocomLastCandle = cryptocomOHLCV[cryptocomOHLCV.length - 1];
  const cryptocomVolume = cryptocomLastCandle[5];
  
  console.log(`\nCrypto.com ${symbol} (latest 15m candle):`);
  console.log(`  Volume: ${cryptocomVolume.toLocaleString()} ADA`);
  console.log(`  Price: $${cryptocomLastCandle[4]}`);
  
  // Your logs show
  const yourLogVolume = 2385.6; // From your logs: 12:00:00 candle
  
  console.log(`\n📝 Your System Logs Show:`);
  console.log(`  Volume: ${yourLogVolume.toLocaleString()} ADA`);
  
  // Analysis
  console.log('\n🔬 ANALYSIS:\n');
  
  const binanceDiff = Math.abs(binanceVolume - yourLogVolume);
  const cryptocomDiff = Math.abs(cryptocomVolume - yourLogVolume);
  
  const binanceRatio = binanceVolume / cryptocomVolume;
  console.log(`Binance has ${binanceRatio.toFixed(1)}x MORE volume than Crypto.com`);
  
  if (cryptocomDiff < binanceDiff) {
    console.log(`\n✅ Your system IS USING: CRYPTO.COM`);
    console.log(`   (Your data closer to Crypto.com: diff=${cryptocomDiff.toFixed(0)} vs ${binanceDiff.toFixed(0)})`);
  } else {
    console.log(`\n✅ Your system IS USING: BINANCE`);
    console.log(`   (Your data closer to Binance: diff=${binanceDiff.toFixed(0)} vs ${cryptocomDiff.toFixed(0)})`);
  }
  
  console.log('\n========================================\n');
  
  await prisma.$disconnect();
}

testWhichExchange().catch(console.error);

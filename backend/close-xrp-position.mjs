/**
 * Script pour fermer manuellement une position XRP ouverte
 */

import ccxt from 'ccxt';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

function decryptApiKey(ciphertext) {
  const secret = process.env.JWT_SECRET || process.env.APP_API_KEY;
  if (!secret) throw new Error('JWT_SECRET or APP_API_KEY not found!');
  
  const key = crypto.scryptSync(secret, 'apikey-salt', 32);
  const parts = ciphertext.split(':');
  if (parts.length !== 2) throw new Error('Invalid encrypted data format');
  
  const iv = Buffer.from(parts[0], 'hex');
  const encrypted = parts[1];
  
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

async function main() {
  console.log('🔧 Closing XRP position...\n');
  
  // Get credentials
  const apiKey = await prisma.userApiKey.findFirst({
    where: { exchange: 'binance', testnet: false, isActive: true },
    orderBy: { updatedAt: 'desc' }
  });
  
  if (!apiKey) {
    console.error('❌ No API key found');
    return;
  }
  
  const credentials = {
    apiKey: decryptApiKey(apiKey.apiKey),
    apiSecret: decryptApiKey(apiKey.apiSecret),
  };
  
  // Connect to Binance
  const exchange = new ccxt.binanceusdm({
    apiKey: credentials.apiKey,
    secret: credentials.apiSecret,
    enableRateLimit: true,
    options: { defaultType: 'future', adjustForTimeDifference: true }
  });
  
  const symbol = 'XRP/USDT:USDT';
  
  // 1. Cancel all open orders
  console.log('📋 Cancelling all open orders...');
  try {
    await exchange.cancelAllOrders(symbol);
    console.log('   ✅ All orders cancelled');
  } catch (e) {
    console.log(`   ⚠️ ${e.message}`);
  }
  
  // 2. Get position
  console.log('\n📊 Fetching position...');
  const positions = await exchange.fetchPositions([symbol]);
  const pos = positions.find(p => 
    p.symbol === symbol && 
    Math.abs(parseFloat(p.contracts || p.info?.positionAmt || 0)) > 0
  );
  
  if (!pos) {
    console.log('   ✅ No open position found - already closed');
    await prisma.$disconnect();
    return;
  }
  
  const qty = Math.abs(parseFloat(pos.contracts || pos.info?.positionAmt));
  const side = parseFloat(pos.contracts || pos.info?.positionAmt) > 0 ? 'long' : 'short';
  const pnl = parseFloat(pos.unrealizedPnl || pos.info?.unRealizedProfit || 0);
  
  console.log(`   Found: ${side.toUpperCase()} ${qty} XRP | PnL: $${pnl.toFixed(4)}`);
  
  // 3. Close position
  console.log('\n🏁 Closing position...');
  try {
    const order = side === 'long'
      ? await exchange.createMarketSellOrder(symbol, qty, { reduceOnly: true })
      : await exchange.createMarketBuyOrder(symbol, qty, { reduceOnly: true });
    
    console.log(`   ✅ CLOSED @ $${order.average || order.price}`);
    console.log(`   📝 Order ID: ${order.id}`);
  } catch (e) {
    console.error(`   ❌ Failed: ${e.message}`);
  }
  
  // 4. Verify
  console.log('\n🔍 Verifying...');
  const posAfter = await exchange.fetchPositions([symbol]);
  const stillOpen = posAfter.find(p => 
    p.symbol === symbol && 
    Math.abs(parseFloat(p.contracts || p.info?.positionAmt || 0)) > 0
  );
  
  if (!stillOpen) {
    console.log('   ✅ Position closed successfully!');
  } else {
    console.log('   ⚠️ Position still open - manual intervention needed');
  }
  
  await prisma.$disconnect();
}

main().catch(console.error);

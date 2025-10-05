import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkStatus() {
  console.log('\n=== CURRENT SYSTEM STATUS ===\n');
  
  // 1. Check active exchange
  const activeKey = await prisma.userApiKey.findFirst({
    where: { isActive: true },
    include: { user: { select: { email: true } } }
  });
  
  if (activeKey) {
    console.log(`✅ Active Exchange: ${activeKey.exchange.toUpperCase()}`);
    console.log(`   User: ${activeKey.user.email}\n`);
  } else {
    console.log('❌ No active API key found!\n');
  }
  
  // 2. Check active agents
  const agents = await prisma.agent.findMany({
    where: {
      mode: 'auto',
      isActive: true
    },
    select: {
      id: true,
      symbol: true,
      userId: true,
      state: true,
      lastTrade: true,
      updatedAt: true
    }
  });
  
  console.log(`📊 Active Auto Agents: ${agents.length}\n`);
  
  agents.forEach((agent, idx) => {
    const timeSinceUpdate = Math.round((Date.now() - agent.updatedAt.getTime()) / 60000);
    const timeSinceLastTrade = agent.lastTrade 
      ? Math.round((Date.now() - agent.lastTrade.getTime()) / 60000)
      : null;
    
    console.log(`${idx + 1}. ${agent.symbol}`);
    console.log(`   State: ${agent.state}`);
    console.log(`   Last update: ${timeSinceUpdate} min ago`);
    console.log(`   Last trade: ${timeSinceLastTrade ? timeSinceLastTrade + ' min ago' : 'Never'}`);
    console.log('');
  });
  
  // 3. Check recent trades
  const recentTrades = await prisma.trade.findMany({
    where: {
      createdAt: {
        gte: new Date(Date.now() - 24 * 60 * 60 * 1000) // Last 24h
      }
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      symbol: true,
      side: true,
      status: true,
      createdAt: true
    }
  });
  
  console.log(`💰 Trades in last 24h: ${recentTrades.length}\n`);
  
  if (recentTrades.length > 0) {
    recentTrades.forEach((trade, idx) => {
      const minutesAgo = Math.round((Date.now() - trade.createdAt.getTime()) / 60000);
      console.log(`${idx + 1}. ${trade.symbol} ${trade.side} - ${trade.status} (${minutesAgo}m ago)`);
    });
  } else {
    console.log('   No trades in last 24 hours');
  }
  
  console.log('\n=== ANALYSIS ===\n');
  
  if (activeKey?.exchange === 'crypto.com') {
    console.log('⚠️  You are still using CRYPTO.COM');
    console.log('   Problem: Low volumes (26x less than Binance)');
    console.log('   Solution: Wait for Binance ban to expire (17:15)');
  } else if (activeKey?.exchange === 'binance') {
    console.log('✅ You are using BINANCE');
    console.log('   If no trades: Check if ban has expired');
    console.log('   Ban expires at: 17:15 (check time now)');
  }
  
  console.log('\nPossible reasons for low trades:');
  console.log('1. Using Crypto.com (low volumes)');
  console.log('2. Binance still banned (wait until 17:15)');
  console.log('3. Quality thresholds too strict for current exchange');
  console.log('4. Agents not updating (check logs)');
  
  await prisma.$disconnect();
}

checkStatus();

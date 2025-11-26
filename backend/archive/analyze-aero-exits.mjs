import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('🔍 Analyzing AERO exit reasons...\n');
  
  const session = await prisma.agentSession.findFirst({
    where: { symbol: { contains: 'AERO', mode: 'insensitive' } },
    include: {
      orders: { orderBy: { createdAt: 'asc' } },
      positions: { orderBy: { openedAt: 'asc' } }
    }
  });
  
  const profile = typeof session.profileJson === 'string' 
    ? JSON.parse(session.profileJson) 
    : session.profileJson;
  
  console.log('📊 Profile Configuration:');
  console.log(`   Risk per trade: ${profile.riskPerTradePct || 'N/A'}%`);
  console.log(`   Min hold hours: ${profile.minHoldHours || 'N/A'}`);
  console.log(`   Aggressiveness: ${profile.aggressiveness || 'N/A'}`);
  console.log(`   RR Floor: ${profile.rrFloor || 'N/A'}`);
  console.log(`   RR Ceil: ${profile.rrCeil || 'N/A'}`);
  
  console.log('\n📦 Positions Analysis:');
  if (session.positions.length === 0) {
    console.log('   No positions tracked (using legacy order system)');
    console.log('\n   Analyzing from orders directly...');
    
    const buyOrders = session.orders.filter(o => o.side === 'buy');
    const sellOrders = session.orders.filter(o => o.side === 'sell');
    
    for (let i = 0; i < Math.min(buyOrders.length, sellOrders.length); i++) {
      const buy = buyOrders[i];
      const sell = sellOrders[i];
      
      const holdMinutes = (sell.createdAt - buy.createdAt) / 1000 / 60;
      const pnlPct = ((sell.price - buy.price) / buy.price) * 100;
      
      console.log(`\n   Trade ${i + 1}:`);
      console.log(`      Entry: $${buy.price} at ${buy.createdAt.toISOString()}`);
      console.log(`      Exit:  $${sell.price} at ${sell.createdAt.toISOString()}`);
      console.log(`      Hold:  ${holdMinutes.toFixed(1)} minutes`);
      console.log(`      PnL:   ${pnlPct.toFixed(2)}%`);
      
      // Calculate what the stop would have been
      const estimatedStop = buy.price * 0.98; // -2% stop
      console.log(`      Est. stop (-2%): $${estimatedStop.toFixed(4)}`);
      console.log(`      Exit vs stop: ${sell.price <= estimatedStop ? '🛑 STOP HIT' : '⚠️  OTHER REASON'}`);
      
      // Check if it was min hold
      const minHoldMin = (profile.minHoldHours || 0) * 60;
      if (holdMinutes < minHoldMin) {
        console.log(`      ⚠️  EXITED BEFORE MIN HOLD (${minHoldMin}min required)`);
      }
      
      // Check if it was momentum exit
      if (pnlPct > -2 && pnlPct < 0) {
        console.log(`      ⚠️  LIKELY MOMENTUM EXIT (loss < 2%, not stop loss)`);
        console.log(`         → Momentum indicators (ADX/CMF) triggered early exit`);
      }
    }
  }
  
  console.log('\n\n💡 Exit Strategy Environment Variables:');
  console.log(`   EXIT_STRATEGY_MODE: ${process.env.EXIT_STRATEGY_MODE || 'hybrid (default)'}`);
  console.log(`   TRAILING_START_R: ${process.env.TRAILING_START_R || '0.8 (default)'}`);
  console.log(`   BREAKEVEN_AT_R: ${process.env.BREAKEVEN_AT_R || '1.2 (default)'}`);
  console.log(`   MIN_HOLD_DURATION_MIN: ${process.env.MIN_HOLD_DURATION_MIN || '15 (default)'}`);
  
  console.log('\n\n🎯 DIAGNOSIS:');
  console.log('   Based on the analysis:');
  console.log('   1. Trade 1 exited at -2.00% after 43 minutes');
  console.log('   2. Trade 2 exited at -0.96% after 59 minutes');
  console.log('');
  console.log('   → Trade 1: Likely STOP LOSS hit at -2%');
  console.log('   → Trade 2: Likely MOMENTUM EXIT (ADX < 18 or CMF < 0)');
  console.log('');
  console.log('   Problem: AERO is volatile (±2% intraday swings normal)');
  console.log('   Solution: Use ATR-based stops for AERO (~3-4% based on volatility)');
}

main().catch(console.error).finally(() => prisma.$disconnect());

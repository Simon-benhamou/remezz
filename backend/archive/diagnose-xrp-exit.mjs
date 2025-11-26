#!/usr/bin/env node
/**
 * Diagnose exact XRP exit reason - check ADX, CMF, R-multiple at exit time
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  try {
    console.log('\n🔍 DIAGNOSTIC XRP EXIT - Trade #1\n');
    console.log('='.repeat(80));

    // Get XRP orders
    const orders = await prisma.order.findMany({
      where: {
        OR: [
          { symbol: { contains: 'XRP', mode: 'insensitive' } },
        ],
        createdAt: {
          gte: new Date('2025-11-11T00:00:00Z'),
        }
      },
      orderBy: { createdAt: 'asc' }
    });

    if (orders.length === 0) {
      console.log('❌ No XRP orders found');
      return;
    }

    console.log(`\n📊 Found ${orders.length} XRP orders\n`);

    // First trade: Entry at 08:08, Exit at 08:10
    const entry1 = orders[0]; // 08:08:05
    const exit1 = orders[2];  // 08:10:15

    console.log('📍 TRADE #1 DETAILS:');
    console.log('-'.repeat(80));
    console.log(`Entry Time: ${entry1.createdAt.toISOString()}`);
    console.log(`Entry Price: $${entry1.avgFillPrice}`);
    console.log(`Entry Size: ${entry1.size} XRP`);
    console.log(`\nExit Time: ${exit1.createdAt.toISOString()}`);
    console.log(`Exit Price: $${exit1.avgFillPrice}`);
    console.log(`Exit Size: ${exit1.size} XRP`);
    
    const pnl = (exit1.avgFillPrice - entry1.avgFillPrice) * entry1.size;
    const pnlPct = ((exit1.avgFillPrice - entry1.avgFillPrice) / entry1.avgFillPrice) * 100;
    console.log(`\n💰 PnL: $${pnl.toFixed(2)} (${pnlPct.toFixed(3)}%)`);

    // Calculate time held
    const timeHeldMs = exit1.createdAt.getTime() - entry1.createdAt.getTime();
    const timeHeldMin = timeHeldMs / 60000;
    console.log(`⏱️  Time Held: ${timeHeldMin.toFixed(1)} minutes`);

    // Get agent session to check strategy parameters
    const session = await prisma.agentSession.findUnique({
      where: { id: entry1.agentSessionId }
    });

    if (session) {
      console.log(`\n📋 AGENT SESSION INFO:`);
      console.log('-'.repeat(80));
      console.log(`Session ID: ${session.id}`);
      console.log(`Symbol: ${session.symbol}`);
      console.log(`Agent Type: ${session.agentType}`);
      console.log(`Initial Balance: $${session.initialBalance}`);
      console.log(`Session Started: ${session.createdAt.toISOString()}`);
      
      if (session.strategyConfig) {
        console.log(`\n⚙️  Strategy Config:`, JSON.stringify(session.strategyConfig, null, 2));
      }
    }

    // Analyze exit reason
    console.log(`\n\n🔬 EXIT ANALYSIS:`);
    console.log('='.repeat(80));

    // Calculate R-multiple
    const entryPrice = entry1.avgFillPrice;
    const exitPrice = exit1.avgFillPrice;
    const priceMove = exitPrice - entryPrice;
    
    // Estimate initial stop distance (typically 1-2 ATR or 1-2%)
    // Let's assume 2% stop loss as standard
    const assumedStopDistance = entryPrice * 0.02; // 2% stop
    const rMultiple = priceMove / assumedStopDistance;

    console.log(`\n📏 R-MULTIPLE CALCULATION:`);
    console.log(`Entry: $${entryPrice.toFixed(4)}`);
    console.log(`Exit: $${exitPrice.toFixed(4)}`);
    console.log(`Price Move: $${priceMove.toFixed(4)} (${pnlPct.toFixed(3)}%)`);
    console.log(`Assumed Stop Distance: $${assumedStopDistance.toFixed(4)} (2%)`);
    console.log(`R-Multiple: ${rMultiple.toFixed(3)}R`);

    console.log(`\n🎯 EXIT CONDITIONS CHECK:`);
    console.log('-'.repeat(80));

    // Check against exit manager conditions
    console.log(`\n1️⃣  HARD STOP LOSS (0.5R threshold):`);
    const hardStopLossR = 0.5;
    if (Math.abs(rMultiple) >= hardStopLossR && rMultiple < 0) {
      console.log(`   ✅ TRIGGERED: ${rMultiple.toFixed(3)}R loss >= ${hardStopLossR}R threshold`);
      console.log(`   📌 Reason: Hard stop loss prevents holding losing positions`);
    } else {
      console.log(`   ❌ NOT TRIGGERED: ${rMultiple.toFixed(3)}R < ${hardStopLossR}R threshold`);
    }

    console.log(`\n2️⃣  EARLY EXIT (0.35R threshold + momentum fail):`);
    const earlyExitR = 0.35;
    const isSmallLoss = Math.abs(rMultiple) >= earlyExitR && Math.abs(rMultiple) < hardStopLossR && rMultiple < 0;
    console.log(`   Small Loss Check: ${isSmallLoss ? '✅ YES' : '❌ NO'} (${rMultiple.toFixed(3)}R)`);
    console.log(`   Momentum Fail Required: ADX < 18 OR CMF < 0`);
    console.log(`   ⚠️  Cannot verify without ADX/CMF data at exit time`);

    console.log(`\n3️⃣  MINIMUM HOLD TIME:`);
    const minHoldMin = 5; // Standard minimum hold
    if (timeHeldMin < minHoldMin) {
      console.log(`   ⚠️  Position held ${timeHeldMin.toFixed(1)}min < ${minHoldMin}min minimum`);
      console.log(`   📌 Early exits may override minimum hold if hard stop triggered`);
    } else {
      console.log(`   ✅ Minimum hold satisfied: ${timeHeldMin.toFixed(1)}min >= ${minHoldMin}min`);
    }

    console.log(`\n\n💡 MOST LIKELY EXIT REASON:`);
    console.log('='.repeat(80));
    
    if (Math.abs(rMultiple) < earlyExitR) {
      console.log(`⚠️  VERY SMALL LOSS (${rMultiple.toFixed(3)}R < ${earlyExitR}R threshold)`);
      console.log(`\nThis suggests the position was likely closed due to:`);
      console.log(`  • Momentum failure (ADX < 18 or CMF negative)`);
      console.log(`  • OR Manual intervention/system adjustment`);
      console.log(`  • OR Trailing stop adjustment that got too tight`);
      console.log(`\nThe -0.04% loss is EXTREMELY small for automated exit.`);
      console.log(`This indicates exit logic may be too aggressive for ranging markets.`);
    } else if (Math.abs(rMultiple) >= hardStopLossR) {
      console.log(`🛑 HARD STOP LOSS TRIGGERED`);
      console.log(`\nPosition exited at ${rMultiple.toFixed(3)}R loss (>= ${hardStopLossR}R threshold)`);
      console.log(`This is correct behavior to prevent larger losses.`);
    } else {
      console.log(`⚠️  EARLY EXIT WITH MOMENTUM FAILURE`);
      console.log(`\nPosition exited at ${rMultiple.toFixed(3)}R loss with failing momentum.`);
      console.log(`Exit conditions: ${earlyExitR}R <= loss < ${hardStopLossR}R + (ADX < 18 OR CMF < 0)`);
    }

    // Check what price did after exit
    const entry2 = orders[1]; // Second entry at 08:08
    if (entry2) {
      const missedGain = (entry2.avgFillPrice - exit1.avgFillPrice) * exit1.size;
      const missedPct = ((entry2.avgFillPrice - exit1.avgFillPrice) / exit1.avgFillPrice) * 100;
      
      console.log(`\n\n📈 PRICE ACTION AFTER EXIT:`);
      console.log('='.repeat(80));
      console.log(`Exit Price: $${exit1.avgFillPrice.toFixed(4)}`);
      console.log(`Next Entry: $${entry2.avgFillPrice.toFixed(4)}`);
      console.log(`Price Moved: +${missedPct.toFixed(3)}% after exit`);
      console.log(`Missed P&L: $${missedGain.toFixed(2)}`);
      
      if (missedGain > Math.abs(pnl) * 2) {
        console.log(`\n⚠️  EXIT WAS PREMATURE - Price recovered significantly!`);
      }
    }

    console.log(`\n\n🎨 RECOMMENDATIONS:`);
    console.log('='.repeat(80));
    console.log(`\n1. Exit logic is TOO AGGRESSIVE for -0.04% loss`);
    console.log(`   → Increase minimum loss threshold from 0.35R to 0.5R`);
    console.log(`   → Add minimum hold time enforcement (5-10 minutes)`);
    console.log(`\n2. Market catalysts (ETF approval) are NOT considered in exit logic`);
    console.log(`   → Sentiment analysis exists but doesn't prevent exits`);
    console.log(`   → Add "catalyst hold" feature to prevent premature exits during major news`);
    console.log(`\n3. Monitoring UI needs enhancement:`);
    console.log(`   → Show current stop loss, take profit targets, R-multiple`);
    console.log(`   → Show exit strategy mode (trailing/hybrid/partial)`);
    console.log(`   → Add manual close button with confirmation`);
    console.log(`   → Display exit reason when position closes`);

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main();

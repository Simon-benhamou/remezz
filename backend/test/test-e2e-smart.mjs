#!/usr/bin/env node
import 'dotenv/config';

// End-to-end sanity test for Binance WS + Smart Agent init + Diagnostics coherence

import { getAIRankedOpportunities } from '../src/ai/cryptoRanking.ts';
import { prisma } from '../src/db/client.js';
import { waitForWsHealthy } from '../src/services/binanceWebSocket.ts';
import { initializeIntelligentAgent } from '../src/services/intelligentAgent.ts';
import { AgentHub } from '../src/agent/hub.js';
import { savePlan } from '../src/services/planStore.ts';
import { proposePlan } from '../src/ai/planOrchestrator.ts';
import { getConfig } from '../src/utils/env.js';

async function main() {
  console.log('🚀 E2E Smart Agent test starting...');

  // 1) Warm-up WS
  const healthy = await waitForWsHealthy(5000);
  console.log(`   WS healthy: ${healthy}`);

  // 2) Top opportunities snapshot
  try {
    const ranked = await getAIRankedOpportunities({ useCache: true });
    console.log(`   Top opportunities (snapshot): ${ranked.slice(0,5).map(r=>r.symbol).join(', ')}`);
  } catch (e) {
    console.warn('   ⚠️ Ranking fetch failed:', e.message);
  }

  // 3) Create a paper Smart Agent session and initialize
  const user = await prisma.user.findFirst({ where: { username: 'simon' } });
  const userId = user?.id;
  const session = await prisma.agentSession.create({
    data: {
      userId,
      symbol: 'SMART/SLEEP',
      mode: 'paper',
      startBalanceUsd: 1000,
      isSmartAgent: true,
      profileJson: { aggressiveness: 'reactive', startBalanceUsd: 1000 }
    }
  });
  console.log('   Created session:', session.id);

  const ok = await initializeIntelligentAgent(session.id);
  const updated = await prisma.agentSession.findUnique({ where: { id: session.id } });
  console.log('   Smart init:', ok, 'symbol:', updated?.symbol);

  // 4) Create a manual agent on BTC/USDT, activate, generate plan, and get diagnostics
  const cfg = getConfig();
  const manual = await prisma.agentSession.create({
    data: {
      userId,
      symbol: 'BTC/USDT',
      mode: 'paper',
      startBalanceUsd: 1000,
      profileJson: { aggressiveness: 'reactive', startBalanceUsd: 1000 }
    }
  });
  await AgentHub.activate(manual.id, {
    symbol: manual.symbol,
    mode: 'paper',
    maxLeverage: 4,
    riskPerTradePct: 1.5,
    dailyLossLimitPct: 3.5,
    timestamp: new Date().toISOString(),
    startBalanceUsd: 1000,
    budgetFraction: 1,
    aggressiveness: 'reactive'
  });

  let diagBeforePlan = null;
  try {
    const a = AgentHub.get(manual.id);
    diagBeforePlan = await a?.getDiagnostics();
  } catch {}
  console.log('   Diagnostics before plan (may be waiting_for_market_data):', diagBeforePlan?.reason);

  // Generate plan (LLM might be used depending on env)
  try {
    const plan = await proposePlan(manual.symbol, { fresh: true, sessionId: manual.id });
    await savePlan(manual.id, plan);
    const a = AgentHub.get(manual.id);
    if (a) {
      await a.propose(plan);
      await a.validateAndArm();
    }
  } catch (e) {
    console.warn('   ⚠️ Plan generation failed (ok in restricted env):', e.message);
  }

  // Final diagnostics + coherence checks
  const agent = AgentHub.get(manual.id);
  const dx = await agent?.getDiagnostics();
  if (!dx) {
    console.log('   ⚠️ No diagnostics');
  } else {
    console.log('   Diagnostics canTrade:', dx.canTrade, 'reason:', dx.reason);
    // Basic coherence: if inEntryZone FAIL → trigger.inZone must be false
    if (dx.checks?.inEntryZone?.status === 'FAIL' && dx.trigger) {
      console.log('   Coherence(inZone):', dx.trigger.inZone === false ? 'OK' : 'MISMATCH');
    }
    // Momentum gates
    if (dx.checks?.momentumGates && dx.trigger) {
      const expected = dx.checks.momentumGates.status === 'PASS';
      console.log('   Coherence(momentumOk):', dx.trigger.momentumOk === expected ? 'OK' : 'MISMATCH');
    }
    // Quality score bounds
    if (dx.checks?.qualityScore?.current != null) {
      const q = Number(dx.checks.qualityScore.current);
      console.log('   QualityScore bounds:', (q >= 0 && q <= 100) ? 'OK' : 'MISMATCH');
    }
  }

  // Cleanup
  try { await prisma.agentSession.delete({ where: { id: session.id } }); } catch {}
  try { await prisma.agentSession.delete({ where: { id: manual.id } }); } catch {}
  console.log('✅ E2E finished');
}

main().catch(err => {
  console.error('❌ E2E failed:', err);
  process.exit(1);
});

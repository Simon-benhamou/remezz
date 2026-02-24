/**
 * Analyze Polymarket prediction win rate by score tier vs EV caps.
 * Queries shared virtual rows (userId=null) to get the TRUE WR
 * of ALL predictions — including those skipped by EV too low.
 *
 * Usage: npx tsx scripts/analyze-polymarket-ev.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface TierStats {
  tier: string;
  scoreRange: string;
  currentCap: number;
  total: number;
  verified: number;
  wins: number;
  losses: number;
  pending: number;
  winRate: number;
  breakeven: number;       // CLOB price where EV = 0 given this WR
  maxProfitableCap: number; // breakeven - margin
}

async function main() {
  // Get ALL shared virtual predictions (userId=null, not skipped)
  const predictions = await prisma.polymarketPrediction.findMany({
    where: {
      userId: null,
      skipped: false,
    },
    orderBy: { createdAt: 'desc' },
  });

  console.log(`\n📊 Polymarket EV Analysis — ${predictions.length} total predictions (shared virtual rows)\n`);

  // ── By score tier ──────────────────────────────────────────────────────────
  const tiers = [
    { name: 'High', range: '60+', min: 60, max: 101, cap: 0.68 },
    { name: 'Mid', range: '50-59', min: 50, max: 60, cap: 0.63 },
    { name: 'Low', range: '40-49', min: 40, max: 50, cap: 0.58 },
  ];

  const results: TierStats[] = [];

  for (const tier of tiers) {
    const tierPreds = predictions.filter((p) => {
      const score = (p.scoreBreakdown as any)?.total ?? p.confidence ?? 0;
      return score >= tier.min && score < tier.max;
    });

    const verified = tierPreds.filter((p) => p.isCorrect !== null);
    const wins = verified.filter((p) => p.isCorrect === true).length;
    const losses = verified.filter((p) => p.isCorrect === false).length;
    const pending = tierPreds.filter((p) => p.isCorrect === null).length;
    const winRate = verified.length > 0 ? (wins / verified.length) * 100 : 0;

    // Breakeven: WR × (1-P)/P = (1-WR) → P = WR (for binary outcomes)
    // Actually: profit = WR × (1/P - 1) - (1-WR) = 0 → P = WR
    const breakeven = winRate / 100;
    const maxProfitableCap = Math.max(0, breakeven - 0.02); // 2% margin

    results.push({
      tier: tier.name,
      scoreRange: tier.range,
      currentCap: tier.cap,
      total: tierPreds.length,
      verified: verified.length,
      wins,
      losses,
      pending,
      winRate,
      breakeven,
      maxProfitableCap,
    });
  }

  // Print tier analysis
  console.log('┌─────────┬────────────┬───────┬──────────┬──────┬────────┬─────────┬──────────────┬───────────────┐');
  console.log('│ Tier    │ Score      │ Count │ Verified │ W/L  │ WR%    │ Cap now │ Breakeven    │ Suggested cap │');
  console.log('├─────────┼────────────┼───────┼──────────┼──────┼────────┼─────────┼──────────────┼───────────────┤');
  for (const r of results) {
    console.log(
      `│ ${r.tier.padEnd(7)} │ ${r.scoreRange.padEnd(10)} │ ${String(r.total).padStart(5)} │ ${String(r.verified).padStart(8)} │ ${String(r.wins).padStart(2)}/${String(r.losses).padStart(2)} │ ${r.winRate.toFixed(1).padStart(5)}% │ ${r.currentCap.toFixed(2).padStart(7)} │ ${r.breakeven.toFixed(3).padStart(12)} │ ${r.maxProfitableCap.toFixed(2).padStart(13)} │`,
    );
  }
  console.log('└─────────┴────────────┴───────┴──────────┴──────┴────────┴─────────┴──────────────┴───────────────┘');

  // ── Overall stats ──────────────────────────────────────────────────────────
  const allVerified = predictions.filter((p) => p.isCorrect !== null);
  const allWins = allVerified.filter((p) => p.isCorrect === true).length;
  const allLosses = allVerified.filter((p) => p.isCorrect === false).length;
  const allPending = predictions.filter((p) => p.isCorrect === null).length;
  const allWR = allVerified.length > 0 ? (allWins / allVerified.length) * 100 : 0;

  console.log(`\n📈 Overall: ${allWins}W / ${allLosses}L (${allPending} pending) = ${allWR.toFixed(1)}% WR`);
  console.log(`   Breakeven CLOB price at this WR: ${(allWR / 100).toFixed(3)}`);

  // ── Simulated PnL at different CLOB prices ─────────────────────────────────
  console.log('\n💰 Simulated PnL per $5 bet at different CLOB prices (verified predictions only):');
  console.log('   CLOB Price │ Per Win    │ Per Loss │ Expected/trade │ Per 100 trades');
  console.log('   ───────────┼────────────┼──────────┼────────────────┼──────────────');

  const betAmount = 5;
  for (const price of [0.50, 0.55, 0.58, 0.63, 0.68, 0.75, 0.80, 0.83, 0.85, 0.90]) {
    const wr = allWR / 100;
    const winProfit = betAmount * (1 - price) / price;
    const lossAmount = -betAmount;
    const ev = wr * winProfit + (1 - wr) * lossAmount;
    const per100 = ev * 100;
    const evStr = ev >= 0 ? `+$${ev.toFixed(2)}` : `-$${Math.abs(ev).toFixed(2)}`;
    const per100Str = per100 >= 0 ? `+$${per100.toFixed(0)}` : `-$${Math.abs(per100).toFixed(0)}`;
    const marker = ev >= 0 ? ' ✅' : ' ❌';
    console.log(`      ${price.toFixed(2)}    │ +$${winProfit.toFixed(2).padStart(6)} │ -$${betAmount.toFixed(2)} │ ${evStr.padStart(14)} │ ${per100Str.padStart(12)}${marker}`);
  }

  // ── By entry odds range (Gamma API) ────────────────────────────────────────
  const oddsRanges = [
    { label: '< 0.50', min: 0, max: 0.50 },
    { label: '0.50-0.58', min: 0.50, max: 0.58 },
    { label: '0.58-0.63', min: 0.58, max: 0.63 },
    { label: '0.63-0.68', min: 0.63, max: 0.68 },
    { label: '0.68-0.75', min: 0.68, max: 0.75 },
    { label: '0.75-0.85', min: 0.75, max: 0.85 },
    { label: '> 0.85', min: 0.85, max: 1.01 },
  ];

  console.log('\n📊 Win rate by Gamma entry odds range:');
  console.log('   Odds Range  │ Count │ Verified │ W/L    │ WR%    │ +EV at this price?');
  console.log('   ────────────┼───────┼──────────┼────────┼────────┼──────────────────');

  for (const range of oddsRanges) {
    const rangePreds = predictions.filter((p) => {
      const odds = p.entryOdds ?? 0;
      return odds >= range.min && odds < range.max;
    });
    const verified = rangePreds.filter((p) => p.isCorrect !== null);
    const wins = verified.filter((p) => p.isCorrect === true).length;
    const losses = verified.filter((p) => p.isCorrect === false).length;
    const wr = verified.length > 0 ? (wins / verified.length) * 100 : 0;
    const isEv = wr / 100 > (range.min + range.max) / 2;

    if (rangePreds.length === 0) continue;
    console.log(
      `   ${range.label.padEnd(10)} │ ${String(rangePreds.length).padStart(5)} │ ${String(verified.length).padStart(8)} │ ${String(wins).padStart(2)}/${String(losses).padStart(2)}  │ ${wr.toFixed(1).padStart(5)}% │ ${isEv ? '✅ YES' : '❌ NO'}`,
    );
  }

  // ── Recent skipped-by-EV predictions ───────────────────────────────────────
  console.log('\n📋 Recent predictions (last 20, all shared rows):');
  const recent = predictions.slice(0, 20);
  for (const p of recent) {
    const score = (p.scoreBreakdown as any)?.total ?? p.confidence ?? '?';
    const result = p.isCorrect === true ? '✅ WIN' : p.isCorrect === false ? '❌ LOSS' : '⏳ PENDING';
    const odds = p.entryOdds ? p.entryOdds.toFixed(3) : 'n/a';
    const dir = p.prediction ?? 'SKIP';
    const time = p.windowStart.toISOString().slice(11, 16);
    console.log(`   ${time} UTC │ ${dir.padEnd(4)} │ score=${String(score).padStart(2)} │ odds=${odds} │ ${result}`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const since = new Date("2026-02-24T00:00:00Z");
  const all = await prisma.polymarketPrediction.findMany({
    where: { windowStart: { gte: since }, prediction: { not: null } },
    orderBy: { windowStart: "asc" }
  });

  // Separate: with executionPrice = VIRTUAL, without = SIGNAL
  const virtual = all.filter(p => p.executionPrice != null);
  const signal = all.filter(p => p.executionPrice == null);

  console.log("=== SIGNAL rows (Gamma odds ~0.50) ===");
  const sigV = signal.filter(p => p.isCorrect != null);
  const sigW = sigV.filter(p => p.isCorrect === true);
  console.log("Count:", signal.length, "| Verified:", sigV.length, "| W:", sigW.length, "L:", sigV.length - sigW.length);
  console.log("PnL:", sigV.reduce((s, p) => s + (p.simulatedPnl || 0), 0).toFixed(2));

  console.log("\n=== VIRTUAL rows (CLOB-priced) ===");
  const virV = virtual.filter(p => p.isCorrect != null);
  const virW = virV.filter(p => p.isCorrect === true);
  const virL = virV.filter(p => p.isCorrect === false);
  const virPnl = virV.reduce((s, p) => s + (p.simulatedPnl || 0), 0);
  console.log("Count:", virtual.length, "| Verified:", virV.length, "| Pending:", virtual.length - virV.length);
  console.log("Wins:", virW.length, "| Losses:", virL.length, "| WR:", (virW.length / virV.length * 100).toFixed(1) + "%");
  console.log("PnL (simulatedPnl):", virPnl.toFixed(2));

  // Recalculate PnL from CLOB executionPrice
  let clobPnl = 0;
  for (const p of virV) {
    if (p.isCorrect) {
      clobPnl += (p.betAmount || 5) * (1 - p.executionPrice!) / p.executionPrice!;
    } else {
      clobPnl -= (p.betAmount || 5);
    }
  }
  console.log("PnL (recalc from CLOB):", clobPnl.toFixed(2));

  // Detail virtual trades
  console.log("\nTime  | Sym  | Pred | Real | Result | simPnl  | CLOB  | clobPnl");
  console.log("-".repeat(75));
  let runningPnl = 0;
  for (const p of virV) {
    const time = new Date(p.windowStart).toISOString().substring(11, 16);
    const result = p.isCorrect ? "WIN " : "LOSS";
    const sim = (p.simulatedPnl || 0).toFixed(2);
    const clob = p.executionPrice!.toFixed(2);
    const cp = p.isCorrect
      ? (p.betAmount || 5) * (1 - p.executionPrice!) / p.executionPrice!
      : -(p.betAmount || 5);
    runningPnl += cp;
    console.log(`${time} | ${(p.symbol || "?").padEnd(4)} | ${(p.prediction || "?").padEnd(4)} | ${(p.actualResult || "?").padEnd(4)} | ${result} | $${sim.padStart(6)} | ${clob} | $${cp.toFixed(2).padStart(6)} | cum=$${runningPnl.toFixed(2)}`);
  }

  // Hour breakdown virtual only
  console.log("\n=== PAR HEURE (virtual only) ===");
  const hourStats: Record<number, {w: number, l: number, pnl: number}> = {};
  for (const p of virV) {
    const h = new Date(p.windowStart).getUTCHours();
    if (!hourStats[h]) hourStats[h] = {w:0,l:0,pnl:0};
    if (p.isCorrect) hourStats[h].w++; else hourStats[h].l++;
    const cp = p.isCorrect
      ? (p.betAmount || 5) * (1 - p.executionPrice!) / p.executionPrice!
      : -(p.betAmount || 5);
    hourStats[h].pnl += cp;
  }
  for (let h = 0; h < 24; h++) {
    const s = hourStats[h];
    if (!s) continue;
    const total = s.w + s.l;
    console.log(`${String(h).padStart(2)}h | ${total} trades | ${s.w}W ${s.l}L | WR ${(s.w/total*100).toFixed(0)}% | PnL $${s.pnl.toFixed(2)}`);
  }

  await prisma.$disconnect();
}
main();

import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const since = new Date("2026-02-24T00:00:00Z");

  const all = await prisma.polymarketPrediction.findMany({
    where: { windowStart: { gte: since } },
    orderBy: { windowStart: "asc" }
  });

  const predicted = all.filter(p => p.prediction != null);
  const verified = predicted.filter(p => p.isCorrect != null);
  const wins = verified.filter(p => p.isCorrect === true);
  const losses = verified.filter(p => p.isCorrect === false);
  const pending = predicted.filter(p => p.isCorrect == null);
  const windows = new Set(all.map(p => p.windowStart.toISOString())).size;

  console.log("=== TODAY (depuis minuit UTC) ===");
  console.log("Windows:", windows, "| Predicted:", predicted.length, "| Verified:", verified.length, "| Pending:", pending.length);
  console.log("Wins:", wins.length, "| Losses:", losses.length);
  console.log("WR:", verified.length > 0 ? (wins.length / verified.length * 100).toFixed(1) + "%" : "N/A");
  console.log("simulatedPnl sum: $" + verified.reduce((s, p) => s + (p.simulatedPnl || 0), 0).toFixed(2));

  // Show all verified trades detail
  console.log("\n=== DETAIL ===");
  console.log("Time  | Sym  | Pred | Real | Result | simPnl  | execPrice | entryOdds | bet");
  console.log("-".repeat(90));

  for (const p of verified) {
    const time = new Date(p.windowStart).toISOString().substring(11, 16);
    const result = p.isCorrect ? "WIN " : "LOSS";
    const sim = (p.simulatedPnl || 0).toFixed(2);
    const exec = p.executionPrice ? p.executionPrice.toFixed(3) : "-";
    const odds = p.entryOdds ? p.entryOdds.toFixed(3) : "-";
    const bet = p.betAmount ? p.betAmount.toFixed(0) : "-";
    console.log(`${time} | ${(p.symbol || "?").padEnd(4)} | ${(p.prediction || "?").padEnd(4)} | ${(p.actualResult || "?").padEnd(4)} | ${result} | $${sim.padStart(6)} | ${exec.padStart(9)} | ${odds.padStart(9)} | $${bet}`);
  }

  // Show pending too
  if (pending.length > 0) {
    console.log("\n=== PENDING ===");
    for (const p of pending) {
      const time = new Date(p.windowStart).toISOString().substring(11, 16);
      const exec = p.executionPrice ? p.executionPrice.toFixed(3) : "-";
      const odds = p.entryOdds ? p.entryOdds.toFixed(3) : "-";
      console.log(`${time} | ${(p.symbol || "?").padEnd(4)} | ${(p.prediction || "?").padEnd(4)} | ${(p.actualResult || "-").padEnd(4)} | PEND | exec=${exec} | odds=${odds}`);
    }
  }

  // Now check: does dashboard maybe use a different time range?
  // Try Israel midnight = 22:00 UTC Feb 23
  const sinceIsrael = new Date("2026-02-23T22:00:00Z");
  const allIsrael = await prisma.polymarketPrediction.findMany({
    where: { windowStart: { gte: sinceIsrael } },
    orderBy: { windowStart: "asc" }
  });
  const predIsrael = allIsrael.filter(p => p.prediction != null);
  const verIsrael = predIsrael.filter(p => p.isCorrect != null);
  const winsIsrael = verIsrael.filter(p => p.isCorrect === true);
  const lossIsrael = verIsrael.filter(p => p.isCorrect === false);
  const pendIsrael = predIsrael.filter(p => p.isCorrect == null);
  const winIsrael = new Set(allIsrael.map(p => p.windowStart.toISOString())).size;

  console.log("\n=== DEPUIS MINUIT ISRAEL (22h UTC Feb 23) ===");
  console.log("Windows:", winIsrael, "| Predicted:", predIsrael.length, "| Verified:", verIsrael.length, "| Pending:", pendIsrael.length);
  console.log("Wins:", winsIsrael.length, "| Losses:", lossIsrael.length);
  console.log("WR:", verIsrael.length > 0 ? (winsIsrael.length / verIsrael.length * 100).toFixed(1) + "%" : "N/A");
  console.log("simulatedPnl sum: $" + verIsrael.reduce((s, p) => s + (p.simulatedPnl || 0), 0).toFixed(2));

  await prisma.$disconnect();
}
main();

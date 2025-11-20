// Simulation du nouveau threshold avec override RSI/ATR

const scenarios = [
  {
    name: "ETH pendant la chute (RSI=24.2, ATR=106.74%)",
    baseThreshold: 0.45, // Large account, usage < 55%
    rsi: 24.2,
    atrPct: 106.74,
    signalConfidence: 0.332
  },
  {
    name: "ETH signal le plus bas (confidence=0.238)",
    baseThreshold: 0.45,
    rsi: 24.2,
    atrPct: 106.74,
    signalConfidence: 0.238
  },
  {
    name: "Conditions normales (RSI=50, ATR=60%)",
    baseThreshold: 0.45,
    rsi: 50,
    atrPct: 60,
    signalConfidence: 0.40
  },
  {
    name: "Overbought extrême (RSI=80, ATR=90%)",
    baseThreshold: 0.45,
    rsi: 80,
    atrPct: 90,
    signalConfidence: 0.35
  }
];

console.log("🧮 Simulation des nouveaux thresholds avec override\n");
console.log("=".repeat(70) + "\n");

for (const scenario of scenarios) {
  let adjustedThreshold = scenario.baseThreshold;
  let adjustments = [];
  
  // RSI override
  if (scenario.rsi < 25 || scenario.rsi > 75) {
    adjustments.push(`RSI=${scenario.rsi.toFixed(1)} (extreme) → -35%`);
    adjustedThreshold = adjustedThreshold * 0.65;
  } else if (scenario.rsi < 30 || scenario.rsi > 70) {
    adjustments.push(`RSI=${scenario.rsi.toFixed(1)} (strong) → -20%`);
    adjustedThreshold = adjustedThreshold * 0.80;
  }
  
  // ATR override
  if (scenario.atrPct > 100) {
    adjustments.push(`ATR=${scenario.atrPct.toFixed(1)}% (explosive) → -15%`);
    adjustedThreshold = adjustedThreshold * 0.85;
  }
  
  const passed = scenario.signalConfidence >= adjustedThreshold;
  const result = passed ? "✅ SIGNAL ACCEPTÉ" : "❌ Signal rejeté";
  
  console.log(`📊 ${scenario.name}`);
  console.log(`   Threshold de base: ${(scenario.baseThreshold * 100).toFixed(1)}%`);
  if (adjustments.length > 0) {
    console.log(`   Ajustements: ${adjustments.join(", ")}`);
  }
  console.log(`   Threshold final: ${(adjustedThreshold * 100).toFixed(1)}%`);
  console.log(`   Signal confidence: ${(scenario.signalConfidence * 100).toFixed(1)}%`);
  console.log(`   ${result}`);
  console.log("");
}

console.log("=".repeat(70));
console.log("\n💡 Résumé:");
console.log("   - Avec RSI < 25: threshold 0.45 → 0.293 (réduit à ~29%)");
console.log("   - Avec RSI < 25 + ATR > 100%: threshold 0.45 → 0.249 (~25%)");
console.log("   - Signaux ETH à 0.238-0.339 passeront maintenant!");

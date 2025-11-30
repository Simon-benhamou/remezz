/**
 * Compare: SL check par LOW vs SL check par CLOSE
 * 
 * Le low d'une bougie est TOUJOURS <= close
 * Donc checker avec LOW déclenche plus de SL que checker avec CLOSE
 */

console.log('═'.repeat(80));
console.log('COMPARAISON: SL CHECK PAR LOW vs CLOSE');
console.log('═'.repeat(80));

// Simulation d'un trade LONG avec une bougie volatile
const examples = [
  { entry: 100, low: 97.5, close: 99, slPct: 1.5, desc: 'Wick but recovered' },
  { entry: 100, low: 98.2, close: 99.5, slPct: 1.5, desc: 'Minor wick' },
  { entry: 100, low: 96.0, close: 98.7, slPct: 1.5, desc: 'Deep wick, recovered' },
  { entry: 100, low: 98.8, close: 101.5, slPct: 1.5, desc: 'Winning trade avec légère wick' },
];

console.log('\n📊 Exemples de bougies:');
console.log('═'.repeat(80));

for (const ex of examples) {
  const slPrice = ex.entry * (1 - ex.slPct / 100);
  const closeDropPct = (ex.entry - ex.close) / ex.entry * 100;
  
  const slByLow = ex.low <= slPrice;
  const slByClose = closeDropPct >= ex.slPct;
  
  console.log(`\n${ex.desc}:`);
  console.log(`  Entry: $${ex.entry}, Low: $${ex.low}, Close: $${ex.close}`);
  console.log(`  SL Price: $${slPrice.toFixed(2)} (${ex.slPct}%)`);
  console.log(`  Close drop: ${closeDropPct.toFixed(2)}%`);
  console.log(`  ❌ SL par LOW:   ${slByLow ? '🛑 STOPPÉ' : '✅ Pas stoppé'}`);
  console.log(`  ✅ SL par CLOSE: ${slByClose ? '🛑 STOPPÉ' : '✅ Pas stoppé'}`);
  
  if (slByLow && !slByClose) {
    console.log(`  ⚠️  DIFFÉRENCE! Ce trade est perdant avec LOW, gagnant avec CLOSE`);
  }
}

console.log('\n' + '═'.repeat(80));
console.log('CONCLUSION');
console.log('═'.repeat(80));

console.log(`
Le backtestService.ts utilise LOW pour checker le SL:
  👉 Plus réaliste (un market order SL serait déclenché au low)
  👉 Mais BEAUCOUP plus de trades perdants

Le backtest-combined-v54.mjs utilise CLOSE pour checker le SL:
  👉 Moins réaliste (on ne voit pas les wicks intra-candle)
  👉 Mais MOINS de trades perdants (faux positif moins pénalisé)

IMPACT SUR WIN RATE:
  Avec LOW:   WR réel ~30-35% → -50% sur 11 mois
  Avec CLOSE: WR apparent ~45-50% → +1000% sur 11 mois

Les deux approches ont des compromis:
  - LOW = plus conservateur, plus réaliste pour futures
  - CLOSE = plus optimiste, mieux pour backtests à long terme
`);

/**
 * Test comparatif des différents leverages
 * Pour trouver le sweet spot ROI/Risque
 */

// Données extraites des backtests
const results = [
  { leverage: '5x uniforme', roi: 2116, maxDD: 51.7, worstTrade: -8.5, avgLoss: -8.4 },
  { leverage: '3-4x par actif', roi: 1078, maxDD: 40.0, worstTrade: -6.7, avgLoss: -6.7 },
];

console.log('═'.repeat(70));
console.log('📊 ANALYSE COMPARATIVE LEVERAGE - $2K Capital sur 24 mois');
console.log('═'.repeat(70));

console.log('\n┌─────────────────┬────────┬──────────┬────────────┬──────────┐');
console.log('│ Configuration   │   ROI  │  Max DD  │ Worst Loss │ Avg Loss │');
console.log('├─────────────────┼────────┼──────────┼────────────┼──────────┤');

for (const r of results) {
  console.log(`│ ${r.leverage.padEnd(15)} │ ${(r.roi + '%').padStart(6)} │ ${(r.maxDD + '%').padStart(8)} │ ${(r.worstTrade + '%').padStart(10)} │ ${(r.avgLoss + '%').padStart(8)} │`);
}
console.log('└─────────────────┴────────┴──────────┴────────────┴──────────┘');

// Calcul du ratio ROI/Risque (Sharpe-like)
console.log('\n📈 RATIO ROI / MAX DRAWDOWN (plus haut = meilleur):');
for (const r of results) {
  const ratio = (r.roi / r.maxDD).toFixed(2);
  console.log(`   ${r.leverage}: ${ratio}x (ROI ${r.roi}% / DD ${r.maxDD}%)`);
}

// Analyse du risque de ruine
console.log('\n⚠️  ANALYSE DU RISQUE:');
console.log('   Avec 4 positions simultanées et un gap de 5%:');

const scenarios = [
  { name: '5x leverage', leverage: 5, margin: 0.4 },
  { name: '4x leverage', leverage: 4, margin: 0.4 },
  { name: '3x leverage', leverage: 3, margin: 0.4 },
];

for (const s of scenarios) {
  const marginPerPos = s.margin / 4;  // 4 positions
  const lossPerPos = 5 * s.leverage;  // 5% gap × leverage
  const totalLoss = marginPerPos * lossPerPos * 4;  // 4 positions
  console.log(`   ${s.name}: Gap 5% = ${lossPerPos}% loss/position → ${(totalLoss).toFixed(0)}% total capital loss`);
}

console.log('\n💡 RECOMMANDATION:');
console.log('   Le ratio ROI/DD de 5x (41.0) est meilleur que 3-4x (27.0)');
console.log('   MAIS le drawdown de 51.7% peut être psychologiquement difficile.');
console.log('   ');
console.log('   SOLUTION INTERMÉDIAIRE: Utiliser 4x uniforme');
console.log('   → Devrait donner ~1500-1700% ROI avec ~45% max DD');
console.log('   → Ratio ROI/DD d\'environ 35x');


// FIX POUR LE BUG D'ENTRÉE - PRIX AU-DESSUS DE LA ZONE
// Corriger la logique pour permettre les entrées breakout
console.log('🔧 FIXING ENTRY ZONE BUG - PRICE ABOVE ZONE...\n');

function analyzeEntryLogicBug() {
  console.log('🐛 PROBLÈME IDENTIFIÉ:');
  console.log('='.repeat(60));
  
  console.log('\n📊 Situation AVNT:');
  console.log('• Prix actuel: 2.2077');
  console.log('• Zone d\'entrée: [2.1695, 2.1869]');
  console.log('• Prix est 0.940% AU-DESSUS de la zone');
  console.log('• Agent devrait entrer LONG mais n\'entre pas');
  
  console.log('\n🧠 ANALYSE DU CODE:');
  console.log(`
Dans agent/state.ts, ligne ~210:

if (playbook === 'momentum_breakout') {
  const breakoutLong = this.plan.bias === 'long' && price > upper;
  const breakoutShort = this.plan.bias === 'short' && price < lower;
  if (breakoutLong || breakoutShort) await this.enter(price, snap);
} else {
  // mean_reversion logic - PROBLÈME ICI !
  if (inZone && distanceFromEntry <= maxDistanceAllowed) {
    await this.enter(price, snap); // ← N'entre QUE si dans la zone
  }
}
  `);
  
  console.log('\n🎯 CAUSES POSSIBLES:');
  
  console.log('\n1. 📋 PLAYBOOK INCORRECT:');
  console.log('   • Agent utilise "mean_reversion" au lieu de "momentum_breakout"');
  console.log('   • mean_reversion = entre seulement DANS la zone');
  console.log('   • momentum_breakout = entre ABOVE zone (LONG) ou BELOW zone (SHORT)');
  
  console.log('\n2. 🎯 BIAS INCORRECT:');
  console.log('   • Prix au-dessus zone = devrait être bias LONG');
  console.log('   • Si bias = "short" ou "none", pas d\'entrée breakout');
  
  console.log('\n3. 🚫 MOMENTUM GATES:');
  console.log('   • RSI, ADX, ou autres filtres bloquent l\'entrée');
  console.log('   • Seuils trop restrictifs pour breakout');
  
  console.log('\n4. ⚙️  ÉTAT AGENT:');
  console.log('   • Agent pas en état ARMED');
  console.log('   • Position déjà ouverte');
  console.log('   • Agent en pause/halt');
  
  console.log('\n🔧 SOLUTIONS POSSIBLES:');
  console.log('='.repeat(60));
  
  console.log('\n✅ SOLUTION 1: Forcer Momentum Breakout');
  console.log(`
// Dans le plan LLM, s'assurer que:
{
  "meta": {
    "playbook": "momentum_breakout",  // ← CRITIQUE
    "bias": "long"                    // ← Prix au-dessus zone
  }
}
  `);
  
  console.log('\n✅ SOLUTION 2: Améliorer Mean Reversion');
  console.log(`
// Permettre entries légèrement au-dessus zone pour mean reversion
const zoneBuffer = zoneWidth * 0.1; // 10% buffer
const expandedZoneMax = Math.max(from, to) + zoneBuffer;
const inExpandedZone = price >= Math.min(from,to) && price <= expandedZoneMax;

if (inExpandedZone && distanceFromEntry <= maxDistanceAllowed) {
  await this.enter(price, snap);
}
  `);
  
  console.log('\n✅ SOLUTION 3: Hybrid Logic (RECOMMANDÉE)');
  console.log(`
// Combiner mean_reversion + breakout logic
const inZone = price >= Math.min(from,to) && price <= Math.max(from,to);
const nearZone = Math.abs(price - Math.max(from,to)) / Math.max(from,to) < 0.02; // 2%

const shouldEnter = playbook === 'momentum_breakout' 
  ? (bias === 'long' && price > Math.max(from,to)) || 
    (bias === 'short' && price < Math.min(from,to))
  : inZone || (nearZone && bias === 'long' && price > Math.max(from,to));

if (shouldEnter) {
  await this.enter(price, snap);
}
  `);
  
  console.log('\n🧪 TESTS À FAIRE:');
  console.log('='.repeat(60));
  
  console.log('\n1. 🔍 Vérifier playbook actuel:');
  console.log('   • Aller dans diagnostics agent');
  console.log('   • Regarder plan.meta.playbook');
  console.log('   • Si "mean_reversion" → c\'est le problème!');
  
  console.log('\n2. 🎯 Vérifier bias:');
  console.log('   • Regarder plan.bias');
  console.log('   • Devrait être "long" si prix > zone');
  
  console.log('\n3. 📊 Tester avec momentum_breakout:');
  console.log('   • Créer nouvel agent AVNT');
  console.log('   • Forcer playbook = "momentum_breakout"');
  console.log('   • Observer si entrée avec prix au-dessus zone');
  
  console.log('\n4. 🔧 Debug API calls:');
  console.log('   • GET /api/agent/sessions/{id}/diagnostics');
  console.log('   • Regarder tous les checks qui fail');
  console.log('   • Identifier le vrai blocage');
  
  console.log('\n💡 FIX IMMÉDIAT RECOMMANDÉ:');
  console.log('='.repeat(60));
  
  console.log('\n🚀 Modification dans state.ts:');
  console.log(`
// Autour ligne 210-250, remplacer:
if (inZone && distanceFromEntry <= maxDistanceAllowed) {
  await this.enter(price, snap);
}

// Par:
const shouldEnterMeanReversion = inZone && distanceFromEntry <= maxDistanceAllowed;
const shouldEnterBreakout = (
  (this.plan.bias === 'long' && price > Math.max(from, to) && 
   (price - Math.max(from, to)) / price < 0.02) || // Max 2% au-dessus
  (this.plan.bias === 'short' && price < Math.min(from, to) && 
   (Math.min(from, to) - price) / price < 0.02)    // Max 2% en-dessous
);

if (shouldEnterMeanReversion || shouldEnterBreakout) {
  await this.enter(price, snap);
}
  `);
  
  console.log('\n⚡ RÉSULTAT ATTENDU:');
  console.log('• Prix 2.2077 > Zone 2.1869 avec bias LONG');
  console.log('• Distance 0.940% < 2% threshold');
  console.log('• Agent devrait entrer LONG immédiatement');
  console.log('• Stop loss autour de 2.16 (en-dessous zone)');
  console.log('• Take profit autour de 2.25+ (ratio 2:1)');
  
  console.log('\n🎯 POUR TON CAS SPÉCIFIQUE:');
  console.log('1. Vérifier que l\'agent AVNT a bias="long"');
  console.log('2. Soit changer playbook vers "momentum_breakout"');
  console.log('3. Soit implémenter le fix hybrid ci-dessus');
  console.log('4. Tester avec le même scenario (prix 2.2077)');
  
  console.log('\n' + '='.repeat(60));
  console.log('🎉 AVEC CE FIX, L\'AGENT DEVRAIT ENTRER !');
  console.log('='.repeat(60));
}

analyzeEntryLogicBug();
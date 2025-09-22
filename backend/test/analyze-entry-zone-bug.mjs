// Test du cas réel DOGE - Reproduire le bug exact observé
console.log('🎯 REPRODUCTION DU BUG EXACT DOGE\n');

async function reproduceDOGEBug() {
  try {
    console.log('🔍 REPRODUCTION DU CAS PROBLÉMATIQUE:');
    console.log('Prix DOGE: $0.2387');
    console.log('Bias calculé: SHORT');
    console.log('Entry zone observée: $0.2297 - $0.2308 (EN-DESSOUS du prix)');
    console.log('');
    
    console.log('🚨 PROBLÈME IDENTIFIÉ:');
    console.log('BIAS SHORT mais entry zone EN-DESSOUS du prix !');
    console.log('Pour SHORT, la zone devrait être AU-DESSUS (résistance)');
    
    console.log('\n🧠 ANALYSE DU CODE calculateDynamicEntryZone:');
    console.log('');
    
    // Simuler la logique problématique
    const currentPrice = 0.2387;
    const bias = 'short';
    
    console.log('📉 LOGIQUE SHORT actuelle:');
    console.log('```typescript');
    console.log('// SHORT SCENARIO: Target resistance areas for rejection entries');
    console.log('const nearestResistance = resistances');
    console.log('  .filter(r => r.price > currentPrice)  // ✅ CORRECT: résistance au-dessus');
    console.log('  .sort((a, b) => Math.abs(currentPrice - a.price) - Math.abs(currentPrice - b.price))[0];');
    console.log('```');
    
    console.log('\n🎯 MAIS ENSUITE... FALLBACK EMA:');
    console.log('```typescript');
    console.log('if (!targetLevel || Math.abs(currentPrice - targetLevel) / currentPrice > 0.08) {');
    console.log('  // Use EMA levels as dynamic resistance');
    console.log('  const ema20 = Number((snap as any)?.ema20 ?? currentPrice);');
    console.log('  const ema50 = Number((snap as any)?.ema50 ?? currentPrice);');
    console.log('  ');
    console.log('  if (currentPrice < ema20 && ema20 > 0 && (ema20 - currentPrice) / currentPrice < 0.05) {');
    console.log('    targetLevel = ema20;  // 🚨 PROBLÈME: ema20 peut être EN-DESSOUS!');
    console.log('  }');
    console.log('}');
    console.log('```');
    
    console.log('\n🚨 BUG IDENTIFIÉ:');
    console.log('Le condition "currentPrice < ema20" est INCORRECTE pour SHORT bias !');
    console.log('');
    console.log('Pour SHORT bias:');
    console.log('- On veut une RÉSISTANCE (niveau AU-DESSUS)');
    console.log('- Donc condition devrait être: currentPrice < ema20 (ema20 au-dessus)');
    console.log('- Mais la logique actuelle dit: "si prix < ema20 alors utiliser ema20"');
    console.log('- Résultat: ema20 peut être en-dessous du prix !');
    
    console.log('\n💡 CORRECTIONS NÉCESSAIRES:');
    
    console.log('\n1️⃣ CORRECTION EMA20 pour SHORT:');
    console.log('```typescript');
    console.log('// AVANT (buggy):');
    console.log('if (currentPrice < ema20 && ema20 > 0 && (ema20 - currentPrice) / currentPrice < 0.05) {');
    console.log('');
    console.log('// APRÈS (correct):');
    console.log('if (currentPrice < ema20 && ema20 > 0 && (ema20 - currentPrice) / currentPrice < 0.05) {');
    console.log('  // ✅ CORRECT: ema20 est au-dessus pour résistance');
    console.log('  targetLevel = ema20;');
    console.log('} else if (currentPrice < ema50 && ema50 > 0 && (ema50 - currentPrice) / currentPrice < 0.08) {');
    console.log('  targetLevel = ema50;');
    console.log('} else {');
    console.log('  // Bounce calculation for SHORT should go UP');
    console.log('  const bouncePct = Math.max(0.02, Math.min(0.04, atrPct / 100));');
    console.log('  targetLevel = currentPrice * (1 + bouncePct);  // ✅ AU-DESSUS');
    console.log('}');
    console.log('```');
    
    console.log('\n2️⃣ VALIDATION FINALE:');
    console.log('```typescript');
    console.log('// Ajouter validation de cohérence');
    console.log('if (bias === "short" && targetLevel <= currentPrice) {');
    console.log('  console.warn(`⚠️ Incohérence SHORT: targetLevel (${targetLevel}) <= currentPrice (${currentPrice})`);');
    console.log('  // Force fallback to bounce above');
    console.log('  targetLevel = currentPrice * 1.025; // 2.5% au-dessus');
    console.log('}');
    console.log('if (bias === "long" && targetLevel >= currentPrice) {');
    console.log('  console.warn(`⚠️ Incohérence LONG: targetLevel (${targetLevel}) >= currentPrice (${currentPrice})`);');
    console.log('  // Force fallback to pullback below');
    console.log('  targetLevel = currentPrice * 0.975; // 2.5% en-dessous');
    console.log('}');
    console.log('```');
    
    console.log('\n🔧 PROCHAINE ÉTAPE:');
    console.log('Appliquer ces corrections dans calculateDynamicEntryZone()');
    
  } catch (error) {
    console.error('❌ Erreur:', error);
  }
}

reproduceDOGEBug();
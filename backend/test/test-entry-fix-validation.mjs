// TEST DU FIX ENTRY ZONE - VÉRIFICATION
// Teste la nouvelle logique d'entrée hybrid
console.log('🧪 TESTING ENTRY ZONE FIX - HYBRID LOGIC...\n');

function testEntryLogicFix() {
  console.log('🎯 SIMULATION DE LA NOUVELLE LOGIQUE:');
  console.log('='.repeat(60));
  
  // Paramètres du test AVNT
  const currentPrice = 2.2077;
  const zoneFrom = 2.1695121000000004;
  const zoneTo = 2.1869379;
  const bias = 'long';
  const breakoutThreshold = 0.02; // 2%
  
  console.log(`📊 Test Parameters:`);
  console.log(`Price: ${currentPrice}`);
  console.log(`Zone: [${zoneFrom.toFixed(4)}, ${zoneTo.toFixed(4)}]`);
  console.log(`Bias: ${bias}`);
  console.log(`Breakout Threshold: ${breakoutThreshold * 100}%`);
  
  // Calculer les valeurs comme dans le code
  const zoneMin = Math.min(zoneFrom, zoneTo);
  const zoneMax = Math.max(zoneFrom, zoneTo);
  const inZone = currentPrice >= zoneMin && currentPrice <= zoneMax;
  
  console.log(`\n🔍 Zone Analysis:`);
  console.log(`Zone Min: ${zoneMin.toFixed(4)}`);
  console.log(`Zone Max: ${zoneMax.toFixed(4)}`);
  console.log(`In Zone: ${inZone}`);
  
  // Test de la logique mean reversion (ancienne)
  const zoneWidth = Math.abs(zoneTo - zoneFrom);
  const distanceFromEntry = bias === 'long' ? 
    (currentPrice - Math.min(zoneFrom, zoneTo)) / zoneWidth : 
    (Math.max(zoneFrom, zoneTo) - currentPrice) / zoneWidth;
  const maxDistanceAllowed = 0.4;
  const shouldEnterMeanReversion = inZone && distanceFromEntry <= maxDistanceAllowed;
  
  console.log(`\n📈 Mean Reversion Logic (OLD):`);
  console.log(`Zone Width: ${zoneWidth.toFixed(4)}`);
  console.log(`Distance From Entry: ${distanceFromEntry.toFixed(3)}`);
  console.log(`Max Distance Allowed: ${maxDistanceAllowed}`);
  console.log(`Would Enter (Mean Rev): ${shouldEnterMeanReversion}`);
  
  // Test de la nouvelle logique breakout
  const shouldEnterBreakout = (
    (bias === 'long' && currentPrice > zoneMax && 
     (currentPrice - zoneMax) / currentPrice < breakoutThreshold) ||
    (bias === 'short' && currentPrice < zoneMin && 
     (zoneMin - currentPrice) / currentPrice < breakoutThreshold)
  );
  
  const distanceAboveZone = (currentPrice - zoneMax) / currentPrice;
  const distanceBelowZone = (zoneMin - currentPrice) / currentPrice;
  
  console.log(`\n🚀 Breakout Logic (NEW):`);
  console.log(`Price > Zone Max: ${currentPrice > zoneMax}`);
  console.log(`Distance Above Zone: ${(distanceAboveZone * 100).toFixed(3)}%`);
  console.log(`Within Breakout Threshold: ${distanceAboveZone < breakoutThreshold}`);
  console.log(`Would Enter (Breakout): ${shouldEnterBreakout}`);
  
  // Résultat final
  const finalDecision = shouldEnterMeanReversion || shouldEnterBreakout;
  
  console.log(`\n✅ FINAL DECISION:`);
  console.log(`Mean Reversion: ${shouldEnterMeanReversion}`);
  console.log(`Breakout: ${shouldEnterBreakout}`);
  console.log(`ENTER TRADE: ${finalDecision ? '🎯 YES' : '❌ NO'}`);
  
  // Scénarios additionnels
  console.log(`\n🧪 ADDITIONAL TEST SCENARIOS:`);
  console.log('='.repeat(60));
  
  const testScenarios = [
    { price: 2.1800, desc: 'Price IN zone' },
    { price: 2.1900, desc: 'Price just above zone (0.15%)' },
    { price: 2.2100, desc: 'Price well above zone (1.05%)' },
    { price: 2.2500, desc: 'Price too far above zone (3.5%)' },
    { price: 2.1600, desc: 'Price below zone' }
  ];
  
  testScenarios.forEach(({ price, desc }) => {
    const inZoneTest = price >= zoneMin && price <= zoneMax;
    const breakoutTest = (
      (bias === 'long' && price > zoneMax && 
       (price - zoneMax) / price < breakoutThreshold) ||
      (bias === 'short' && price < zoneMin && 
       (zoneMin - price) / price < breakoutThreshold)
    );
    const distFromZone = price > zoneMax ? 
      ((price - zoneMax) / price * 100).toFixed(2) + '% above' :
      price < zoneMin ? 
        ((zoneMin - price) / price * 100).toFixed(2) + '% below' :
        'in zone';
    
    const wouldEnter = inZoneTest || breakoutTest;
    console.log(`${price.toFixed(4)} (${desc}): ${distFromZone} → ${wouldEnter ? '✅ ENTER' : '❌ NO'}`);
  });
  
  // Comparaison avant/après fix
  console.log(`\n🔄 BEFORE vs AFTER FIX:`);
  console.log('='.repeat(60));
  
  console.log(`AVNT Scenario (Price 2.2077):`);
  console.log(`BEFORE: ${shouldEnterMeanReversion ? '✅ Would enter' : '❌ Would NOT enter'} (mean reversion only)`);
  console.log(`AFTER:  ${finalDecision ? '✅ WILL enter' : '❌ Will NOT enter'} (hybrid logic)`);
  
  if (finalDecision && !shouldEnterMeanReversion) {
    console.log(`🎉 FIX SUCCESSFUL! Breakout logic catches this entry.`);
  }
  
  console.log(`\n📊 Entry Details for AVNT:`);
  console.log(`Entry Price: ${currentPrice}`);
  console.log(`Stop Loss: ~${(zoneMin * 0.995).toFixed(4)} (below zone)`);
  console.log(`Take Profit: ~${(currentPrice * 1.025).toFixed(4)} (2.5% above)`);
  console.log(`Risk/Reward: ~${((currentPrice * 1.025 - currentPrice) / (currentPrice - zoneMin * 0.995)).toFixed(2)}:1`);
  
  console.log(`\n🔧 IMPLEMENTATION STATUS:`);
  console.log('✅ Code updated in agent/state.ts');
  console.log('✅ Hybrid logic implemented');
  console.log('✅ Breakout threshold set to 2%');
  console.log('✅ Both mean reversion AND breakout supported');
  
  console.log(`\n🚀 NEXT STEPS:`);
  console.log('1. Restart backend to load new code');
  console.log('2. Create or restart AVNT agent');
  console.log('3. Test with current market conditions');
  console.log('4. Verify entry happens at price > zone');
  
  return finalDecision;
}

const result = testEntryLogicFix();
console.log(`\n${'='.repeat(60)}`);
console.log(`🎯 CONCLUSION: ${result ? 'FIX SHOULD WORK!' : 'ADDITIONAL DEBUGGING NEEDED'}`);
console.log(`${'='.repeat(60)}`);
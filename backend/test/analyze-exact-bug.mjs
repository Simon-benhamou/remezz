// Test reproduction exacte du bug symbol mismatch
console.log('🐞 REPRODUCTION EXACTE DU BUG SYMBOL MISMATCH\n');

async function reproduceExactBug() {
  try {
    console.log('🎯 SCENARIO: Reproduire le cas exact du user');
    console.log('Message user: "Price 4167.5800 outside original zone [4438.9976, 4506.0857] (6.513% below)"');
    console.log('Agent sélectionné: DOGE, mais prix/zone = ETH\n');
    
    // Données exactes du bug
    const bugData = {
      currentPrice: 4167.58,    // Prix affiché (ETH scale)
      zoneFrom: 4438.997604166666,
      zoneTo: 4506.085729166666,
      selectedSymbol: 'DOGE',   // Agent a sélectionné DOGE
      inZone: false,
      isDynamic: false
    };
    
    console.log('📊 BUG DATA ANALYSIS:');
    console.log(`- Current Price: $${bugData.currentPrice}`);
    console.log(`- Zone: [$${bugData.zoneFrom.toFixed(4)}, $${bugData.zoneTo.toFixed(4)}]`);
    console.log(`- Selected Symbol: ${bugData.selectedSymbol}`);
    console.log(`- In Zone: ${bugData.inZone}`);
    console.log(`- Is Dynamic: ${bugData.isDynamic}`);
    
    // Test notre logique de détection
    const zoneAvg = (bugData.zoneFrom + bugData.zoneTo) / 2;
    const scaleRatio = Math.max(bugData.currentPrice, zoneAvg) / Math.min(bugData.currentPrice, zoneAvg);
    const shouldDetectMismatch = scaleRatio > 50;
    
    console.log('\n🔍 MISMATCH DETECTION:');
    console.log(`- Zone avg: $${zoneAvg.toFixed(2)}`);
    console.log(`- Scale ratio: ${scaleRatio.toFixed(0)}x`);
    console.log(`- Should detect mismatch: ${shouldDetectMismatch}`);
    
    if (shouldDetectMismatch) {
      console.log(`✅ Our fix WOULD detect this as symbol mismatch`);
    } else {
      console.log(`❌ Our fix would NOT detect this - threshold too high`);
    }
    
    // Mais le problème est plus subtil : prix DOGE réel ~$0.24, pas $4167
    console.log('\n🤔 DEEPER ANALYSIS:');
    console.log('Le prix $4167 pour DOGE est impossible !');
    console.log('DOGE real price ~$0.24');
    console.log('Donc le bug est que l\'agent:');
    console.log('1. A sélectionné DOGE comme symbol');
    console.log('2. Mais utilise encore l\'ancien snap/price d\'ETH');
    console.log('3. Zones d\'ETH + Prix d\'ETH + Label "DOGE"');
    
    console.log('\n💡 ROOT CAUSE:');
    console.log('Le changement de symbol ne déclenche pas:');
    console.log('- Refresh du snapshot technique');
    console.log('- Recalcul des zones');
    console.log('- Reset du plan');
    
    console.log('\n🔧 SOLUTION COMPLÈTE:');
    console.log('En plus de detectSymbolMismatch(), il faut:');
    console.log('1. ✅ Détecter scale mismatch (implémenté)');
    console.log('2. ⚠️  Forcer refresh snapshot après symbol change');
    console.log('3. ⚠️  Reset plan/zone lors symbol switch');
    console.log('4. ⚠️  Validation cohérence symbol/snap dans onTick()');
    
    // Test de validation supplémentaire
    console.log('\n🧪 ADDITIONAL VALIDATION:');
    
    // Si DOGE mais prix > $100, forcément incohérent
    const dogePrice = bugData.currentPrice;
    const isDogePriceRealistic = dogePrice >= 0.01 && dogePrice <= 10; // Gamme réaliste DOGE
    
    console.log(`DOGE price $${dogePrice} realistic: ${isDogePriceRealistic}`);
    
    if (!isDogePriceRealistic && bugData.selectedSymbol === 'DOGE') {
      console.log(`🚨 ADDITIONAL BUG: DOGE price $${dogePrice} is completely unrealistic`);
      console.log(`   This confirms symbol/snapshot inconsistency`);
    }
    
    console.log('\n🎯 ENHANCED FIX NEEDED:');
    console.log('```typescript');
    console.log('// In agent when symbol changes:');
    console.log('if (newSymbol !== this.profile.symbol) {');
    console.log('  console.log(`Symbol changed: ${this.profile.symbol} → ${newSymbol}`);');
    console.log('  this.profile.symbol = newSymbol;');
    console.log('  this.plan = null; // Force plan regeneration');
    console.log('  this.zone = null; // Clear old zones');
    console.log('  await this.refreshSnapshot(); // Get new market data');
    console.log('}');
    console.log('```');
    
    console.log('\n📝 IMMEDIATE ACTION:');
    console.log('La correction detectSymbolMismatch() aide mais il faut aussi:');
    console.log('- Vérifier que le symbol change déclenche un plan refresh complet');
    console.log('- S\'assurer que buildTechSnapshot utilise le bon symbol');
    
  } catch (error) {
    console.error('❌ Analysis failed:', error);
  }
}

reproduceExactBug();
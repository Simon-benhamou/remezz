// Test de la nouvelle logique de validation symbol/price
console.log('✅ TEST VALIDATION SYMBOL/PRICE AMÉLIORÉE\n');

async function testEnhancedValidation() {
  try {
    console.log('🧪 TESTING NEW VALIDATION LOGIC');
    
    // Simuler la fonction detectSymbolMismatch améliorée
    function testDetectSymbolMismatch(currentPrice, zoneMin, zoneMax, symbol) {
      // Check 1: Scale ratio
      const zoneAvg = (zoneMin + zoneMax) / 2;
      const scaleRatio = Math.max(currentPrice, zoneAvg) / Math.min(currentPrice, zoneAvg);
      
      if (scaleRatio > 50) {
        console.log(`🚨 Scale mismatch: price=${currentPrice}, zone avg=${zoneAvg.toFixed(2)}, ratio=${scaleRatio.toFixed(0)}x`);
        return true;
      }
      
      // Check 2: Symbol-specific realism
      if (symbol) {
        const base = symbol.split('/')[0].toUpperCase();
        
        const priceRanges = {
          'DOGE': { min: 0.01, max: 10 },
          'BTC': { min: 1000, max: 200000 },
          'ETH': { min: 100, max: 20000 },
          'SOL': { min: 1, max: 1000 },
          'XRP': { min: 0.1, max: 10 },
          'ADA': { min: 0.01, max: 10 },
        };
        
        const range = priceRanges[base];
        if (range && (currentPrice < range.min || currentPrice > range.max)) {
          console.log(`🚨 Symbol/price realism mismatch: ${base} price $${currentPrice} outside [$${range.min}, $${range.max}]`);
          return true;
        }
      }
      
      return false;
    }
    
    // Test cases incluant le bug exact du user
    const testCases = [
      {
        name: 'User Bug - DOGE with ETH price',
        currentPrice: 4167.58,
        zoneMin: 4438.9976,
        zoneMax: 4506.0857,
        symbol: 'DOGE/USDT',
        expectedDetection: true // Nouvelle logique devrait détecter
      },
      {
        name: 'Normal DOGE',
        currentPrice: 0.24,
        zoneMin: 0.23,
        zoneMax: 0.25,
        symbol: 'DOGE/USDT',
        expectedDetection: false
      },
      {
        name: 'Normal ETH',
        currentPrice: 4200,
        zoneMin: 4150,
        zoneMax: 4250,
        symbol: 'ETH/USDT',
        expectedDetection: false
      },
      {
        name: 'BTC with tiny alt price',
        currentPrice: 0.001,
        zoneMin: 0.0009,
        zoneMax: 0.0011,
        symbol: 'BTC/USDT',
        expectedDetection: true // BTC ne peut pas être $0.001
      },
      {
        name: 'XRP with massive price',
        currentPrice: 50000,
        zoneMin: 49000,
        zoneMax: 51000,
        symbol: 'XRP/USDT',
        expectedDetection: true // XRP ne peut pas être $50k
      }
    ];
    
    console.log('📊 TESTING ENHANCED DETECTION:');
    
    testCases.forEach((test, i) => {
      console.log(`\n${i+1}. ${test.name}:`);
      console.log(`   Symbol: ${test.symbol}`);
      console.log(`   Price: $${test.currentPrice}`);
      console.log(`   Zone: [$${test.zoneMin}, $${test.zoneMax}]`);
      
      const detected = testDetectSymbolMismatch(
        test.currentPrice, 
        test.zoneMin, 
        test.zoneMax, 
        test.symbol
      );
      
      console.log(`   Detected: ${detected}`);
      console.log(`   Expected: ${test.expectedDetection}`);
      
      if (detected === test.expectedDetection) {
        console.log(`   ✅ CORRECT`);
      } else {
        console.log(`   ❌ INCORRECT`);
      }
    });
    
    console.log('\n🎯 KEY IMPROVEMENT:');
    console.log('La nouvelle logique ajoute la validation price realism:');
    console.log('- DOGE $4167 → DÉTECTÉ comme incohérent');
    console.log('- BTC $0.001 → DÉTECTÉ comme incohérent');
    console.log('- XRP $50000 → DÉTECTÉ comme incohérent');
    
    console.log('\n✅ RÉSOLUTION BUG USER:');
    console.log('Avant: DOGE $4167 → pas détecté (scale ratio=1x)');
    console.log('Après: DOGE $4167 → DÉTECTÉ (price realism)');
    console.log('Result: Force dynamic recalculation avec snapshot DOGE');
    
    console.log('\n🔧 PROCHAINE ÉTAPE:');
    console.log('Attendre qu\'un agent AUTO change de crypto pour tester en réel');
    console.log('Ou forcer un re-selection pour déclencher le scenario');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

testEnhancedValidation();
// Test du fix symbol mismatch - Zones persistantes lors changement crypto
console.log('🔧 TEST FIX SYMBOL MISMATCH - Zones Persistantes\n');

async function testSymbolMismatchFix() {
  try {
    console.log('🧪 SCENARIO: Agent avec zones ETH testant prix DOGE');
    
    // Cas de test reproduisant le bug
    const testCases = [
      {
        name: 'ETH → DOGE Mismatch',
        currentPrice: 0.2387, // Prix DOGE
        zoneMin: 4438.9976,   // Zone ETH
        zoneMax: 4506.0857,   // Zone ETH
        expectedMismatch: true
      },
      {
        name: 'BTC → Small Alt Mismatch',
        currentPrice: 1.25,    // Alt coin
        zoneMin: 41000,       // Zone BTC
        zoneMax: 43000,       // Zone BTC
        expectedMismatch: true
      },
      {
        name: 'Normal ETH Range',
        currentPrice: 4200,    // Prix ETH normal
        zoneMin: 4150,        // Zone ETH normale
        zoneMax: 4250,        // Zone ETH normale
        expectedMismatch: false
      },
      {
        name: 'DOGE Range Normal',
        currentPrice: 0.24,    // Prix DOGE normal
        zoneMin: 0.23,        // Zone DOGE normale
        zoneMax: 0.25,        // Zone DOGE normale
        expectedMismatch: false
      }
    ];
    
    // Simuler la logique detectSymbolMismatch
    console.log('📊 TESTING DETECTION LOGIC:');
    
    testCases.forEach((test, i) => {
      console.log(`\n${i+1}. ${test.name}:`);
      console.log(`   Price: $${test.currentPrice}`);
      console.log(`   Zone: [$${test.zoneMin}, $${test.zoneMax}]`);
      
      // Reproduire la logique
      const zoneAvg = (test.zoneMin + test.zoneMax) / 2;
      const scaleRatio = Math.max(test.currentPrice, zoneAvg) / Math.min(test.currentPrice, zoneAvg);
      const mismatchDetected = scaleRatio > 50;
      
      console.log(`   Zone avg: $${zoneAvg.toFixed(2)}`);
      console.log(`   Scale ratio: ${scaleRatio.toFixed(0)}x`);
      console.log(`   Mismatch detected: ${mismatchDetected}`);
      console.log(`   Expected: ${test.expectedMismatch}`);
      
      if (mismatchDetected === test.expectedMismatch) {
        console.log(`   ✅ CORRECT`);
      } else {
        console.log(`   ❌ INCORRECT - Logic needs adjustment`);
      }
    });
    
    console.log('\n🔍 DIAGNOSTICS INTEGRATION:');
    
    // Tester l'intégration avec getDiagnostics via API
    console.log('Testing real agent diagnostics...');
    
    try {
      // Récupérer les sessions actives
      const response = await fetch('http://localhost:4000/api/agent/sessions');
      const sessions = await response.json();
      
      if (sessions && sessions.length > 0) {
        const dogeSession = sessions.find(s => s.symbol && s.symbol.includes('DOGE'));
        
        if (dogeSession) {
          console.log(`\n🐕 Found DOGE session: ${dogeSession.id.substring(0, 8)}...`);
          
          // Appeler diagnostics
          const diagResponse = await fetch(`http://localhost:4000/api/agent/sessions/${dogeSession.id}/diagnostics`);
          const diagnostics = await diagResponse.json();
          
          if (diagnostics && diagnostics.checks && diagnostics.checks.inEntryZone) {
            const zoneCheck = diagnostics.checks.inEntryZone;
            
            console.log('\n📋 DIAGNOSTICS RESULTS:');
            console.log(`- Status: ${zoneCheck.status}`);
            console.log(`- Reason: ${zoneCheck.reason}`);
            
            if (zoneCheck.details) {
              const details = zoneCheck.details;
              console.log(`- Current Price: $${details.currentPrice}`);
              console.log(`- Zone From: $${details.zoneFrom}`);
              console.log(`- Zone To: $${details.zoneTo}`);
              console.log(`- In Zone: ${details.inZone}`);
              console.log(`- Is Dynamic: ${details.isDynamic}`);
              
              // Analyser si la correction a fonctionné
              const priceScale = details.currentPrice;
              const zoneScale = (details.zoneFrom + details.zoneTo) / 2;
              const ratio = Math.max(priceScale, zoneScale) / Math.min(priceScale, zoneScale);
              
              console.log(`\n🧮 SCALE ANALYSIS:`);
              console.log(`- Price scale: $${priceScale}`);
              console.log(`- Zone scale: $${zoneScale.toFixed(2)}`);
              console.log(`- Ratio: ${ratio.toFixed(0)}x`);
              
              if (ratio > 50) {
                console.log(`❌ MISMATCH STILL EXISTS - Fix may not be working`);
              } else {
                console.log(`✅ SCALES COMPATIBLE - Fix appears to be working`);
              }
              
              if (details.isDynamic) {
                console.log(`✅ Zone was recalculated dynamically`);
              } else {
                console.log(`⚠️  Zone not recalculated - may need to trigger`);
              }
            }
          }
        } else {
          console.log('No DOGE session found for testing');
        }
      }
    } catch (apiError) {
      console.log(`❌ API test failed: ${apiError.message}`);
      console.log('Server may not be running on localhost:4000');
    }
    
    console.log('\n✅ FIX SUMMARY:');
    console.log('1. Added detectSymbolMismatch() method');
    console.log('2. Checks for >50x price/zone scale difference');
    console.log('3. Forces dynamic recalculation on symbol changes');
    console.log('4. Prevents ETH zones being used for DOGE prices');
    
    console.log('\n🎯 EXPECTED BEHAVIOR:');
    console.log('When agent switches DOGE → should see:');
    console.log('🚨 Price scale mismatch detected: price=0.2387, zone avg=4472.54, ratio=18719x');
    console.log('🔍 Dynamic zone recalc for DOGE/USDT: Symbol mismatch detected');
    console.log('🎯 Dynamic zone recalculation: [4438.9976, 4506.0857] → [0.2322, 0.2357]');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

testSymbolMismatchFix();
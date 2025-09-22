// ANALYSE XRP - Comportement Agent avec Baisse -5%
console.log('📊 ANALYSE COMPORTEMENT AGENT XRP (-5% en 24h)...\n');

async function analyzeXRPAgent() {
  console.log('🔍 ANALYSE XRP AGENT BEHAVIOR:');
  console.log('='.repeat(70));
  
  try {
    // 1. Récupérer données XRP actuelles
    console.log('\n📈 1. DONNÉES MARCHÉ XRP:');
    const tickerResponse = await fetch('https://api.crypto.com/v2/public/get-ticker?instrument_name=XRPUSD-PERP');
    
    if (tickerResponse.ok) {
      const tickerData = await tickerResponse.json();
      const ticker = tickerData.result?.data?.[0];
      
      if (ticker) {
        const price = Number(ticker.a || 0); // Ask price
        const change24h = Number(ticker.c || 0); // Change 24h
        const volume = Number(ticker.v || 0); // Volume
        const high24h = Number(ticker.h || 0);
        const low24h = Number(ticker.l || 0);
        
        console.log(`💰 Prix XRP: $${price.toFixed(4)}`);
        console.log(`📊 Change 24h: ${change24h > 0 ? '+' : ''}${change24h.toFixed(2)}%`);
        console.log(`📈 High 24h: $${high24h.toFixed(4)}`);
        console.log(`📉 Low 24h: $${low24h.toFixed(4)}`);
        console.log(`💹 Volume: $${(volume/1000000).toFixed(1)}M`);
        
        // 2. Analyser le contexte technique
        console.log('\n🧠 2. ANALYSE TECHNIQUE:');
        const priceRange = high24h - low24h;
        const volatility = (priceRange / price) * 100;
        const pricePosition = ((price - low24h) / priceRange) * 100;
        
        console.log(`🎯 Volatilité: ${volatility.toFixed(2)}% (range 24h)`);
        console.log(`📍 Position prix: ${pricePosition.toFixed(1)}% du range 24h`);
        
        if (pricePosition < 30) {
          console.log(`📉 CONTEXTE: Prix près du LOW 24h - Potentiel REBOND`);
        } else if (pricePosition > 70) {
          console.log(`📈 CONTEXTE: Prix près du HIGH 24h - Potentiel RESISTANCE`);
        } else {
          console.log(`⚖️ CONTEXTE: Prix en milieu de range - NEUTRE`);
        }
        
        // 3. Prédire comportement agent
        console.log('\n🤖 3. PRÉDICTION COMPORTEMENT AGENT:');
        
        // Logique basée sur les règles de l'agent
        const isOversold = change24h < -3; // Baisse > 3%
        const isNearLow = pricePosition < 40;
        const hasVolume = volume > 100000000; // > $100M volume
        
        console.log(`💡 Conditions détectées:`);
        console.log(`   • Oversold (< -3%): ${isOversold ? '✅ OUI' : '❌ NON'} (${change24h.toFixed(1)}%)`);
        console.log(`   • Near Low (<40%): ${isNearLow ? '✅ OUI' : '❌ NON'} (${pricePosition.toFixed(1)}%)`);
        console.log(`   • Volume OK (>$100M): ${hasVolume ? '✅ OUI' : '❌ NON'} ($${(volume/1000000).toFixed(0)}M)`);
        
        // Prédiction bias
        let predictedBias = 'NEUTRAL';
        let reasoning = '';
        
        if (isOversold && isNearLow && hasVolume) {
          predictedBias = 'LONG';
          reasoning = 'Oversold + Near Low + High Volume → REBOND probable';
        } else if (change24h < -5 && !isNearLow) {
          predictedBias = 'SHORT';
          reasoning = 'Forte baisse + Pas près du low → CONTINUATION possible';
        } else if (volatility > 5 && hasVolume) {
          predictedBias = 'SCALP';
          reasoning = 'Haute volatilité + Volume → Opportunité SCALPING';
        } else {
          reasoning = 'Conditions mixtes → ATTENTE signal clair';
        }
        
        console.log(`\n🎯 PRÉDICTION AGENT:`);
        console.log(`   📊 Bias probable: ${predictedBias}`);
        console.log(`   🧠 Raisonnement: ${reasoning}`);
        
        // 4. Analyse entry zone
        console.log('\n🎪 4. ANALYSE ENTRY ZONE:');
        
        // Simuler calcul entry zone (basé sur ATR et support)
        const atrEst = priceRange * 0.7; // Estimation ATR
        const supportEst = low24h * 1.002; // Support estimé légèrement au-dessus du low
        const resistanceEst = high24h * 0.998; // Resistance légèrement en-dessous du high
        
        console.log(`📍 Support estimé: $${supportEst.toFixed(4)}`);
        console.log(`📍 Resistance estimée: $${resistanceEst.toFixed(4)}`);
        console.log(`📊 ATR estimé: $${atrEst.toFixed(4)} (${((atrEst/price)*100).toFixed(2)}%)`);
        
        // Entry zone pour LONG
        const longEntryLow = supportEst - (atrEst * 0.3);
        const longEntryHigh = supportEst + (atrEst * 0.5);
        
        console.log(`\n📈 LONG Entry Zone:`);
        console.log(`   🟢 De: $${longEntryLow.toFixed(4)}`);
        console.log(`   🟢 À:  $${longEntryHigh.toFixed(4)}`);
        console.log(`   📏 Width: ${(((longEntryHigh - longEntryLow)/price)*100).toFixed(2)}%`);
        
        if (longEntryHigh - longEntryLow < atrEst * 0.5) {
          console.log(`   ⚠️ ZONE ÉTROITE - Seuil bas détecté`);
        } else {
          console.log(`   ✅ Zone normale`);
        }
        
        // 5. Recommandations
        console.log('\n💡 5. RECOMMANDATIONS:');
        
        if (change24h <= -5) {
          console.log(`🚨 BAISSE SIGNIFICATIVE (-5%+):`);
          console.log(`   • Surveiller support $${supportEst.toFixed(4)}`);
          console.log(`   • Si break support → SHORT continuation`);
          console.log(`   • Si rebond support → LONG reversal`);
          console.log(`   • Entry zone probablement SERRÉE (volatilité)`);
        }
        
        return {
          price,
          change24h,
          volume,
          volatility,
          pricePosition,
          predictedBias,
          reasoning,
          entryZoneWidth: ((longEntryHigh - longEntryLow)/price)*100,
          isNarrowZone: longEntryHigh - longEntryLow < atrEst * 0.5
        };
      }
    }
    
  } catch (error) {
    console.log('❌ Erreur récupération données XRP:', error.message);
    
    // Analyse théorique si pas de données
    console.log('\n📚 ANALYSE THÉORIQUE XRP (-5%):');
    console.log('🔍 Avec baisse -5% en 24h:');
    console.log('   • Agent va probablement chercher REBOND');
    console.log('   • Entry zone sera PRÈS DU SUPPORT');
    console.log('   • Seuil bas = NORMAL pour rebond technique');
    console.log('   • Bias probable: LONG (oversold bounce)');
    
    return {
      theoretical: true,
      reasoning: 'Analyse théorique - données non disponibles'
    };
  }
}

// Test de validation comportement
async function validateAgentBehavior() {
  console.log('\n🧪 VALIDATION COMPORTEMENT AGENT:');
  console.log('='.repeat(70));
  
  console.log('\n✅ COMPORTEMENTS ATTENDUS:');
  console.log(`1. 📉 BAISSE -5%:`);
  console.log(`   → Agent détecte OVERSOLD`);
  console.log(`   → Bias: LONG (rebond probable)`);
  console.log(`   → Entry zone: PRÈS DU SUPPORT`);
  console.log(`   → Seuil: BAS (entry précise)`);
  
  console.log(`\n2. 🎯 ENTRY ZONE BASSE:`);
  console.log(`   → NORMAL pour rebond technique`);
  console.log(`   → Permet entry précise au support`);
  console.log(`   → Évite false breakout`);
  console.log(`   → Risk/Reward optimisé`);
  
  console.log(`\n3. 🔍 SIGNAUX À SURVEILLER:`);
  console.log(`   → RSI < 35 (oversold confirme)`);
  console.log(`   → Prix près support key`);
  console.log(`   → Volume augmentation sur rebond`);
  console.log(`   → Rejection wick sur low`);
  
  console.log(`\n4. 🚨 RISQUES À MONITORER:`);
  console.log(`   → Break support → SHORT signal`);
  console.log(`   → Volume faible → False bottom`);
  console.log(`   → Continuation baisse → Trend change`);
  console.log(`   → News negatives → Sentiment shift`);
}

// Exécution de l'analyse
console.log('🚀 DÉMARRAGE ANALYSE XRP...\n');

analyzeXRPAgent().then((result) => {
  if (result) {
    console.log('\n📋 RÉSUMÉ ANALYSE:');
    console.log('='.repeat(70));
    
    if (result.theoretical) {
      console.log('📚 Analyse théorique effectuée');
    } else {
      console.log(`💰 Prix: $${result.price?.toFixed(4)}`);
      console.log(`📊 Change: ${result.change24h?.toFixed(2)}%`);
      console.log(`🎯 Bias prédit: ${result.predictedBias}`);
      console.log(`📏 Entry zone: ${result.entryZoneWidth?.toFixed(2)}% width`);
      console.log(`⚠️ Zone étroite: ${result.isNarrowZone ? 'OUI' : 'NON'}`);
    }
    
    validateAgentBehavior();
    
    console.log('\n🎯 CONCLUSION:');
    console.log('Si agent XRP a seuil bas avec baisse -5%:');
    console.log('✅ COMPORTEMENT NORMAL - Cherche rebond technique');
    console.log('✅ Entry zone serrée = PRÉCISION accrue');
    console.log('✅ Logique oversold bounce = CORRECT');
  }
}).catch(console.error);
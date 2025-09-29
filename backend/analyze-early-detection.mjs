import { getBestIntelligentOpportunity, scanIntelligentOpportunities } from './dist/src/services/intelligentAgent.js';

console.log('🔍 ANALYSE DE DÉTECTION PRÉCOCE');
console.log('=' .repeat(50));

async function analyzeEarlyDetection() {
  try {
    console.log('\n📊 CAPACITÉS DE DÉTECTION ACTUELLES');
    console.log('-'.repeat(40));
    
    console.log('🎯 Signaux techniques utilisés:');
    console.log('  ✅ RSI (14 périodes) - Surachat/Survente');
    console.log('  ✅ ADX (14 périodes) - Force de tendance');
    console.log('  ✅ Volatility - Volatilité réalisée');
    console.log('  ✅ Trend Strength - Force directionnelle');
    console.log('  ✅ Volume 24h - Activité marché');
    console.log('  ✅ Momentum - Variation % 24h');
    
    console.log('\n⏱️ FRÉQUENCE DE SCAN:');
    console.log('  📡 Scan toutes les 5 minutes');
    console.log('  🔄 100+ marchés analysés simultanément');
    console.log('  ⚡ Détection en temps quasi-réel');
    
    console.log('\n🚨 SEUILS DE DÉTECTION ACTUELS:');
    console.log('  📈 Mouvement standard: >0.1% détecté');
    console.log('  🚀 Mouvement fort: >2% priorité');
    console.log('  ⚡ Mouvement extrême: >5% alerte');
    console.log('  🎯 RSI < 30 ou > 70: Signal technique');
    console.log('  📊 ADX > 25: Tendance forte détectée');
    
    console.log('\n📈 EXEMPLE: Détection BTC +3%');
    console.log('-'.repeat(40));
    
    const timeline = [
      { time: 'T-15min', btc: '+0.2%', status: '✅ Détecté - Momentum faible' },
      { time: 'T-10min', btc: '+0.8%', status: '✅ Détecté - Momentum croissant' },
      { time: 'T-5min', btc: '+1.5%', status: '🚀 PRIORITÉ - Momentum fort' },
      { time: 'T-0min', btc: '+3.0%', status: '⚡ MAXIMUM - Action immédiate' }
    ];
    
    timeline.forEach(point => {
      console.log(`  ${point.time}: BTC ${point.btc} → ${point.status}`);
    });
    
    console.log('\n🔍 ANALYSE DE PERFORMANCE ACTUELLE:');
    console.log('-'.repeat(40));
    
    const opportunities = await scanIntelligentOpportunities();
    
    if (opportunities.length > 0) {
      console.log(`📊 Opportunités détectées: ${opportunities.length}`);
      
      // Analyse des mouvements détectés
      const movements = opportunities.map(op => ({
        symbol: op.symbol,
        momentum: op.metrics.momentum,
        rsi: op.metrics.rsi,
        adx: op.metrics.adx,
        volume: op.metrics.volume24h
      })).sort((a, b) => Math.abs(b.momentum) - Math.abs(a.momentum));
      
      console.log('\n🏆 Top 5 mouvements détectés:');
      movements.slice(0, 5).forEach((mov, i) => {
        const signal = Math.abs(mov.momentum) > 2 ? '🚀' : 
                      Math.abs(mov.momentum) > 1 ? '📈' : '📊';
        const rsiSignal = mov.rsi < 30 ? '🟢' : mov.rsi > 70 ? '🔴' : '⚪';
        const trendSignal = mov.adx > 25 ? '💪' : '💤';
        
        console.log(`  ${i+1}. ${mov.symbol}: ${mov.momentum.toFixed(2)}% ${signal}`);
        console.log(`     RSI: ${mov.rsi.toFixed(1)} ${rsiSignal} | ADX: ${mov.adx.toFixed(1)} ${trendSignal}`);
        console.log(`     Volume: $${(mov.volume/1000000).toFixed(1)}M`);
      });
      
      // Détection précoce simulée
      const earlySignals = movements.filter(m => 
        Math.abs(m.momentum) < 1 && 
        (m.rsi < 35 || m.rsi > 65 || m.adx > 20)
      );
      
      console.log(`\n🔮 Signaux précoces potentiels: ${earlySignals.length}`);
      earlySignals.slice(0, 3).forEach(signal => {
        console.log(`  📡 ${signal.symbol}: ${signal.momentum.toFixed(2)}% - Signaux techniques actifs`);
      });
    }
    
    console.log('\n⚡ AMÉLIORATIONS POSSIBLES POUR DÉTECTION PRÉCOCE:');
    console.log('-'.repeat(50));
    
    console.log('🎯 SIGNAUX AVANCÉS (non implémentés):');
    console.log('  📊 MACD - Convergence/Divergence moyennes mobiles');
    console.log('  📈 Bollinger Bands - Bandes de volatilité');
    console.log('  🌊 Volume Profile - Analyse volume/prix');
    console.log('  ⚡ Order Book - Profondeur marché');
    console.log('  📡 Social Sentiment - Analyse réseaux sociaux');
    console.log('  🔄 Patterns - Reconnaissance motifs');
    
    console.log('\n⏱️ TIMING AMÉLIORÉ:');
    console.log('  🚀 Scan 1 minute au lieu de 5 minutes');
    console.log('  📡 WebSocket temps réel sur majors');
    console.log('  ⚡ Alertes push sur seuils précoces');
    console.log('  🎯 Pre-positioning sur signaux faibles');
    
    console.log('\n🧠 IA PRÉDICTIVE:');
    console.log('  📈 Machine Learning sur historiques');
    console.log('  🔮 Prédiction mouvement 15-30min');
    console.log('  📊 Scoring probabiliste');
    console.log('  ⚡ Action préventive sur >80% confidence');
    
  } catch (error) {
    console.error('❌ Erreur analyse:', error);
  }
}

analyzeEarlyDetection();
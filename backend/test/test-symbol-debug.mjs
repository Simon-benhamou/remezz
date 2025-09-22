// Test rapide pour débugger la confusion de symboles
import { buildTechSnapshot } from '../dist/ai/tech.js';

console.log('🧪 Test AVNT/USDT symbol resolution...');

try {
  const result = await buildTechSnapshot('AVNT/USDT');
  console.log('✅ Résultat buildTechSnapshot pour AVNT/USDT:');
  console.log(`- Symbol: ${result.symbol}`);
  console.log(`- Last price: ${result.last}`);
  console.log(`- ATR%: ${result.atrPct.toFixed(4)}%`);
  console.log(`- Support: ${result.support}`);
  console.log(`- Resistance: ${result.resistance}`);
} catch (error) {
  console.error('❌ Erreur:', error.message);
}

console.log('\n🧪 Test ETH/USDT pour comparaison...');

try {
  const result = await buildTechSnapshot('ETH/USDT');
  console.log('✅ Résultat buildTechSnapshot pour ETH/USDT:');
  console.log(`- Symbol: ${result.symbol}`);
  console.log(`- Last price: ${result.last}`);
  console.log(`- ATR%: ${result.atrPct.toFixed(4)}%`);
  console.log(`- Support: ${result.support}`);
  console.log(`- Resistance: ${result.resistance}`);
} catch (error) {
  console.error('❌ Erreur:', error.message);
}
#!/usr/bin/env node
/**
 * Analyse des trades du weekend 28-29 Nov 2025
 */

console.log('═══════════════════════════════════════════════════════════════════');
console.log('📊 ANALYSE DES 3 TRADES DU WEEKEND');
console.log('═══════════════════════════════════════════════════════════════════\n');

// Trade 1: IMX LONG
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🟢 TRADE 1: IMX LONG');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
const t1Entry = 0.3199, t1Exit = 0.3231;
const t1Pnl = ((t1Exit - t1Entry) / t1Entry * 100).toFixed(2);
console.log('Entry: 28/11 09:30 @ $' + t1Entry);
console.log('Exit:  28/11 15:30 @ $' + t1Exit);
console.log('Duration: 6h00');
console.log('PnL: +' + t1Pnl + '% → +$8.00');
console.log('📝 Résultat: ✅ WIN - Trailing stop a protégé un petit gain');

// Trade 2: XRP LONG (celui visible sur le chart)
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🔴 TRADE 2: XRP LONG (visible sur le chart!)');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
const t2Entry = 2.2614, t2Exit = 2.2103;
const t2Pnl = ((t2Exit - t2Entry) / t2Entry * 100).toFixed(2);
const t2Notional = 1598.30 * t2Entry;
console.log('Entry: 28/11 16:26 @ $' + t2Entry);
console.log('Exit:  28/11 17:26 @ $' + t2Exit);
console.log('Duration: 1h00');
console.log('PnL: ' + t2Pnl + '% → -$81.67');
console.log('Notional: ~$' + t2Notional.toFixed(0));
console.log('\n⚠️  PROBLÈME POTENTIEL:');
console.log('   - Entry à $2.2614 = APRÈS le pic (chart montre pic à ~$2.29)');
console.log('   - Le prix a immédiatement chuté après l\'entrée');
console.log('   - Signal peut-être arrivé en retard? (lag de 1-2 bougies 15m?)');

// Trade 3: XRP LONG (deuxième entry visible sur le chart)
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🟡 TRADE 3: XRP LONG (2ème entry visible sur le chart)');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
const t3Entry = 2.2103; // Entry visible sur le chart
console.log('Entry: selon chart @ $' + t3Entry);
console.log('📝 Note: Ceci est probablement un trade encore OPEN ou');
console.log('   c\'est l\'exit du trade précédent interprété comme entry?');

// Trade 4: IMX SHORT  
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🔴 TRADE 4: IMX SHORT');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
const t4Entry = 0.3140, t4Exit = 0.3190;
const t4Pnl = ((t4Entry - t4Exit) / t4Entry * 100).toFixed(2);
const t4Notional = 11042.65 * t4Entry;
console.log('Entry: 28/11 18:27 @ $' + t4Entry);
console.log('Exit:  29/11 02:18 @ $' + t4Exit);
console.log('Duration: ~8h');
console.log('PnL: ' + t4Pnl + '% → -$55.21');
console.log('Notional: ~$' + t4Notional.toFixed(0));
console.log('📝 Résultat: ❌ STOP LOSS');

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('📈 RÉSUMÉ WEEKEND:');
console.log('═══════════════════════════════════════════════════════════════════');
console.log('   - Trades: 3 (1 WIN, 2 LOSSES)');
console.log('   - Win Rate: 33%');
console.log('   - Total PnL: $8 - $81.67 - $55.21 = -$128.88');
console.log('');
console.log('🔍 DIAGNOSTIC:');
console.log('   1. Le chart montre 2 "Entry" pour XRP mais pas les exits');
console.log('      → BUG FRONTEND: Les exits ne sont pas affichés!');
console.log('');
console.log('   2. XRP LONG entry à $2.2614 semble être APRÈS le pic');
console.log('      → Le momentum était déjà en train de se retourner');
console.log('      → Possible: signal en retard de 1-2 bougies (15-30 min)');
console.log('');
console.log('   3. 33% Win Rate ce weekend vs 66% attendu');
console.log('      → Échantillon trop petit (3 trades) pour être significatif');
console.log('      → Sur 1711 trades backtestés, 66% WR est stable');
console.log('═══════════════════════════════════════════════════════════════════');

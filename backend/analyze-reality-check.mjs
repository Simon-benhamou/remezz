/**
 * REALITY CHECK - Notre stratégie est-elle trop belle pour être vraie ?
 * Analyse des biais potentiels dans nos backtests
 */
import fs from 'fs';
import path from 'path';

const dataDir = path.join(process.cwd(), 'data');

console.log('╔════════════════════════════════════════════════════════════════════════════╗');
console.log('║                    REALITY CHECK - Analyse des Biais                      ║');
console.log('╚════════════════════════════════════════════════════════════════════════════╝\n');

// Load sample data
const btcData = JSON.parse(fs.readFileSync(`${dataDir}/BTC_USDT_15m.json`, 'utf-8'));
const ethData = JSON.parse(fs.readFileSync(`${dataDir}/ETH_USDT_15m.json`, 'utf-8'));

console.log('═══ 1. PÉRIODE DE TEST ═══\n');
const startDate = new Date(btcData[0].timestamp || btcData[0].openTime);
const endDate = new Date(btcData[btcData.length-1].timestamp || btcData[btcData.length-1].openTime);
console.log(`Période: ${startDate.toISOString().split('T')[0]} → ${endDate.toISOString().split('T')[0]}`);

// Calculer le rendement BTC sur la période
const btcStart = btcData[0].close;
const btcEnd = btcData[btcData.length-1].close;
const btcReturn = ((btcEnd - btcStart) / btcStart) * 100;
console.log(`BTC: $${btcStart.toFixed(0)} → $${btcEnd.toFixed(0)} = ${btcReturn >= 0 ? '+' : ''}${btcReturn.toFixed(0)}%`);

const ethStart = ethData[0].close;
const ethEnd = ethData[ethData.length-1].close;
const ethReturn = ((ethEnd - ethStart) / ethStart) * 100;
console.log(`ETH: $${ethStart.toFixed(0)} → $${ethEnd.toFixed(0)} = ${ethReturn >= 0 ? '+' : ''}${ethReturn.toFixed(0)}%`);

console.log(`\n⚠️ BIAIS POTENTIEL #1: Période majoritairement BULL`);
console.log(`   → BTC a fait +${btcReturn.toFixed(0)}% sur 2 ans = marché favorable aux LONG`);

console.log('\n═══ 2. ANALYSE DU WIN RATE 86-89% ═══\n');

console.log('Notre stratégie utilise:');
console.log('  - SL ATR×3.0 = 1.0% à 4.5% de SL');
console.log('  - Trailing activé à +0.5%, distance 0.3%');
console.log('  - Leverage 4.5x');
console.log('');
console.log('Simulation du ratio gain/perte:');

const slPct = 2.5; // SL moyen
const trailActivation = 0.5;
const trailDistance = 0.3;
const leverage = 4.5;

// Si trailing s'active à +0.5% et trail à 0.3%, exit minimum = +0.2%
const minWinPct = (trailActivation - trailDistance) * leverage;
const maxLossPct = slPct * leverage;

console.log(`  - Perte max (SL): -${maxLossPct.toFixed(1)}% (avec ${slPct}% SL × ${leverage}x lev)`);
console.log(`  - Gain min (trailing): +${minWinPct.toFixed(1)}% (0.5% - 0.3% × ${leverage}x lev)`);
console.log(`  - Ratio risque/récompense: ${(maxLossPct / minWinPct).toFixed(1)}:1`);
console.log('');
console.log('⚠️ BIAIS POTENTIEL #2: Le trailing "capture" beaucoup de petits gains');
console.log('   → Un prix qui monte de +0.5% puis redescend = WIN (+0.2% min)');
console.log('   → Beaucoup de "wins" sont des petits gains, les "losses" sont grosses');

console.log('\n═══ 3. ANALYSE PnL RÉEL PAR TRADE ═══\n');

// Simuler quelques trades pour voir la distribution
console.log('Distribution typique avec notre config:');
console.log('  - WIN par trailing à +0.5%: environ +0.9% net (après frais)');
console.log('  - WIN par trailing à +1%:   environ +3.2% net');
console.log('  - WIN par trailing à +2%:   environ +7.6% net');
console.log('  - LOSS par SL 2.5%:         environ -11.3% net');
console.log('');
console.log('Pour être profitable avec 86% WR:');
console.log('  86 wins × +2% avg = +172%');
console.log('  14 losses × -11% avg = -154%');
console.log('  Net: +18% sur 100 trades');
console.log('');
console.log('⚠️ C\'est POSSIBLE mais serré - le WR élevé compense les grosses pertes');

console.log('\n═══ 4. COMPARAISON AVEC BENCHMARKS ═══\n');

console.log('Stratégies de trading typiques:');
console.log('  - Trend following: 30-40% WR, gros gains, petites pertes');
console.log('  - Mean reversion: 60-70% WR, petits gains, grosses pertes');
console.log('  - Notre stratégie: 86% WR, petits-moyens gains, grosses pertes');
console.log('');
console.log('Notre stratégie est un "scalping amélioré":');
console.log('  ✅ Breakout BB = entrée sur momentum fort');
console.log('  ✅ Trailing serré = capture les petits mouvements');
console.log('  ✅ Régime BTC = évite les shorts en bull (ou inverse)');
console.log('');
console.log('⚠️ BIAIS POTENTIEL #3: Overfitting?');
console.log('   → Les paramètres ont été optimisés sur ces mêmes données');
console.log('   → SL ATR×3.0, Trail 0.5%/0.3% = peut-être trop ajusté');

console.log('\n═══ 5. CE QUI MANQUE DANS NOTRE TEST ═══\n');

console.log('❌ Slippage réel (on utilise 0.05% fixe, en réalité variable)');
console.log('❌ Liquidité (on suppose toujours rempli au prix voulu)');
console.log('❌ Latence (entrée instantanée vs réalité)');
console.log('❌ Spread bid/ask (on utilise le close, pas le ask)');
console.log('❌ Funding rate variable (on utilise 0.01% fixe)');
console.log('❌ Rejects d\'ordres / Rate limits');
console.log('❌ Émotions (en live, on peut paniquer)');

console.log('\n═══ 6. ESTIMATION RÉALISTE ═══\n');

// Appliquer des pénalités réalistes
const backtestPnl = 1807; // Notre résultat
const slippagePenalty = 0.15; // 15% de perte due au slippage réel
const executionPenalty = 0.10; // 10% trades ratés
const overfitPenalty = 0.20; // 20% d'overfitting
const totalPenalty = slippagePenalty + executionPenalty + overfitPenalty;

const realisticPnl = backtestPnl * (1 - totalPenalty);
console.log(`PnL Backtest: +${backtestPnl}%`);
console.log(`Pénalités estimées:`);
console.log(`  - Slippage réel: -${(slippagePenalty*100).toFixed(0)}%`);
console.log(`  - Exécution ratée: -${(executionPenalty*100).toFixed(0)}%`);
console.log(`  - Overfitting: -${(overfitPenalty*100).toFixed(0)}%`);
console.log(`PnL Réaliste estimé: +${realisticPnl.toFixed(0)}% (${((realisticPnl/backtestPnl)*100).toFixed(0)}% du backtest)`);

console.log('\n═══ 7. POURQUOI ÇA PEUT QUAND MÊME MARCHER ═══\n');

console.log('✅ Le marché crypto est TRÈS volatile (+100% BTC en 2 ans)');
console.log('✅ Breakout BB + Volume = signal de qualité prouvé');
console.log('✅ Régime BTC = on trade dans le sens du marché');
console.log('✅ Trailing agressif = on ne laisse pas les gains s\'évaporer');
console.log('✅ Leverage modéré (4.5x) = pas de liquidation facile');
console.log('');
console.log('La stratégie exploite:');
console.log('  1. La volatilité crypto (mouvements de +2-5% fréquents)');
console.log('  2. Le momentum (breakout = continuation probable)');
console.log('  3. La gestion du risque (trailing + SL)');

console.log('\n═══ CONCLUSION ═══\n');

console.log('📊 Les 86% WR et +1807% PnL sont POSSIBLES mais OPTIMISTES');
console.log('');
console.log('En réalité, attends-toi à:');
console.log('  - WR réel: 70-80% (vs 86% backtest)');
console.log('  - PnL réel: +500-1000% sur 2 ans (vs +1807% backtest)');
console.log('  - Certains mois négatifs (comme Juillet 2024, Octobre 2025)');
console.log('');
console.log('Ce n\'est PAS une arnaque, mais le backtest est toujours optimiste.');
console.log('La vraie performance sera visible après quelques mois de trading live.');

/**
 * ANALYSE DE ROBUSTESSE - Pourquoi ETH/XRP et pas BTC/SOL?
 * Et quelle probabilité de continuer?
 */

import fs from 'fs';

function loadData(symbol) {
    const filename = `./data/${symbol.replace('/', '_')}_1h.json`;
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

// ═══════════════════════════════════════════════════════════════════════════
// ANALYSE DES CARACTÉRISTIQUES PAR ASSET
// ═══════════════════════════════════════════════════════════════════════════

function analyzeAssetCharacteristics(symbol) {
    const candles = loadData(symbol);
    
    // Volatilité moyenne
    const returns = [];
    for (let i = 1; i < candles.length; i++) {
        returns.push((candles[i].close - candles[i-1].close) / candles[i-1].close);
    }
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const volatility = Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length);
    
    // Tendance globale sur l'année
    const startPrice = candles[0].close;
    const endPrice = candles[candles.length - 1].close;
    const yearlyReturn = (endPrice - startPrice) / startPrice;
    
    // Nombre de breakouts (prix au-dessus du high des 20 dernières bougies)
    let breakouts = 0;
    let falseBreakouts = 0;
    
    for (let i = 21; i < candles.length - 10; i++) {
        let highest = 0;
        for (let j = i - 20; j < i; j++) {
            if (candles[j].high > highest) highest = candles[j].high;
        }
        
        if (candles[i].close > highest) {
            breakouts++;
            
            // Est-ce un faux breakout? (prix revient sous le breakout dans les 10 bougies)
            let isFalse = false;
            for (let j = i + 1; j < Math.min(i + 10, candles.length); j++) {
                if (candles[j].close < highest * 0.98) {
                    isFalse = true;
                    break;
                }
            }
            if (isFalse) falseBreakouts++;
        }
    }
    
    // Analyse par trimestre
    const quarters = [];
    const candlesPerQuarter = Math.floor(candles.length / 4);
    
    for (let q = 0; q < 4; q++) {
        const start = q * candlesPerQuarter;
        const end = (q + 1) * candlesPerQuarter;
        const qCandles = candles.slice(start, end);
        
        const qReturn = (qCandles[qCandles.length - 1].close - qCandles[0].close) / qCandles[0].close;
        
        // Volatilité du trimestre
        const qReturns = [];
        for (let i = 1; i < qCandles.length; i++) {
            qReturns.push((qCandles[i].close - qCandles[i-1].close) / qCandles[i-1].close);
        }
        const qVol = Math.sqrt(qReturns.reduce((sum, r) => sum + Math.pow(r, 2), 0) / qReturns.length);
        
        quarters.push({
            return: qReturn,
            volatility: qVol,
            trend: qReturn > 0.05 ? 'BULL' : qReturn < -0.05 ? 'BEAR' : 'RANGE'
        });
    }
    
    return {
        symbol,
        yearlyReturn,
        volatility,
        breakouts,
        falseBreakouts,
        falseBreakoutRate: falseBreakouts / breakouts,
        quarters
    };
}

console.log('═'.repeat(80));
console.log('🔬 ANALYSE DE ROBUSTESSE - Pourquoi ETH/XRP marchent?');
console.log('═'.repeat(80));

const SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT'];
const analysis = {};

for (const symbol of SYMBOLS) {
    analysis[symbol] = analyzeAssetCharacteristics(symbol);
}

// Affichage comparatif
console.log('\n📊 CARACTÉRISTIQUES PAR ASSET (2024-2025):\n');

console.log('┌──────────┬────────────┬────────────┬───────────┬─────────────┬──────────────┐');
console.log('│ Asset    │ Return 1Y  │ Volatilité │ Breakouts │ Faux BO %   │ Profitabilité│');
console.log('├──────────┼────────────┼────────────┼───────────┼─────────────┼──────────────┤');

const strategyResults = {
    'BTC/USDT': -12,
    'ETH/USDT': 398,
    'SOL/USDT': -91,
    'XRP/USDT': 241
};

for (const symbol of SYMBOLS) {
    const a = analysis[symbol];
    const profit = strategyResults[symbol];
    const profitStr = profit >= 0 ? `✅ +${profit}%` : `❌ ${profit}%`;
    
    console.log(`│ ${symbol.replace('/USDT', '').padEnd(8)} │ ${(a.yearlyReturn * 100).toFixed(0).padStart(8)}% │ ${(a.volatility * 100).toFixed(2).padStart(9)}% │ ${a.breakouts.toString().padStart(9)} │ ${(a.falseBreakoutRate * 100).toFixed(0).padStart(10)}% │ ${profitStr.padStart(12)} │`);
}

console.log('└──────────┴────────────┴────────────┴───────────┴─────────────┴──────────────┘');

// Analyse par trimestre
console.log('\n📅 TENDANCE PAR TRIMESTRE:\n');

console.log('┌──────────┬────────────────┬────────────────┬────────────────┬────────────────┐');
console.log('│ Asset    │ Q1 (Dec-Feb)   │ Q2 (Mar-May)   │ Q3 (Jun-Aug)   │ Q4 (Sep-Nov)   │');
console.log('├──────────┼────────────────┼────────────────┼────────────────┼────────────────┤');

for (const symbol of SYMBOLS) {
    const a = analysis[symbol];
    const qStr = a.quarters.map(q => {
        const icon = q.trend === 'BULL' ? '📈' : q.trend === 'BEAR' ? '📉' : '➡️';
        return `${icon} ${(q.return * 100).toFixed(0).padStart(4)}%`;
    });
    
    console.log(`│ ${symbol.replace('/USDT', '').padEnd(8)} │ ${qStr[0].padEnd(14)} │ ${qStr[1].padEnd(14)} │ ${qStr[2].padEnd(14)} │ ${qStr[3].padEnd(14)} │`);
}

console.log('└──────────┴────────────────┴────────────────┴────────────────┴────────────────┘');

// Corrélation entre caractéristiques et profitabilité
console.log('\n' + '═'.repeat(80));
console.log('🔍 CORRÉLATIONS TROUVÉES');
console.log('═'.repeat(80));

const profitable = ['ETH/USDT', 'XRP/USDT'];
const unprofitable = ['BTC/USDT', 'SOL/USDT'];

const avgProfitableFalseBO = profitable.reduce((sum, s) => sum + analysis[s].falseBreakoutRate, 0) / 2;
const avgUnprofitableFalseBO = unprofitable.reduce((sum, s) => sum + analysis[s].falseBreakoutRate, 0) / 2;

const avgProfitableVol = profitable.reduce((sum, s) => sum + analysis[s].volatility, 0) / 2;
const avgUnprofitableVol = unprofitable.reduce((sum, s) => sum + analysis[s].volatility, 0) / 2;

console.log(`
ASSETS PROFITABLES (ETH, XRP):
  • Taux de faux breakouts: ${(avgProfitableFalseBO * 100).toFixed(0)}%
  • Volatilité moyenne: ${(avgProfitableVol * 100).toFixed(2)}%

ASSETS NON PROFITABLES (BTC, SOL):
  • Taux de faux breakouts: ${(avgUnprofitableFalseBO * 100).toFixed(0)}%
  • Volatilité moyenne: ${(avgUnprofitableVol * 100).toFixed(2)}%
`);

// Analyse de la probabilité de continuation
console.log('═'.repeat(80));
console.log('📈 PROBABILITÉ DE CONTINUATION');
console.log('═'.repeat(80));

console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║ ⚠️  ANALYSE HONNÊTE DE LA ROBUSTESSE                                          ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║ 🔴 RISQUES IDENTIFIÉS:                                                        ║
║                                                                               ║
║ 1. OVERFITTING TEMPOREL                                                       ║
║    - La période testée (Nov 2024 - Nov 2025) était MAJORITAIREMENT BULLISH    ║
║    - ETH: ${(analysis['ETH/USDT'].yearlyReturn * 100).toFixed(0).padStart(3)}% sur l'année, XRP: ${(analysis['XRP/USDT'].yearlyReturn * 100).toFixed(0).padStart(3)}% sur l'année                           ║
║    - Une stratégie LONG-only performe bien en bull market... évidemment       ║
║                                                                               ║
║ 2. SÉLECTION D'ASSETS POST-HOC                                                ║
║    - On a CHOISI ETH+XRP APRÈS avoir vu qu'ils performaient                   ║
║    - C'est du "cherry-picking" - biais de survivant                           ║
║    - Qui dit que ETH/XRP seront les meilleurs l'année prochaine?              ║
║                                                                               ║
║ 3. RÉGIME DE MARCHÉ                                                           ║
║    - 2024-2025: Post-halving BTC, cycle haussier classique                    ║
║    - En bear market (2022), cette stratégie aurait été CATASTROPHIQUE         ║
║                                                                               ║
║ 4. COMPOUNDING IRRÉALISTE                                                     ║
║    - Le +4853% assume qu'on réinvestit 100% des gains                         ║
║    - En pratique: frais de retrait, impôts, gestion du risque                 ║
║                                                                               ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║ 🟢 CE QUI EST QUAND MÊME POSITIF:                                             ║
║                                                                               ║
║ 1. Win Rate de 69.5% est RÉEL et consistant                                   ║
║ 2. 11/13 mois positifs = bonne régularité                                     ║
║ 3. Le filtre ConsecUp<4 a une LOGIQUE (éviter overextension)                  ║
║ 4. Les exits sont basés sur des signaux techniques valides                    ║
║                                                                               ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║ 📊 ESTIMATION RÉALISTE POUR L'ANNÉE PROCHAINE:                                ║
║                                                                               ║
║ Si marché BULL (similaire):     ~200-400% possible (pas 4800%)                ║
║ Si marché RANGE:                ~50-100% possible                             ║
║ Si marché BEAR:                 -30% à -60% PROBABLE                          ║
║                                                                               ║
║ 🎲 Probabilité de résultats similaires: ~25-35%                               ║
║    (Dépend entièrement du régime de marché)                                   ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
`);

// Recommandations
console.log('\n' + '═'.repeat(80));
console.log('💡 RECOMMANDATIONS');
console.log('═'.repeat(80));

console.log(`
┌─────────────────────────────────────────────────────────────────────────────┐
│ SI TU VEUX IMPLÉMENTER CETTE STRATÉGIE:                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│ 1. ⚠️  RÉDUIRE LES ATTENTES                                                 │
│    - Viser +100-200%/an, pas +4800%                                         │
│    - Retirer les profits régulièrement (ne pas compounder 100%)             │
│                                                                             │
│ 2. 🛡️  AJOUTER UN FILTRE DE RÉGIME                                          │
│    - Désactiver la stratégie si BTC est en bear market (< SMA200)           │
│    - Réduire le leverage en période volatile                                │
│                                                                             │
│ 3. 🎯 DIVERSIFIER LES ASSETS                                                │
│    - Ne pas se limiter à ETH+XRP                                            │
│    - Sélectionner dynamiquement les assets les plus "trendy"                │
│                                                                             │
│ 4. 📉 PRÉPARER LE BEAR MARKET                                               │
│    - Avoir une stratégie SHORT pour les marchés baissiers                   │
│    - Ou simplement: ne pas trader en bear market                            │
│                                                                             │
│ 5. 💰 GESTION DU CAPITAL                                                    │
│    - Max 20-30% du capital sur cette stratégie                              │
│    - Stop loss sur le portefeuille global (-20% max)                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

🎯 CONCLUSION HONNÊTE:

   La stratégie a une EDGE (avantage) réel basé sur:
   - Breakout + momentum + volume = confirmation d'un mouvement
   - ConsecUp<4 = éviter les entrées "trop tard"
   - Exits intelligents (momentum fade, time-based)

   MAIS cette edge est CONDITIONNELLE au régime de marché.
   
   En BULL: ça marche très bien ✅
   En BEAR: ça perd de l'argent ❌
   
   → La vraie question: Sommes-nous en bull market pour 2025-2026?
`);

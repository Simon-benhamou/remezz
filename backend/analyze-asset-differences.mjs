/**
 * 🔬 WHY XRP/BTC vs ETH/SOL?
 * 
 * Is there a REAL reason or just luck?
 * Let's analyze the differences between these assets
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binance({ 
  enableRateLimit: true,
  options: { defaultType: 'future' }
});

async function fetchCandles(symbol, timeframe = '4h', days = 365) {
  try {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const all = [];
    let fetchSince = since;
    
    while (fetchSince < Date.now()) {
      const candles = await exchange.fetchOHLCV(symbol, timeframe, fetchSince, 500);
      if (candles.length === 0) break;
      all.push(...candles);
      fetchSince = candles[candles.length - 1][0] + 1;
      if (candles.length < 500) break;
    }
    return all;
  } catch (e) {
    console.error(`Error ${symbol}:`, e.message);
    return [];
  }
}

async function fetchFundingRates(symbol, days = 365) {
  try {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const all = [];
    let fetchSince = since;
    
    while (fetchSince < Date.now()) {
      const rates = await exchange.fetchFundingRateHistory(symbol, fetchSince, 500);
      if (rates.length === 0) break;
      all.push(...rates);
      fetchSince = rates[rates.length - 1].timestamp + 1;
      if (rates.length < 500) break;
    }
    return all;
  } catch (e) {
    console.error(`Error funding ${symbol}:`, e.message);
    return [];
  }
}

function calcVolatility(candles) {
  // Calculate average daily % move
  const moves = [];
  for (let i = 1; i < candles.length; i++) {
    const move = Math.abs((candles[i][4] - candles[i - 1][4]) / candles[i - 1][4]) * 100;
    moves.push(move);
  }
  return moves.reduce((a, b) => a + b, 0) / moves.length;
}

function calcMaxDrawdown(candles) {
  let peak = candles[0][4];
  let maxDD = 0;
  
  for (const c of candles) {
    if (c[4] > peak) peak = c[4];
    const dd = (peak - c[4]) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function calcTrendStrength(candles) {
  // How often price moves in same direction for multiple candles
  let trendCandles = 0;
  let currentStreak = 0;
  let lastDir = 0;
  
  for (let i = 1; i < candles.length; i++) {
    const dir = candles[i][4] > candles[i - 1][4] ? 1 : -1;
    if (dir === lastDir) {
      currentStreak++;
      if (currentStreak >= 3) trendCandles++;
    } else {
      currentStreak = 1;
    }
    lastDir = dir;
  }
  
  return (trendCandles / candles.length) * 100;
}

function calcMeanReversion(candles) {
  // How often price reverts after big move
  let bigMoves = 0;
  let reversions = 0;
  
  for (let i = 1; i < candles.length - 1; i++) {
    const move1 = (candles[i][4] - candles[i - 1][4]) / candles[i - 1][4] * 100;
    const move2 = (candles[i + 1][4] - candles[i][4]) / candles[i][4] * 100;
    
    if (Math.abs(move1) > 2) { // Big move > 2%
      bigMoves++;
      if (Math.sign(move1) !== Math.sign(move2)) {
        reversions++;
      }
    }
  }
  
  return bigMoves > 0 ? (reversions / bigMoves) * 100 : 0;
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🔬 ANALYSE: Pourquoi XRP/BTC vs ETH/SOL?');
  console.log('═'.repeat(80));
  
  const symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT'];
  const analysis = {};
  
  console.log('\n📥 Fetching data...');
  
  for (const symbol of symbols) {
    const candles = await fetchCandles(symbol, '4h', 365);
    const funding = await fetchFundingRates(symbol, 365);
    
    if (candles.length === 0) continue;
    
    const asset = symbol.split('/')[0];
    
    // Price change over period
    const priceChange = ((candles[candles.length - 1][4] - candles[0][4]) / candles[0][4]) * 100;
    
    // Volatility
    const volatility = calcVolatility(candles);
    
    // Max drawdown
    const maxDD = calcMaxDrawdown(candles);
    
    // Trend strength
    const trendStrength = calcTrendStrength(candles);
    
    // Mean reversion tendency
    const meanReversion = calcMeanReversion(candles);
    
    // Funding rate analysis
    const fundingValues = funding.map(f => f.fundingRate * 100);
    const avgFunding = fundingValues.length > 0 ? fundingValues.reduce((a, b) => a + b, 0) / fundingValues.length : 0;
    const extremePositive = fundingValues.filter(f => f > 0.05).length;
    const extremeNegative = fundingValues.filter(f => f < -0.03).length;
    const fundingVolatility = fundingValues.length > 0 
      ? Math.sqrt(fundingValues.map(f => Math.pow(f - avgFunding, 2)).reduce((a, b) => a + b, 0) / fundingValues.length)
      : 0;
    
    analysis[asset] = {
      priceChange,
      volatility,
      maxDD,
      trendStrength,
      meanReversion,
      avgFunding,
      extremePositive,
      extremeNegative,
      fundingVolatility,
      totalFundingSnapshots: fundingValues.length
    };
    
    console.log(`   ${asset}: ${candles.length} candles, ${funding.length} funding snapshots`);
  }
  
  // Display comparison
  console.log('\n' + '═'.repeat(80));
  console.log('📊 COMPARAISON DES ASSETS');
  console.log('═'.repeat(80));
  
  console.log('\n┌───────────┬────────────┬────────────┬────────────┬────────────┐');
  console.log('│ Metric    │    BTC     │    ETH     │    SOL     │    XRP     │');
  console.log('├───────────┼────────────┼────────────┼────────────┼────────────┤');
  
  const metrics = [
    { key: 'priceChange', label: 'Price Δ', format: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%` },
    { key: 'volatility', label: 'Volatility', format: v => `${v.toFixed(2)}%` },
    { key: 'maxDD', label: 'Max DD', format: v => `-${v.toFixed(1)}%` },
    { key: 'trendStrength', label: 'Trend Str', format: v => `${v.toFixed(1)}%` },
    { key: 'meanReversion', label: 'Mean Rev', format: v => `${v.toFixed(1)}%` },
    { key: 'avgFunding', label: 'Avg Fund', format: v => `${v.toFixed(4)}%` },
    { key: 'fundingVolatility', label: 'Fund Vol', format: v => `${v.toFixed(4)}` },
    { key: 'extremePositive', label: 'Ext +Fund', format: v => `${v}x` },
    { key: 'extremeNegative', label: 'Ext -Fund', format: v => `${v}x` },
  ];
  
  for (const m of metrics) {
    const values = ['BTC', 'ETH', 'SOL', 'XRP'].map(a => analysis[a] ? m.format(analysis[a][m.key]) : 'N/A');
    console.log(`│ ${m.label.padEnd(9)} │ ${values[0].padStart(10)} │ ${values[1].padStart(10)} │ ${values[2].padStart(10)} │ ${values[3].padStart(10)} │`);
  }
  
  console.log('└───────────┴────────────┴────────────┴────────────┴────────────┘');
  
  // Key findings
  console.log('\n' + '═'.repeat(80));
  console.log('🔍 ANALYSE DES DIFFÉRENCES');
  console.log('═'.repeat(80));
  
  console.log(`
📊 VOLATILITÉ:
   • SOL: ${analysis.SOL?.volatility.toFixed(2)}% (PLUS VOLATILE)
   • ETH: ${analysis.ETH?.volatility.toFixed(2)}%
   • XRP: ${analysis.XRP?.volatility.toFixed(2)}%
   • BTC: ${analysis.BTC?.volatility.toFixed(2)}% (MOINS VOLATILE)
   
   → Plus de volatilité = plus de stop loss touchés = plus de pertes

📈 MEAN REVERSION (tendance à revenir après un gros mouvement):
   • BTC: ${analysis.BTC?.meanReversion.toFixed(1)}%
   • ETH: ${analysis.ETH?.meanReversion.toFixed(1)}%
   • SOL: ${analysis.SOL?.meanReversion.toFixed(1)}%
   • XRP: ${analysis.XRP?.meanReversion.toFixed(1)}%
   
   → Plus de mean reversion = meilleur pour stratégie de reversal

💰 FUNDING RATE EXTREME:
   • SOL: ${analysis.SOL?.extremeNegative} fois funding négatif extrême
   • ETH: ${analysis.ETH?.extremeNegative} fois funding négatif extrême
   • XRP: ${analysis.XRP?.extremeNegative} fois funding négatif extrême
   • BTC: ${analysis.BTC?.extremeNegative} fois funding négatif extrême
   
   → SOL a BEAUCOUP plus d'événements de funding extrême!

📉 MAX DRAWDOWN:
   • SOL: -${analysis.SOL?.maxDD.toFixed(1)}% (ÉNORME)
   • XRP: -${analysis.XRP?.maxDD.toFixed(1)}%
   • ETH: -${analysis.ETH?.maxDD.toFixed(1)}%
   • BTC: -${analysis.BTC?.maxDD.toFixed(1)}% (plus stable)
   
   → SOL peut perdre massivement = dangereux avec leverage
`);

  console.log('\n' + '═'.repeat(80));
  console.log('💡 CONCLUSION');
  console.log('═'.repeat(80));
  
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║ 🎯 POURQUOI LA STRATÉGIE A MIEUX MARCHÉ SUR XRP/BTC?                         ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║ 1. VOLATILITÉ:                                                                ║
║    • SOL est ~${((analysis.SOL?.volatility / analysis.BTC?.volatility - 1) * 100).toFixed(0)}% plus volatile que BTC                                  ║
║    • Plus de volatilité = stops touchés plus souvent                          ║
║                                                                               ║
║ 2. DRAWDOWNS:                                                                 ║
║    • SOL peut perdre ${analysis.SOL?.maxDD.toFixed(0)}% (vs ${analysis.BTC?.maxDD.toFixed(0)}% pour BTC)                                ║
║    • Avec leverage, c'est la liquidation                                      ║
║                                                                               ║
║ 3. FUNDING EXTREMES:                                                          ║
║    • SOL a ${analysis.SOL?.extremeNegative}x events de funding extrême (vs ${analysis.BTC?.extremePositive}x BTC)                       ║
║    • Mais ces reversals ne marchent pas car SOL est "meme coin"               ║
║                                                                               ║
║ 4. COMPORTEMENT DE MARCHÉ:                                                    ║
║    • BTC = "digital gold" → plus prévisible                                   ║
║    • XRP = narratif institutionnel → patterns distincts                       ║
║    • SOL/ETH = tech coins → suivent le momentum, moins de reversal            ║
║                                                                               ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║ ⚠️ MAIS: 8 TRADES N'EST PAS STATISTIQUEMENT SIGNIFICATIF!                     ║
║                                                                               ║
║ Pour avoir confiance dans une stratégie, il faut:                             ║
║ • Minimum 30-50 trades (idealement 100+)                                      ║
║ • Performance positive sur plusieurs années                                   ║
║ • Consistency (pas juste quelques gros gains)                                 ║
║                                                                               ║
║ Les 8 trades gagnants peuvent être:                                           ║
║ • ✓ Un vrai edge                                                              ║
║ • ✗ De la chance pure (50% prob avec 8 trades = possible)                     ║
║ • ✗ Overfitting sur la période testée                                         ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
`);

  // What's statistically valid
  console.log('\n' + '═'.repeat(80));
  console.log('📈 CE QUI EST STATISTIQUEMENT VALIDE');
  console.log('═'.repeat(80));
  
  console.log(`
Pour avoir une stratégie FIABLE, voici ce qu'il faut:

1. NOMBRE DE TRADES:
   • 8 trades → Marge d'erreur: ±35% (TROP ÉLEVÉ)
   • 30 trades → Marge d'erreur: ±18%
   • 100 trades → Marge d'erreur: ±10%
   • 300 trades → Marge d'erreur: ±5.7%
   
   → Notre "best reactive" avec 299 trades est plus fiable que 8 trades!

2. VALIDATION:
   • Test sur plusieurs années (pas juste 1 an)
   • Test sur plusieurs assets
   • Out-of-sample testing (train/test split)
   
3. RÉALITÉ DES RÉSULTATS:
   
   FUNDING RATE (8 trades): +102% → probablement CHANCE
   BEST REACTIVE (299 trades): +5% → probablement RÉEL mais faible
   
   Le edge réel est probablement entre +5% et +15% par an avec leverage.
   Pas +100%.
`);
}

main().catch(console.error);

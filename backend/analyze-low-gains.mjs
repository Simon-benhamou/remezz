#!/usr/bin/env node
/**
 * Analyse pourquoi les gains sont si faibles (0.2% au lieu de 1-2%)
 * Malgré levier x5 et mouvements de prix suffisants
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function analyzeLowGains() {
  console.log('🔍 ANALYSE DES FAIBLES GAINS\n');
  console.log('=' .repeat(80));

  // Récupérer les dernières positions fermées
  const recentPositions = await prisma.position.findMany({
    where: {
      openedAt: { not: null }
    },
    orderBy: { openedAt: 'desc' },
    take: 30,
    include: {
      session: {
        select: {
          symbol: true,
          activationProfile: true
        }
      }
    }
  });

  console.log(`\n📊 Analyse de ${recentPositions.length} positions récentes\n`);

  const positionsWithExits = recentPositions.filter(p => p.entryPrice && p.markPrice);
  
  if (positionsWithExits.length === 0) {
    console.log('❌ Aucune position avec données de sortie trouvée');
    await prisma.$disconnect();
    return;
  }

  console.log('📈 DÉTAIL DES POSITIONS :\n');
  
  let totalWins = 0;
  let totalLosses = 0;
  let stopLossExits = 0;
  let profitTargetExits = 0;
  let avgGainPct = 0;
  let avgLossPct = 0;

  for (const pos of positionsWithExits) {
    const entry = pos.entryPrice;
    const exit = pos.markPrice;
    const side = pos.side;
    const leverage = pos.leverage || 1;
    
    // Calcul du mouvement de prix
    const priceMovePct = side === 'buy' 
      ? ((exit - entry) / entry) * 100 
      : ((entry - exit) / entry) * 100;
    
    // Gain réel avec levier
    const realizedGainPct = priceMovePct * leverage;
    
    // Distance du stop loss
    const stopDistance = pos.stopPrice 
      ? (side === 'buy' 
          ? ((entry - pos.stopPrice) / entry) * 100 
          : ((pos.stopPrice - entry) / entry) * 100)
      : 0;

    const isWin = priceMovePct > 0;
    const exitType = Math.abs(exit - (pos.stopPrice || 0)) < Math.abs(exit - entry) * 0.1
      ? '🛑 STOP LOSS'
      : '🎯 TARGET/TRAIL';

    if (isWin) {
      totalWins++;
      avgGainPct += realizedGainPct;
    } else {
      totalLosses++;
      avgLossPct += realizedGainPct;
      if (exitType === '🛑 STOP LOSS') stopLossExits++;
    }

    console.log(`${pos.symbol} ${side.toUpperCase()} - Levier x${leverage.toFixed(1)}`);
    console.log(`  Entry: ${entry?.toFixed(6)} → Exit: ${exit?.toFixed(6)}`);
    console.log(`  Mouvement prix: ${priceMovePct > 0 ? '+' : ''}${priceMovePct.toFixed(2)}%`);
    console.log(`  Gain réel (avec levier): ${realizedGainPct > 0 ? '+' : ''}${realizedGainPct.toFixed(2)}%`);
    console.log(`  Stop loss: -${stopDistance.toFixed(2)}% | Exit: ${exitType}`);
    console.log(`  ⏱️  Durée: ${pos.openedAt ? ((Date.now() - new Date(pos.openedAt).getTime()) / 60000).toFixed(0) : '?'} min`);
    console.log('');
  }

  console.log('\n' + '='.repeat(80));
  console.log('📊 STATISTIQUES GLOBALES\n');
  
  const winRate = (totalWins / positionsWithExits.length) * 100;
  avgGainPct = totalWins > 0 ? avgGainPct / totalWins : 0;
  avgLossPct = totalLosses > 0 ? avgLossPct / totalLosses : 0;

  console.log(`Win Rate: ${winRate.toFixed(1)}% (${totalWins} wins, ${totalLosses} losses)`);
  console.log(`Gain moyen: +${avgGainPct.toFixed(2)}%`);
  console.log(`Perte moyenne: ${avgLossPct.toFixed(2)}%`);
  console.log(`Sorties par stop loss: ${stopLossExits}/${totalLosses} pertes (${(stopLossExits/Math.max(totalLosses,1)*100).toFixed(0)}%)`);

  console.log('\n' + '='.repeat(80));
  console.log('🔍 DIAGNOSTIC : POURQUOI SI PEU DE GAINS ?\n');

  // Analyse du trailing stop
  console.log('1️⃣  TRAILING STOP TROP SERRÉ ?');
  console.log('   Le code montre plusieurs problèmes :');
  console.log('   ❌ multiplier *= 0.7 pour mouvements normaux (ligne 839)');
  console.log('   ❌ multiplier *= 0.85 si upR > 1.5 (ligne 836)');
  console.log('   ❌ multiplier *= 0.75 si upR > 2.5 (ligne 837)');
  console.log('   ➡️  Résultat : le stop se resserre TROP VITE, sortie prématurée\n');

  console.log('2️⃣  OBJECTIF : +50$ avec 1000$ et levier x5');
  console.log(`   Gain nécessaire : ${((50 / (1000 * 5)) * 100).toFixed(2)}% de mouvement de prix`);
  console.log(`   Avec levier x5 : ${((50 / 1000) * 100).toFixed(1)}% de gain sur capital\n`);

  console.log('3️⃣  GAINS ACTUELS :');
  if (avgGainPct < 5) {
    console.log(`   ⚠️  Gain moyen de ${avgGainPct.toFixed(2)}% << 5% attendu`);
    console.log('   🔴 PROBLÈME : Trailing stop sort trop vite, avant que le mouvement se développe\n');
  }

  console.log('4️⃣  SOLUTIONS PROPOSÉES :');
  console.log('   ✅ Augmenter multiplier base (0.85 → 1.2)');
  console.log('   ✅ Supprimer le resserrement pour mouvements normaux (ligne 839)');
  console.log('   ✅ Laisser respirer la position : ne resserrer qu\'à +3% unrealized');
  console.log('   ✅ Utiliser breakeven seulement après +2% réel (pas 1.5%)');

  await prisma.$disconnect();
}

analyzeLowGains().catch(console.error);

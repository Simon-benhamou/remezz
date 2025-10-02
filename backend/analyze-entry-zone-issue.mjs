#!/usr/bin/env node
/**
 * Analyse pourquoi l'agent n'a pas tradé SOL malgré +6% aujourd'hui et +4% hier
 * Problème : Entry zone bloquée sur un niveau irréaliste (trop bas pour LONG)
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function analyzeEntryZoneIssue() {
  console.log('🔍 ANALYSE : Pourquoi l\'agent n\'a pas tradé SOL\n');
  console.log('=' .repeat(80));

  // Récupérer les sessions actives pour SOL
  const solSessions = await prisma.agentSession.findMany({
    where: {
      symbol: {
        contains: 'SOL'
      }
    },
    orderBy: { createdAt: 'desc' },
    take: 5,
    include: {
      position: true,
      kpi: true
    }
  });

  console.log(`\n📊 Trouvé ${solSessions.length} sessions SOL\n`);

  for (const session of solSessions) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`SESSION: ${session.symbol}`);
    console.log(`État: ${session.state} | Créée: ${session.createdAt.toISOString()}`);
    console.log(`Mode: ${session.mode}`);
    
    // Analyser l'activation profile
    const profile = session.activationProfile;
    if (profile) {
      console.log(`\n📋 PROFIL:`);
      console.log(`  Levier max: x${profile.maxLeverage || 'N/A'}`);
      console.log(`  Risque par trade: ${profile.riskPerTradePct || 'N/A'}%`);
      console.log(`  Agressivité: ${profile.aggressiveness || 'reactive'}`);
    }

    // Vérifier si position active
    if (session.position) {
      console.log(`\n💼 POSITION ACTIVE:`);
      console.log(`  Side: ${session.position.side}`);
      console.log(`  Entry: ${session.position.entryPrice}`);
      console.log(`  Qty: ${session.position.qty}`);
      console.log(`  Mark: ${session.position.markPrice}`);
      console.log(`  P&L: ${session.position.unrealizedPnl}`);
    } else {
      console.log(`\n⚠️  AUCUNE POSITION - L'agent n'a pas entré`);
    }

    // Analyser les KPIs
    if (session.kpi) {
      console.log(`\n📈 PERFORMANCE:`);
      console.log(`  P&L réalisé: ${session.kpi.realizedPnlUsd.toFixed(2)}$`);
      console.log(`  P&L non réalisé: ${session.kpi.unrealizedPnlUsd.toFixed(2)}$`);
      console.log(`  ROI: ${session.kpi.roiPct.toFixed(2)}%`);
      console.log(`  Win rate: ${session.kpi.winRate.toFixed(1)}%`);
    }
  }

  console.log(`\n\n${'='.repeat(80)}`);
  console.log('🔍 DIAGNOSTIC : PROBLÈME D\'ENTRY ZONE\n');

  console.log('📍 LOGIQUE ACTUELLE (lignes 1223-1290 de state.ts) :');
  console.log('');
  console.log('  Pour une position LONG :');
  console.log('  1️⃣  Cherche un support en DESSOUS du prix actuel');
  console.log('  2️⃣  Si pas de support proche, utilise EMA20/EMA50');
  console.log('  3️⃣  Sinon, calcule pullback de 2-4% EN DESSOUS du prix');
  console.log('');
  console.log('  ❌ PROBLÈME : Attend un PULLBACK qui ne vient jamais !');
  console.log('');

  console.log('💡 SCÉNARIO SOL :');
  console.log('');
  console.log('  Hier : SOL à 100$ → +4% → 104$');
  console.log('  Entry zone calculée : 98-99$ (pullback de 2%)');
  console.log('  Prix actuel : 104$ → HORS ZONE ❌');
  console.log('');
  console.log('  Aujourd\'hui : SOL à 104$ → +6% → 110.24$');
  console.log('  Entry zone toujours : 98-99$ (pas recalculée !)');
  console.log('  Prix actuel : 110.24$ → HORS ZONE ❌');
  console.log('');
  console.log('  📊 Résultat : +10% de mouvement RATÉ car zone bloquée en bas');
  console.log('');

  console.log('🔴 PROBLÈMES IDENTIFIÉS :');
  console.log('');
  console.log('  1️⃣  ZONE STATIQUE : Calculée une fois, jamais mise à jour');
  console.log('     → Si prix monte, zone reste en bas (irréaliste)');
  console.log('');
  console.log('  2️⃣  STRATÉGIE TROP CONSERVATIVE : Attend TOUJOURS un pullback');
  console.log('     → Rate les mouvements de tendance forte (momentum)');
  console.log('');
  console.log('  3️⃣  PAS DE BREAKOUT ENTRY : Seulement rebound/rejection');
  console.log('     → Ne peut pas entrer sur continuation de tendance');
  console.log('');

  console.log('✅ SOLUTIONS PROPOSÉES :');
  console.log('');
  console.log('  OPTION 1 - ZONE DYNAMIQUE (Conservative) :');
  console.log('    • Recalculer entry zone toutes les 15-30 minutes');
  console.log('    • Si prix > zone + 2% → Décaler zone vers le haut');
  console.log('    • Permet de suivre le mouvement sans chase');
  console.log('    • ⚠️  Toujours rate les 2 premiers %');
  console.log('');
  console.log('  OPTION 2 - BREAKOUT MODE (Agressive) :');
  console.log('    • Détecter tendance forte (ADX > 30, +2% en 1h)');
  console.log('    • Switcher en mode "breakout entry"');
  console.log('    • Entry zone = prix actuel ±0.3% (entrée immédiate)');
  console.log('    • Stop plus serré (0.8% au lieu de 2%)');
  console.log('    • ✅ Capture les mouvements en cours');
  console.log('');
  console.log('  OPTION 3 - HYBRIDE (Recommandé ⭐) :');
  console.log('    • Par défaut : Pullback mode (zone en bas)');
  console.log('    • SI tendance forte + prix > zone + 3% pendant 2h :');
  console.log('      → Passer en breakout mode');
  console.log('      → Entry zone = prix actuel (catch-up)');
  console.log('    • Évite le FOMO mais permet de rejoindre une vraie tendance');
  console.log('');

  console.log('🎯 IMPLÉMENTATION RECOMMANDÉE :');
  console.log('');
  console.log('  1. Ajouter fonction `shouldSwitchToBreakoutMode()` :');
  console.log('     • Check ADX > 30');
  console.log('     • Check prix > entry zone + 3%');
  console.log('     • Check durée > 2h hors zone');
  console.log('     • Check mouvement > 4% sur 24h');
  console.log('');
  console.log('  2. Modifier `calculateDynamicEntryZone()` :');
  console.log('     • Ajouter paramètre `allowBreakout: boolean`');
  console.log('     • Si breakout mode : zone = prix actuel ±0.3%');
  console.log('     • Sinon : logique pullback actuelle');
  console.log('');
  console.log('  3. Scheduler recalcul zone :');
  console.log('     • Toutes les 30 min en mode ARMED');
  console.log('     • Check si besoin de switch breakout');
  console.log('     • Update zone si nécessaire');
  console.log('');

  console.log('📊 RÉSULTAT ATTENDU :');
  console.log('');
  console.log('  AVANT (actuel) :');
  console.log('    • SOL +10% en 2 jours → 0 trade (zone bloquée)');
  console.log('    • Taux de capture : 0% des grandes tendances');
  console.log('');
  console.log('  APRÈS (avec breakout mode) :');
  console.log('    • SOL +4% hier → Attend pullback (OK)');
  console.log('    • SOL +6% aujourd\'hui après 2h → Switch breakout');
  console.log('    • Entry à 105$ → Exit à 108$ → +3% capture ✅');
  console.log('    • Taux de capture : ~30-40% des grandes tendances');
  console.log('');

  await prisma.$disconnect();
}

analyzeEntryZoneIssue().catch(console.error);

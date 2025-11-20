import { prisma } from '../db/client.js';

async function checkETHCapital() {
  try {
    console.log('🔍 Analyse du capital et threshold ETH\n');
    
    // Récupérer la session ETH la plus récente
    const session = await (prisma as any).tradingSession.findFirst({
      where: { crypto: 'ETH', isActive: true },
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, username: true } }
      }
    });
    
    if (!session) {
      console.log('❌ Aucune session ETH active trouvée');
      return;
    }
    
    console.log(`📊 Session ETH: ${session.id.slice(0, 12)}`);
    console.log(`   User: ${session.user.username}`);
    console.log(`   Budget: $${session.budget}`);
    console.log(`   Leverage: ${session.leverage}x`);
    console.log(`   Created: ${session.createdAt.toISOString()}\n`);
    
    // Récupérer toutes les positions actives de l'utilisateur
    const activeSessions = await (prisma as any).tradingSession.findMany({
      where: {
        userId: session.userId,
        isActive: true,
        hasOpenPosition: true
      },
      include: {
        currentPosition: true
      }
    });
    
    console.log(`💼 Positions actives de l'utilisateur: ${activeSessions.length}`);
    
    let totalUsedCapital = 0;
    for (const s of activeSessions) {
      if (s.currentPosition) {
        const posValue = Math.abs(s.currentPosition.quantity * s.currentPosition.entryPrice);
        totalUsedCapital += posValue;
        console.log(`   - ${s.crypto}: $${posValue.toFixed(2)} (${s.currentPosition.side})`);
      }
    }
    
    console.log(`\n💰 Capital Analysis:`);
    console.log(`   Budget session ETH: $${session.budget}`);
    console.log(`   Capital utilisé (toutes positions): $${totalUsedCapital.toFixed(2)}`);
    
    // Simuler le calcul du threshold
    const totalCapital = session.budget;
    const usedCapital = totalUsedCapital;
    const freeCapital = totalCapital - usedCapital;
    const usageRatio = totalCapital > 0 ? usedCapital / totalCapital : 0;
    
    let minConfidenceRequired: number;
    let accountCategory: string;
    
    if (totalCapital < 200) {
      minConfidenceRequired = 0.50;
      accountCategory = 'SMALL (<$200)';
    } else if (totalCapital < 1000) {
      minConfidenceRequired = usageRatio < 0.50 ? 0.50 : 0.65;
      accountCategory = 'MEDIUM ($200-$1000)';
    } else {
      accountCategory = 'LARGE (>$1000)';
      // Large account logic
      if (usageRatio < 0.55) {
        minConfidenceRequired = 0.45;
      } else if (usageRatio < 0.75) {
        minConfidenceRequired = 0.54;
      } else {
        minConfidenceRequired = 0.62;
      }
    }
    
    console.log(`\n📊 Calculs (selon le code):`);
    console.log(`   Account Category: ${accountCategory}`);
    console.log(`   Total Capital: $${totalCapital.toFixed(2)}`);
    console.log(`   Used Capital: $${usedCapital.toFixed(2)}`);
    console.log(`   Free Capital: $${freeCapital.toFixed(2)}`);
    console.log(`   Usage Ratio: ${(usageRatio * 100).toFixed(1)}%`);
    console.log(`   ⚙️  Min Confidence Required: ${minConfidenceRequired.toFixed(3)}`);
    
    // Comparer avec les logs
    console.log(`\n⚠️  Dans les logs du serveur:`);
    console.log(`   Threshold observé: 0.45`);
    console.log(`   Confidence des signaux: 0.238-0.339 (23-34%)`);
    console.log(`   Résultat: ${minConfidenceRequired > 0.34 ? '❌ TOUS LES SIGNAUX REJETÉS' : '✅ OK'}`);
    
    console.log(`\n🎯 Analyse du problème:`);
    console.log(`   1. Threshold de 0.45 (45%) est le minimum pour large accounts`);
    console.log(`   2. Mais avec RSI=24.2 (SURVENTE EXTRÊME) + ATR=106% (VOLATILITÉ ÉNORME)`);
    console.log(`   3. Le predictor donne seulement 23-34% de confidence`);
    console.log(`   4. ❌ BUG: Pas de système d'override pour conditions extrêmes!`);
    
    console.log(`\n💡 Solutions possibles:`);
    console.log(`   A. Réduire le threshold minimum de 0.45 à 0.30 pour conditions extrêmes`);
    console.log(`   B. Ajouter un override quand RSI < 25 OU RSI > 75 (survente/surachat)`);
    console.log(`   C. Multiplier confidence par un facteur quand ATR > 100%`);
    console.log(`   D. Système de "panic mode" qui ignore les thresholds`);
    
    // Récupérer les dernières décisions
    console.log(`\n📋 Dernières décisions de la session:`);
    const decisions = await (prisma as any).tradingDecision.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: 'desc' },
      take: 10
    });
    
    if (decisions.length > 0) {
      for (const dec of decisions) {
        const ago = Math.floor((Date.now() - dec.createdAt.getTime()) / (1000 * 60));
        const emoji = dec.action === 'NONE' ? '⏸️' : dec.action === 'OPEN_LONG' || dec.action === 'OPEN_SHORT' ? '🚀' : '🔄';
        console.log(`   ${emoji} ${dec.action} - il y a ${ago} min`);
        if (dec.blockReason) {
          console.log(`      ❌ BLOQUÉ: ${dec.blockReason.slice(0, 80)}`);
        }
        if (dec.reason) {
          console.log(`      ℹ️  ${dec.reason.slice(0, 80)}`);
        }
      }
    } else {
      console.log(`   Aucune décision trouvée`);
    }
    
  } catch (error) {
    console.error('❌ Erreur:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

checkETHCapital().catch(err => {
  console.error(err);
  process.exit(1);
});

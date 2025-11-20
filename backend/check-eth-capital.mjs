import { prisma } from './dist/src/db/client.js';

async function checkETHCapital() {
  try {
    console.log('🔍 Analyse du capital et threshold ETH\n');
    
    // Récupérer la session ETH la plus récente
    const session = await prisma.tradingSession.findFirst({
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
    const activeSessions = await prisma.tradingSession.findMany({
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
    
    let minConfidenceRequired;
    
    if (totalCapital < 200) {
      minConfidenceRequired = 0.50;
    } else if (totalCapital < 1000) {
      minConfidenceRequired = usageRatio < 0.50 ? 0.50 : 0.65;
    } else {
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
    console.log(`   Total Capital: $${totalCapital.toFixed(2)}`);
    console.log(`   Used Capital: $${usedCapital.toFixed(2)}`);
    console.log(`   Free Capital: $${freeCapital.toFixed(2)}`);
    console.log(`   Usage Ratio: ${(usageRatio * 100).toFixed(1)}%`);
    console.log(`   Min Confidence Required: ${minConfidenceRequired.toFixed(3)}`);
    
    // Comparer avec les logs
    console.log(`\n⚠️  Dans les logs, le threshold était à 0.45`);
    console.log(`   Confidence des signaux: 0.238-0.339 (23-34%)`);
    console.log(`   Problème: ${minConfidenceRequired > 0.34 ? '❌ TROP ÉLEVÉ' : '✅ OK'}`);
    
    console.log(`\n🎯 Recommandations:`);
    if (minConfidenceRequired >= 0.45) {
      console.log(`   1. Le threshold de 0.45 est trop élevé pour des conditions de survente extrême`);
      console.log(`   2. RSI=24.2 + ATR=106% = signal TRÈS fort qui devrait override le threshold`);
      console.log(`   3. Besoin d'un système d'override pour conditions extrêmes`);
    }
    
    // Récupérer les dernières décisions
    console.log(`\n📋 Dernières décisions de la session:`);
    const decisions = await prisma.tradingDecision.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: 'desc' },
      take: 5
    });
    
    for (const dec of decisions) {
      const ago = Math.floor((Date.now() - dec.createdAt.getTime()) / (1000 * 60));
      console.log(`   ${dec.action} - il y a ${ago} min`);
      if (dec.blockReason) {
        console.log(`      BLOQUÉ: ${dec.blockReason.slice(0, 100)}`);
      }
    }
    
  } catch (error) {
    console.error('❌ Erreur:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkETHCapital();

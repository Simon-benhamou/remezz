import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function checkETHCapital() {
  try {
    console.log('🔍 Analyse du capital et threshold ETH\n');
    
    // Récupérer la session ETH la plus récente ACTIVE
    const session = await prisma.agentSession.findFirst({
      where: { 
        symbol: { contains: 'ETH' },
        stoppedAt: null // Active
      },
      orderBy: { startedAt: 'desc' },
      include: {
        user: { select: { id: true, username: true } }
      }
    });
    
    if (!session) {
      console.log('❌ Aucune session ETH active trouvée');
      console.log('Recherche de toutes les sessions ETH...\n');
      
      const allETH = await prisma.agentSession.findMany({
        where: { symbol: { contains: 'ETH' } },
        orderBy: { startedAt: 'desc' },
        take: 5
      });
      
      if (allETH.length > 0) {
        console.log(`Trouvé ${allETH.length} sessions ETH (actives ou inactives):`);
        for (const s of allETH) {
          const active = s.stoppedAt === null ? '✅ ACTIVE' : '❌ STOPPED';
          console.log(`   ${s.symbol} - ${active} - créée ${s.startedAt.toISOString()}`);
        }
      }
      return;
    }
    
    const age = Math.floor((Date.now() - session.startedAt.getTime()) / (1000 * 60 * 60));
    console.log(`📊 Session ETH Active Trouvée!`);
    console.log(`   ID: ${session.id.slice(0, 12)}...`);
    console.log(`   Symbol: ${session.symbol}`);
    console.log(`   User: ${session.user?.username || 'N/A'}`);
    console.log(`   Initial Balance: $${session.initialBalance}`);
    console.log(`   Status: ${session.status}`);
    console.log(`   Agent Type: ${session.agentType}`);
    console.log(`   Créée: ${session.startedAt.toISOString()} (il y a ${age}h)\n`);
    
    // Récupérer toutes les positions actives de l'utilisateur
    const userId = session.userId;
    const activeSessions = await prisma.agentSession.findMany({
      where: {
        userId: userId,
        stoppedAt: null, // Active
      },
      include: {
        positions: {
          take: 10
        }
      }
    });
    
    console.log(`💼 Toutes les sessions actives de l'utilisateur: ${activeSessions.length}`);
    
    let totalUsedCapital = 0;
    let totalInitialBalance = 0;
    
    for (const s of activeSessions) {
      const bal = parseFloat(s.initialBalance) || 0;
      totalInitialBalance += bal;
      
      // Compter seulement les positions qui ont openedAt et pas de closedAt
      const openPositions = s.positions.filter(p => p.openedAt && !p.closedAt);
      
      if (openPositions.length > 0) {
        for (const pos of openPositions) {
          const qty = pos.qty || pos.quantity || 0;
          const posValue = Math.abs(qty * pos.entryPrice);
          totalUsedCapital += posValue;
          console.log(`   - ${s.symbol}: $${posValue.toFixed(2)} (${pos.side}, qty=${qty})`);
        }
      } else {
        console.log(`   - ${s.symbol}: $0 (pas de position ouverte)`);
      }
    }
    
    console.log(`\n💰 Capital Analysis:`);
    console.log(`   Total Initial Balance: $${totalInitialBalance.toFixed(2)}`);
    console.log(`   Capital utilisé (toutes positions): $${totalUsedCapital.toFixed(2)}`);
    
    // Simuler le calcul du threshold EXACTEMENT comme dans le code
    const totalCapital = totalInitialBalance;
    const usedCapital = totalUsedCapital;
    const freeCapital = totalCapital - usedCapital;
    const usageRatio = totalCapital > 0 ? usedCapital / totalCapital : 0;
    
    let minConfidenceRequired;
    let accountCategory;
    
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
    
    console.log(`\n📊 Calculs du Threshold (selon metaAdaptiveOrchestrator.ts):`);
    console.log(`   Account Category: ${accountCategory}`);
    console.log(`   Total Capital: $${totalCapital.toFixed(2)}`);
    console.log(`   Used Capital: $${usedCapital.toFixed(2)}`);
    console.log(`   Free Capital: $${freeCapital.toFixed(2)}`);
    console.log(`   Usage Ratio: ${(usageRatio * 100).toFixed(1)}%`);
    console.log(`   ⚙️  Min Confidence Required: ${(minConfidenceRequired * 100).toFixed(1)}%`);
    
    // Comparer avec les logs
    console.log(`\n⚠️  Dans les logs du serveur (16:48-17:12):`);
    console.log(`   Threshold observé: 0.45 (45%)`);
    console.log(`   Confidence des signaux: 0.238-0.339 (23.8%-33.9%)`);
    console.log(`   Conditions de marché:`);
    console.log(`      - RSI: 24.2 (SURVENTE EXTRÊME)`);
    console.log(`      - ATR: 106.74% (VOLATILITÉ ÉNORME)`);
    console.log(`      - Prix: $2867 → $2861 (-0.2%)`);
    console.log(`   Résultat: ${minConfidenceRequired > 0.34 ? '❌ TOUS LES SIGNAUX REJETÉS' : '✅ Signaux acceptés'}`);
    
    console.log(`\n🔴 PROBLÈME IDENTIFIÉ:`);
    console.log(`   Le threshold de ${(minConfidenceRequired * 100).toFixed(0)}% est TROP ÉLEVÉ pour:`);
    console.log(`   1. Conditions de survente extrême (RSI < 25)`);
    console.log(`   2. Volatilité explosive (ATR > 100%)`);
    console.log(`   3. Predictor qui donne naturellement des confidences basses en conditions extrêmes`);
    
    console.log(`\n💡 SOLUTIONS RECOMMANDÉES:`);
    console.log(`   Option A - QUICK FIX: Réduire threshold minimum`);
    console.log(`      if (usageRatio < 0.55) minConfidenceRequired = 0.30; // Au lieu de 0.45`);
    console.log(`\n   Option B - SMART FIX: Override pour conditions extrêmes`);
    console.log(`      if (rsi < 25 || rsi > 75) minConfidenceRequired *= 0.7; // -30%`);
    console.log(`\n   Option C - OPTIMAL: Système adaptatif complet`);
    console.log(`      - Ajuster threshold selon volatilité (ATR)`);
    console.log(`      - Override pour RSI extrêmes`);
    console.log(`      - Boost confidence en conditions claires`);
    
    // Récupérer les derniers orders
    console.log(`\n📋 Derniers orders de la session:`);
    const orders = await prisma.order.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: 'desc' },
      take: 5
    });
    
    if (orders.length > 0) {
      for (const order of orders) {
        const ago = Math.floor((Date.now() - order.createdAt.getTime()) / (1000 * 60));
        console.log(`   ${order.status} - ${order.side} @ $${order.price} (il y a ${ago} min)`);
      }
    } else {
      console.log(`   ❌ AUCUN ORDER - L'agent n'a jamais tradé!`);
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

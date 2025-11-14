import { prisma } from './dist/src/db/client.js';
import { getPrediction, isPythonPredictorAvailable } from './dist/src/quantai/pythonPredictor.js';

async function testPredictorOnSymbols() {
  try {
    const sessions = await prisma.agentSession.findMany({
      where: { 
        stoppedAt: null,
        haltedAt: null
      },
      select: { 
        id: true, 
        symbol: true,
        profileJson: true 
      },
      take: 5,
      orderBy: { startedAt: 'desc' }
    });
    
    console.log('\n🔍 Testing predictor on', sessions.length, 'active symbols:\n');
    
    if (!isPythonPredictorAvailable()) {
      console.log('❌ Python predictor not available');
      await prisma.$disconnect();
      process.exit(1);
    }
    
    for (const session of sessions) {
      const profile = session.profileJson;
      const features = profile?._diagnostics?.lastPredictorData?.features;
      
      if (!features || Object.keys(features).length === 0) {
        console.log(`⏭️  ${session.symbol}: No features available\n`);
        continue;
      }
      
      try {
        const prediction = await getPrediction(features);
        const probLong = (prediction.probabilityLong * 100).toFixed(1);
        const probShort = (prediction.probabilityShort * 100).toFixed(1);
        const probNone = (prediction.probabilityNone * 100).toFixed(1);
        const conf = (prediction.confidence * 100).toFixed(1);
        
        console.log(`📊 ${session.symbol}:`);
        console.log(`   Decision: ${prediction.decision.toUpperCase()} (confidence: ${conf}%)`);
        console.log(`   Probabilities: LONG=${probLong}% SHORT=${probShort}% NONE=${probNone}%`);
        console.log(`   Features sample: RSI=${features.rsi?.toFixed(1) ?? 'N/A'} MACD=${features.macd?.toFixed(4) ?? 'N/A'} ADX=${features.adx?.toFixed(1) ?? 'N/A'}`);
        console.log(`   Session ID: ${session.id.slice(0, 8)}...\n`);
      } catch (error) {
        console.log(`❌ ${session.symbol}: Error - ${error.message}\n`);
      }
    }
    
    await prisma.$disconnect();
  } catch (error) {
    console.error('Fatal error:', error);
    await prisma.$disconnect();
    process.exit(1);
  }
}

testPredictorOnSymbols();

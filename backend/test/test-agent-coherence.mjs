// Test de cohérence de l'analyse diagnostique des agents
// Vérifie si les agents agissent correctement selon les conditions de marché
console.log('🧠 Testing Agent Diagnostic Analysis Coherence...\n');

async function testAgentCoherence() {
  try {
    // Import des modules nécessaires
    const { buildTechSnapshot } = await import('../dist/ai/tech.js');
    const { AgentHub } = await import('../dist/agent/hub.js');
    
    console.log('🔍 Analyzing active agents and their market decisions...\n');
    
    // Récupérer les IDs des agents actifs
    const activeIds = AgentHub.listActiveIds();
    console.log(`📊 Found ${activeIds.length} active agents`);
    
    if (activeIds.length === 0) {
      console.log('⚠️ No active agents found. Create some agents first to test diagnostic coherence.');
      console.log('💡 Go to the dashboard and create some paper trading agents to test.');
      return;
    }
    
    // Obtenir le snapshot des agents
    const agentsSnapshot = AgentHub.snapshot();
    console.log('\n🤖 ACTIVE AGENTS OVERVIEW:');
    agentsSnapshot.forEach((agent, idx) => {
      console.log(`  ${idx + 1}. ${agent.symbol} (${agent.mode}) - State: ${agent.state} - Position: ${agent.hasPosition ? 'Yes' : 'No'}`);
    });
    
    // Test de cohérence pour chaque agent
    for (let i = 0; i < activeIds.length; i++) {
      const sessionId = activeIds[i];
      const agent = AgentHub.get(sessionId);
      
      if (!agent) {
        console.log(`❌ Agent ${sessionId}: Not found in hub`);
        continue;
      }
      
      const symbol = agent.profile?.symbol;
      
      if (!symbol) {
        console.log(`❌ Agent ${sessionId}: No symbol found`);
        continue;
      }
      
      console.log(`\n🤖 AGENT ANALYSIS: ${symbol} (Session: ${sessionId.substring(0, 8)}...)`);
      console.log(`Mode: ${agent.profile?.mode || 'unknown'}`);
      console.log(`State: ${agent.state || 'UNKNOWN'}`);
      console.log(`Bias: ${agent.bias || 'none'}`);
      console.log(`Has Position: ${agent.pos ? 'Yes' : 'No'}`);
      
      try {
        // Obtenir les données techniques actuelles
        const snap = await buildTechSnapshot(symbol);
        
        console.log(`\n📈 CURRENT MARKET DATA for ${symbol}:`);
        console.log(`Price: $${snap.last}`);
        console.log(`RSI(14): ${snap.rsi14.toFixed(1)}`);
        console.log(`ADX(14): ${snap.adx14.toFixed(1)}`);
        console.log(`EMA20: $${snap.ema20.toFixed(4)}`);
        console.log(`EMA50: $${snap.ema50.toFixed(4)}`);
        console.log(`ATR%: ${snap.atrPct.toFixed(2)}%`);
        
        // Calculer les indicateurs de tendance
        const emaSpread = ((snap.ema20 - snap.ema50) / snap.ema50) * 100;
        const priceVsEma20 = ((snap.last - snap.ema20) / snap.ema20) * 100;
        const priceVsEma50 = ((snap.last - snap.ema50) / snap.ema50) * 100;
        
        console.log(`EMA Spread: ${emaSpread.toFixed(2)}%`);
        console.log(`Price vs EMA20: ${priceVsEma20.toFixed(2)}%`);
        console.log(`Price vs EMA50: ${priceVsEma50.toFixed(2)}%`);
        
        // Déterminer les conditions de marché
        console.log(`\n🔍 MARKET CONDITIONS ANALYSIS:`);
        
        // Tendance
        let trendDirection = 'SIDEWAYS';
        if (emaSpread > 0.5) trendDirection = 'BULLISH';
        else if (emaSpread < -0.5) trendDirection = 'BEARISH';
        console.log(`Trend (EMA): ${trendDirection} (${emaSpread.toFixed(2)}%)`);
        
        // Force de la tendance
        let trendStrength = 'WEAK';
        if (snap.adx14 > 25) trendStrength = 'STRONG';
        else if (snap.adx14 > 20) trendStrength = 'MODERATE';
        console.log(`Trend Strength: ${trendStrength} (ADX: ${snap.adx14.toFixed(1)})`);
        
        // Conditions RSI
        let rsiCondition = 'NEUTRAL';
        if (snap.rsi14 > 70) rsiCondition = 'OVERBOUGHT';
        else if (snap.rsi14 < 30) rsiCondition = 'OVERSOLD';
        else if (snap.rsi14 > 60) rsiCondition = 'BULLISH';
        else if (snap.rsi14 < 40) rsiCondition = 'BEARISH';
        console.log(`RSI Condition: ${rsiCondition} (${snap.rsi14.toFixed(1)})`);
        
        // Position par rapport aux EMA
        let pricePosition = 'BETWEEN';
        if (snap.last > snap.ema20 && snap.last > snap.ema50) pricePosition = 'ABOVE_ALL';
        else if (snap.last < snap.ema20 && snap.last < snap.ema50) pricePosition = 'BELOW_ALL';
        console.log(`Price Position: ${pricePosition}`);
        
        // Obtenir les diagnostics de l'agent
        console.log(`\n🩺 AGENT DIAGNOSTICS:`);
        let diagnostics = null;
        try {
          diagnostics = await agent.getDiagnostics();
          console.log(`Diagnostics Status: ✅ Available`);
        } catch (diagError) {
          console.log(`Diagnostics Status: ❌ Error - ${diagError.message}`);
        }
        
        // Analyser la cohérence des décisions
        console.log(`\n🧠 COHERENCE ANALYSIS:`);
        
        // Vérifier si l'état de l'agent est cohérent avec les conditions de marché
        const agentState = agent.state;
        const agentBias = agent.bias || 'none';
        
        console.log(`Agent State: ${agentState}`);
        console.log(`Agent Bias: ${agentBias}`);
        
        // Tests de cohérence
        let coherenceScore = 0;
        let maxScore = 0;
        const issues = [];
        const goodDecisions = [];
        
        // Test 1: Bias vs Trend coherence
        maxScore += 20;
        if (agentBias === 'long' && trendDirection === 'BULLISH') {
          coherenceScore += 20;
          goodDecisions.push('✅ LONG bias aligns with BULLISH trend');
        } else if (agentBias === 'short' && trendDirection === 'BEARISH') {
          coherenceScore += 20;
          goodDecisions.push('✅ SHORT bias aligns with BEARISH trend');
        } else if (agentBias === 'none' && trendDirection === 'SIDEWAYS') {
          coherenceScore += 15;
          goodDecisions.push('✅ NEUTRAL bias appropriate for SIDEWAYS market');
        } else if (agentBias !== 'none') {
          issues.push(`⚠️ ${agentBias.toUpperCase()} bias conflicts with ${trendDirection} trend`);
        }
        
        // Test 2: State vs Market conditions
        maxScore += 20;
        if (agentState === 'ARMED' && trendStrength !== 'WEAK') {
          coherenceScore += 20;
          goodDecisions.push('✅ ARMED state with sufficient trend strength');
        } else if (agentState === 'MANAGE' && agent.pos) {
          coherenceScore += 20;
          goodDecisions.push('✅ MANAGE state with active position');
        } else if (agentState === 'IDLE' && trendStrength === 'WEAK') {
          coherenceScore += 15;
          goodDecisions.push('✅ IDLE state appropriate for weak trend');
        } else if (agentState === 'ARMED' && trendStrength === 'WEAK') {
          issues.push('⚠️ ARMED state despite weak trend strength');
        }
        
        // Test 3: RSI vs Actions
        maxScore += 20;
        if (agentBias === 'long' && rsiCondition === 'OVERSOLD') {
          coherenceScore += 20;
          goodDecisions.push('✅ LONG bias during OVERSOLD conditions (good entry)');
        } else if (agentBias === 'short' && rsiCondition === 'OVERBOUGHT') {
          coherenceScore += 20;
          goodDecisions.push('✅ SHORT bias during OVERBOUGHT conditions (good entry)');
        } else if (agentBias === 'long' && rsiCondition === 'OVERBOUGHT') {
          issues.push('⚠️ LONG bias during OVERBOUGHT conditions (risky entry)');
        } else if (agentBias === 'short' && rsiCondition === 'OVERSOLD') {
          issues.push('⚠️ SHORT bias during OVERSOLD conditions (risky entry)');
        } else {
          coherenceScore += 10; // Neutral situations
        }
        
        // Test 4: Volatility vs Risk management
        maxScore += 20;
        const isHighVolatility = snap.atrPct > 3.0;
        if (isHighVolatility && agentState === 'ARMED') {
          coherenceScore += 15;
          goodDecisions.push('✅ Conservative approach in high volatility');
        } else if (!isHighVolatility && agentState === 'ARMED') {
          coherenceScore += 20;
          goodDecisions.push('✅ Active in low volatility environment');
        } else if (isHighVolatility && agentState === 'IDLE') {
          coherenceScore += 10;
          goodDecisions.push('✅ Cautious during high volatility');
        }
        
        // Test 5: Position consistency
        maxScore += 20;
        if (agent.pos) {
          const positionSide = agent.pos.side;
          if ((positionSide === 'buy' && agentBias === 'long') || 
              (positionSide === 'sell' && agentBias === 'short')) {
            coherenceScore += 20;
            goodDecisions.push('✅ Position direction matches agent bias');
          } else {
            issues.push('⚠️ Position direction conflicts with agent bias');
          }
        } else if (agentState === 'ARMED') {
          coherenceScore += 15;
          goodDecisions.push('✅ No position while ARMED (waiting for entry)');
        } else {
          coherenceScore += 10; // Neutral
        }
        
        // Calcul du score final
        const coherencePercentage = Math.round((coherenceScore / maxScore) * 100);
        
        console.log(`\n📊 COHERENCE SCORE: ${coherenceScore}/${maxScore} (${coherencePercentage}%)`);
        
        if (coherencePercentage >= 80) {
          console.log('🟢 EXCELLENT: Agent decisions are highly coherent with market conditions');
        } else if (coherencePercentage >= 60) {
          console.log('🟡 GOOD: Agent decisions are mostly coherent with some minor issues');
        } else if (coherencePercentage >= 40) {
          console.log('🟠 MODERATE: Agent decisions have some incoherence issues');
        } else {
          console.log('🔴 POOR: Agent decisions show significant incoherence with market conditions');
        }
        
        // Afficher les bonnes décisions
        if (goodDecisions.length > 0) {
          console.log('\n✅ GOOD DECISIONS:');
          goodDecisions.forEach(decision => console.log(`  ${decision}`));
        }
        
        // Afficher les problèmes
        if (issues.length > 0) {
          console.log('\n⚠️ POTENTIAL ISSUES:');
          issues.forEach(issue => console.log(`  ${issue}`));
        }
        
        // Recommandations
        console.log('\n💡 RECOMMENDATIONS:');
        if (trendStrength === 'WEAK' && agentState === 'ARMED') {
          console.log('  - Consider waiting for stronger trend confirmation');
        }
        if (issues.some(i => i.includes('bias conflicts'))) {
          console.log('  - Review agent bias settings vs current market trend');
        }
        if (isHighVolatility && agentState === 'ARMED') {
          console.log('  - Consider tighter risk management in high volatility');
        }
        if (rsiCondition === 'OVERBOUGHT' && agentBias === 'long') {
          console.log('  - Wait for RSI pullback before long entries');
        }
        if (rsiCondition === 'OVERSOLD' && agentBias === 'short') {
          console.log('  - Wait for RSI recovery before short entries');
        }
        
      } catch (error) {
        console.error(`❌ Error analyzing agent ${symbol}:`, error.message);
      }
      
      console.log('\n' + '='.repeat(80));
    }
    
    console.log('\n🎯 SUMMARY:');
    console.log('This analysis checks if agents make coherent decisions based on:');
    console.log('  - Trend direction vs agent bias');
    console.log('  - Market strength vs agent state');
    console.log('  - RSI conditions vs entry timing');
    console.log('  - Volatility vs risk management');
    console.log('  - Position consistency');
    console.log('\nUse this analysis to optimize agent parameters and improve trading performance.');
    
  } catch (error) {
    console.error('❌ Test Error:', error.message);
    console.log('\n💡 Troubleshooting:');
    console.log('1. Make sure agents are running');
    console.log('2. Verify market data access');
    console.log('3. Check agent diagnostic functionality');
  }
}

testAgentCoherence();
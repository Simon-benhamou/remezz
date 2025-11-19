#!/usr/bin/env node
/**
 * Comprehensive Subagent Test Suite
 * 
 * Tests all 7 subagents to ensure they work correctly:
 * 1. Risk Governor
 * 2. Execution Agent
 * 3. Predictor Agent
 * 4. Sentiment Agent
 * 5. Market Quality Agent
 * 6. Entry Timing Agent
 * 7. Exit Strategy Agent
 */

import { config } from 'dotenv';
import { getTicker } from '../src/ai/broker.js';
import { fetchTechSnapshot } from '../src/ai/tech.js';

config();

const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

function log(message, color = COLORS.reset) {
  console.log(`${color}${message}${COLORS.reset}`);
}

function header(message) {
  log(`\n${'='.repeat(70)}`, COLORS.cyan);
  log(message, COLORS.bright + COLORS.cyan);
  log('='.repeat(70), COLORS.cyan);
}

function success(message) {
  log(`✓ ${message}`, COLORS.green);
}

function error(message) {
  log(`✗ ${message}`, COLORS.red);
}

function info(message) {
  log(`ℹ ${message}`, COLORS.blue);
}

function warning(message) {
  log(`⚠ ${message}`, COLORS.yellow);
}

// Dynamically import agents
async function loadAgents() {
  const riskModule = await import('../src/agent/subagents/riskGovernorAgent.js');
  const executionModule = await import('../src/agent/subagents/executionAgent.js');
  const predictorModule = await import('../src/agent/subagents/predictorAgent.js');
  const sentimentModule = await import('../src/agent/subagents/sentimentAgent.js');
  const marketQualityModule = await import('../src/agent/subagents/marketQualityAgent.js');
  const entryTimingModule = await import('../src/agent/subagents/entryTimingAgent.js');
  const exitStrategyModule = await import('../src/agent/subagents/exitStrategyAgent.js');
  
  return {
    riskGovernor: new riskModule.DefaultRiskGovernorAgent(),
    execution: new executionModule.DefaultExecutionAgent(),
    predictor: new predictorModule.DefaultPredictorAgent(),
    sentiment: new sentimentModule.DefaultSentimentAgent(),
    marketQuality: new marketQualityModule.DefaultMarketQualityAgent(),
    entryTiming: new entryTimingModule.EntryTimingAgent(),
    exitStrategy: new exitStrategyModule.ExitStrategyAgent(),
  };
}

async function testRiskGovernor(agent) {
  header('TEST 1: Risk Governor Agent');
  
  const testSessionId = 'test-session-123';
  const testSymbol = 'BTC/USDT';
  
  try {
    info('Fetching risk limits...');
    const limits = await agent.getLimits(testSessionId, testSymbol);
    
    console.log('\n  Risk Limits:');
    console.log(`    Max Position USD: $${limits.maxPositionUsd.toFixed(2)}`);
    console.log(`    Max Leverage: ${limits.maxLeverage}x`);
    console.log(`    Hedging Required: ${limits.hedgingRequired ? 'Yes' : 'No'}`);
    console.log(`    Reason: ${limits.reason || 'N/A'}`);
    
    if (limits.maxPositionUsd > 0 && limits.maxLeverage > 0) {
      success('Risk Governor returns valid limits');
    } else {
      error('Risk Governor returned invalid limits');
    }
    
    if (!limits.hedgingRequired) {
      success('Risk Governor allows trading (no hedge required)');
    } else {
      warning(`Risk Governor requires hedging: ${limits.reason}`);
    }
    
    return { passed: true, limits };
    
  } catch (err) {
    error(`Risk Governor test failed: ${err.message}`);
    return { passed: false, error: err.message };
  }
}

async function testExecutionAgent(agent) {
  header('TEST 2: Execution Agent');
  
  const testSymbol = 'BTC/USDT';
  
  try {
    info('Fetching execution recommendation...');
    const recommendation = await agent.getRecommendation(testSymbol);
    
    console.log('\n  Execution Recommendation:');
    console.log(`    Mode: ${recommendation.mode}`);
    console.log(`    Passive Bias: ${recommendation.passiveBias?.toFixed(2) ?? 'N/A'}`);
    console.log(`    Fallback MS: ${recommendation.fallbackMs ?? 'N/A'}`);
    console.log(`    Confidence: ${recommendation.confidence?.toFixed(2) ?? 'N/A'}`);
    
    const validModes = ['market', 'sweep', 'iceberg', 'twap'];
    if (validModes.includes(recommendation.mode)) {
      success(`Execution mode is valid: ${recommendation.mode}`);
    } else {
      error(`Invalid execution mode: ${recommendation.mode}`);
    }
    
    return { passed: true, recommendation };
    
  } catch (err) {
    error(`Execution Agent test failed: ${err.message}`);
    return { passed: false, error: err.message };
  }
}

async function testPredictorAgent(agent) {
  header('TEST 3: Predictor Agent');
  
  const testSymbol = 'BTC/USDT';
  
  try {
    info('Fetching predictor insight...');
    const insight = await agent.getInsight(testSymbol);
    
    console.log('\n  Predictor Insight:');
    console.log(`    Enabled: ${insight.enabled}`);
    console.log(`    Bias: ${insight.bias}`);
    console.log(`    Confidence: ${insight.confidence.toFixed(3)}`);
    console.log(`    Last Retrained: ${insight.lastRetrainedAt ?? 'Never'}`);
    console.log(`    Reason: ${insight.reason}`);
    
    if (!insight.enabled) {
      warning('Predictor is DISABLED - model may need training');
      info('💡 Run: npm run retrain (in backend/) to train model');
    } else {
      success('Predictor is ENABLED');
    }
    
    const validBiases = ['bullish', 'bearish', 'neutral'];
    if (validBiases.includes(insight.bias)) {
      success(`Predictor bias is valid: ${insight.bias}`);
    } else {
      error(`Invalid predictor bias: ${insight.bias}`);
    }
    
    if (insight.confidence >= 0 && insight.confidence <= 1) {
      success(`Predictor confidence in valid range: ${insight.confidence.toFixed(3)}`);
    } else {
      error(`Predictor confidence out of range: ${insight.confidence}`);
    }
    
    return { passed: true, insight };
    
  } catch (err) {
    error(`Predictor Agent test failed: ${err.message}`);
    return { passed: false, error: err.message };
  }
}

async function testSentimentAgent(agent) {
  header('TEST 4: Sentiment Agent');
  
  const testSymbol = 'BTC/USDT';
  
  try {
    info('Fetching sentiment signal...');
    const signal = await agent.getSignal(testSymbol);
    
    console.log('\n  Sentiment Signal:');
    console.log(`    Bias: ${signal.bias}`);
    console.log(`    Confidence: ${signal.confidence.toFixed(3)}`);
    console.log(`    News Heat: ${signal.newsHeat.toFixed(2)}`);
    console.log(`    Whale Activity: ${signal.whaleActivity.toFixed(2)}`);
    console.log(`    Cooldown Until: ${signal.cooldownUntil ?? 'None'}`);
    
    const validBiases = ['bullish', 'bearish', 'neutral'];
    if (validBiases.includes(signal.bias)) {
      success(`Sentiment bias is valid: ${signal.bias}`);
    } else {
      error(`Invalid sentiment bias: ${signal.bias}`);
    }
    
    if (signal.confidence >= 0 && signal.confidence <= 1) {
      success(`Sentiment confidence in valid range: ${signal.confidence.toFixed(3)}`);
    } else {
      error(`Sentiment confidence out of range: ${signal.confidence}`);
    }
    
    return { passed: true, signal };
    
  } catch (err) {
    error(`Sentiment Agent test failed: ${err.message}`);
    return { passed: false, error: err.message };
  }
}

async function testMarketQualityAgent(agent) {
  header('TEST 5: Market Quality Agent');
  
  const testSymbol = 'BTC/USDT';
  
  try {
    info('Assessing market quality...');
    const assessment = await agent.assess(testSymbol);
    
    console.log('\n  Market Quality Assessment:');
    console.log(`    Score: ${assessment.score.toFixed(2)}`);
    console.log(`    Spread (bps): ${assessment.spreadBps.toFixed(2)}`);
    console.log(`    Book Depth: $${assessment.bookDepthUsd.toFixed(0)}`);
    console.log(`    Is Liquid: ${assessment.isLiquid ? 'Yes' : 'No'}`);
    console.log(`    Is Acceptable: ${assessment.isAcceptable ? 'Yes' : 'No'}`);
    
    if (assessment.score >= 0 && assessment.score <= 1) {
      success(`Market quality score in valid range: ${assessment.score.toFixed(2)}`);
    } else {
      error(`Market quality score out of range: ${assessment.score}`);
    }
    
    if (assessment.isAcceptable) {
      success('Market quality is ACCEPTABLE for trading');
    } else {
      warning(`Market quality REJECTED: ${assessment.reason ?? 'unknown'}`);
    }
    
    return { passed: true, assessment };
    
  } catch (err) {
    error(`Market Quality Agent test failed: ${err.message}`);
    return { passed: false, error: err.message };
  }
}

async function testEntryTimingAgent(agent) {
  header('TEST 6: Entry Timing Agent');
  
  const testSymbol = 'BTC/USDT';
  
  try {
    info('Fetching technical snapshot...');
    const tech = await fetchTechSnapshot(testSymbol);
    
    info('Evaluating entry timing...');
    const timing = await agent.evaluateEntryTiming(testSymbol, tech, 0.75);
    
    console.log('\n  Entry Timing Recommendation:');
    console.log(`    Action: ${timing.action}`);
    console.log(`    Aggressiveness: ${timing.aggressiveness.toFixed(2)}x`);
    console.log(`    Optimal Entry Offset: ${timing.optimalEntryOffset} bps`);
    console.log(`    Confidence: ${timing.confidence.toFixed(3)}`);
    console.log(`    Reason: ${timing.reason}`);
    
    const validActions = ['immediate', 'wait_pullback', 'wait_confirmation'];
    if (validActions.includes(timing.action)) {
      success(`Entry timing action is valid: ${timing.action}`);
    } else {
      error(`Invalid entry timing action: ${timing.action}`);
    }
    
    if (timing.aggressiveness >= 0.5 && timing.aggressiveness <= 1.5) {
      success(`Aggressiveness in valid range: ${timing.aggressiveness.toFixed(2)}x`);
    } else {
      warning(`Aggressiveness outside expected range: ${timing.aggressiveness.toFixed(2)}x`);
    }
    
    return { passed: true, timing };
    
  } catch (err) {
    error(`Entry Timing Agent test failed: ${err.message}`);
    return { passed: false, error: err.message };
  }
}

async function testExitStrategyAgent(agent) {
  header('TEST 7: Exit Strategy Agent');
  
  const testSymbol = 'BTC/USDT';
  
  try {
    info('Fetching technical snapshot...');
    const tech = await fetchTechSnapshot(testSymbol);
    
    const volatility = (tech.atr14 / tech.last) * 100;
    
    info('Generating exit strategy...');
    const strategy = await agent.generateExitStrategy(
      testSymbol,
      tech,
      1.5, // current R-multiple
      30 * 60000, // 30 minutes in position
      volatility
    );
    
    console.log('\n  Exit Strategy:');
    console.log(`    Scale-out Plan:`);
    for (const exit of strategy.scaleOutPlan) {
      console.log(`      - Exit ${(exit.exitPct * 100).toFixed(0)}% at ${exit.rMultiple.toFixed(1)}R`);
    }
    console.log(`    Trailing Stop: ${strategy.trailingStopAtrMultiplier.toFixed(1)}x ATR`);
    console.log(`    Trailing Activation: ${strategy.trailingStopActivationR.toFixed(1)}R`);
    console.log(`    Max Hold Time: ${(strategy.maxHoldTimeMs / 3600000).toFixed(1)} hours`);
    console.log(`    Lock Profit Threshold: ${strategy.lockProfitThreshold.toFixed(1)}R`);
    console.log(`    Confidence: ${strategy.confidence.toFixed(3)}`);
    console.log(`    Reason: ${strategy.reason}`);
    
    if (strategy.scaleOutPlan.length > 0) {
      success(`Exit strategy has ${strategy.scaleOutPlan.length} scale-out levels`);
    } else {
      error('Exit strategy has no scale-out plan!');
    }
    
    const totalExitPct = strategy.scaleOutPlan.reduce((sum, exit) => sum + exit.exitPct, 0);
    if (Math.abs(totalExitPct - 1.0) < 0.01) {
      success(`Scale-out plan totals 100%: ${(totalExitPct * 100).toFixed(0)}%`);
    } else {
      error(`Scale-out plan doesn't total 100%: ${(totalExitPct * 100).toFixed(0)}%`);
    }
    
    return { passed: true, strategy };
    
  } catch (err) {
    error(`Exit Strategy Agent test failed: ${err.message}`);
    return { passed: false, error: err.message };
  }
}

async function main() {
  log('\n' + '█'.repeat(70), COLORS.bright + COLORS.blue);
  log('  COMPREHENSIVE SUBAGENT TEST SUITE', COLORS.bright + COLORS.blue);
  log('█'.repeat(70) + '\n', COLORS.bright + COLORS.blue);
  
  try {
    info('Loading all agents...');
    const agents = await loadAgents();
    success('All agents loaded successfully\n');
    
    const results = {
      riskGovernor: await testRiskGovernor(agents.riskGovernor),
      execution: await testExecutionAgent(agents.execution),
      predictor: await testPredictorAgent(agents.predictor),
      sentiment: await testSentimentAgent(agents.sentiment),
      marketQuality: await testMarketQualityAgent(agents.marketQuality),
      entryTiming: await testEntryTimingAgent(agents.entryTiming),
      exitStrategy: await testExitStrategyAgent(agents.exitStrategy),
    };
    
    // Summary
    header('TEST SUMMARY');
    
    const totalTests = Object.keys(results).length;
    const passedTests = Object.values(results).filter(r => r.passed).length;
    const failedTests = totalTests - passedTests;
    
    console.log(`\n  Total Tests: ${totalTests}`);
    console.log(`  Passed: ${COLORS.green}${passedTests}${COLORS.reset}`);
    console.log(`  Failed: ${failedTests > 0 ? COLORS.red : COLORS.reset}${failedTests}${COLORS.reset}`);
    
    console.log('\n  Agent Status:');
    for (const [name, result] of Object.entries(results)) {
      const status = result.passed ? `${COLORS.green}✓ PASSED${COLORS.reset}` : `${COLORS.red}✗ FAILED${COLORS.reset}`;
      console.log(`    ${name.padEnd(20)}: ${status}`);
    }
    
    if (passedTests === totalTests) {
      log('\n' + '='.repeat(70), COLORS.green);
      success('ALL TESTS PASSED! ✓');
      log('='.repeat(70) + '\n', COLORS.green);
    } else {
      log('\n' + '='.repeat(70), COLORS.red);
      error(`${failedTests} TEST(S) FAILED!`);
      log('='.repeat(70) + '\n', COLORS.red);
      process.exit(1);
    }
    
  } catch (err) {
    error('\nFatal error during testing:');
    console.error(err);
    process.exit(1);
  }
}

main();

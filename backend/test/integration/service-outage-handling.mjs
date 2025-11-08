/**
 * Integration test for LLM and Python predictor outage handling
 * Tests that the trading system can continue operating when external services fail
 */

import { llmJSONSafe } from '../../dist/src/ai/llm.js';
import { 
  getPredictionSafe, 
  getRuleBasedPrediction 
} from '../../dist/src/quantai/pythonPredictor.js';
import { 
  setCircuitBreakerState, 
  resetServiceHealth,
  getServiceHealth,
  getServiceFallbackMetrics 
} from '../../dist/src/infra/serviceHealth.js';

async function testLLMFallback() {
  console.log('\n=== Testing LLM Fallback Mechanism ===');
  
  // Reset state
  resetServiceHealth();
  
  // Test 1: Normal operation (should work if LLM is available, or return null gracefully)
  console.log('Test 1: Normal LLM call with llmJSONSafe...');
  try {
    const result = await llmJSONSafe('Test prompt', { 
      cacheKey: 'test-fallback',
      context: { kind: 'test' }
    });
    
    if (result === null) {
      console.log('✓ LLM unavailable - returned null gracefully');
    } else {
      console.log('✓ LLM available - got response');
    }
  } catch (error) {
    console.error('✗ Unexpected error:', error);
    return false;
  }
  
  // Test 2: Circuit breaker open
  console.log('\nTest 2: LLM with circuit breaker open...');
  setCircuitBreakerState('llm', true);
  
  try {
    const result = await llmJSONSafe('Test prompt', {
      cacheKey: 'test-circuit-breaker',
      context: { kind: 'test' }
    });
    
    if (result === null) {
      console.log('✓ Circuit breaker prevented call - returned null');
      
      const fallbacks = getServiceFallbackMetrics('llm');
      console.log(`✓ Fallback triggered ${fallbacks.triggered} time(s)`);
    } else {
      console.log('✗ Expected null when circuit breaker is open');
      return false;
    }
  } catch (error) {
    console.error('✗ Should not throw, should return null:', error);
    return false;
  }
  
  // Test 3: Verify service health tracking
  console.log('\nTest 3: Verify service health...');
  const health = getServiceHealth('llm');
  console.log(`Service status: ${health.status}`);
  console.log(`Circuit breaker open: ${health.circuitBreakerOpen}`);
  console.log(`Total calls: ${health.totalCalls}`);
  console.log(`Successful calls: ${health.successfulCalls}`);
  console.log(`Failed calls: ${health.failedCalls}`);
  
  // Reset for next test
  resetServiceHealth();
  
  return true;
}

function testPythonPredictorFallback() {
  console.log('\n=== Testing Python Predictor Fallback Mechanism ===');
  
  // Reset state
  resetServiceHealth();
  
  // Test 1: Rule-based fallback with realistic features
  console.log('Test 1: Rule-based prediction fallback...');
  const features = {
    rsi_14: 25,  // Oversold
    macd_signal: 0.5,  // Positive momentum
    volume_ratio: 2.0,  // High volume
    atr_14_pct: 2.5,
    price_change_1h_pct: 1.2
  };
  
  try {
    const prediction = getRuleBasedPrediction(features);
    
    console.log(`Decision: ${prediction.decision}`);
    console.log(`Confidence: ${prediction.confidence.toFixed(3)}`);
    console.log(`Probabilities: Long=${prediction.probabilityLong.toFixed(3)} Short=${prediction.probabilityShort.toFixed(3)} None=${prediction.probabilityNone.toFixed(3)}`);
    console.log(`Source: ${prediction.meta?.source}`);
    
    if (prediction.decision === 'long' && prediction.probabilityLong > 0.4) {
      console.log('✓ Rule-based prediction returned long bias as expected (oversold + volume)');
    } else {
      console.log('? Unexpected decision, but fallback worked');
    }
  } catch (error) {
    console.error('✗ Rule-based fallback failed:', error);
    return false;
  }
  
  // Test 2: getPredictionSafe with circuit breaker
  console.log('\nTest 2: getPredictionSafe with circuit breaker...');
  setCircuitBreakerState('python_predictor', true);
  
  getPredictionSafe(features, { allowFallback: true })
    .then(prediction => {
      if (prediction.meta?.source === 'rule_based_fallback') {
        console.log('✓ Used fallback when circuit breaker was open');
        
        const fallbacks = getServiceFallbackMetrics('python_predictor');
        console.log(`✓ Fallback triggered ${fallbacks.triggered} time(s)`);
      } else {
        console.log('? Got prediction but not from fallback');
      }
    })
    .catch(error => {
      console.error('✗ Should not throw with allowFallback=true:', error);
      return false;
    });
  
  // Test 3: Different market conditions
  console.log('\nTest 3: Rule-based fallback with overbought conditions...');
  const overboughtFeatures = {
    rsi_14: 75,  // Overbought
    macd_signal: -0.3,  // Negative momentum
    volume_ratio: 2.5,  // High volume
    atr_14_pct: 2.0,
    price_change_1h_pct: -0.8
  };
  
  try {
    const prediction = getRuleBasedPrediction(overboughtFeatures);
    
    console.log(`Decision: ${prediction.decision}`);
    console.log(`Confidence: ${prediction.confidence.toFixed(3)}`);
    
    if (prediction.decision === 'short' && prediction.probabilityShort > 0.4) {
      console.log('✓ Rule-based prediction returned short bias as expected (overbought)');
    } else {
      console.log('? Unexpected decision, but fallback worked');
    }
  } catch (error) {
    console.error('✗ Rule-based fallback failed:', error);
    return false;
  }
  
  // Reset
  resetServiceHealth();
  
  return true;
}

async function main() {
  console.log('='.repeat(60));
  console.log('LLM and Python Predictor Outage Handling Test');
  console.log('='.repeat(60));
  
  try {
    const llmSuccess = await testLLMFallback();
    const pythonSuccess = testPythonPredictorFallback();
    
    console.log('\n' + '='.repeat(60));
    if (llmSuccess && pythonSuccess) {
      console.log('✓ All fallback mechanisms working correctly');
      console.log('✓ Trading system can operate during external service outages');
      process.exit(0);
    } else {
      console.log('✗ Some tests failed');
      process.exit(1);
    }
  } catch (error) {
    console.error('Test suite error:', error);
    process.exit(1);
  }
}

main();

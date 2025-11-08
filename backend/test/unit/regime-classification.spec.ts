/**
 * Regime Classification Unit Tests
 * 
 * Tests the core logic of regime classification functions
 */

import assert from 'node:assert/strict';
import {
  classifyVolatilityRegime,
  classifyDirectionBias,
  classifyVolumeRegime,
  classifyTrendingRanging,
  type VolatilityRegime,
  type DirectionBias,
  type VolumeRegime,
  type TrendingRanging,
} from '../../src/learning/personalityProfile.js';

// Test classifyVolatilityRegime
console.log('\n🧪 Testing classifyVolatilityRegime...');

// Low volatility (< 3%)
assert.equal(classifyVolatilityRegime(1.5), 'low', 'ATR 1.5% should be low volatility');
assert.equal(classifyVolatilityRegime(2.9), 'low', 'ATR 2.9% should be low volatility');

// Medium volatility (3-6%)
assert.equal(classifyVolatilityRegime(3.0), 'medium', 'ATR 3.0% should be medium volatility');
assert.equal(classifyVolatilityRegime(4.5), 'medium', 'ATR 4.5% should be medium volatility');
assert.equal(classifyVolatilityRegime(6.0), 'medium', 'ATR 6.0% should be medium volatility');

// High volatility (> 6%)
assert.equal(classifyVolatilityRegime(6.1), 'high', 'ATR 6.1% should be high volatility');
assert.equal(classifyVolatilityRegime(10.0), 'high', 'ATR 10.0% should be high volatility');

// Edge cases
assert.equal(classifyVolatilityRegime(undefined), 'medium', 'undefined ATR should default to medium');
assert.equal(classifyVolatilityRegime(NaN), 'medium', 'NaN ATR should default to medium');

console.log('✅ classifyVolatilityRegime tests passed');

// Test classifyDirectionBias
console.log('\n🧪 Testing classifyDirectionBias...');

// Long bias (EMA20 > EMA50 * 1.001)
assert.equal(classifyDirectionBias(50000, 49000), 'long', 'EMA20 > EMA50 should be long bias');
assert.equal(classifyDirectionBias(50100, 50000), 'long', 'EMA20 > EMA50 * 1.001 should be long bias');

// Short bias (EMA20 < EMA50 * 0.999)
assert.equal(classifyDirectionBias(49000, 50000), 'short', 'EMA20 < EMA50 should be short bias');
assert.equal(classifyDirectionBias(49900, 50000), 'short', 'EMA20 < EMA50 * 0.999 should be short bias');

// Neutral (within 0.1% buffer)
assert.equal(classifyDirectionBias(50000, 50000), 'neutral', 'Equal EMAs should be neutral');
assert.equal(classifyDirectionBias(50025, 50000), 'neutral', 'Within 0.1% buffer should be neutral');
assert.equal(classifyDirectionBias(49975, 50000), 'neutral', 'Within 0.1% buffer should be neutral');

// Edge cases
assert.equal(classifyDirectionBias(undefined, 50000), 'neutral', 'undefined EMA20 should be neutral');
assert.equal(classifyDirectionBias(50000, undefined), 'neutral', 'undefined EMA50 should be neutral');
assert.equal(classifyDirectionBias(NaN, 50000), 'neutral', 'NaN EMA20 should be neutral');

console.log('✅ classifyDirectionBias tests passed');

// Test classifyVolumeRegime
console.log('\n🧪 Testing classifyVolumeRegime...');

// Using Z-score (preferred method)
assert.equal(classifyVolumeRegime(undefined, undefined, -1.0), 'low', 'Z-score -1.0 should be low volume');
assert.equal(classifyVolumeRegime(undefined, undefined, -0.6), 'low', 'Z-score -0.6 should be low volume');
assert.equal(classifyVolumeRegime(undefined, undefined, 0.0), 'normal', 'Z-score 0.0 should be normal volume');
assert.equal(classifyVolumeRegime(undefined, undefined, 0.3), 'normal', 'Z-score 0.3 should be normal volume');
assert.equal(classifyVolumeRegime(undefined, undefined, 0.6), 'high', 'Z-score 0.6 should be high volume');
assert.equal(classifyVolumeRegime(undefined, undefined, 1.5), 'high', 'Z-score 1.5 should be high volume');

// Using volume ratio (fallback)
assert.equal(classifyVolumeRegime(6500, 10000, undefined), 'low', 'Ratio 0.65 should be low volume');
assert.equal(classifyVolumeRegime(6000, 10000, undefined), 'low', 'Ratio 0.6 should be low volume');
assert.equal(classifyVolumeRegime(10000, 10000, undefined), 'normal', 'Ratio 1.0 should be normal volume');
assert.equal(classifyVolumeRegime(9000, 10000, undefined), 'normal', 'Ratio 0.9 should be normal volume');
assert.equal(classifyVolumeRegime(14000, 10000, undefined), 'high', 'Ratio 1.4 should be high volume');
assert.equal(classifyVolumeRegime(15000, 10000, undefined), 'high', 'Ratio 1.5 should be high volume');

// Edge cases
assert.equal(classifyVolumeRegime(undefined, undefined, undefined), 'normal', 'All undefined should default to normal');
assert.equal(classifyVolumeRegime(10000, undefined, undefined), 'normal', 'Missing volumeMA should default to normal');
assert.equal(classifyVolumeRegime(10000, 0, undefined), 'normal', 'Zero volumeMA should default to normal');

console.log('✅ classifyVolumeRegime tests passed');

// Test classifyTrendingRanging
console.log('\n🧪 Testing classifyTrendingRanging...');

// Clear trending (ADX > 25)
assert.equal(classifyTrendingRanging(26, undefined), 'trending', 'ADX 26 should be trending');
assert.equal(classifyTrendingRanging(30, undefined), 'trending', 'ADX 30 should be trending');
assert.equal(classifyTrendingRanging(40, 2.0), 'trending', 'ADX 40 should be trending regardless of ATR');

// Clear ranging (ADX < 20)
assert.equal(classifyTrendingRanging(15, undefined), 'ranging', 'ADX 15 should be ranging');
assert.equal(classifyTrendingRanging(19, undefined), 'ranging', 'ADX 19 should be ranging');
assert.equal(classifyTrendingRanging(10, 8.0), 'ranging', 'ADX 10 should be ranging regardless of ATR');

// Transitional zone (20-25): uses ATR as tiebreaker
assert.equal(classifyTrendingRanging(22, 5.0), 'trending', 'ADX 22 with high ATR 5.0% should be trending');
assert.equal(classifyTrendingRanging(22, 3.0), 'ranging', 'ADX 22 with low ATR 3.0% should be ranging');
assert.equal(classifyTrendingRanging(23, undefined), 'ranging', 'ADX 23 without ATR should default to ranging');

// Fallback to ATR when no ADX
assert.equal(classifyTrendingRanging(undefined, 5.0), 'trending', 'High ATR 5.0% without ADX should be trending');
assert.equal(classifyTrendingRanging(undefined, 3.0), 'ranging', 'Low ATR 3.0% without ADX should be ranging');

// Edge cases
assert.equal(classifyTrendingRanging(undefined, undefined), 'ranging', 'All undefined should default to ranging');
assert.equal(classifyTrendingRanging(NaN, undefined), 'ranging', 'NaN ADX should default to ranging');

console.log('✅ classifyTrendingRanging tests passed');

// Test interaction scenarios
console.log('\n🧪 Testing regime interaction scenarios...');

// Scenario 1: High volatility + trending + high volume + long bias
const scenario1 = {
  volatility: classifyVolatilityRegime(7.5), // high
  direction: classifyDirectionBias(52000, 50000), // long
  volume: classifyVolumeRegime(undefined, undefined, 1.2), // high
  trending: classifyTrendingRanging(30, 7.5), // trending
};
assert.equal(scenario1.volatility, 'high', 'Scenario 1: High volatility');
assert.equal(scenario1.direction, 'long', 'Scenario 1: Long direction');
assert.equal(scenario1.volume, 'high', 'Scenario 1: High volume');
assert.equal(scenario1.trending, 'trending', 'Scenario 1: Trending market');
console.log('✅ Scenario 1 (aggressive bullish momentum): All regimes classified correctly');

// Scenario 2: Low volatility + ranging + normal volume + neutral bias
const scenario2 = {
  volatility: classifyVolatilityRegime(2.0), // low
  direction: classifyDirectionBias(50000, 50050), // neutral
  volume: classifyVolumeRegime(undefined, undefined, 0.1), // normal
  trending: classifyTrendingRanging(15, 2.0), // ranging
};
assert.equal(scenario2.volatility, 'low', 'Scenario 2: Low volatility');
assert.equal(scenario2.direction, 'neutral', 'Scenario 2: Neutral direction');
assert.equal(scenario2.volume, 'normal', 'Scenario 2: Normal volume');
assert.equal(scenario2.trending, 'ranging', 'Scenario 2: Ranging market');
console.log('✅ Scenario 2 (quiet choppy market): All regimes classified correctly');

// Scenario 3: Medium volatility + trending + low volume + short bias
const scenario3 = {
  volatility: classifyVolatilityRegime(4.5), // medium
  direction: classifyDirectionBias(48000, 50000), // short
  volume: classifyVolumeRegime(undefined, undefined, -0.8), // low
  trending: classifyTrendingRanging(28, 4.5), // trending
};
assert.equal(scenario3.volatility, 'medium', 'Scenario 3: Medium volatility');
assert.equal(scenario3.direction, 'short', 'Scenario 3: Short direction');
assert.equal(scenario3.volume, 'low', 'Scenario 3: Low volume');
assert.equal(scenario3.trending, 'trending', 'Scenario 3: Trending market');
console.log('✅ Scenario 3 (bearish trend with thin liquidity): All regimes classified correctly');

console.log('\n✅ All regime classification tests passed!');
console.log('📊 Tested 4 classification functions with edge cases and interaction scenarios');

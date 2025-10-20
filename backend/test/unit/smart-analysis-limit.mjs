import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';

const { resolveSmartAnalysisLimit } = await import('../../dist/src/services/agentCreationFlow.js');

assert.equal(resolveSmartAnalysisLimit(undefined), 25, 'default limit should use fallback');
assert.equal(resolveSmartAnalysisLimit('18'), 18, 'numeric env string should be parsed');
assert.equal(resolveSmartAnalysisLimit('2'), 5, 'limit should enforce minimum floor');
assert.equal(resolveSmartAnalysisLimit(100), 60, 'limit should clamp to maximum cap');
assert.equal(resolveSmartAnalysisLimit('abc'), 25, 'invalid values should revert to fallback');

console.log('✅ smart-analysis-limit.mjs passed');

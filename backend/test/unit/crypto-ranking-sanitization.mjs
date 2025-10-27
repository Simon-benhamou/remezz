import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';

const { sanitizeBaseSymbol } = await import('../../dist/src/ai/cryptoRanking.js');

assert.equal(sanitizeBaseSymbol('ETH'), 'ETH', 'ETH should remain unchanged');
assert.equal(sanitizeBaseSymbol('btc'), 'BTC', 'lowercase symbols should be uppercased');
assert.equal(sanitizeBaseSymbol('1000BONK'), '1000BONK', 'alphanumeric tokens should be preserved');
assert.equal(sanitizeBaseSymbol('1inch'), '1INCH', 'mixed-case tokens should normalize');
assert.equal(sanitizeBaseSymbol('币安人生'), null, 'non-latin symbols should be rejected');
assert.equal(sanitizeBaseSymbol('H'), null, 'single-character bases should be rejected');
assert.equal(sanitizeBaseSymbol('1234'), null, 'purely numeric bases should be rejected');

console.log('crypto-ranking-sanitization ✅');

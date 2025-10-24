import assert from 'node:assert/strict';

const { createKlineShardQueueTestHarness } = await import('../../dist/src/services/binanceWebSocket.js');

const harness = createKlineShardQueueTestHarness();
const { shard, flush, attempts, sent, emitOpen } = harness;

shard.setStreams(['btcusdt@kline_1m']);

await flush();
await flush();

assert.equal(attempts().length, 0, 'expected no subscription send while socket is connecting');

emitOpen();

await flush();
await flush();

const attemptCount = attempts().length;
assert.equal(attemptCount, 1, 'expected exactly one subscription send after socket opens');

const messages = sent();
assert.equal(messages.length, 1, 'expected a single subscription payload to be sent');
const [payload] = messages;
assert.equal(payload.method, 'SUBSCRIBE');
assert.deepEqual(payload.params, ['btcusdt@kline_1m']);

console.log('ws-subscription-queue ✅');

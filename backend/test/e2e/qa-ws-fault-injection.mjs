#!/usr/bin/env node
import 'dotenv/config';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer, WebSocket } from 'ws';

// Ensure the WebSocket hub runs in a deterministic, in-memory environment.
process.env.UNIT_TEST_MODE = 'true';
process.env.REQUIRE_API_KEY = process.env.REQUIRE_API_KEY ?? 'false';
process.env.APP_API_KEY = process.env.APP_API_KEY ?? 'qa-ws-fault-test';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'qa-ws-fault-secret';
process.env.WS_JWT_SECRET = process.env.WS_JWT_SECRET ?? process.env.JWT_SECRET;
process.env.WS_JWT_TTL_SEC = process.env.WS_JWT_TTL_SEC ?? '120';

const { register } = await import('tsx/esm/api');
register();

let startWSHub;
try {
  ({ startWSHub } = await import('../../src/ws/hub.ts'));
} catch (tsErr) {
  try {
    ({ startWSHub } = await import('../../dist/src/ws/hub.js'));
  } catch (distErr) {
    throw tsErr;
  }
}

console.log('🧪 QA WebSocket fault injection scenario');
console.log('   → booting in-memory WebSocket hub...');

const wss = new WebSocketServer({ port: 0 });
startWSHub(wss);

let client;

try {
  await once(wss, 'listening');
  const address = wss.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  assert.ok(port, 'WebSocket test server did not start');

  const url = `ws://127.0.0.1:${port}`;
  console.log(`   → connecting test client on ${url}`);

  client = new WebSocket(url);
  await once(client, 'open');

  client.send(JSON.stringify({ type: 'hello' }));
  const [rawHello] = await once(client, 'message');
  const helloMsg = JSON.parse(rawHello.toString());
  assert.equal(helloMsg.type, 'hello_ok', 'Expected hello_ok acknowledgement');
  console.log('   ✅ handshake completed without requiring API key');

  assert.equal(wss.clients.size, 1, 'Exactly one client should be connected');

  console.log('   → injecting simulated network fault (server terminate)');
  const [serverSocket] = Array.from(wss.clients.values());
  assert.ok(serverSocket, 'Server connection missing before fault injection');
  serverSocket.terminate();

  await once(client, 'close');
  await delay(50);

  assert.equal(wss.clients.size, 0, 'Client set should be empty after termination');
  console.log('   ✅ hub recovered from injected fault and cleaned up connection');

  client.removeAllListeners();
  client.close();

  console.log('\n✅ QA WebSocket fault injection scenario completed successfully');
  process.exit(0);
} catch (error) {
  console.error('\n❌ QA WebSocket fault injection scenario failed');
  console.error(error);
  process.exit(1);
} finally {
  try {
    if (client && client.readyState === WebSocket.OPEN) {
      client.close();
    }
    client?.removeAllListeners();
    wss.close();
  } catch (err) {
    console.warn('⚠️  Unable to close WebSocket server cleanly:', err);
  }
}

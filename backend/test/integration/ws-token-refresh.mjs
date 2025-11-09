import 'dotenv/config';
import http from 'http';

process.env.APP_API_KEY = 'integration-key';
process.env.REQUIRE_API_KEY = 'true';
process.env.WS_JWT_TTL_SEC = '1';
process.env.WS_JWT_SECRET = 'ws-test-secret';
process.env.JWT_SECRET = 'jwt-test-secret';

console.log('🧪 Verifying WS token refresh workflow...');

const express = (await import('express')).default;
const { router: authRouter } = await import('../../dist/src/routes/auth.js');
const { startWSHub } = await import('../../dist/src/ws/hub.js');
const wsLib = await import('ws');
const { WebSocket, WebSocketServer } = wsLib;

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
startWSHub(wss);

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

async function issueToken() {
  const res = await fetch(`${base}/api/auth/ws-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.APP_API_KEY ?? '',
    },
    body: JSON.stringify({ sessionId: 'session-test' }),
  });
  if (!res.ok) {
    throw new Error(`Token issuance failed with status ${res.status}`);
  }
  return res.json();
}

const initial = await issueToken();
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
const queue = [];
ws.on('message', (data) => {
  try { queue.push(JSON.parse(data.toString())); } catch {}
});

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('WS open timeout')), 3000);
  ws.on('open', () => {
    clearTimeout(timer);
    resolve(null);
  });
});

ws.send(JSON.stringify({ type: 'hello', token: initial.token }));

function waitFor(pred, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const check = () => {
      const idx = queue.findIndex(pred);
      if (idx >= 0) {
        const msg = queue.splice(idx, 1)[0];
        resolve(msg);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error('Timed out waiting for WS message.'));
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

const hello = await waitFor((m) => m.type === 'hello_ok');
const expiresAt = typeof hello?.expiresAt === 'string'
  ? new Date(hello.expiresAt).getTime()
  : typeof initial.expiresAt === 'string'
  ? new Date(initial.expiresAt).getTime()
  : Date.now() + 1000;
const waitMs = Math.max(0, expiresAt - Date.now() + 500);
await new Promise((resolve) => setTimeout(resolve, waitMs));

ws.send(JSON.stringify({ type: 'refresh', token: initial.token }));
const expired = await waitFor((m) => m.type === 'error' && m.code === 'ws.auth.expired');
if (!expired) throw new Error('Expected expired token error.');

const renewed = await issueToken();
ws.send(JSON.stringify({ type: 'refresh', token: renewed.token }));
await waitFor((m) => m.type === 'refresh_ok');

ws.send(JSON.stringify({ type: 'refresh', token: 'bad-token' }));
await waitFor((m) => m.type === 'error' && m.code === 'ws.auth.invalid');

console.log('✅ WS token refresh integration test passed.');

ws.close();
wss.close();
server.close();

process.exit(0);

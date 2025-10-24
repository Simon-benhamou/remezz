import assert from 'node:assert/strict';
import express from 'express';

const { router: capitalRouter } = await import('../../dist/src/routes/capital.js');
const { setPaperBalance } = await import('../../dist/src/services/capitalPool.js');

const app = express();
app.use(express.json());
app.use('/api/capital', capitalRouter);

const server = app.listen(0);
const address = server.address();
if (!address || typeof address === 'string') {
  throw new Error('Failed to bind test server');
}

const baseUrl = `http://127.0.0.1:${address.port}/api/capital`;

try {
  await setPaperBalance('1000');

  let res = await fetch(`${baseUrl}/paper/snapshot`);
  assert.equal(res.status, 200);
  let body: any = await res.json();
  assert.equal(Math.round(body.freeUSD), 1000);

  res = await fetch(`${baseUrl}/paper/set-balance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initialUSD: 1500 }),
  });
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(Math.round(body.freeUSD), 1500);

  res = await fetch(`${baseUrl}/paper/snapshot`);
  body = await res.json();
  assert.equal(Math.round(body.totalUSD), 1500);
  assert.equal(Math.round(body.freeUSD), 1500);

  res = await fetch(`${baseUrl}/live/snapshot`);
  body = await res.json();
  assert.equal(Math.round(body.totalUSD), 0);
  assert.equal(Math.round(body.freeUSD), 0);

  res = await fetch(`${baseUrl}/reservations`);
  body = await res.json();
  assert.ok(Array.isArray(body.paper));
  assert.ok(Array.isArray(body.live));

  res = await fetch(`${baseUrl}/expire`, { method: 'POST' });
  body = await res.json();
  assert.equal(body.ok, true);

  console.log('✅ capital.routes.spec passed');
} finally {
  server.close();
}

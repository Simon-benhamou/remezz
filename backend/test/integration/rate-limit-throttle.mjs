import 'dotenv/config';

process.env.API_RATE_LIMIT_AGENT_PER_IP = '2';
process.env.API_RATE_LIMIT_AGENT_PER_KEY = '5';
process.env.API_RATE_LIMIT_MONITOR_PER_IP = '5';
process.env.API_RATE_LIMIT_MONITOR_PER_KEY = '1';
process.env.API_RATE_LIMIT_AGENT_WINDOW_MS = '1000';
process.env.API_RATE_LIMIT_MONITOR_WINDOW_MS = '1000';
process.env.APP_API_KEY = 'integration-key';
process.env.REQUIRE_API_KEY = 'true';

console.log('🧪 Verifying REST rate limit enforcement...');

const express = (await import('express')).default;
const { createAgentRateLimiters, createMonitorRateLimiters } = await import('../../dist/src/middleware/rateLimit.js');

const app = express();
app.use(express.json());

const agentLimits = createAgentRateLimiters({ windowMs: 500, perIp: 2, perKey: 5 });
const monitorLimits = createMonitorRateLimiters({ windowMs: 500, perIp: 5, perKey: 1 });

app.use('/api/agent/test', ...agentLimits, (_req, res) => {
  res.json({ ok: true });
});

app.use('/api/monitor/test', ...monitorLimits, (_req, res) => {
  res.json({ ok: true });
});

const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.on('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

async function fetchJson(path) {
  const res = await fetch(`${base}${path}`, {
    headers: { 'x-api-key': process.env.APP_API_KEY ?? '' },
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

try {
  const a1 = await fetchJson('/api/agent/test');
  const a2 = await fetchJson('/api/agent/test');
  const a3 = await fetchJson('/api/agent/test');
  if (a1.status !== 200 || a2.status !== 200) {
    throw new Error(`Expected first two agent requests to pass, got ${a1.status}/${a2.status}`);
  }
  if (a3.status !== 429 || a3.data.code !== 'rate_limit.agent.ip') {
    throw new Error(`Expected agent IP throttle -> 429, got ${a3.status} with code ${a3.data.code}`);
  }

  const m1 = await fetchJson('/api/monitor/test');
  const m2 = await fetchJson('/api/monitor/test');
  if (m1.status !== 200) {
    throw new Error(`Expected first monitor request to pass, got ${m1.status}`);
  }
  if (m2.status !== 429 || m2.data.code !== 'rate_limit.monitor.key') {
    throw new Error(`Expected monitor key throttle -> 429, got ${m2.status} with code ${m2.data.code}`);
  }

  console.log('✅ REST rate limit integration test passed.');
} catch (err) {
  console.error('❌ REST rate limit integration test failed:', err);
  server.close();
  process.exit(1);
}

server.close();

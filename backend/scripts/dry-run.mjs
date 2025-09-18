#!/usr/bin/env node
// Simple dry-run orchestrator for paper sessions
// Usage: node backend/scripts/dry-run.mjs --symbols BTC/USDT,ETH/USDT,SOL/USDT --minutes 30 --api http://localhost:4000

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.findIndex(a => a === `--${name}`);
  if (i >= 0 && args[i+1]) return args[i+1];
  const kv = args.find(a => a.startsWith(`--${name}=`));
  if (kv) return kv.split('=')[1];
  return def;
};

const API = getArg('api', process.env.API_BASE || 'http://localhost:4000');
const symbols = (getArg('symbols', 'BTC/USDT,ETH/USDT,SOL/USDT') || '').split(',').map(s => s.trim()).filter(Boolean);
const minutes = Number(getArg('minutes', '30'));
const budgetPct = Number(getArg('budget', '100'));
const riskPct = Number(getArg('risk', '1.5'));
const maxLev = Number(getArg('lev', '4'));

async function http(path, opts = {}) {
  const url = `${API}${path}`;
  const r = await fetch(url, {
    method: 'GET',
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    },
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${path}`);
  return await r.json();
}

async function post(path, body) {
  return http(path, { method: 'POST', body: JSON.stringify(body) });
}

function ts() { return new Date().toISOString().replace(/[:.]/g,'-'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const log = [];
  const out = { startedAt: new Date().toISOString(), api: API, symbols, minutes, sessions: [], events: [], improvements: [] };
  console.log(`[dry-run] Starting paper sessions for: ${symbols.join(', ')} (duration ${minutes} min)`);

  // Start sessions
  for (const symbol of symbols) {
    try {
      const s = await post('/api/agent/start', { symbol, mode: 'paper', riskPerTradePct: riskPct, maxLeverage: maxLev, dailyLossLimitPct: 3.5, budgetPct });
      out.sessions.push({ symbol, id: s.id, startedAt: s.startedAt });
      console.log(`[dry-run] Started ${symbol} session=${s.id}`);
      // gentle spacing to avoid concurrent LLM bursts on activation
      await sleep(1000);
    } catch (e) {
      console.error(`[dry-run] Failed to start ${symbol}:`, e.message || e);
    }
  }

  const endAt = Date.now() + minutes * 60_000;
  while (Date.now() < endAt) {
    try {
      const events = await http('/api/ops/events?limit=200');
      out.events = events;
    } catch {}
    try {
      const items = await http('/api/improvements');
      out.improvements = items;
    } catch {}
    process.stdout.write('.');
    await sleep(10_000);
  }
  console.log(`\n[dry-run] Stopping sessions…`);

  for (const s of out.sessions) {
    try { await post('/api/agent/stop', { sessionId: s.id, closePosition: true }); console.log(`[dry-run] Stopped ${s.symbol} (${s.id})`); } catch {}
  }

  const file = `dry-run-${ts()}.json`;
  try {
    const fs = await import('fs');
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(`[dry-run] Report saved to ${file}`);
  } catch (e) {
    console.log('[dry-run] Failed to write report:', e.message || e);
  }
})();


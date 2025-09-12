import type { WebSocketServer, WebSocket } from 'ws';
import { prisma } from '../db/client.js';
import { getConfig } from '../utils/env.js';
import { buildTechSnapshot } from '../ai/tech.js';
import { fullAnalysis } from '../ai/analysis.js';
import { requestStrategy } from '../ai/strategyManager.js';
import { setActiveSession } from '../metrics/aiCalls.js';

type ClientState = {
  ws: WebSocket;
  authed: boolean;
  symbol?: string;
  sessionId?: string;
};

const clients = new Set<ClientState>();

function send(ws: WebSocket, msg: any) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

export function broadcast(type: string, payload: any, symbol?: string, sessionId?: string) {
  for (const c of clients) {
    if (!c.authed) continue;
    if (sessionId && c.sessionId && c.sessionId !== sessionId) continue;
    if (symbol && c.symbol && c.symbol !== symbol) continue;
    send(c.ws, { type, symbol, sessionId, data: payload });
  }
}

export function startWSHub(wss: WebSocketServer) {
  const cfg = getConfig();

  // Heartbeat ping/pong to clean up dead connections
  const HEARTBEAT_MS = 30_000;
  const hb = setInterval(() => {
    try {
      // @ts-ignore
      const all = (wss as any).clients as Set<WebSocket>;
      for (const ws of all) {
        // @ts-ignore
        if (!(ws as any).isAlive) {
          try { ws.terminate(); } catch {}
          continue;
        }
        // @ts-ignore
        (ws as any).isAlive = false;
        try { ws.ping(); } catch {}
      }
    } catch {}
  }, HEARTBEAT_MS);

  wss.on('connection', (ws) => {
    const state: ClientState = { ws, authed: !cfg.REQUIRE_API_KEY };
    clients.add(state);

    // mark alive on connect and on pong
    // @ts-ignore
    (ws as any).isAlive = true;
    ws.on('pong', () => { try { /* @ts-ignore */ (ws as any).isAlive = true; } catch {} });

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'hello') {
          const ok = !cfg.REQUIRE_API_KEY || msg.apiKey === cfg.APP_API_KEY;
          state.authed = ok;
          send(ws, { type: ok ? 'hello_ok' : 'hello_ko' });
          if (!ok) { try { ws.close(); } catch {} }
          return;
        }

        if (!state.authed) {
          try { send(ws, { type: 'error', data: 'unauthorized' }); } catch {}
          try { ws.close(); } catch {}
          return;
        }

        if (msg.type === 'sub') {
          state.symbol = msg.symbol;
          state.sessionId = msg.sessionId;
          try { if (state.sessionId) await setActiveSession(state.sessionId); } catch {}
          send(ws, { type: 'sub_ok', symbol: state.symbol, sessionId: state.sessionId, data: { symbol: state.symbol, sessionId: state.sessionId } });
          // Push analysis immediately so UI can fill tabs
          try {
            const a = await fullAnalysis(state.symbol!);
            send(ws, { type: 'analysis', symbol: state.symbol, sessionId: state.sessionId, data: a });
          } catch {
            try {
              const snap = await buildTechSnapshot(state.symbol!);
              send(ws, { type: 'analysis', symbol: state.symbol, sessionId: state.sessionId, data: { symbol: state.symbol, technical: snap } });
            } catch {}
          }
          return;
        }

        // Optional: change active session symbol via WS
        if (msg.type === 'set_symbol') {
          const { sessionId, symbol } = msg;
          if (!sessionId) return send(ws, { type: 'error', data: 'sessionId_required' });
          const s = await prisma.agentSession.findUnique({ where: { id: sessionId } });
          if (!s) return send(ws, { type: 'error', data: 'no_session' });
          const upd = await prisma.agentSession.update({ where: { id: s.id }, data: { symbol } });
          state.symbol = upd.symbol; state.sessionId = upd.id;
          broadcast('session', upd, upd.symbol, upd.id);
          return;
        }

        // Request instantaneous snapshot push (without REST)
        if (msg.type === 'fetch_now') {
          const symbol = state.symbol || cfg.SYMBOL;
          try {
            const snap = await buildTechSnapshot(symbol);
            send(ws, { type: 'analysis', symbol: state.symbol, sessionId: state.sessionId, data: { symbol, technical: snap } });
          } catch {}
          return;
        }

        // Example: request a new classic strategy via WS
        if (msg.type === 'gen_strategy') {
          const symbol = msg.symbol || state.symbol || cfg.SYMBOL;
          const { strategy: strat, levels: lvls } = await requestStrategy({ symbol, trigger: msg.trigger || 'manual', sessionId: state.sessionId });
          broadcast('strategy', { ...(strat as any), levels: lvls }, symbol, state.sessionId);
          return;
        }

      } catch (e) {
        send(ws, { type: 'error', data: String((e as any)?.message || e) });
      }
    });

    ws.on('close', () => { clients.delete(state); });
  });

  // Ensure timer is cleared on server close
  // @ts-ignore
  wss.on('close', () => { try { clearInterval(hb); } catch {} });
}

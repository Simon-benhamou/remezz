import type { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { prisma } from '../db/client.js';
import { getConfig } from '../utils/env.js';
import { buildTechSnapshot } from '../ai/tech.js';
import { fullAnalysis } from '../ai/analysis.js';
import { requestStrategy } from '../ai/strategyManager.js';
import { setActiveSession } from '../metrics/aiCalls.js';
import { recordOpsEvent } from '../monitor/ops.js';

type ClientState = {
  ws: WebSocket;
  authed: boolean;
  symbol?: string;
  sessionId?: string;
  tokenExpiresAt?: number;
  identity?: string;
};

const clients = new Set<ClientState>();

function send(ws: WebSocket, msg: any) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function sendError(ws: WebSocket, code: string, message: string, details?: Record<string, any>) {
  send(ws, { type: 'error', code, message, details });
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
  const secret = cfg.WS_JWT_SECRET || cfg.JWT_SECRET || cfg.APP_API_KEY;

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
    if (!cfg.REQUIRE_API_KEY) {
      state.tokenExpiresAt = Number.MAX_SAFE_INTEGER;
    }
    clients.add(state);

    // mark alive on connect and on pong
    // @ts-ignore
    (ws as any).isAlive = true;
    ws.on('pong', () => { try { /* @ts-ignore */ (ws as any).isAlive = true; } catch {} });

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'hello') {
          if (!cfg.REQUIRE_API_KEY) {
            state.authed = true;
            send(ws, { type: 'hello_ok', expiresAt: null });
            return;
          }

          if (typeof msg.token !== 'string' || !msg.token.trim()) {
            sendError(ws, 'ws.auth.required', 'WebSocket token is required.');
            try { ws.close(); } catch {}
            return;
          }

          try {
            const payload = jwt.verify(msg.token, secret) as any;
            const expMs = payload?.exp ? payload.exp * 1000 : Date.now() + cfg.WS_JWT_TTL_SEC * 1000;
            state.authed = true;
            state.tokenExpiresAt = expMs;
            state.identity = payload?.sub || 'unknown';
            if (payload?.sessionId && typeof payload.sessionId === 'string') {
              state.sessionId = payload.sessionId;
            }
            send(ws, { type: 'hello_ok', expiresAt: new Date(expMs).toISOString() });
            recordOpsEvent({
              level: 'debug', // Changed from 'info' to reduce frontend noise
              source: 'ws_auth',
              message: 'ws_hello_ok',
              details: {
                identity: state.identity,
                sessionId: state.sessionId,
                expiresAt: new Date(expMs).toISOString(),
              },
            });
          } catch (err: any) {
            const expired = err?.name === 'TokenExpiredError';
            sendError(
              ws,
              expired ? 'ws.auth.expired' : 'ws.auth.invalid',
              expired ? 'WebSocket token has expired.' : 'WebSocket token is invalid.',
              expired && err?.expiredAt ? { expiredAt: err.expiredAt } : undefined,
            );
            recordOpsEvent({
              level: 'warn',
              source: 'ws_auth',
              message: expired ? 'ws_hello_expired' : 'ws_hello_invalid',
              details: { error: String(err?.message || err) },
            });
            try { ws.close(); } catch {}
          }
          return;
        }

        if (msg.type === 'refresh') {
          if (typeof msg.token !== 'string' || !msg.token.trim()) {
            sendError(ws, 'ws.auth.invalid', 'Refresh token missing.');
            return;
          }
          try {
            const payload = jwt.verify(msg.token, secret) as any;
            const expMs = payload?.exp ? payload.exp * 1000 : Date.now() + cfg.WS_JWT_TTL_SEC * 1000;
            state.authed = true;
            state.tokenExpiresAt = expMs;
            state.identity = payload?.sub || state.identity;
            if (payload?.sessionId && typeof payload.sessionId === 'string') {
              state.sessionId = payload.sessionId;
            }
            send(ws, { type: 'refresh_ok', expiresAt: new Date(expMs).toISOString() });
            recordOpsEvent({
              level: 'debug', // Changed from 'info' to reduce frontend noise
              source: 'ws_auth',
              message: 'ws_token_refreshed',
              details: {
                identity: state.identity,
                sessionId: state.sessionId,
                expiresAt: new Date(expMs).toISOString(),
              },
            });
          } catch (err: any) {
            const expired = err?.name === 'TokenExpiredError';
            sendError(
              ws,
              expired ? 'ws.auth.expired' : 'ws.auth.invalid',
              expired ? 'WebSocket refresh token expired.' : 'WebSocket refresh token invalid.',
              expired && err?.expiredAt ? { expiredAt: err.expiredAt } : undefined,
            );
            recordOpsEvent({
              level: 'warn',
              source: 'ws_auth',
              message: expired ? 'ws_refresh_expired' : 'ws_refresh_invalid',
              details: { error: String(err?.message || err) },
            });
          }
          return;
        }

        if (!state.authed) {
          sendError(ws, 'ws.auth.required', 'WebSocket authentication required.');
          try { ws.close(); } catch {}
          return;
        }

        if (state.tokenExpiresAt && Date.now() >= state.tokenExpiresAt) {
          state.authed = false;
          sendError(ws, 'ws.auth.expired', 'WebSocket token expired. Please refresh.', {
            expiresAt: new Date(state.tokenExpiresAt).toISOString(),
          });
          recordOpsEvent({
            level: 'warn',
            source: 'ws_auth',
            message: 'ws_token_expired',
            details: {
              identity: state.identity,
              sessionId: state.sessionId,
            },
          });
          return;
        }

        if (msg.type === 'sub') {
          const rawSymbol = typeof msg.symbol === 'string' ? msg.symbol.trim() : '';
          const normalizedSymbol = rawSymbol.length ? rawSymbol : undefined;
          const rawSessionId = typeof msg.sessionId === 'string' ? msg.sessionId.trim() : '';
          const normalizedSessionId = rawSessionId.length ? rawSessionId : undefined;

          state.symbol = normalizedSymbol;
          state.sessionId = normalizedSessionId;

          try { if (state.sessionId) await setActiveSession(state.sessionId); } catch {}

          send(ws, {
            type: 'sub_ok',
            symbol: state.symbol,
            sessionId: state.sessionId,
            data: { symbol: state.symbol, sessionId: state.sessionId },
          });

          if (!state.symbol) {
            return;
          }

          // Push analysis immediately so UI can fill tabs
          try {
            const a = await fullAnalysis(state.symbol);
            send(ws, { type: 'analysis', symbol: state.symbol, sessionId: state.sessionId, data: a });
          } catch {
            try {
              const snap = await buildTechSnapshot(state.symbol);
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

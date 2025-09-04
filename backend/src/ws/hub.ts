import type { WebSocketServer, WebSocket } from 'ws';
import { prisma } from '../db/client.js';
import { getConfig } from '../utils/env.js';
import { buildTechSnapshot } from '../ai/tech.js';
import { generateStrategy } from '../ai/orchestrator.js';
import { levels as calcLevels } from '../risk/brackets.js';

type ClientState = {
  ws: WebSocket;
  authed: boolean;
  symbol?: string;
};

const clients = new Set<ClientState>();

function send(ws: WebSocket, msg: any) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

export function broadcast(type: string, payload: any, symbol?: string) {
  for (const c of clients) {
    if (!c.authed) continue;
    if (symbol && c.symbol && c.symbol !== symbol) continue;
    send(c.ws, { type, data: payload });
  }
}

export function startWSHub(wss: WebSocketServer) {
  const cfg = getConfig();

  wss.on('connection', (ws) => {
    const state: ClientState = { ws, authed: !cfg.REQUIRE_API_KEY };
    clients.add(state);

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'hello') {
          const ok = !cfg.REQUIRE_API_KEY || msg.apiKey === cfg.APP_API_KEY;
          state.authed = ok;
          send(ws, { type: ok ? 'hello_ok' : 'hello_ko' });
          return;
        }

        if (!state.authed) {
          send(ws, { type: 'error', data: 'unauthorized' });
          return;
        }

        if (msg.type === 'sub') {
          state.symbol = msg.symbol;
          send(ws, { type: 'sub_ok', data: { symbol: state.symbol } });
          return;
        }

        // Optionnel: changer le symbole de la session active depuis le WS
        if (msg.type === 'set_symbol') {
          const s = await prisma.agentSession.findFirst({ where: { stoppedAt: null }, orderBy: { startedAt: 'desc' } });
          if (!s) return send(ws, { type: 'error', data: 'no_active_session' });
          const upd = await prisma.agentSession.update({ where: { id: s.id }, data: { symbol: msg.symbol } });
          state.symbol = upd.symbol;
          broadcast('session', upd, upd.symbol);
          return;
        }

        // Demandes de snapshot en push (sans REST)
        if (msg.type === 'fetch_now') {
          const s = await prisma.agentSession.findFirst({ where: { stoppedAt: null }, orderBy: { startedAt: 'desc' } });
          const symbol = s?.symbol || state.symbol || cfg.SYMBOL;
          try {
            const snap = await buildTechSnapshot(symbol);
            send(ws, { type: 'analysis', data: { symbol, technical: snap } });
          } catch {}
          return;
        }

        // (ex: déclenche une nouvelle stratégie manuelle par WS)
        if (msg.type === 'gen_strategy') {
          const s = await prisma.agentSession.findFirst({ where: { stoppedAt: null }, orderBy: { startedAt: 'desc' } });
          const symbol = msg.symbol || s?.symbol || state.symbol || cfg.SYMBOL;
          const strat = await generateStrategy(symbol, msg.trigger || 'manual');
          // calc levels from mid price if needed
          const entryPrice = strat.entry.price ?? ((strat.entry.zone?.min ?? 0) + (strat.entry.zone?.max ?? 0)) / 2;
          let lvls: any = undefined;
          if (entryPrice && isFinite(entryPrice)) {
            const side = strat.bias === 'long' ? 'buy' : 'sell';
            lvls = calcLevels(entryPrice, side as any, strat.risk.stop as any, strat.risk.target as any);
          }
          broadcast('strategy', { ...strat, levels: lvls }, symbol);
          return;
        }

      } catch (e) {
        send(ws, { type: 'error', data: String((e as any)?.message || e) });
      }
    });

    ws.on('close', () => { clients.delete(state); });
  });
}

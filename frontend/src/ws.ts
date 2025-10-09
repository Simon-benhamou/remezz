import { api } from './api';

type Handler = (msg: any) => void;

type ManagedWS = {
  readonly socket: WebSocket | null;
  close: () => void;
};

type TokenInfo = {
  token: string;
  expiresAt?: string;
  expiresIn?: number;
};

const MIN_DELAY = 1_000;
const MAX_DELAY = 30_000;

// Auto-reconnecting WS with exponential backoff, token refresh and resubscribe
export function openWS(
  apiBase: string,
  _apiKey: string,
  symbol: string | undefined,
  on: Handler,
  onConn?: (ok: boolean) => void,
  onReplace?: (next: WebSocket) => void,
  sessionId?: string,
): ManagedWS {
  const url = apiBase.replace('http', 'ws') + '/ws';
  let attempt = 0;
  const curSymbol = typeof symbol === 'string' && symbol.trim().length ? symbol : undefined;
  const curSessionId: string | undefined = sessionId;
  let ws: WebSocket | null = null;
  let tokenInfo: TokenInfo | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const clearRefresh = () => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  };

  const clearReconnect = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = (opts: { baseDelay?: number } = {}) => {
    if (closed || reconnectTimer) return;
    onConn?.(false);
    attempt += 1;
    clearRefresh();
    const delay = opts.baseDelay ?? Math.min(MAX_DELAY, MIN_DELAY * Math.pow(2, Math.min(attempt, 5)));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (closed) return;
      connect();
    }, delay);
  };

  const requestToken = async () => {
    const response = await api.auth.requestWsToken(curSessionId);
    tokenInfo = response;
    return response;
  };

  const handleTokenError = (err: any) => {
    const retryAfterSec =
      Number(err?.response?.data?.retryAfterSec) ||
      Number(err?.response?.headers?.['retry-after']) ||
      0;
    const status = err?.response?.status;
    const baseDelay = retryAfterSec > 0
      ? retryAfterSec * 1000
      : status === 429
      ? 8_000
      : 3_000;
    scheduleReconnect({ baseDelay });
  };

  const scheduleTokenRefresh = (expiresAt?: string) => {
    clearRefresh();
    if (!expiresAt) return;
    const refreshAt = new Date(expiresAt).getTime() - 10_000;
    const delay = Math.max(2_000, refreshAt - Date.now());
    refreshTimer = setTimeout(async () => {
      if (closed) return;
      try {
        const fresh = await api.auth.requestWsToken(curSessionId);
        tokenInfo = fresh;
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'refresh', token: fresh.token }));
        }
        scheduleTokenRefresh(fresh.expiresAt);
      } catch (err) {
        handleTokenError(err);
      }
    }, delay);
  };

  const connect = async () => {
    if (closed) return;
    clearRefresh();
    try {
      await requestToken();
    } catch (err) {
      handleTokenError(err);
      return;
    }

    if (closed) return;
    const next = new WebSocket(url);
    ws = next;
    onReplace?.(next);

    next.onopen = () => {
      attempt = 0;
      onConn?.(true);
      if (tokenInfo?.token) {
        try { next.send(JSON.stringify({ type: 'hello', token: tokenInfo.token })); } catch {}
      }
    };

    next.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'hello_ok') {
          const expiresAt = msg.expiresAt || tokenInfo?.expiresAt;
          if (tokenInfo) tokenInfo.expiresAt = expiresAt;
          scheduleTokenRefresh(expiresAt);
          setTimeout(() => {
            try {
              const payload: Record<string, any> = { type: 'sub' };
              if (curSymbol) payload.symbol = curSymbol;
              if (curSessionId) payload.sessionId = curSessionId;
              next.send(JSON.stringify(payload));
            } catch {}
          }, 100);
        } else if (msg.type === 'refresh_ok') {
          const expiresAt = msg.expiresAt || tokenInfo?.expiresAt;
          if (tokenInfo) tokenInfo.expiresAt = expiresAt;
          scheduleTokenRefresh(expiresAt);
        } else if (msg.type === 'error') {
          const code: string | undefined = msg.code || msg.data;
          if (typeof code === 'string') {
            if (code.startsWith('ws.auth')) {
              scheduleReconnect({ baseDelay: 5_000 });
            }
            if (code.startsWith('rate_limit')) {
              const retry = Number(msg.retryAfterSec || msg.details?.retryAfterSec || 5);
              scheduleReconnect({ baseDelay: Math.max(3_000, retry * 1000) });
            }
          }
        }
        on(msg);
      } catch {}
    };

    const handleDisconnect = () => {
      if (closed) return;
      clearRefresh();
      ws = null;
      scheduleReconnect();
    };

    next.onclose = handleDisconnect;
    next.onerror = handleDisconnect;
  };

  connect();

  return {
    get socket() {
      return ws;
    },
    close: () => {
      closed = true;
      clearRefresh();
      clearReconnect();
      try { ws?.close(); } catch {}
      ws = null;
    },
  };
}

export function wsSend(target: WebSocket | { socket?: WebSocket | null } | null, msg: any) {
  const ws = target instanceof WebSocket ? target : target?.socket ?? null;
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// Optional helpers for session-aware clients
export function setWsSession(target: WebSocket | { socket?: WebSocket | null } | null, sessionId?: string) {
  const ws = target instanceof WebSocket ? target : target?.socket ?? null;
  try { (ws as any).sessionId = sessionId; } catch {}
}

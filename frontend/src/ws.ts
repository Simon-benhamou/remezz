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

type Subscription = {
  id: number;
  channel: string;
  callback: Handler;
};

type SubRequest = {
  symbol?: string;
  sessionId?: string;
};

const MIN_DELAY = 1_000;
const MAX_DELAY = 30_000;

// ============================================================================
// WsManager — Singleton multiplexed WebSocket connection
// ============================================================================

class WsManager {
  private ws: WebSocket | null = null;
  private url: string = '';
  private tokenInfo: TokenInfo | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private attempt = 0;
  private authenticated = false;

  // Subscriptions
  private subscriptions: Subscription[] = [];
  private nextSubId = 1;

  // Active sub requests (symbol/session combos sent to backend)
  private subRequests: Map<string, SubRequest> = new Map();

  // Connection status listeners
  private connListeners: Set<(connected: boolean) => void> = new Set();

  // Track connection state
  private _connected = false;

  get connected(): boolean {
    return this._connected;
  }

  get socket(): WebSocket | null {
    return this.ws;
  }

  // ------------------------------------------------------------------
  // connect — idempotent; only opens a connection once
  // ------------------------------------------------------------------

  connect(apiBase?: string): void {
    // If already connected or connecting, nothing to do
    if (this.ws && !this.closed) return;

    const base = apiBase || (import.meta as any).env?.VITE_API_BASE || 'http://localhost:4000';
    this.url = base.replace('http', 'ws') + '/ws';
    this.closed = false;
    this.attempt = 0;
    this._doConnect();
  }

  // ------------------------------------------------------------------
  // disconnect — tears down the connection
  // ------------------------------------------------------------------

  disconnect(): void {
    this.closed = true;
    this._clearRefresh();
    this._clearReconnect();
    this.authenticated = false;
    this._setConnected(false);
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.subRequests.clear();
  }

  // ------------------------------------------------------------------
  // subscribe — register a listener for a specific message type (channel)
  //   channel = msg.type filter; '*' receives all messages
  //   Returns an unsubscribe function
  // ------------------------------------------------------------------

  subscribe(channel: string, callback: Handler): () => void {
    const id = this.nextSubId++;
    this.subscriptions.push({ id, channel, callback });

    // Return unsubscribe function
    return () => {
      this.subscriptions = this.subscriptions.filter((s) => s.id !== id);
    };
  }

  // ------------------------------------------------------------------
  // subscribeSub — register a backend sub request (symbol/session)
  //   Sends `{ type: 'sub', symbol?, sessionId? }` to the backend.
  //   Returns an unsubscribe function that removes the sub request.
  // ------------------------------------------------------------------

  subscribeSub(opts: SubRequest): () => void {
    const key = `${opts.symbol || ''}::${opts.sessionId || ''}`;
    this.subRequests.set(key, opts);

    // If already authenticated, send the sub immediately
    if (this.authenticated && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._sendSub(opts);
    }

    return () => {
      this.subRequests.delete(key);
    };
  }

  // ------------------------------------------------------------------
  // onConnection — listen for connection status changes
  // ------------------------------------------------------------------

  onConnection(listener: (connected: boolean) => void): () => void {
    this.connListeners.add(listener);
    // Immediately fire current status
    listener(this._connected);
    return () => {
      this.connListeners.delete(listener);
    };
  }

  // ------------------------------------------------------------------
  // send — send a raw message over the shared connection
  // ------------------------------------------------------------------

  send(msg: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // ------------------------------------------------------------------
  // hasSubscribers — check if any subscriptions are active
  // ------------------------------------------------------------------

  get subscriberCount(): number {
    return this.subscriptions.length;
  }

  // ====================================================================
  // PRIVATE
  // ====================================================================

  private _setConnected(ok: boolean): void {
    if (this._connected === ok) return;
    this._connected = ok;
    for (const listener of this.connListeners) {
      try { listener(ok); } catch {}
    }
  }

  private _clearRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private _clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private _scheduleReconnect(opts: { baseDelay?: number } = {}): void {
    if (this.closed || this.reconnectTimer) return;
    this._setConnected(false);
    this.authenticated = false;
    this.attempt += 1;
    this._clearRefresh();
    const delay = opts.baseDelay ?? Math.min(MAX_DELAY, MIN_DELAY * Math.pow(2, Math.min(this.attempt, 5)));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      this._doConnect();
    }, delay);
  }

  private async _requestToken(): Promise<void> {
    const response = await api.auth.requestWsToken();
    this.tokenInfo = response;
  }

  private _handleTokenError(err: any): void {
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
    this._scheduleReconnect({ baseDelay });
  }

  private _scheduleTokenRefresh(expiresAt?: string): void {
    this._clearRefresh();
    if (!expiresAt) return;
    const refreshAt = new Date(expiresAt).getTime() - 10_000;
    const delay = Math.max(2_000, refreshAt - Date.now());
    this.refreshTimer = setTimeout(async () => {
      if (this.closed) return;
      try {
        const fresh = await api.auth.requestWsToken();
        this.tokenInfo = fresh;
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'refresh', token: fresh.token }));
        }
        this._scheduleTokenRefresh(fresh.expiresAt);
      } catch (err) {
        this._handleTokenError(err);
      }
    }, delay);
  }

  private _sendSub(opts: SubRequest): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      const payload: Record<string, any> = { type: 'sub' };
      if (opts.symbol) payload.symbol = opts.symbol;
      if (opts.sessionId) payload.sessionId = opts.sessionId;
      this.ws.send(JSON.stringify(payload));
    } catch {}
  }

  private _replaySubRequests(): void {
    // Send all registered sub requests after authentication
    for (const opts of this.subRequests.values()) {
      this._sendSub(opts);
    }
    // If no specific sub requests, send a generic sub so the backend starts sending data
    if (this.subRequests.size === 0) {
      try {
        this.ws?.send(JSON.stringify({ type: 'sub' }));
      } catch {}
    }
  }

  private _dispatch(msg: any): void {
    const type: string = msg?.type || '';
    for (const sub of this.subscriptions) {
      if (sub.channel === '*' || sub.channel === type) {
        try { sub.callback(msg); } catch {}
      }
    }
  }

  private async _doConnect(): Promise<void> {
    if (this.closed) return;
    this._clearRefresh();

    try {
      await this._requestToken();
    } catch (err) {
      this._handleTokenError(err);
      return;
    }

    if (this.closed) return;
    const next = new WebSocket(this.url);
    this.ws = next;

    next.onopen = () => {
      this.attempt = 0;
      this._setConnected(true);
      if (this.tokenInfo?.token) {
        try {
          next.send(JSON.stringify({ type: 'hello', token: this.tokenInfo.token }));
        } catch {}
      }
    };

    next.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);

        if (msg.type === 'hello_ok') {
          const expiresAt = msg.expiresAt || this.tokenInfo?.expiresAt;
          if (this.tokenInfo) this.tokenInfo.expiresAt = expiresAt;
          this._scheduleTokenRefresh(expiresAt);
          this.authenticated = true;

          // Replay all sub requests after a short delay (same as original)
          setTimeout(() => {
            this._replaySubRequests();
          }, 100);
        } else if (msg.type === 'refresh_ok') {
          const expiresAt = msg.expiresAt || this.tokenInfo?.expiresAt;
          if (this.tokenInfo) this.tokenInfo.expiresAt = expiresAt;
          this._scheduleTokenRefresh(expiresAt);
        } else if (msg.type === 'error') {
          const code: string | undefined = msg.code || msg.data;
          if (typeof code === 'string') {
            if (code.startsWith('ws.auth')) {
              this._scheduleReconnect({ baseDelay: 5_000 });
            }
            if (code.startsWith('rate_limit')) {
              const retry = Number(msg.retryAfterSec || msg.details?.retryAfterSec || 5);
              this._scheduleReconnect({ baseDelay: Math.max(3_000, retry * 1000) });
            }
          }
        }

        // Dispatch to all subscribers
        this._dispatch(msg);
      } catch {}
    };

    const handleDisconnect = () => {
      if (this.closed) return;
      this._clearRefresh();
      this.ws = null;
      this.authenticated = false;
      this._scheduleReconnect();
    };

    next.onclose = handleDisconnect;
    next.onerror = handleDisconnect;
  }
}

// ============================================================================
// Singleton instance
// ============================================================================

export const wsManager = new WsManager();

// ============================================================================
// Backward-compatible exports (deprecated — use wsManager instead)
// ============================================================================

/**
 * @deprecated Use `wsManager.connect()` + `wsManager.subscribe()` instead.
 *
 * Opens a WebSocket connection (delegates to the shared WsManager singleton).
 * Each call to openWS now shares the same underlying connection; `close()`
 * only unsubscribes the caller — it does NOT tear down the shared socket.
 */
export function openWS(
  apiBase: string,
  _apiKey: string,
  symbol: string | undefined,
  on: Handler,
  onConn?: (ok: boolean) => void,
  onReplace?: (next: WebSocket) => void,
  sessionId?: string,
): ManagedWS {
  // Ensure the singleton is connected
  wsManager.connect(apiBase);

  // Subscribe to all messages (the caller's handler will filter as needed)
  const unsubMsg = wsManager.subscribe('*', on);

  // Register connection listener if provided
  let unsubConn: (() => void) | null = null;
  if (onConn) {
    unsubConn = wsManager.onConnection(onConn);
  }

  // Register symbol/session sub request if needed
  const curSymbol = typeof symbol === 'string' && symbol.trim().length ? symbol : undefined;
  let unsubSub: (() => void) | null = null;
  if (curSymbol || sessionId) {
    unsubSub = wsManager.subscribeSub({ symbol: curSymbol, sessionId });
  }

  return {
    get socket() {
      return wsManager.socket;
    },
    close: () => {
      unsubMsg();
      unsubConn?.();
      unsubSub?.();
    },
  };
}

export function wsSend(target: WebSocket | { socket?: WebSocket | null } | null, msg: any) {
  // If target is the manager-style object or null, use the manager
  if (!target || (target && !(target instanceof WebSocket) && !target.socket)) {
    wsManager.send(msg);
    return;
  }
  const ws = target instanceof WebSocket ? target : target?.socket ?? null;
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// Optional helpers for session-aware clients
export function setWsSession(target: WebSocket | { socket?: WebSocket | null } | null, sessionId?: string) {
  const ws = target instanceof WebSocket ? target : target?.socket ?? null;
  try { (ws as any).sessionId = sessionId; } catch {}
}

type Handler = (msg: any) => void;

// Auto-reconnecting WS with exponential backoff and resubscribe
export function openWS(
  apiBase: string,
  apiKey: string,
  symbol: string,
  on: Handler,
  onConn?: (ok: boolean) => void,
  onReplace?: (next: WebSocket) => void,
): WebSocket {
  const url = apiBase.replace('http', 'ws') + '/ws';
  let attempt = 0;
  let curKey = apiKey;
  let curSymbol = symbol;
  let ws: WebSocket | null = null;

  const connect = () => {
    const next = new WebSocket(url);
    ws = next;

    next.onopen = () => {
      attempt = 0;
      onConn?.(true);
      try { next.send(JSON.stringify({ type: 'hello', apiKey: curKey })); } catch {}
      // After hello_ok, subscribe to symbol (little delay to sequence nicely)
      setTimeout(() => { try { next.send(JSON.stringify({ type: 'sub', symbol: curSymbol })); } catch {} }, 100);
    };

    next.onmessage = (ev) => {
      try { on(JSON.parse(ev.data)); } catch {}
    };

    const scheduleReconnect = () => {
      onConn?.(false);
      attempt += 1;
      const delay = Math.min(30_000, 1000 * Math.pow(2, Math.min(attempt, 5)));
      setTimeout(() => {
        connect();
        onReplace?.(ws!);
      }, delay);
    };

    next.onclose = scheduleReconnect;
    next.onerror = scheduleReconnect;
  };

  connect();
  // Provide a best-effort current socket synchronously
  return ws!;
}

export function wsSend(ws: WebSocket, msg: any) {
  if (ws && (ws as any).readyState === 1) ws.send(JSON.stringify(msg));
}

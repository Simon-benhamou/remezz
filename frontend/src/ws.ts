type Handler = (msg:any)=>void;

export function openWS(apiBase: string, apiKey: string, symbol: string, on: Handler, onConn?: (ok:boolean)=>void) {
  const url = apiBase.replace('http', 'ws') + '/ws';
  const ws = new WebSocket(url);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'hello', apiKey }));
    // After hello_ok, subscribe to symbol
    setTimeout(()=> ws.send(JSON.stringify({ type: 'sub', symbol })), 100);
    onConn?.(true);
  };

  ws.onmessage = (ev) => {
    try { on(JSON.parse(ev.data)); } catch {}
  };

  ws.onclose = () => { try { onConn?.(false); } catch {} };

  return ws;
}

export function wsSend(ws: WebSocket, msg: any) {
  if (ws && (ws as any).readyState === 1) ws.send(JSON.stringify(msg));
}

import axios, { AxiosHeaders } from "axios";
const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:4000";
let TOKEN: string = localStorage.getItem('apiKey') || '';
export function setApiKey(tok: string){
  TOKEN = tok || '';
  localStorage.setItem('apiKey', TOKEN);
  const h = client.defaults.headers as unknown as AxiosHeaders;
  h.set('x-api-key', TOKEN);
}
export function getApiKey(){ return TOKEN || localStorage.getItem('apiKey') || ''; }
export function clearApiKey(){
  TOKEN='';
  localStorage.removeItem('apiKey');
  const h = client.defaults.headers as unknown as AxiosHeaders;
  h.delete('x-api-key');
}

export const client = axios.create({ baseURL: API_BASE });
// Initialize default x-api-key from env if present
if (import.meta.env.VITE_APP_API_KEY) {
  const h = client.defaults.headers;
  if (h) {
    (h as any)['x-api-key'] = import.meta.env.VITE_APP_API_KEY;
  }
}
client.interceptors.request.use((cfg)=>{
  const k = getApiKey();
  if (k) {
    if (cfg.headers) {
      if (cfg.headers instanceof AxiosHeaders) {
        cfg.headers?.set('x-api-key', k);
      } else {
        // Fallback for plain object headers
        (cfg.headers as any)['x-api-key'] = k;
      }
    } else {
      cfg.headers = new AxiosHeaders({ 'x-api-key': k });
    }
  }
  return cfg;
});
export const api = {
  client,
  auth: {
    login: async (username: string, password: string) => {
      const out = (await client.post('/api/auth/login', { username, password })).data;
      if (out?.token) setApiKey(out.token);
      return out;
    }
  },
  status: async (sessionId?: string) => (await client.get("/api/status", { params: { sessionId } })).data,
  strategyToday: async (symbol: string) =>
    (await client.get("/api/strategy/today", { params: { symbol } })).data,
  generateStrategy: async (symbol: string, trigger = "manual") =>
    (await client.post("/api/strategy/generate", { symbol, trigger })).data,
  proposePlan: async (symbol: string) =>
    (await client.post("/api/strategy/propose-plan", { symbol })).data,
  startSession: async (
    symbol: string,
    mode: "paper" | "live",
    startBalanceUsd?: number
  ) =>
    (await client.post("/api/agent/start", { symbol, mode, startBalanceUsd }))
      .data,
  stopSession: async (sessionId: string, closePosition?: boolean) => (await client.post("/api/agent/stop", { sessionId, closePosition })).data,
  getSession: async () => (await client.get("/api/agent/session")).data,
  listSessions: async () => (await client.get("/api/agent/sessions")).data,
  deleteSession: async (id: string) => (await client.delete(`/api/agent/sessions/${id}`)).data,
  overview: async () => (await client.get("/api/agent/overview")).data,
  setSessionSymbol: async (sessionId: string, symbol: string) => (await client.post('/api/agent/set-symbol', { sessionId, symbol })).data,
  getAgentState: async (sessionId: string) => (await client.get("/api/agent/state", { params: { sessionId } })).data,
  proposeAgentPlan: async (sessionId: string, plan: any) => (await client.post("/api/agent/propose", { sessionId, ...plan })).data,
  getTriggers: async (sessionId: string) => (await client.get("/api/agent/triggers", { params: { sessionId } })).data,
  getOrders: async (sessionId?: string) => (await client.get("/api/orders", { params: { sessionId } })).data,
  getTrades: async (
    sessionId?: string,
    opts?: { from?: string; to?: string; limit?: number }
  ) => (await client.get("/api/orders/trades", { params: { sessionId, ...opts } })).data,
  getPerf: async (sessionId: string) =>
    (await client.get("/api/perf", { params: { sessionId } })).data,
  getPerfBreakdown: async (sessionId: string) =>
    (await client.get("/api/perf/breakdown", { params: { sessionId } })).data,
  getAlerts: async (sessionId: string) =>
    (await client.get('/api/monitor/alerts', { params: { sessionId } })).data,
  getMonitorAnalytics: async (sessionId: string) =>
    (await client.get('/api/monitor/analytics', { params: { sessionId } })).data,
  getDailyReport: async (sessionId: string, date?: string, opts?: { refresh?: boolean }) =>
    (await client.get('/api/monitor/reports/daily', { params: { sessionId, date, refresh: opts?.refresh ? 'true' : undefined } })).data,
  listDailyReports: async (sessionId: string, limit = 30) =>
    (await client.get('/api/monitor/reports/daily/list', { params: { sessionId, limit } })).data,
  saveDailyReport: async (sessionId: string, date: string, report: any) =>
    (await client.post('/api/monitor/reports/daily', { sessionId, date, stats: report?.stats, llm: report?.llm })).data,
  analysis: async (symbol: string) =>
    (await client.get("/api/analysis", { params: { symbol } })).data,
  quicktest: async (symbol: string, hours: number, plan?: any) =>
    (await client.post('/api/sim/quicktest', { symbol, hours, plan })).data,
  getOpsMetrics: async () =>
    (await client.get('/api/ops/metrics')).data,
  getOpsEvents: async (limit = 50) =>
    (await client.get('/api/ops/events', { params: { limit } })).data,
};

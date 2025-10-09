import axios from "axios";
const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:4000";
let TOKEN: string = localStorage.getItem('apiKey') || '';

export function setApiKey(tok: string){
  TOKEN = tok || '';
  localStorage.setItem('apiKey', TOKEN);
  // Set header directly using bracket notation for compatibility
  client.defaults.headers.common['x-api-key'] = TOKEN;
}

export function getApiKey(){ return TOKEN || localStorage.getItem('apiKey') || ''; }

export function clearApiKey(){
  TOKEN='';
  localStorage.removeItem('apiKey');
  
  // Nettoyer les headers d'authentification
  delete client.defaults.headers.common['x-api-key'];
  delete client.defaults.headers.common['Authorization'];
  
  // Nettoyer les cookies de session si existants
  document.cookie.split(";").forEach(function(c) { 
    document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/"); 
  });
}

export const client = axios.create({ baseURL: API_BASE });

// Initialize default x-api-key from env if present
if (import.meta.env.VITE_APP_API_KEY) {
  client.defaults.headers.common['x-api-key'] = import.meta.env.VITE_APP_API_KEY;
}

// Request interceptor to ensure auth headers are always set
client.interceptors.request.use((cfg)=>{
  const k = getApiKey();
  if (k && cfg.headers) {
    (cfg.headers as any)['x-api-key'] = k;
    (cfg.headers as any)['Authorization'] = `Bearer ${k}`;
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
  status: async (sessionId?: string, options?: { includeBalance?: boolean; includeTech?: boolean }) => {
    const params: any = { sessionId };
    if (options?.includeBalance) params.includeBalance = 'true';
    if (options?.includeTech) params.includeTech = 'true';
    return (await client.get("/api/status", { params })).data;
  },
  strategyToday: async (symbol: string) =>
    (await client.get("/api/strategy/today", { params: { symbol } })).data,
  generateStrategy: async (symbol: string, trigger = "manual") =>
    (await client.post("/api/strategy/generate", { symbol, trigger })).data,
  proposePlan: async (symbol: string, opts?: { sessionId?: string; fresh?: boolean }) =>
    (await client.post("/api/strategy/propose-plan", { symbol, sessionId: opts?.sessionId, fresh: opts?.fresh })).data,
  startSession: async (
    symbol: string,
    mode: "paper" | "live",
    startBalanceUsd?: number
  ) =>
    (await client.post("/api/agent/start", { symbol, mode, startBalanceUsd }))
      .data,
  prepareAgentCreation: async (payload: Record<string, any>) =>
    (await client.post('/api/agent/creation/prepare', payload)).data,
  createAgentSession: async (creationId: string, symbol?: string) =>
    (await client.post('/api/agent/creation/create-session', { creationId, symbol })).data,
  activateAgentCreation: async (creationId: string) =>
    (await client.post('/api/agent/creation/activate', { creationId })).data,
  restartSession: async (sessionId: string, payload: Record<string, any>) =>
    (await client.post('/api/agent/restart', { sessionId, ...payload })).data,
  stopSession: async (sessionId: string, closePosition?: boolean) => (await client.post("/api/agent/stop", { sessionId, closePosition })).data,
  stopAllAgents: async () => (await client.post('/api/agent/stop-all')).data,
  getSession: async () => (await client.get("/api/agent/session")).data,
  listSessions: async (mode?: string, includeStats?: boolean) => {
    const params: any = {};
    if (mode) params.mode = mode;
    if (includeStats) params.includeStats = 'true';
    return (await client.get("/api/agent/sessions", { params })).data;
  },
  deleteSession: async (id: string) => (await client.delete(`/api/agent/sessions/${id}`)).data,
  overview: async (mode?: string) => (await client.get("/api/agent/overview", { params: mode ? { mode } : undefined })).data,
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
  getHealth: async (sessionId?: string) =>
    (await client.get('/api/monitor/health', { params: { sessionId } })).data,
  getDailyReport: async (sessionId: string, date?: string, opts?: { refresh?: boolean }) =>
    (await client.get('/api/monitor/reports/daily', { params: { sessionId, date, refresh: opts?.refresh ? 'true' : undefined } })).data,
  listDailyReports: async (sessionId: string, limit = 30) =>
    (await client.get('/api/monitor/reports/daily/list', { params: { sessionId, limit } })).data,
  saveDailyReport: async (sessionId: string, date: string, report: any) =>
    (await client.post('/api/monitor/reports/daily', { sessionId, date, stats: report?.stats, llm: report?.llm })).data,
  analysis: async (symbol: string) =>
    (await client.get("/api/analysis", { params: { symbol } })).data,
  setAggressiveness: async (sessionId: string, level: 'conservative'|'reactive'|'aggressive') =>
    (await client.post('/api/agent/aggressiveness', { sessionId, level })).data,
  getDiagnostics: async (sessionId: string) =>
    (await client.get(`/api/agent/sessions/${sessionId}/diagnostics`)).data,
  getTicker: async (symbol: string) =>
    (await client.post(`/api/market/ticker`, { symbol })).data,
  getHistory: async (symbol: string) =>
    (await client.post(`/api/market/history`, { symbol })).data,
  quicktest: async (symbol: string, hours: number, plan?: any) =>
    (await client.post('/api/sim/quicktest', { symbol, hours, plan })).data,
  getOpsMetrics: async () =>
    (await client.get('/api/ops/metrics')).data,
  getOpsEvents: async (limit = 50) =>
    (await client.get('/api/ops/events', { params: { limit } })).data,
  getAdaptiveWeights: async (params?: { family?: string; limit?: number; decisionsLimit?: number }) =>
    (await client.get('/api/monitor/adaptive-weights', { params })).data,
  listImprovements: async (status?: string) =>
    (await client.get('/api/improvements', { params: { status } })).data,
  createImprovement: async (payload: any) =>
    (await client.post('/api/improvements', payload)).data,
  updateImprovement: async (id: string, payload: any) =>
    (await client.put(`/api/improvements/${id}`, payload)).data,
  deleteImprovement: async (id: string) =>
    (await client.delete(`/api/improvements/${id}`)).data,
};

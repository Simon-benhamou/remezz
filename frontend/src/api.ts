import axios from "axios";
import type { OpsJobsResponse } from './types/ops';
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
    },
    requestWsToken: async (sessionId?: string) => {
      const payload = sessionId ? { sessionId } : {};
      return (await client.post('/api/auth/ws-token', payload)).data as {
        token: string;
        expiresAt?: string;
        expiresIn?: number;
      };
    },
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
  optimizeSymbol: async (symbol: string) =>
    (await client.post("/api/strategy/optimize-symbol", { symbol })).data,
  optimizeAllSymbols: async () =>
    (await client.post("/api/strategy/optimize-all")).data,
  getSymbolProfile: async (symbol: string) =>
    (await client.get(`/api/strategy/symbol-profile/${symbol}`)).data,
  getAllSymbolProfiles: async () =>
    (await client.get("/api/strategy/symbol-profiles")).data,
  buildSymbolProfiles: async (lookbackDays?: number) =>
    (await client.post("/api/strategy/build-symbol-profiles", { lookbackDays })).data,
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
  triggerSmartReselect: async (sessionId: string) =>
    (await client.post('/api/agent/reselect', { sessionId })).data,
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
  getSessionMetrics: async (sessionIds: string | string[]) => {
    const ids = (Array.isArray(sessionIds) ? sessionIds : [sessionIds]).filter((id) => !!id);
    const params: Record<string, string | string[]> = { sessionId: ids };
    return (await client.get("/api/perf/session-metrics", { params })).data;
  },
  getAlerts: async (sessionId: string) =>
    (await client.get('/api/monitor/alerts', { params: { sessionId } })).data,
  getMonitorAnalytics: async (sessionId: string) =>
    (await client.get('/api/monitor/analytics', { params: { sessionId } })).data,
  getMarginOverview: async (limit?: number) =>
    (await client.get('/api/monitor/margin', { params: limit ? { limit } : undefined })).data,
  getSessionMargin: async (sessionId: string, limit = 60) =>
    (await client.get(`/api/monitor/margin/${sessionId}`, { params: { limit } })).data,
  getHealth: async (sessionId?: string) =>
    (await client.get('/api/monitor/health', { params: { sessionId } })).data,
  getPredictorDecisions: async (symbol: string, options?: { limit?: number; since?: string }) =>
    (await client.post('/api/predictor/decisions', {
      symbol,
      limit: options?.limit ?? 100,
      since: options?.since,
    })).data,
  getIncoherenceFeed: async (params?: {
    limit?: number;
    sessionId?: string;
    symbol?: string;
    category?: string;
    severity?: string;
    since?: number;
  }) => (await client.get('/api/monitor/incoherences', { params })).data,
  getIncoherenceSummary: async (windowMs?: number) =>
    (await client.get('/api/monitor/incoherences/summary', {
      params: typeof windowMs === 'number' ? { windowMs } : undefined,
    })).data,
  exportIncoherences: async (payload: {
    limit?: number;
    windowMs?: number;
    sessionId?: string;
    persist?: boolean;
    filePath?: string;
  }) => (await client.post('/api/monitor/incoherences/export', payload)).data,
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
  clearCooldown: async (sessionId: string) =>
    (await client.post('/api/agent/clear-cooldown', { sessionId })).data,
  getDiagnostics: async (sessionId: string) =>
    (await client.get(`/api/agent/${sessionId}/diagnostics`)).data,
  getTicker: async (symbol: string) =>
    (await client.post(`/api/market/ticker`, { symbol })).data,
  getHistory: async (symbol: string) =>
    (await client.post(`/api/market/history`, { symbol })).data,
  getOHLCV: async (symbol: string, timeframe: string, limit: number) =>
    (await client.post(`/api/market/ohlcv`, { symbol, timeframe, limit })).data,
  quicktest: async (symbol: string, hours: number, plan?: any) =>
    (await client.post('/api/sim/quicktest', { symbol, hours, plan })).data,
  getOpsMetrics: async () =>
    (await client.get('/api/ops/metrics')).data,
  getOpsEvents: async (limit = 50, sessionId?: string) => {
    const params: Record<string, any> = { limit };
    if (sessionId) params.sessionId = sessionId;
    return (await client.get('/api/ops/events', { params })).data;
  },
  getOpsJobs: async () => (await client.get('/api/ops/jobs')).data as OpsJobsResponse,
  getAgentHealth: async () =>
    (await client.get('/api/ops/agent-health')).data,
  getPortfolio: async (mode: 'paper' | 'live' = 'paper') =>
    (await client.get('/api/agent/portfolio', { params: { mode } })).data,
  setPortfolioBalance: async (mode: 'paper' | 'live', balanceUsd: number) =>
    (await client.post('/api/agent/portfolio/balance', { mode, balanceUsd })).data,
  rebalancePortfolio: async (mode: 'paper' | 'live') =>
    (await client.post('/api/agent/portfolio/rebalance', { mode })).data,
  getCapitalSnapshot: async (mode: 'paper' | 'live') =>
    (await client.get(`/api/capital/${mode}/snapshot`)).data as {
      totalUSD: number;
      freeUSD: number;
      reservedUSD: number;
      inPositionsUSD: number;
      ts: number;
    },
  getCapitalReservations: async () =>
    (await client.get('/api/capital/reservations')).data as {
      paper: Array<{
        id: string;
        agentId: string;
        symbol: string;
        requestedUSD: number;
        grantedUSD: number;
        leverage?: number;
        expiresAt: number;
        state: 'reserved' | 'committed' | 'released';
      }>;
      live: Array<{
        id: string;
        agentId: string;
        symbol: string;
        requestedUSD: number;
        grantedUSD: number;
        leverage?: number;
        expiresAt: number;
        state: 'reserved' | 'committed' | 'released';
      }>;
    },
  setPaperCapitalBalance: async (initialUSD: number) =>
    (await client.post('/api/capital/paper/set-balance', { initialUSD })).data,
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
  
  // Entry analytics endpoints
  getEntryDecisions: async (sessionId: string, limit?: number) =>
    (await client.post('/api/entry-analytics/entry-decisions', {
      sessionId,
      limit,
    })).data,
  getRegimeThresholds: async (symbol: string) =>
    (await client.get(`/api/entry-analytics/regime-thresholds/${symbol}`)).data,
};

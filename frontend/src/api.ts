import axios, { AxiosHeaders } from "axios";
const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:4000";
console.log(import.meta.env.VITE_API_BASE)
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
  status: async () => (await client.get("/api/status")).data,
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
  stopSession: async (closePosition?: boolean) => (await client.post("/api/agent/stop", closePosition!=null ? { closePosition } : {})).data,
  getSession: async () => (await client.get("/api/agent/session")).data,
  listSessions: async () => (await client.get("/api/agent/sessions")).data,
  getAgentState: async () => (await client.get("/api/agent/state")).data,
  proposeAgentPlan: async (plan: any) => (await client.post("/api/agent/propose", plan)).data,
  getTriggers: async () => (await client.get("/api/agent/triggers")).data,
  getOrders: async () => (await client.get("/api/orders")).data,
  getPerf: async (sessionId: string) =>
    (await client.get("/api/perf", { params: { sessionId } })).data,
  analysis: async (symbol: string) =>
    (await client.get("/api/analysis", { params: { symbol } })).data,
  quicktest: async (symbol: string, hours: number, plan?: any) =>
    (await client.post('/api/sim/quicktest', { symbol, hours, plan })).data,
};

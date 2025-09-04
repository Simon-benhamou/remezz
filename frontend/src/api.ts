import axios from "axios";
const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:4000";
const API_KEY = import.meta.env.VITE_APP_API_KEY || "";

export const client = axios.create({
  baseURL: API_BASE,
  headers: { "x-api-key": API_KEY },
});
export const api = {
  client,
  status: async () => (await client.get("/api/status")).data,
  strategyToday: async (symbol: string) =>
    (await client.get("/api/strategy/today", { params: { symbol } })).data,
  generateStrategy: async (symbol: string, trigger = "manual") =>
    (await client.post("/api/strategy/generate", { symbol, trigger })).data,
  rankPerps: async (perps: string[]) =>
    (await client.post("/api/strategy/rank", { perps })).data,
  startSession: async (
    symbol: string,
    mode: "paper" | "live",
    startBalanceUsd?: number
  ) =>
    (await client.post("/api/agent/start", { symbol, mode, startBalanceUsd }))
      .data,
  stopSession: async () => (await client.post("/api/agent/stop")).data,
  getSession: async () => (await client.get("/api/agent/session")).data,
  getTriggers: async () => (await client.get("/api/agent/triggers")).data,
  getOrders: async () => (await client.get("/api/orders")).data,
  getPerf: async (sessionId: string) =>
    (await client.get("/api/perf", { params: { sessionId } })).data,
};

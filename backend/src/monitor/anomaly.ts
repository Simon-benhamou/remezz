export type Anomaly = {
  type: 'slippage'|'order_reject'|'latency'|'equity_gap'|'llm_invalid'|'churn'|'maxdd_mid';
  severity: 'low'|'med'|'high';
  details?: any;
  ts: number;
};

export class AnomalyMonitor {
  private events: Anomaly[] = [];
  record(a: Anomaly) { this.events.push(a); }
  recent(n = 50) { return this.events.slice(-n); }
  hasBlocking(): boolean { return this.events.slice(-10).some(e => e.severity === 'high'); }
}

// Optional DB persistence helper; safe no-op if prisma is not available in this module.
export async function recordAnomalyDB(sessionId: string|undefined, a: Anomaly) {
  try {
    const { prisma } = await import('../db/client.js');
    await prisma.$executeRaw`-- noop`;
    // If you later add an Anomaly model in Prisma, persist it here.
  } catch {}
}

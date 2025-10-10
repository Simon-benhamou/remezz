declare module '@prisma/client' {
  export class PrismaClient {
    leverageConstraint: any;
    marginSnapshot: any;
    fill: any;
    position: any;
    agentSession: any;
    order: any;
    sessionKpi: any;
    alert: any;
    strategy: any;
    triggerLog: any;
    adaptiveThreshold: any;
    decisionMemory: any;
    user: any;
    improvementItem: any;
    sentimentSnapshot: any;
    userApiKey: any;
    userSetting: any;
    auditLog: any;
    $executeRaw: any;
    $transaction: any;
    dailyReport: any;
  }

  export interface LeverageConstraint {
    id: string;
    symbol: string;
    category: string | null;
    hardCap: number | null;
    targetLeverage: number | null;
    liquidityUsd: number | null;
    liquiditySampledAt: Date | null;
    atrPct: number | null;
    atrSampledAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }
}

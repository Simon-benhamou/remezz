/**
 * Types pour le système multi-stratégies
 */

export type StrategyType = 'trend_following' | 'mean_reversion' | 'breakout' | 'momentum';

export interface StrategyPerformance {
  strategy: StrategyType;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  bySymbol: Array<{
    symbol: string;
    trades: number;
    winRate: number;
    totalPnl: number;
    avgPnl: number;
  }>;
  dailyPnl: Array<{
    date: string;
    pnl: number;
  }>;
}

export interface StrategyHeatmapCell {
  trades: number;
  winRate: number;
  pnl: number;
  avgPnl: number;
}

export interface StrategyHeatmap {
  symbol: string;
  strategies: {
    [strategy: string]: StrategyHeatmapCell;
  };
}

export interface GlobalStrategyStats {
  strategy: StrategyType;
  totalTrades: number;
  winRate: number;
  totalPnlUsd: number;
  avgPnlUsd: number;
  cryptoCount: number;
  profitFactor: number;
}

export interface StrategyPerformanceResponse {
  period: {
    days: number;
    symbol?: string;
  };
  global: GlobalStrategyStats[];
  bySymbol: Array<{
    symbol: string;
    recommendedStrategy: StrategyType;
    confidence: number;
    reason: string;
    strategies: Array<{
      strategy: StrategyType;
      totalTrades: number;
      winRate: number;
      avgPnlUsd: number;
      totalPnlUsd: number;
      avgConfidence: number;
    }>;
  }>;
}

export interface DetailedStrategyResponse {
  period: number;
  strategies: StrategyPerformance[];
}

export interface HeatmapResponse {
  period: number;
  heatmap: StrategyHeatmap[];
}

export const STRATEGY_COLORS: Record<StrategyType, string> = {
  trend_following: '#1890ff', // Bleu
  mean_reversion: '#52c41a',  // Vert
  breakout: '#fa8c16',         // Orange
  momentum: '#f5222d',         // Rouge
};

export const STRATEGY_LABELS: Record<StrategyType, string> = {
  trend_following: 'Trend Following',
  mean_reversion: 'Mean Reversion',
  breakout: 'Breakout',
  momentum: 'Momentum',
};

export type StrategyEngineOption = 'intraday_dual' | 'meta_adaptive';

export type StrategyChecklistItem = {
  key: string;
  label: string;
  status: string;
  reason?: string | null;
  details?: any;
  source: string;
};

export type RecognizedStrategySummary = {
  id: string;
  label: string;
  bias: 'long' | 'short' | 'both';
  confidence: number;
  score: number;
  guardrail: string | null;
  penalties: string[];
  exploration: boolean;
  active: boolean;
  reasons: string[];
  executionMode?: string | null;
  riskPct?: number | null;
  stopAtrMult?: number | null;
};

export type StrategyContextSnapshot = {
  regime: string;
  basePlaybook: string;
  effectivePlaybook: string;
  direction: 'long' | 'short' | 'none';
  strongTrend: boolean;
  moderateTrend: boolean;
  allowMomentumOverride: boolean;
  favorMeanReversion: boolean;
  confidence: number;
  notes: string[];
  hurst: number | null;
  trendStrength: number | null;
  adx: number | null;
  family: string | null;
  token: string | null;
};

export type StrategySnapshot = {
  engine: StrategyEngineOption | null;
  primary: RecognizedStrategySummary | null;
  recognized: RecognizedStrategySummary[];
  context: StrategyContextSnapshot | null;
  checklist: StrategyChecklistItem[];
};

// Polymarket 5-min prediction experiment types

export interface Candle1m {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isFinal: boolean;
}

export interface ScoreBreakdown {
  volumeSpike: number;       // 0-25
  microRoc: number;          // 0-20
  bodyRatio: number;         // 0-15
  wickRejection: number;     // -15 to +15
  candleAlignment: number;   // 0-15
  preWindowMomentum: number; // -10 to +10
  total: number;
}

export interface PredictionResult {
  direction: 'UP' | 'DOWN';
  confidence: number;
  score: ScoreBreakdown;
  microRocPct: number;
}

export interface PolymarketOdds {
  slug: string;
  upPrice: number;
  downPrice: number;
  upTokenId: string | null;
  downTokenId: string | null;
  found: boolean;
}

export interface WindowState {
  symbol: string;  // 'BTC', 'ETH', 'SOL', 'XRP'
  windowStart: number;
  windowEnd: number;
  startPrice: number;
  currentPrice: number;
  elapsed: number;
  prediction: PredictionResult | null;
  entryOdds: number | null;
  executionPrice: number | null;  // Actual CLOB price paid (differs from Gamma entryOdds)
  betAmount: number | null;
  tokenId: string | null;         // CLOB token ID (for auto-sell after WIN)
  // Observation phase (smart CLOB entry)
  observationStatus: 'idle' | 'observing' | 'filled' | 'skipped_ev' | null;
  observationInitialAsk: number | null;
  observationBestAsk: number | null;
  observationTrigger: string | null;  // 'dip' | 'bounce' | 'rising' | 'deadline' | 'window_end'
  status: 'accumulating' | 'predicted' | 'resolved' | 'skipped';
}

export interface PredictionStats {
  totalWindows: number;
  totalPredictions: number;
  wins: number;
  losses: number;
  skips: number;
  winRate: number;
  cumulativePnl: number;
  todayWindows: number;
  todayPredictions: number;
  todayWins: number;
  todayLosses: number;
  todayWinRate: number;
  todayPnl: number;
  // Real traded stats (executionPrice IS NOT NULL = order was placed & filled)
  tradedWins: number;
  tradedLosses: number;
  tradedWinRate: number;
  tradedPnl: number;          // sum of realPnl (live) or simulatedPnl (virtual)
  todayTradedWins: number;
  todayTradedLosses: number;
  todayTradedWinRate: number;
  todayTradedPnl: number;
  // Unredeemed tokens info
  unredeemedCount: number;
  unredeemedUsdc: number;
}

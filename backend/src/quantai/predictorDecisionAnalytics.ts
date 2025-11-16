type PrismaPredictorDecision = {
  id: string;
  symbol: string;
  decision: string;
  previousDecision: string | null;
  probabilityLong: number;
  probabilityShort: number;
  confidence: number;
  entryWeight: number | null;
  riskMultiplier: number | null;
  price: number;
  createdAt: Date;
};

type DeterminedOutcome = {
  outcome: PredictorOutcome;
  priceChange: number | null;
  pnlEstimate: number | null;
  durationMinutes: number | null;
  exitPrice: number | null;
  exitTime: Date | null;
};

export type PredictorOutcome = 'good' | 'bad' | 'neutral' | 'pending' | 'not_applicable';

export interface AnalyzedPredictorDecision extends PrismaPredictorDecision {
  outcome: PredictorOutcome;
  priceChange: number | null;
  pnlEstimate: number | null;
  durationMinutes: number | null;
  exitPrice: number | null;
  exitTime: Date | null;
}

export interface PredictorMetricsSummary {
  totalDecisions: number;
  completedTrades: number;
  pendingTrades: number;
  notApplicableTrades: number;
  goodTrades: number;
  badTrades: number;
  neutralTrades: number;
  winRate: number; // percentage 0-100
  avgPnl: number;  // percentage
  totalPnl: number; // percentage
  avgDurationMinutes: number;
}

export interface PredictorAnalysisResult {
  chronological: AnalyzedPredictorDecision[];
  reverseChronological: AnalyzedPredictorDecision[];
  metrics: PredictorMetricsSummary;
}

function determineOutcome(decision: PrismaPredictorDecision, nextDecision?: PrismaPredictorDecision): DeterminedOutcome {
  if (!nextDecision) {
    return { outcome: 'pending' as PredictorOutcome, priceChange: null, pnlEstimate: null, durationMinutes: null, exitPrice: null, exitTime: null };
  }
  if (decision.decision === 'none') {
    return { outcome: 'not_applicable' as PredictorOutcome, priceChange: null, pnlEstimate: null, durationMinutes: 0, exitPrice: nextDecision?.price ?? null, exitTime: nextDecision?.createdAt ?? null };
  }

  const entryPrice = decision.price;
  const exitPrice = nextDecision.price;
  const priceChange = ((exitPrice - entryPrice) / entryPrice) * 100;
  const durationMinutes = Math.floor((nextDecision.createdAt.getTime() - decision.createdAt.getTime()) / 60000);

  if (decision.decision === 'long') {
    const pnlEstimate = priceChange;
    const outcome: PredictorOutcome = priceChange > 0 ? 'good' : (priceChange < -0.1 ? 'bad' : 'neutral');
    return { outcome, priceChange, pnlEstimate, durationMinutes, exitPrice, exitTime: nextDecision.createdAt };
  }

  const pnlEstimate = -priceChange;
  const outcome: PredictorOutcome = priceChange < 0 ? 'good' : (priceChange > 0.1 ? 'bad' : 'neutral');
  return { outcome, priceChange, pnlEstimate, durationMinutes, exitPrice, exitTime: nextDecision.createdAt };
}

export function analyzePredictorDecisions(decisions: PrismaPredictorDecision[]): PredictorAnalysisResult {
  if (decisions.length === 0) {
    return {
      chronological: [],
      reverseChronological: [],
      metrics: {
        totalDecisions: 0,
        completedTrades: 0,
        pendingTrades: 0,
        notApplicableTrades: 0,
        goodTrades: 0,
        badTrades: 0,
        neutralTrades: 0,
        winRate: 0,
        avgPnl: 0,
        totalPnl: 0,
        avgDurationMinutes: 0,
      },
    };
  }

  const chronological = [...decisions].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const analyzedChronological: AnalyzedPredictorDecision[] = [];

  for (let i = 0; i < chronological.length; i++) {
    const decision = chronological[i];
    const nextDecision = chronological[i + 1];
    const { outcome, priceChange, pnlEstimate, durationMinutes, exitPrice, exitTime } = determineOutcome(decision, nextDecision);

    analyzedChronological.push({
      ...decision,
      outcome,
      priceChange,
      pnlEstimate,
      durationMinutes,
      exitPrice,
      exitTime,
    });
  }

  const completedTrades = analyzedChronological.filter(d => d.outcome !== 'pending' && d.outcome !== 'not_applicable');
  const goodTrades = completedTrades.filter(d => d.outcome === 'good');
  const badTrades = completedTrades.filter(d => d.outcome === 'bad');
  const neutralTrades = completedTrades.filter(d => d.outcome === 'neutral');

  const pendingTrades = analyzedChronological.filter(d => d.outcome === 'pending');
  const notApplicableTrades = analyzedChronological.filter(d => d.outcome === 'not_applicable');

  const winRate = completedTrades.length > 0
    ? (goodTrades.length / completedTrades.length) * 100
    : 0;

  const avgPnl = completedTrades.length > 0
    ? completedTrades.reduce((sum, t) => sum + (t.pnlEstimate || 0), 0) / completedTrades.length
    : 0;

  const totalPnl = completedTrades.reduce((sum, t) => sum + (t.pnlEstimate || 0), 0);

  const avgDuration = completedTrades.length > 0
    ? completedTrades.reduce((sum, t) => sum + (t.durationMinutes || 0), 0) / completedTrades.length
    : 0;

  return {
    chronological: analyzedChronological,
    reverseChronological: [...analyzedChronological].reverse(),
    metrics: {
      totalDecisions: analyzedChronological.length,
      completedTrades: completedTrades.length,
      pendingTrades: pendingTrades.length,
      notApplicableTrades: notApplicableTrades.length,
      goodTrades: goodTrades.length,
      badTrades: badTrades.length,
      neutralTrades: neutralTrades.length,
      winRate: parseFloat(winRate.toFixed(2)),
      avgPnl: parseFloat(avgPnl.toFixed(2)),
      totalPnl: parseFloat(totalPnl.toFixed(2)),
      avgDurationMinutes: parseFloat(avgDuration.toFixed(1)),
    },
  };
}

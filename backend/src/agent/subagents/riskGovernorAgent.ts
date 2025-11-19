import { prisma } from '../../db/client.js';
import { getCapitalManager } from '../../services/capitalPool.js';
import { capitalConfig } from '../../config/capital.js';
import { getConfig } from '../../utils/env.js';
import { getSubagentTuning } from '../../services/subagentLearning.js';
import type { RiskGovernorAgent, RiskLimits } from './types.js';

const envConfig = getConfig();

function sumNotional(qty?: number | null, price?: number | null): number {
  const normalizedQty = Number(qty ?? 0);
  const normalizedPrice = Number(price ?? 0);
  if (!Number.isFinite(normalizedQty) || !Number.isFinite(normalizedPrice)) {
    return 0;
  }
  return Math.abs(normalizedQty * normalizedPrice);
}

function parsePositionPct(raw?: number | string | null): number | null {
  if (raw == null) return null;
  const value = typeof raw === 'string' ? Number.parseFloat(raw) : Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  const normalized = value > 1 ? value / 100 : value;
  return Math.min(1, Math.max(0.01, normalized));
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function extractBaseSymbol(symbol: string): string {
  if (!symbol) return '';
  const [base] = symbol.split(/[/:]/);
  return (base ?? '').toUpperCase();
}

export class DefaultRiskGovernorAgent implements RiskGovernorAgent {
  private readonly minPositionUsd = Math.max(
    capitalConfig.minOrderUSD.toNumber(),
    Number.parseFloat(process.env.META_ADAPTIVE_MIN_POSITION_USD ?? '0') || 2_000,
  );

  private readonly defaultMaxPositionPct =
    parsePositionPct(process.env.META_ADAPTIVE_MAX_POSITION_PCT) ?? 0.35;

  private readonly defaultMaxLeverage =
    Number(envConfig.DEFAULT_MAX_LEVERAGE ?? 5) || 5;

  async getLimits(sessionId: string, symbol: string): Promise<RiskLimits> {
    const session = await prisma.agentSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        mode: true,
        startBalanceUsd: true,
        profileJson: true,
        positions: {
          select: { symbol: true, qty: true, entryPrice: true, side: true, leverage: true },
        },
        SessionKpi: {
          select: {
            realizedPnlUsd: true,
            unrealizedPnlUsd: true,
            maxDrawdownPct: true,
          },
        },
      },
    });

    if (!session) {
      throw new Error(`Risk governor session ${sessionId} not found`);
    }

    const positions = session.positions ?? [];
    const realizedPnl = Number(session.SessionKpi?.realizedPnlUsd ?? 0);
    const unrealizedPnl = Number(session.SessionKpi?.unrealizedPnlUsd ?? 0);
    const drawdownPct = Math.max(0, Number(session.SessionKpi?.maxDrawdownPct ?? 0));
    const startBalance = Number(session.startBalanceUsd ?? 0) || 0;
    const inferredEquity = Math.max(0, startBalance + realizedPnl + unrealizedPnl);
    const profile = ((session.profileJson ?? {}) as Record<string, unknown>) || {};
    const regime = typeof profile?.regime === 'string' ? (profile.regime as string) : undefined;

    const profileMaxPositionUsd = (() => {
      const candidates = [
        profile?.riskControls && (profile.riskControls as Record<string, unknown>)?.maxPositionUsd,
        profile?.maxPositionUsd,
      ];
      for (const candidate of candidates) {
        if (candidate == null) continue;
        const value = typeof candidate === 'string' ? Number.parseFloat(candidate) : Number(candidate);
        if (Number.isFinite(value) && value > 0) {
          return value;
        }
      }
      return null;
    })();

    const profilePositionPct = (() => {
      const candidate =
        (profile?.riskControls as Record<string, unknown> | undefined)?.maxPositionPct ?? profile?.maxPositionPct;
      return parsePositionPct(
        typeof candidate === 'string' || typeof candidate === 'number' ? candidate : null,
      );
    })();

    const sessionBaseBudget = profileMaxPositionUsd
      ? profileMaxPositionUsd
      : Math.max(
          this.minPositionUsd,
          (inferredEquity || startBalance || this.minPositionUsd) *
            (profilePositionPct ?? this.defaultMaxPositionPct),
        );

    const capitalManager = getCapitalManager(session.mode === 'live' ? 'live' : 'paper');
    const poolSnapshot = await capitalManager.getBalance();
    const poolTotalUsd = poolSnapshot.totalUSD.toNumber();
    const poolFreeUsd = poolSnapshot.freeUSD.toNumber();
    const poolFreeRatio = poolTotalUsd > 0 ? poolFreeUsd / poolTotalUsd : 1;
    const perSymbolCapPct = capitalConfig.perSymbolCapPct.toNumber();
    const perSymbolMarginCapUsd = Math.max(this.minPositionUsd, poolTotalUsd * perSymbolCapPct);
    const symbolMarginExposureUsd = capitalManager.getSymbolExposureUsd(symbol).toNumber();
    const marginRoomUsd = Math.max(0, perSymbolMarginCapUsd - symbolMarginExposureUsd);

    const drawdownPenalty = drawdownPct >= 30
      ? 0.45
      : drawdownPct >= 20
        ? 0.6
        : drawdownPct >= 12
          ? 0.8
          : 1;
    const poolStressPenalty = poolFreeRatio < 0.08
      ? 0.4
      : poolFreeRatio < 0.15
        ? 0.6
        : poolFreeRatio < 0.3
          ? 0.8
          : 1;

    const adjustedSessionCap = Math.max(
      0,
      sessionBaseBudget * Math.min(drawdownPenalty, poolStressPenalty),
    );

    const profileMaxLeverage = (() => {
      const candidate = (profile?.riskControls as Record<string, unknown> | undefined)?.maxLeverage ?? profile?.maxLeverage;
      const parsed = typeof candidate === 'string' ? Number.parseFloat(candidate) : Number(candidate);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
      return this.defaultMaxLeverage;
    })();

    const leveragePenalty = Math.min(drawdownPenalty, poolStressPenalty);
    const maxLeverage = clampNumber(
      Math.max(1, profileMaxLeverage * leveragePenalty),
      1,
      Math.max(1, profileMaxLeverage),
    );

    const leverageCeil = Math.max(1, Math.min(maxLeverage, 12));
    const poolMarginNotional = marginRoomUsd * leverageCeil;
    const poolFreeNotional = poolFreeUsd * leverageCeil * 0.9;
    const constraintValues = [adjustedSessionCap, poolMarginNotional, poolFreeNotional]
      .map((value) => (Number.isFinite(value) ? value : 0))
      .filter((value) => value >= 0);
    const maxPositionCandidate = constraintValues.length
      ? Math.min(...constraintValues)
      : adjustedSessionCap;
    let maxPositionUsd = Math.max(0, maxPositionCandidate);
    let tunedMaxLeverage = maxLeverage;

    const learning = await getSubagentTuning('risk_governor', symbol, {
      mode: session.mode ?? 'paper',
      regime,
    });

    if (learning) {
      tunedMaxLeverage = clampNumber(
        Math.min(maxLeverage, learning.recommendedMaxLeverage),
        1,
        Math.max(1, profileMaxLeverage),
      );
      const equityBasis = inferredEquity || startBalance || this.minPositionUsd;
      const learningCap = Math.max(this.minPositionUsd, equityBasis * learning.recommendedMaxPositionPct);
      maxPositionUsd = Math.min(maxPositionUsd, Math.round(learningCap));
    }

    const sessionExposureUsd = positions.reduce(
      (acc, pos) => acc + sumNotional(pos.qty, pos.entryPrice),
      0,
    );
    const symbolExposureUsd = positions
      .filter((pos) => pos.symbol === symbol)
      .reduce((acc, pos) => acc + sumNotional(pos.qty, pos.entryPrice), 0);
    const netExposureUsd = positions.reduce((acc, pos) => {
      const direction = (pos.side ?? '').toLowerCase() === 'sell' ? -1 : 1;
      return acc + direction * sumNotional(pos.qty, pos.entryPrice);
    }, 0);

    const baseSymbol = extractBaseSymbol(symbol);
    const clusterExposureUsd = baseSymbol
      ? await this.computeClusterExposure(baseSymbol)
      : sessionExposureUsd;
    const clusterBaseLimit = Math.max(maxPositionUsd * 2, adjustedSessionCap * 1.8);
    const clusterUpperBound = poolTotalUsd > 0 ? poolTotalUsd * 0.45 : clusterBaseLimit;
    const clusterExposureCap = Math.max(
      0,
      Math.min(
        Number.isFinite(clusterUpperBound) && clusterUpperBound > 0
          ? clusterUpperBound
          : clusterBaseLimit,
        clusterBaseLimit,
      ),
    );

    const hedgingReasons: string[] = [];
    if (sessionExposureUsd > maxPositionUsd * 1.1 && sessionExposureUsd > this.minPositionUsd) {
      hedgingReasons.push('session_exposure_over_cap');
    }
    if (clusterExposureUsd > clusterExposureCap * 1.05 && clusterExposureCap > 0) {
      hedgingReasons.push('cluster_exposure_over_cap');
    }
    if (Math.abs(netExposureUsd) > adjustedSessionCap * 1.1 && sessionExposureUsd > 0) {
      hedgingReasons.push('net_directional_imbalance');
    }
    // BUG FIX: Reduced pool stress threshold from 8% to 3% to avoid blocking all agents prematurely
    // Only trigger if there are actual positions to hedge
    if (poolFreeRatio < 0.03 && sessionExposureUsd > this.minPositionUsd) {
      hedgingReasons.push('capital_pool_stress');
    }
    if (symbolExposureUsd > Math.max(this.minPositionUsd, maxPositionUsd * 0.9) && positions.length > 1) {
      hedgingReasons.push('single_symbol_overweight');
    }
    if (maxPositionUsd < this.minPositionUsd * 0.5 && sessionExposureUsd > 0) {
      hedgingReasons.push('budget_exhausted');
    }
    // Learning-based hedge conditions with neutral defaults for new symbols
    // Symbols without historical data get hedgingTension=0.30 (won't trigger) and confidence=0.50 (neutral)
    if (learning) {
      // Only trigger on very high tension (>90%) indicating consistent bad performance
      if (learning.hedgingTension > 0.90 && sessionExposureUsd > this.minPositionUsd * 2) {
        hedgingReasons.push('learning_high_tension');
      }
      // Only trigger on very low confidence (<15%) with significant exposure
      if (learning.confidence < 0.15 && sessionExposureUsd > maxPositionUsd) {
        hedgingReasons.push('learning_low_confidence');
      }
    }

    return {
      sessionId,
      maxLeverage: Number(tunedMaxLeverage.toFixed(2)),
      maxPositionUsd: Math.max(0, Math.round(maxPositionUsd)),
      clusterExposureUsd: Math.max(0, Math.round(clusterExposureCap)),
      hedgingRequired: hedgingReasons.length > 0,
      reason: hedgingReasons.length ? hedgingReasons.join('|') : undefined,
      timestamp: Date.now(),
    };
  }

  private async computeClusterExposure(baseSymbol: string): Promise<number> {
    if (!baseSymbol) return 0;
    const positions = await prisma.position.findMany({
      where: {
        OR: [
          { symbol: { startsWith: `${baseSymbol}/` } },
          { symbol: { startsWith: `${baseSymbol}-` } },
          { symbol: { startsWith: baseSymbol } },
        ],
      },
      select: { qty: true, entryPrice: true },
    });
    return positions.reduce((acc, pos) => acc + sumNotional(pos.qty, pos.entryPrice), 0);
  }
}

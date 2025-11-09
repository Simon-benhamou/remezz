/**
 * Correlation Analysis Module
 * 
 * Provides portfolio-wide correlation analysis to prevent overexposure to correlated assets
 * and adjust risk based on correlation regimes (RISK_ON vs RISK_OFF).
 */

import { prisma } from '../db/client.js';

/**
 * Correlation regime types
 */
export type CorrelationRegime = 'RISK_ON' | 'RISK_OFF' | 'NEUTRAL';

/**
 * Correlation matrix entry
 */
export interface CorrelationPair {
  symbol1: string;
  symbol2: string;
  correlation: number;
  sampleSize: number;
  lastUpdated: Date;
}

/**
 * Correlation matrix
 */
export interface CorrelationMatrix {
  pairs: Map<string, Map<string, number>>;
  regime: CorrelationRegime;
  avgCorrelation: number;
  calculatedAt: Date;
}

/**
 * Portfolio exposure assessment
 */
export interface PortfolioExposure {
  totalPositions: number;
  highlyCorrelatedGroups: string[][];
  overexposedSymbols: string[];
  riskMultiplier: number;
  correlationRegime: CorrelationRegime;
  warnings: string[];
}

/**
 * Configuration for correlation analysis
 */
export interface CorrelationConfig {
  // Correlation calculation
  minSampleSize: number;              // Minimum returns needed for correlation (default: 20)
  lookbackDays: number;               // Days to look back for returns (default: 30)
  
  // Correlation thresholds
  highCorrelationThreshold: number;   // Threshold for high correlation (default: 0.7)
  extremeCorrelationThreshold: number; // Threshold for extreme correlation (default: 0.9)
  
  // Regime classification
  riskOffCorrelationThreshold: number; // Avg correlation for RISK_OFF (default: 0.6)
  riskOnCorrelationThreshold: number;  // Avg correlation for RISK_ON (default: 0.3)
  
  // Portfolio limits
  maxCorrelatedPositions: number;     // Max positions with >0.9 correlation (default: 5)
  
  // Risk adjustments
  riskOffMultiplier: number;          // Size multiplier during RISK_OFF (default: 0.5)
  highCorrelationMultiplier: number;  // Multiplier for highly correlated assets (default: 0.7)
}

/**
 * Default configuration
 */
export const DEFAULT_CORRELATION_CONFIG: CorrelationConfig = {
  minSampleSize: Number(process.env.CORR_MIN_SAMPLE_SIZE ?? '20'),
  lookbackDays: Number(process.env.CORR_LOOKBACK_DAYS ?? '30'),
  highCorrelationThreshold: Number(process.env.CORR_HIGH_THRESHOLD ?? '0.7'),
  extremeCorrelationThreshold: Number(process.env.CORR_EXTREME_THRESHOLD ?? '0.9'),
  riskOffCorrelationThreshold: Number(process.env.CORR_RISK_OFF_THRESHOLD ?? '0.6'),
  riskOnCorrelationThreshold: Number(process.env.CORR_RISK_ON_THRESHOLD ?? '0.3'),
  maxCorrelatedPositions: Number(process.env.CORR_MAX_POSITIONS ?? '5'),
  riskOffMultiplier: Number(process.env.CORR_RISK_OFF_MULTIPLIER ?? '0.5'),
  highCorrelationMultiplier: Number(process.env.CORR_HIGH_CORR_MULTIPLIER ?? '0.7'),
};

/**
 * In-memory cache for correlation matrices
 */
interface CacheEntry {
  matrix: CorrelationMatrix;
  expiresAt: Date;
}

/**
 * Correlation Analysis Manager
 */
export class CorrelationAnalyzer {
  private cache: Map<string, CacheEntry> = new Map();
  private readonly CACHE_TTL_HOURS = 1; // Cache correlations for 1 hour
  
  constructor(
    private readonly config: CorrelationConfig = DEFAULT_CORRELATION_CONFIG
  ) {}

  /**
   * Calculate Pearson correlation coefficient
   */
  private calculateCorrelation(returns1: number[], returns2: number[]): number {
    if (returns1.length !== returns2.length || returns1.length === 0) {
      return 0;
    }

    const n = returns1.length;
    const mean1 = returns1.reduce((sum, val) => sum + val, 0) / n;
    const mean2 = returns2.reduce((sum, val) => sum + val, 0) / n;

    let numerator = 0;
    let sumSq1 = 0;
    let sumSq2 = 0;

    for (let i = 0; i < n; i++) {
      const diff1 = returns1[i] - mean1;
      const diff2 = returns2[i] - mean2;
      numerator += diff1 * diff2;
      sumSq1 += diff1 * diff1;
      sumSq2 += diff2 * diff2;
    }

    const denominator = Math.sqrt(sumSq1 * sumSq2);
    if (denominator === 0) return 0;

    return numerator / denominator;
  }

  /**
   * Get returns for a symbol from recent closed trades
   */
  private async getSymbolReturns(symbol: string, lookbackDays: number): Promise<number[]> {
    const lookbackDate = new Date();
    lookbackDate.setDate(lookbackDate.getDate() - lookbackDays);

    const orders = await prisma.order.findMany({
      where: {
        symbol,
        status: 'closed',
        createdAt: { gte: lookbackDate },
        clientOrderId: { endsWith: '.exit' },
      },
      include: { Fill: true },
      orderBy: { createdAt: 'asc' },
    });

    const returns: number[] = [];
    for (const order of orders) {
      const fills = order.fills || [];
      const realizedPnl = fills.reduce((sum, f) => sum + Number(f.realizedPnl || 0), 0);
      const qty = Number(order.qty || 0);
      const price = Number(order.price || 0);
      const notional = Math.abs(qty * price);

      if (notional > 0) {
        const returnPct = (realizedPnl / notional);
        if (Number.isFinite(returnPct) && Math.abs(returnPct) < 5) {
          returns.push(returnPct);
        }
      }
    }

    return returns;
  }

  /**
   * Calculate correlation matrix for given symbols
   */
  async calculateCorrelationMatrix(symbols: string[]): Promise<CorrelationMatrix> {
    // Check cache first
    const cacheKey = symbols.sort().join(',');
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > new Date()) {
      return cached.matrix;
    }

    const pairs = new Map<string, Map<string, number>>();
    const returnsMap = new Map<string, number[]>();

    // Fetch returns for all symbols
    for (const symbol of symbols) {
      const returns = await this.getSymbolReturns(symbol, this.config.lookbackDays);
      if (returns.length >= this.config.minSampleSize) {
        returnsMap.set(symbol, returns);
      }
    }

    // Calculate pairwise correlations
    const validSymbols = Array.from(returnsMap.keys());
    let totalCorrelation = 0;
    let correlationCount = 0;

    for (let i = 0; i < validSymbols.length; i++) {
      const symbol1 = validSymbols[i];
      const returns1 = returnsMap.get(symbol1)!;
      
      if (!pairs.has(symbol1)) {
        pairs.set(symbol1, new Map());
      }

      for (let j = i + 1; j < validSymbols.length; j++) {
        const symbol2 = validSymbols[j];
        const returns2 = returnsMap.get(symbol2)!;

        // Align returns by taking minimum length
        const minLength = Math.min(returns1.length, returns2.length);
        const alignedReturns1 = returns1.slice(-minLength);
        const alignedReturns2 = returns2.slice(-minLength);

        const correlation = this.calculateCorrelation(alignedReturns1, alignedReturns2);
        
        pairs.get(symbol1)!.set(symbol2, correlation);
        if (!pairs.has(symbol2)) {
          pairs.set(symbol2, new Map());
        }
        pairs.get(symbol2)!.set(symbol1, correlation);

        totalCorrelation += Math.abs(correlation);
        correlationCount++;
      }
    }

    const avgCorrelation = correlationCount > 0 ? totalCorrelation / correlationCount : 0;

    // Determine regime based on average correlation
    let regime: CorrelationRegime = 'NEUTRAL';
    if (avgCorrelation >= this.config.riskOffCorrelationThreshold) {
      regime = 'RISK_OFF';
    } else if (avgCorrelation <= this.config.riskOnCorrelationThreshold) {
      regime = 'RISK_ON';
    }

    const matrix: CorrelationMatrix = {
      pairs,
      regime,
      avgCorrelation,
      calculatedAt: new Date(),
    };

    // Cache the result
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + this.CACHE_TTL_HOURS);
    this.cache.set(cacheKey, { matrix, expiresAt });

    return matrix;
  }

  /**
   * Get correlation between two symbols
   */
  getCorrelation(matrix: CorrelationMatrix, symbol1: string, symbol2: string): number {
    return matrix.pairs.get(symbol1)?.get(symbol2) ?? 0;
  }

  /**
   * Find groups of highly correlated assets
   */
  findCorrelatedGroups(matrix: CorrelationMatrix, threshold: number = this.config.highCorrelationThreshold): string[][] {
    const symbols = Array.from(matrix.pairs.keys());
    const visited = new Set<string>();
    const groups: string[][] = [];

    for (const symbol of symbols) {
      if (visited.has(symbol)) continue;

      const group = [symbol];
      visited.add(symbol);

      // Find all symbols correlated with this one
      for (const otherSymbol of symbols) {
        if (visited.has(otherSymbol)) continue;

        const correlation = Math.abs(this.getCorrelation(matrix, symbol, otherSymbol));
        if (correlation >= threshold) {
          group.push(otherSymbol);
          visited.add(otherSymbol);
        }
      }

      if (group.length > 1) {
        groups.push(group);
      }
    }

    return groups;
  }

  /**
   * Assess portfolio exposure and correlation risk
   */
  async assessPortfolioExposure(sessionIds?: string[]): Promise<PortfolioExposure> {
    // Get all open positions
    const whereClause: any = { qty: { gt: 0 } };
    if (sessionIds && sessionIds.length > 0) {
      whereClause.sessionId = { in: sessionIds };
    }

    const positions = await prisma.position.findMany({
      where: whereClause,
      select: { symbol: true, qty: true, entryPrice: true },
    });

    if (positions.length === 0) {
      return {
        totalPositions: 0,
        highlyCorrelatedGroups: [],
        overexposedSymbols: [],
        riskMultiplier: 1.0,
        correlationRegime: 'NEUTRAL',
        warnings: [],
      };
    }

    const symbols = [...new Set(positions.map(p => p.symbol))];
    const matrix = await this.calculateCorrelationMatrix(symbols);

    // Find highly correlated groups
    const highlyCorrelatedGroups = this.findCorrelatedGroups(
      matrix, 
      this.config.extremeCorrelationThreshold
    );

    // Check for overexposure
    const warnings: string[] = [];
    const overexposedSymbols: string[] = [];

    // Check if we have too many highly correlated positions
    const extremelyCorrelatedCount = highlyCorrelatedGroups.reduce(
      (sum, group) => sum + group.length, 
      0
    );

    if (extremelyCorrelatedCount > this.config.maxCorrelatedPositions) {
      warnings.push(
        `${extremelyCorrelatedCount} highly correlated positions exceed limit of ${this.config.maxCorrelatedPositions}`
      );
      
      // Mark symbols in largest correlated group as overexposed
      const largestGroup = highlyCorrelatedGroups.reduce(
        (max, group) => group.length > max.length ? group : max,
        [] as string[]
      );
      overexposedSymbols.push(...largestGroup);
    }

    // Calculate risk multiplier based on regime
    let riskMultiplier = 1.0;
    if (matrix.regime === 'RISK_OFF') {
      riskMultiplier = this.config.riskOffMultiplier;
      warnings.push(
        `RISK_OFF regime detected (avg correlation: ${matrix.avgCorrelation.toFixed(2)})`
      );
    }

    // Additional penalty for highly correlated positions
    if (extremelyCorrelatedCount > 0) {
      riskMultiplier *= this.config.highCorrelationMultiplier;
    }

    return {
      totalPositions: positions.length,
      highlyCorrelatedGroups,
      overexposedSymbols,
      riskMultiplier,
      correlationRegime: matrix.regime,
      warnings,
    };
  }

  /**
   * Check if opening a new position would create correlation risk
   */
  async checkNewPositionCorrelation(
    newSymbol: string,
    sessionIds?: string[]
  ): Promise<{
    allowed: boolean;
    riskMultiplier: number;
    reason?: string;
  }> {
    // Get current positions
    const whereClause: any = { qty: { gt: 0 } };
    if (sessionIds && sessionIds.length > 0) {
      whereClause.sessionId = { in: sessionIds };
    }

    const positions = await prisma.position.findMany({
      where: whereClause,
      select: { symbol: true },
    });

    if (positions.length === 0) {
      return { allowed: true, riskMultiplier: 1.0 };
    }

    const existingSymbols = [...new Set(positions.map(p => p.symbol))];
    const allSymbols = [...existingSymbols, newSymbol];

    const matrix = await this.calculateCorrelationMatrix(allSymbols);

    // Check correlation with existing positions
    let highlyCorrelatedCount = 0;
    let maxCorrelation = 0;

    for (const existingSymbol of existingSymbols) {
      const correlation = Math.abs(this.getCorrelation(matrix, newSymbol, existingSymbol));
      maxCorrelation = Math.max(maxCorrelation, correlation);
      
      if (correlation >= this.config.extremeCorrelationThreshold) {
        highlyCorrelatedCount++;
      }
    }

    // Check if adding this position would exceed limits
    const exposure = await this.assessPortfolioExposure(sessionIds);
    const totalHighlyCorrelated = exposure.overexposedSymbols.length + 
      (highlyCorrelatedCount > 0 ? 1 : 0);

    if (totalHighlyCorrelated > this.config.maxCorrelatedPositions) {
      return {
        allowed: false,
        riskMultiplier: 0,
        reason: `Would exceed correlated position limit (${totalHighlyCorrelated} > ${this.config.maxCorrelatedPositions})`,
      };
    }

    // Calculate risk multiplier based on correlation and regime
    let riskMultiplier = 1.0;

    if (matrix.regime === 'RISK_OFF') {
      riskMultiplier *= this.config.riskOffMultiplier;
    }

    if (highlyCorrelatedCount > 0) {
      riskMultiplier *= this.config.highCorrelationMultiplier;
    }

    return {
      allowed: true,
      riskMultiplier,
      reason: highlyCorrelatedCount > 0 
        ? `Highly correlated with ${highlyCorrelatedCount} existing positions (max: ${maxCorrelation.toFixed(2)})`
        : undefined,
    };
  }

  /**
   * Clear correlation cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get current cache statistics
   */
  getCacheStats(): { size: number; entries: string[] } {
    return {
      size: this.cache.size,
      entries: Array.from(this.cache.keys()),
    };
  }
}

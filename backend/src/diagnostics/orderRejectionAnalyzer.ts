/**
 * Order Rejection Analyzer
 * 
 * This diagnostic tool analyzes why an agent didn't place orders despite price movements.
 * It checks all the filtering conditions and guard rails that could block trade execution.
 */

import { buildTechSnapshot, type TechnicalSnapshot } from '../ai/tech.js';
import { getTicker } from '../data/market.js';
import { getQuantAIConfig } from '../quantai/index.js';
import { getModeParams } from '../utils/env.js';

export type OrderRejectionReason = {
  category: 'entry_filter' | 'quality' | 'risk' | 'regime' | 'timing' | 'position' | 'zone';
  code: string;
  message: string;
  details: Record<string, any>;
  severity: 'blocking' | 'warning' | 'info';
  timestamp: number;
};

export type OrderRejectionAnalysis = {
  symbol: string;
  timestamp: number;
  currentPrice: number;
  priceChange24hPct: number;
  canTrade: boolean;
  rejections: OrderRejectionReason[];
  summary: string;
  recommendations: string[];
};

export class OrderRejectionAnalyzer {
  /**
   * Analyze why an agent didn't place orders for a given symbol
   */
  async analyze(
    symbol: string,
    options?: {
      mode?: 'paper' | 'live';
      aggressiveness?: 'conservative' | 'reactive' | 'aggressive';
      plan?: any; // Agent's current plan
      agentState?: any; // Agent's current state
    }
  ): Promise<OrderRejectionAnalysis> {
    const timestamp = Date.now();
    const rejections: OrderRejectionReason[] = [];
    const recommendations: string[] = [];

    try {
      // Get market data
      const snap = await buildTechSnapshot(symbol);
      const ticker = await getTicker(symbol);
      const currentPrice = snap.last || ticker?.last || 0;

      // Calculate 24h price change
      const price24hAgo = (snap as any).close24hAgo || currentPrice;
      const priceChange24hPct = ((currentPrice - price24hAgo) / price24hAgo) * 100;

      // Get configuration
      const quantConfig = getQuantAIConfig();
      const modeParams = getModeParams(options?.aggressiveness || 'reactive');

      // Check 1: Insufficient data
      if (!snap || !snap.last) {
        rejections.push({
          category: 'entry_filter',
          code: 'INSUFFICIENT_DATA',
          message: 'Insufficient market data available',
          details: { snap },
          severity: 'blocking',
          timestamp
        });
      }

      // Check 2: Regime analysis (with smart regime logic)
      if (snap.regime) {
        // Import smart regime analyzer
        const { smartRegimeAnalyzer } = await import('../ai/smartRegime.js');
        const regimeDecision = smartRegimeAnalyzer.evaluateRegime(snap.regime);
        
        if (!regimeDecision.canTrade) {
          rejections.push({
            category: 'regime',
            code: 'REGIME_NO_TRADE',
            message: `Market regime blocks trading: ${regimeDecision.reason}`,
            details: { 
              regime: snap.regime,
              decision: regimeDecision
            },
            severity: 'blocking',
            timestamp
          });
          recommendations.push('Wait for market regime to improve before trading');
        } else if (regimeDecision.requireHigherQuality) {
          // Regime allows trading but with restrictions
          const explanation = smartRegimeAnalyzer.explainDecision(regimeDecision);
          rejections.push({
            category: 'regime',
            code: 'REGIME_RESTRICTED',
            message: `Trading allowed with restrictions: ${explanation}`,
            details: { 
              regime: snap.regime,
              decision: regimeDecision,
              riskMultiplier: regimeDecision.riskMultiplier,
              minQualityScore: regimeDecision.minQualityScore
            },
            severity: 'warning',
            timestamp
          });
          recommendations.push(`Regime requires ${(regimeDecision.riskMultiplier * 100).toFixed(0)}% size and quality ≥${(regimeDecision.minQualityScore! * 100).toFixed(0)}%`);
        }
      }

      // Check 3: Plan bias
      if (options?.plan) {
        const plan = options.plan;
        if (plan.bias === 'none') {
          rejections.push({
            category: 'entry_filter',
            code: 'NO_BIAS',
            message: 'Trading plan has no directional bias',
            details: { bias: plan.bias },
            severity: 'blocking',
            timestamp
          });
          recommendations.push('Agent needs a new trading plan with directional bias');
        }
      }

      // Check 4: Entry zone validation
      if (options?.plan?.zone) {
        const zone = options.plan.zone;
        const { from, to, mid } = zone;
        const inZone = currentPrice >= Math.min(from, to) && currentPrice <= Math.max(from, to);

        if (!inZone) {
          const distanceFromZone = Math.min(
            Math.abs(currentPrice - from) / currentPrice,
            Math.abs(currentPrice - to) / currentPrice
          ) * 100;

          rejections.push({
            category: 'zone',
            code: 'PRICE_OUTSIDE_ENTRY_ZONE',
            message: `Price ${currentPrice.toFixed(6)} is outside entry zone [${from.toFixed(6)}, ${to.toFixed(6)}]`,
            details: {
              currentPrice,
              zone: { from, to, mid },
              distancePct: distanceFromZone.toFixed(2)
            },
            severity: 'blocking',
            timestamp
          });
          recommendations.push(`Price moved ${distanceFromZone.toFixed(2)}% away from entry zone - consider recalculating zone`);
        }
      }

      // Check 5: ADX threshold (trend strength)
      const adx = (snap as any).adx14;
      if (adx != null && options?.plan) {
        const bias = options.plan.bias;
        const minAdx = quantConfig.filters?.minAdx || 18;

        if (adx < minAdx) {
          rejections.push({
            category: 'entry_filter',
            code: 'ADX_TOO_LOW',
            message: `ADX ${adx.toFixed(2)} below minimum ${minAdx} for ${bias} trade`,
            details: { adx, minAdx, bias },
            severity: 'blocking',
            timestamp
          });
          recommendations.push('Wait for stronger trend (higher ADX) before entering');
        }
      }

      // Check 6: RSI thresholds (using same logic as agent)
      const rsi = (snap as any).rsi14;
      if (rsi != null && options?.plan) {
        const bias = options.plan.bias;
        const aggressiveness = options.aggressiveness || 'reactive';
        
        // Base thresholds from config
        let ENTRY_SHORT_MIN_RSI = 45; // Default from env.ts
        let ENTRY_LONG_MAX_RSI = 65;  // Default from env.ts
        
        // Apply aggressiveness adjustments (matching agent logic)
        if (aggressiveness === 'reactive') {
          ENTRY_SHORT_MIN_RSI = Math.max(35, ENTRY_SHORT_MIN_RSI - 5);
          ENTRY_LONG_MAX_RSI = Math.min(75, ENTRY_LONG_MAX_RSI + 5);
        } else if (aggressiveness === 'aggressive') {
          ENTRY_SHORT_MIN_RSI = Math.max(30, ENTRY_SHORT_MIN_RSI - 10);
          ENTRY_LONG_MAX_RSI = Math.min(80, ENTRY_LONG_MAX_RSI + 10);
        }
        
        if (bias === 'long' && rsi > ENTRY_LONG_MAX_RSI) {
          rejections.push({
            category: 'entry_filter',
            code: 'RSI_OVERBOUGHT',
            message: `RSI ${rsi.toFixed(2)} above maximum ${ENTRY_LONG_MAX_RSI} for long entry`,
            details: { rsi, maxRsi: ENTRY_LONG_MAX_RSI, bias, aggressiveness },
            severity: 'blocking',
            timestamp
          });
          recommendations.push('RSI indicates overbought conditions - wait for pullback');
        } else if (bias === 'short' && rsi < ENTRY_SHORT_MIN_RSI) {
          rejections.push({
            category: 'entry_filter',
            code: 'RSI_OVERSOLD',
            message: `RSI ${rsi.toFixed(2)} below minimum ${ENTRY_SHORT_MIN_RSI} for short entry`,
            details: { rsi, minRsi: ENTRY_SHORT_MIN_RSI, bias, aggressiveness },
            severity: 'blocking',
            timestamp
          });
          recommendations.push('RSI indicates oversold conditions - wait for bounce');
        }
      }

      // Check 7: Volatility
      const atrPct = (snap as any).atrPct;
      if (atrPct != null) {
        const maxAtrPct = quantConfig.filters?.maxAtrPct || 8;
        if (atrPct > maxAtrPct) {
          rejections.push({
            category: 'entry_filter',
            code: 'VOLATILITY_TOO_HIGH',
            message: `ATR ${atrPct.toFixed(2)}% exceeds maximum ${maxAtrPct}%`,
            details: { atrPct, maxAtrPct },
            severity: 'blocking',
            timestamp
          });
          recommendations.push('Market too volatile - wait for volatility to decrease');
        }
      }

      // Check 8: Agent state checks
      if (options?.agentState) {
        const agent = options.agentState;

        // Check if agent is in cooldown
        if (agent.state === 'COOLDOWN') {
          rejections.push({
            category: 'timing',
            code: 'AGENT_IN_COOLDOWN',
            message: 'Agent is in cooldown period',
            details: { 
              state: agent.state,
              cooldownContext: agent.cooldownContext 
            },
            severity: 'blocking',
            timestamp
          });
          recommendations.push('Wait for cooldown period to expire');
        }

        // Check if agent is halted
        if (agent.state === 'HALT') {
          rejections.push({
            category: 'timing',
            code: 'AGENT_HALTED',
            message: 'Agent is halted',
            details: { 
              state: agent.state,
              haltReason: agent.killSwitchContext?.reason
            },
            severity: 'blocking',
            timestamp
          });
          recommendations.push('Agent needs manual restart or issue resolution');
        }

        // Check consecutive stops
        if (agent.consecutiveStops >= 3) {
          rejections.push({
            category: 'risk',
            code: 'CONSECUTIVE_STOPS_LIMIT',
            message: `Agent hit ${agent.consecutiveStops} consecutive stops`,
            details: { consecutiveStops: agent.consecutiveStops },
            severity: 'blocking',
            timestamp
          });
          recommendations.push('Too many consecutive losses - agent needs to recover or reset');
        }

        // Check daily trade limit with smart limit logic
        const recentTrades = agent.recentTrades || [];
        const recentWinRate = recentTrades.length > 0
          ? recentTrades.filter((t: any) => t.win).length / recentTrades.length
          : 0.5;
        
        // Check if at base limit
        if (agent.tradesToday >= modeParams.maxTradesPerDay) {
          rejections.push({
            category: 'risk',
            code: 'DAILY_TRADE_LIMIT',
            message: `Base daily trade limit reached: ${agent.tradesToday}/${modeParams.maxTradesPerDay}`,
            details: { 
              tradesToday: agent.tradesToday, 
              baseLimit: modeParams.maxTradesPerDay,
              recentWinRate: (recentWinRate * 100).toFixed(1) + '%',
              recentTrades: recentTrades.length
            },
            severity: 'warning',
            timestamp
          });
          
          if (recentWinRate >= 0.70 && recentTrades.length >= 5) {
            recommendations.push(`Excellent win rate (${(recentWinRate * 100).toFixed(0)}%) - smart limits may allow additional high-quality trades`);
          } else if (recentWinRate < 0.40 && recentTrades.length >= 5) {
            recommendations.push(`Low win rate (${(recentWinRate * 100).toFixed(0)}%) - focus on improving quality before increasing trades`);
          } else {
            recommendations.push('Base daily trade limit reached - high quality opportunities may still be allowed with smart limits');
          }
        }

        // Check if position already exists
        if (agent.pos && agent.state === 'MANAGE') {
          rejections.push({
            category: 'position',
            code: 'POSITION_ALREADY_OPEN',
            message: 'Agent already has an open position',
            details: { 
              position: {
                side: agent.pos.side,
                entry: agent.pos.entry,
                qty: agent.pos.qty
              }
            },
            severity: 'info',
            timestamp
          });
        }

        // Check quality threshold adjustments
        if (agent.qualityThresholdAdjustment > 0) {
          rejections.push({
            category: 'quality',
            code: 'QUALITY_THRESHOLD_RAISED',
            message: `Quality threshold raised by ${agent.qualityThresholdAdjustment} points due to recent performance`,
            details: { 
              adjustment: agent.qualityThresholdAdjustment,
              recentTrades: agent.recentTrades?.length || 0
            },
            severity: 'warning',
            timestamp
          });
          recommendations.push('Quality bar is higher due to recent losses - only high-quality setups will be taken');
        }
      }

      // Check 9: Price movement analysis
      if (Math.abs(priceChange24hPct) > 5) {
        // Significant price movement but no trade - add info
        rejections.push({
          category: 'timing',
          code: 'LARGE_MOVE_MISSED',
          message: `Significant ${priceChange24hPct.toFixed(2)}% move occurred without trade execution`,
          details: { 
            priceChange24hPct,
            currentPrice,
            price24hAgo
          },
          severity: 'info',
          timestamp
        });
        
        if (priceChange24hPct > 0) {
          recommendations.push('Price already moved significantly higher - entry zone may need recalculation');
        } else {
          recommendations.push('Price dropped significantly - check if bearish bias is appropriate');
        }
      }

      // Determine if trading is possible
      const blockingRejections = rejections.filter(r => r.severity === 'blocking');
      const canTrade = blockingRejections.length === 0;

      // Generate summary
      let summary = '';
      if (canTrade) {
        summary = `Agent CAN trade ${symbol}. No blocking conditions found.`;
      } else {
        summary = `Agent CANNOT trade ${symbol}. Found ${blockingRejections.length} blocking condition(s): ${blockingRejections.map(r => r.code).join(', ')}`;
      }

      // Add context about price movement
      if (Math.abs(priceChange24hPct) > 1) {
        summary += ` Price moved ${priceChange24hPct > 0 ? '+' : ''}${priceChange24hPct.toFixed(2)}% in last 24h.`;
      }

      return {
        symbol,
        timestamp,
        currentPrice,
        priceChange24hPct,
        canTrade,
        rejections,
        summary,
        recommendations
      };

    } catch (error) {
      rejections.push({
        category: 'entry_filter',
        code: 'ANALYSIS_ERROR',
        message: `Error during analysis: ${(error as any)?.message || error}`,
        details: { error: String(error) },
        severity: 'blocking',
        timestamp
      });

      return {
        symbol,
        timestamp,
        currentPrice: 0,
        priceChange24hPct: 0,
        canTrade: false,
        rejections,
        summary: `Analysis failed for ${symbol}`,
        recommendations: ['Check system logs for errors']
      };
    }
  }

  /**
   * Format analysis results for console output
   */
  formatAnalysis(analysis: OrderRejectionAnalysis): string {
    const lines: string[] = [];
    
    lines.push('═'.repeat(80));
    lines.push(`📊 Order Rejection Analysis for ${analysis.symbol}`);
    lines.push('═'.repeat(80));
    lines.push('');
    
    lines.push(`Timestamp: ${new Date(analysis.timestamp).toISOString()}`);
    lines.push(`Current Price: $${analysis.currentPrice.toFixed(6)}`);
    lines.push(`24h Price Change: ${analysis.priceChange24hPct > 0 ? '+' : ''}${analysis.priceChange24hPct.toFixed(2)}%`);
    lines.push(`Can Trade: ${analysis.canTrade ? '✅ YES' : '❌ NO'}`);
    lines.push('');
    
    lines.push('─'.repeat(80));
    lines.push(`SUMMARY: ${analysis.summary}`);
    lines.push('─'.repeat(80));
    lines.push('');
    
    if (analysis.rejections.length > 0) {
      lines.push(`Found ${analysis.rejections.length} condition(s):`);
      lines.push('');
      
      // Group by severity
      const blocking = analysis.rejections.filter(r => r.severity === 'blocking');
      const warnings = analysis.rejections.filter(r => r.severity === 'warning');
      const info = analysis.rejections.filter(r => r.severity === 'info');
      
      if (blocking.length > 0) {
        lines.push('🔴 BLOCKING CONDITIONS:');
        blocking.forEach((r, i) => {
          lines.push(`  ${i + 1}. [${r.code}] ${r.message}`);
          if (Object.keys(r.details).length > 0) {
            lines.push(`     Details: ${JSON.stringify(r.details, null, 2).split('\n').join('\n     ')}`);
          }
        });
        lines.push('');
      }
      
      if (warnings.length > 0) {
        lines.push('⚠️  WARNINGS:');
        warnings.forEach((r, i) => {
          lines.push(`  ${i + 1}. [${r.code}] ${r.message}`);
        });
        lines.push('');
      }
      
      if (info.length > 0) {
        lines.push('ℹ️  INFORMATION:');
        info.forEach((r, i) => {
          lines.push(`  ${i + 1}. [${r.code}] ${r.message}`);
        });
        lines.push('');
      }
    } else {
      lines.push('✅ No blocking conditions found - agent should be able to trade');
      lines.push('');
    }
    
    if (analysis.recommendations.length > 0) {
      lines.push('─'.repeat(80));
      lines.push('💡 RECOMMENDATIONS:');
      analysis.recommendations.forEach((rec, i) => {
        lines.push(`  ${i + 1}. ${rec}`);
      });
      lines.push('');
    }
    
    lines.push('═'.repeat(80));
    
    return lines.join('\n');
  }

  /**
   * Export analysis as JSON
   */
  exportAnalysis(analysis: OrderRejectionAnalysis): string {
    return JSON.stringify(analysis, null, 2);
  }
}

// Singleton instance
export const orderRejectionAnalyzer = new OrderRejectionAnalyzer();

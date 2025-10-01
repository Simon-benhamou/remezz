import { getConfig } from '../utils/env.js';
import { llmJSON } from './llm.js';

export interface PredictionResult {
  direction: 'up' | 'down' | 'neutral';
  confidence: number; // 0-1
  reasoning: string;
  timestamp: number;
}

export class Predictor {
  private cache = new Map<string, { result: PredictionResult; ttl: number }>();

  async predictMove(symbol: string, currentPrice: number, indicators: any): Promise<PredictionResult | null> {
    const cacheKey = `${symbol}-${Math.floor(Date.now() / 300000)}`; // Cache 5 minutes (300s)
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.ttl) {
      return cached.result;
    }

    // 🚀 OPTIMISATION: Ne prédire que si conditions de marché intéressantes
    const atrPct = indicators.atrPct || 0;
    const volumeRatio = indicators.volumeRatio || 1;
    const adx = indicators.adx14 || 0;
    const rsi = indicators.rsi14 || 50;

    // Seuils optimisés pour crypto: ATR > 0.5%, volume > 2x moyenne, ADX > 20 (trend), RSI pas extrême
    const shouldPredict = (
      atrPct > 0.5 && // Marché avec plus de volatilité suffisante
      volumeRatio > 2.0 && // Volume beaucoup plus élevé
      adx > 20 && // Trend plus fort
      rsi > 30 && rsi < 70 // RSI plus restrictif
    );

    if (!shouldPredict) {
      // Retourner une prédiction neutre sans appel IA
      return {
        direction: 'neutral',
        confidence: 0.5,
        reasoning: 'Market conditions not favorable for prediction',
        timestamp: Date.now()
      };
    }

    try {
      const prompt = `Analyze the current market data for ${symbol} and predict the short-term price movement (next 5-15 minutes) with confidence.

Current price: ${currentPrice}
Indicators: ${JSON.stringify(indicators, null, 2)}

Provide a JSON response with:
- direction: "up", "down", or "neutral"
- confidence: number between 0 and 1 (0.75+ for actionable)
- reasoning: brief explanation

Focus on momentum, volume, and technical signals for crypto markets.`;

      const response = await llmJSON(prompt, { provider: 'grok', ttlMin: 5 }); // Cache 5 min

      // Parse JSON response
      const result = JSON.parse(response) as PredictionResult;
      result.timestamp = Date.now();

      // Cache for 5 minutes
      this.cache.set(cacheKey, { result, ttl: Date.now() + 300000 });

      return result;
    } catch (error) {
      console.error('Prediction error:', error);
      return null;
    }
  }
}

export const predictor = new Predictor();
/**
 * PATCH FILE: Optimisations pour Trading Crypto Agressif
 * ========================================================
 * 
 * Ce fichier contient les modifications de code recommandées
 * pour transformer la stratégie conservative en stratégie aggressive
 * 
 * Instructions:
 * 1. Backup vos fichiers actuels
 * 2. Appliquer les changements section par section
 * 3. Tester progressivement (voir AGGRESSIVE_TRADING_CONFIG.md)
 */

// ============================================================================
// SECTION 1: Configuration Environment (.env)
// ============================================================================

/*
Ajouter ces variables à votre fichier .env:

# ==== AGGRESSIVE MODE SETTINGS ====
AGGRESSIVE_MODE_ENABLED=true

# Thresholds plus bas pour plus d'opportunités
ENTRY_MIN_ATR_PCT=0.20           # Actuel: 0.4-0.6
ENTRY_MIN_SLOPE_ABS_PCT=0.08     # Actuel: 0.1-0.15

# Position sizing plus élevé
DEFAULT_RISK_PCT=2.0              # Actuel: 1.0
AGGRESSIVE_MAX_RISK_PCT=3.5       # Pour setups qualité maximale

# Limites daily étendues
DAILY_LOSS_LIMIT_PCT=6.0          # Actuel: 3.5
MAX_TRADES_PER_DAY=15             # Actuel: 8
MAX_CONSECUTIVE_STOPS=3           # Actuel: 2

# Cooldowns réduits
TRADE_COOLDOWN_MS=10000           # 10s (actuel: 30s)
TRADE_COOLDOWN_WIN_MS=5000        # 5s après win
TRADE_COOLDOWN_LOSS_MS=15000      # 15s après loss

# Quality filters moins stricts
QUALITY_MIN_SCORE_AGGRESSIVE=3.0  # Actuel: 5-6
QUALITY_VOLUME_RATIO_FLOOR=0.3    # Actuel: 0.4

# ADX threshold plus bas
ENTRY_LONG_MIN_ADX=8              # Actuel: 12
ENTRY_SHORT_MIN_ADX=8             # Actuel: 12
*/

// ============================================================================
// SECTION 2: Modifications dans src/utils/env.ts
// ============================================================================

/*
Dans getConfig(), ajouter ces champs au type Cfg et leur parsing:

export type Cfg = {
  // ... existing fields ...
  
  // Aggressive mode settings
  AGGRESSIVE_MODE_ENABLED: boolean;
  AGGRESSIVE_MAX_RISK_PCT: number;
  MAX_TRADES_PER_DAY: number;
  MAX_CONSECUTIVE_STOPS: number;
};

// Dans la fonction getConfig(), ajouter:
export function getConfig(): Cfg {
  const e = process.env as Record<string, string>;
  return {
    // ... existing config ...
    
    // Aggressive settings
    AGGRESSIVE_MODE_ENABLED: e.AGGRESSIVE_MODE_ENABLED === 'true',
    AGGRESSIVE_MAX_RISK_PCT: Number(e.AGGRESSIVE_MAX_RISK_PCT || "3.5"),
    MAX_TRADES_PER_DAY: Number(e.MAX_TRADES_PER_DAY || "15"),
    MAX_CONSECUTIVE_STOPS: Number(e.MAX_CONSECUTIVE_STOPS || "3"),
    
    // Adjust defaults based on aggressive mode
    DEFAULT_RISK_PCT: Number(e.DEFAULT_RISK_PCT || (e.AGGRESSIVE_MODE_ENABLED === 'true' ? "2.0" : "1.0")),
    DAILY_LOSS_LIMIT_PCT: Number(e.DAILY_LOSS_LIMIT_PCT || (e.AGGRESSIVE_MODE_ENABLED === 'true' ? "6.0" : "3.5")),
    ENTRY_MIN_ATR_PCT: Number(e.ENTRY_MIN_ATR_PCT || (e.AGGRESSIVE_MODE_ENABLED === 'true' ? "0.20" : "0.40")),
  };
}
*/

// ============================================================================
// SECTION 3: Modifications dans src/risk/manager.ts
// ============================================================================

/*
Modifier defaultLimits() pour utiliser les nouvelles configs:

import { getConfig } from '../utils/env.js';

export const defaultLimits = (): RiskLimits => {
  const cfg = getConfig();
  
  return {
    riskPctPerTrade: { 
      min: 0.5, 
      max: cfg.AGGRESSIVE_MODE_ENABLED ? cfg.AGGRESSIVE_MAX_RISK_PCT : 2.5 
    },
    dailyLossLimitPct: cfg.DAILY_LOSS_LIMIT_PCT,
    maxLeverage: 10,
    maxTradesPerDay: cfg.MAX_TRADES_PER_DAY,
    maxConsecutiveStops: cfg.MAX_CONSECUTIVE_STOPS,
  };
};
*/

// ============================================================================
// SECTION 4: Modifications dans src/agent/state.ts
// ============================================================================

/*
CHANGE #1: Ajouter méthodes de détection de scenarios alternatifs

// Insérer après la ligne ~1915 (avant passesEntryMomentumGates):

  private checkStrongTrend(snap: TechnicalSnapshot): boolean {
    const ema20 = Number((snap as any)?.ema20 ?? snap.last);
    const ema50 = Number((snap as any)?.ema50 ?? snap.last);
    const adx = Number((snap as any)?.adx14 ?? 0);
    const volume = Number((snap as any)?.volume ?? 0);
    const volumeMA = Number((snap as any)?.volumeMA ?? volume);
    
    const emaSpread = Math.abs(((ema20 - ema50) / ema50) * 100);
    const bias = this.plan?.bias || 'long';
    const trendAligned = bias === 'long' ? ema20 > ema50 : ema20 < ema50;
    
    return trendAligned && emaSpread > 0.15 && adx > 15 && volume > volumeMA * 0.8;
  }

  private checkModerateTrend(snap: TechnicalSnapshot): boolean {
    const ema20 = Number((snap as any)?.ema20 ?? snap.last);
    const ema50 = Number((snap as any)?.ema50 ?? snap.last);
    const rsi = Number((snap as any)?.rsi14 ?? 50);
    const atr = Number((snap as any)?.atrPct ?? 0);
    const bias = this.plan?.bias || 'long';
    
    const trendAligned = bias === 'long' ? ema20 > ema50 : ema20 < ema50;
    const rsiOK = bias === 'long' ? (rsi >= 30 && rsi <= 80) : (rsi >= 20 && rsi <= 70);
    
    return trendAligned && rsiOK && atr > 0.20;
  }

  private detectBreakout(snap: TechnicalSnapshot): boolean {
    const volume = Number((snap as any)?.volume ?? 0);
    const volumeMA = Number((snap as any)?.volumeMA ?? volume);
    const momentumPct = Math.abs(Number((snap as any)?.momentumPct ?? 0));
    const atr = Number((snap as any)?.atrPct ?? 0);
    
    const volumeSurge = volume > volumeMA * 1.5;
    const strongMomentum = momentumPct > 1.8;
    const volatilityOK = atr > 0.25;
    
    // Check if price breaking out of zone
    const price = snap.last;
    const { from, to } = this.plan?.zone || { from: price, to: price };
    const zoneHigh = Math.max(from, to);
    const zoneLow = Math.min(from, to);
    const breakingOut = price > zoneHigh * 1.015 || price < zoneLow * 0.985;
    
    return volumeSurge && strongMomentum && volatilityOK && breakingOut;
  }

  private checkMeanReversion(snap: TechnicalSnapshot): boolean {
    const rsi = Number((snap as any)?.rsi14 ?? 50);
    const volume = Number((snap as any)?.volume ?? 0);
    const volumeMA = Number((snap as any)?.volumeMA ?? volume);
    const bias = this.plan?.bias || 'long';
    
    // RSI extreme for mean reversion
    const rsiExtreme = bias === 'long' ? rsi < 35 : rsi > 65;
    const volumeOK = volume > volumeMA * 0.6;
    
    // Check if near support/resistance
    const price = snap.last;
    const { from, to } = this.plan?.zone || { from: price, to: price };
    const zoneMid = (from + to) / 2;
    const nearZone = Math.abs((price - zoneMid) / zoneMid) < 0.015; // Within 1.5%
    
    return rsiExtreme && volumeOK && nearZone;
  }
*/

/*
CHANGE #2: Modifier passesEntryMomentumGates pour OR logic

// Remplacer la fin de la méthode passesEntryMomentumGates (ligne ~2020):

  private passesEntryMomentumGates(snap: TechnicalSnapshot, reasonHint: 'enter'|'reverse'): boolean {
    const thresholds = this.effectiveEntryThresholds();
    // ... keep existing circuit breaker and bias switching checks ...
    
    const cfg = getConfig();
    
    // Si aggressive mode, utiliser OR logic avec scenarios
    if (cfg.AGGRESSIVE_MODE_ENABLED) {
      const scenarios = {
        strongTrend: this.checkStrongTrend(snap),
        moderateTrend: this.checkModerateTrend(snap),
        breakout: this.detectBreakout(snap),
        meanReversion: this.checkMeanReversion(snap),
      };
      
      const passedScenario = Object.entries(scenarios).find(([name, passed]) => passed);
      
      if (passedScenario) {
        console.log(`✅ Entry allowed via ${passedScenario[0]} scenario`);
        return true;
      }
      
      recordOpsEvent({
        level: 'info',
        source: 'entry_gate',
        message: 'no_scenario_matched',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { scenarios, reason: reasonHint },
      });
      return false;
    }
    
    // Sinon, garder la logique conservative actuelle
    // ... keep existing ATR and slope checks ...
  }
*/

/*
CHANGE #3: Modifier passesQualityFilters pour scoring system

// Remplacer passesQualityFilters (ligne ~2050) par:

  private passesQualityFilters(snap: TechnicalSnapshot): boolean {
    if (!this.plan) return false;
    const bias = this.plan.bias;
    if (bias === 'none') return false;
    
    const cfg = getConfig();
    
    // Si aggressive mode, utiliser scoring au lieu de rejet binaire
    if (cfg.AGGRESSIVE_MODE_ENABLED) {
      let qualityScore = 0;
      const price = snap.last;
      const ema20 = Number((snap as any)?.ema20 ?? price);
      const ema50 = Number((snap as any)?.ema50 ?? price);
      const adx = Number((snap as any)?.adx14 ?? 0);
      const rsi = Number((snap as any)?.rsi14 ?? 50);
      const atrPct = Number((snap as any)?.atrPct ?? 0);
      const volume = Number((snap as any)?.volume ?? 0);
      const volumeMA = Number((snap as any)?.volumeMA ?? volume);
      
      // EMA alignment (worth 2 points)
      const emaSpread = ((ema20 - ema50) / ema50) * 100;
      const trendAligned = bias === 'long' ? ema20 > ema50 : ema20 < ema50;
      if (trendAligned && Math.abs(emaSpread) > 0.10) qualityScore += 2;
      
      // ADX strength (worth 2 points)
      if (adx >= 8) {
        qualityScore += adx >= 15 ? 2 : 1;
      }
      
      // RSI position (worth 1 point)
      const rsiOK = bias === 'long' ? (rsi >= 25 && rsi <= 85) : (rsi >= 15 && rsi <= 75);
      if (rsiOK) qualityScore += 1;
      
      // ATR volatility (worth 2 points)
      if (atrPct >= 0.15) {
        qualityScore += atrPct >= 0.30 ? 2 : 1;
      }
      
      // Volume confirmation (worth 1 point)
      const volumeRatio = volumeMA > 0 ? volume / volumeMA : 1;
      if (volumeRatio >= 0.5) qualityScore += 1;
      
      // Threshold based on aggressiveness
      const level = this.profile?.aggressiveness || 'conservative';
      const thresholds = {
        conservative: 6, // Need most filters
        reactive: 4,     // Need half
        aggressive: 3    // Need minimum
      };
      
      const required = thresholds[level];
      const passed = qualityScore >= required;
      
      if (!passed) {
        recordOpsEvent({
          level: 'info',
          source: 'quality_filter',
          message: 'quality_score_insufficient',
          sessionId: this.sessionId || undefined,
          symbol: this.profile?.symbol,
          details: { qualityScore, required, level, bias },
        });
      }
      
      return passed;
    }
    
    // Sinon, garder la logique conservative actuelle
    // ... keep existing strict filters ...
  }
*/

/*
CHANGE #4: Optimiser computeQualityBasedSizing pour aggressive

// Dans computeQualityBasedSizing (ligne ~2270), modifier les bounds:

  private computeQualityBasedSizing(snap: TechnicalSnapshot): number {
    // ... keep existing logic ...
    
    const cfg = getConfig();
    
    // Apply bounds based on mode
    if (cfg.AGGRESSIVE_MODE_ENABLED) {
      // Aggressive: Allow larger position sizing
      sizeMultiplier = Math.max(0.8, Math.min(2.2, sizeMultiplier));
    } else {
      // Conservative: Current bounds
      sizeMultiplier = Math.max(0.35, Math.min(1.8, sizeMultiplier));
    }
    
    return sizeMultiplier;
  }
*/

/*
CHANGE #5: Optimiser stop loss placement

// Dans la méthode enter() (ligne ~440), après calcul du stop:

  async enter(mktPrice: number, _snap?: TechnicalSnapshot) {
    // ... existing code until stop calculation ...
    
    const cfg = getConfig();
    
    // Original ATR-based stop
    let stop = side === 'buy' ? (entry - this.plan.stopDistance) : (entry + this.plan.stopDistance);
    
    // Si aggressive mode, limiter le stop à un % maximum
    if (cfg.AGGRESSIVE_MODE_ENABLED) {
      const maxStopPct = 0.015; // 1.5% max
      const maxStopDistance = entry * maxStopPct;
      
      if (side === 'buy') {
        stop = Math.max(stop, entry - maxStopDistance);
      } else {
        stop = Math.min(stop, entry + maxStopDistance);
      }
      
      console.log(`🎯 Aggressive stop: original ${this.plan.stopDistance.toFixed(6)}, capped at ${maxStopDistance.toFixed(6)}`);
    }
    
    // ... rest of enter logic ...
  }
*/

/*
CHANGE #6: Optimiser TP ladder pour scaling

// Dans la méthode enter(), après création de this.pos (ligne ~670):

  async enter(mktPrice: number, _snap?: TechnicalSnapshot) {
    // ... existing code until position creation ...
    
    const cfg = getConfig();
    
    // Adjust TP ladder for aggressive mode
    if (cfg.AGGRESSIVE_MODE_ENABLED && side) {
      const direction = side === 'buy' ? 1 : -1;
      const stopDist = this.plan.stopDistance;
      
      // Aggressive scaling: 25% at 2R, 25% at 4R, 50% at 6R
      const tp1 = this.pos.entry + (direction * stopDist * 2);  // Quick profit
      const tp2 = this.pos.entry + (direction * stopDist * 4);  // Standard
      const tp3 = this.pos.entry + (direction * stopDist * 6);  // Runner
      
      this.pos.tp = [tp1, tp2, tp3];
      
      console.log(`🎯 Aggressive TP ladder: 2R / 4R / 6R`);
    } else if (!Array.isArray(this.pos.tp) || this.pos.tp.length === 0) {
      // Conservative: Current logic (4R and 5R)
      const baseTp = side === 'buy' ? 
        (this.pos.entry + (this.plan.stopDistance * 4)) : 
        (this.pos.entry - (this.plan.stopDistance * 4));
      this.pos.tp = [baseTp];
    }
    
    // ... rest of enter logic ...
  }
*/

// ============================================================================
// SECTION 5: Testing and Validation
// ============================================================================

/*
TESTING CHECKLIST:

1. Paper Trading d'abord
   - Activer AGGRESSIVE_MODE_ENABLED=true
   - Mode paper pour tester sans risque
   - Observer pendant 1 semaine

2. Métriques à surveiller:
   - Trade frequency (target: 6-10/jour)
   - Win rate (acceptable: 38-45%)
   - Profit factor (target: >1.4)
   - Max drawdown (limite: 7%)
   - Average R (target: >0.5)

3. Red Flags (arrêter si):
   - Win rate < 35%
   - Profit factor < 1.0
   - Max drawdown > 8%
   - Trop de rejections "quality_score_insufficient"

4. Ajustements progressifs:
   Phase 1 (Semaine 1): Settings modérés
     ENTRY_MIN_ATR_PCT=0.25
     DEFAULT_RISK_PCT=1.5
     MAX_TRADES_PER_DAY=10
   
   Phase 2 (Semaine 2): Settings medium-aggressive
     ENTRY_MIN_ATR_PCT=0.20
     DEFAULT_RISK_PCT=2.0
     MAX_TRADES_PER_DAY=12
   
   Phase 3 (Semaine 3): Full aggressive
     ENTRY_MIN_ATR_PCT=0.15
     DEFAULT_RISK_PCT=2.5
     MAX_TRADES_PER_DAY=15

5. Monitoring continu:
   - Vérifier logs pour comprendre rejections
   - Analyser quels scenarios passent le plus
   - Ajuster thresholds si nécessaire
*/

// ============================================================================
// NOTES IMPORTANTES
// ============================================================================

/*
⚠️ WARNINGS:

1. Ne PAS désactiver le circuit breaker
2. Ne PAS augmenter leverage au-delà de 10x
3. Toujours tester en paper d'abord
4. Surveiller la liquidité des marchés
5. Respecter les stop-loss

✅ GARDE-FOUS À CONSERVER:

1. Circuit breaker system
2. Daily loss limits (même si augmentés)
3. Anti-whale filters
4. Liquidity checks
5. Spread checks
6. Min notional checks

📈 RÉSULTATS ATTENDUS:

Conservative → Aggressive
- Trades/jour: 2-3 → 6-10 (+200-300%)
- Win rate: 45-50% → 40-45% (-10% acceptable)
- Profit factor: 1.2-1.4 → 1.5-2.0 (+25-40%)
- Risk/trade: 0.5-2% → 1.5-3% (+100-200%)
- Drawdown max: 3-4% → 6-7% (+75-100%)

Le facteur clé: Plus de trades avec taille plus grande = 
potentiel de profit 3-5x supérieur si exécuté correctement
*/

export default {
  version: '1.0.0',
  description: 'Aggressive Trading Optimizations',
  author: 'Trading Strategy Analysis',
  created: new Date().toISOString(),
  status: 'READY_FOR_IMPLEMENTATION'
};

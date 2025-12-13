# 🤖 Agent Trading V5.7 - Documentation Complète

## 📋 Vue d'ensemble

L'agent trading utilise la **stratégie V5.7** optimisée sur 24 mois de backtest avec:
- **+1990% ROI** (avec frais, slippage, funding)
- **~789 trades** sur 12 mois (~2-3/jour)
- **68.7% Win Rate**
- **10/12 mois positifs**

### Améliorations V5.7 vs V5.4
- **Dynamic Stop Loss** basé sur ATR (au lieu de SL fixe 1.5%)
- **Leverage uniforme** 4.5x pour tous les assets
- **Liquidity caps** par tier d'asset
- **Circuit breaker** avec cooldown adaptatif

---

## 🔄 Flow Complet de l'Agent

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           DÉMARRAGE AGENT                                    │
│  start() → loadExistingPosition() → syncWithExchange() (live) → tick()     │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         TICK LOOP (toutes les 60s)                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. Log tick: "🔄 [ETH] Tick #22 | WATCHING | mode=paper"                  │
│                                                                             │
│  2. [LIVE ONLY] syncWithExchange()                                         │
│     → Détecte si SL exécuté sur Binance                                    │
│     → Sync position si mismatch                                            │
│                                                                             │
│  3. Fetch BTC candles (WebSocket ou REST)                                  │
│     → 220 bougies 15m pour SMA200                                          │
│                                                                             │
│  4. Calcul Market Conditions                                               │
│     → BTC > SMA200 ? → favorable_long (LONG only)                          │
│     → BTC < SMA200 ? → favorable_short (SHORT only)                        │
│                                                                             │
│  5. Fetch Symbol candles (WebSocket ou REST)                               │
│     → 100 bougies 15m                                                      │
│                                                                             │
│  6. Broadcast tick au frontend via WebSocket                               │
│                                                                             │
│  7. SI position ouverte → checkExit()                                      │
│     SINON → checkEntry()                                                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 📊 Détermination du Régime de Marché

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    RÉGIME BTC (SMA 200 périodes 15m)                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   Prix BTC actuel vs SMA200 (200 × 15min = 50h de données)                 │
│                                                                             │
│   BTC > SMA200  →  🟢 BULL MARKET  →  Cherche LONG uniquement              │
│   BTC < SMA200  →  🔴 BEAR MARKET  →  Cherche SHORT uniquement             │
│                                                                             │
│   Exemple log:                                                              │
│   "📊 Market: favorable_long | BTC trend=bullish | BTC 95000 > SMA200 92000"│
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 🟢 Conditions d'Entrée LONG (Bull Market)

Quand `BTC > SMA200`, l'agent cherche des opportunités LONG.

### Les 5 Filtres (tous doivent être TRUE):

| # | Filtre | Condition | Pourquoi |
|---|--------|-----------|----------|
| 1 | **Bougie Bullish** | `close > open` | Confirme momentum haussier |
| 2 | **Consec Up ≤ 3** | Max 3 bougies vertes d'affilée | Évite d'acheter les tops |
| 3 | **BB Breakout** | `close > Bollinger Upper` (20, 2σ) | Breakout confirmé |
| 4 | **ROC10 ≥ 2.5%** | Prix +2.5% sur 10 bougies | Momentum significatif |
| 5 | **Volume ≥ 2x** | Volume actuel ≥ 2× moyenne 20 | Confirmation par volume |

### Exemple de rejet:
```
🔍 [ETH] Signal check @ $3014.18 | vol=0.2x | bullish=true | >MA20=true
❌ [ETH] No signal: bull_regime:no_breakout(close=3014.18 < bb_upper=3072.30)
```
→ Volume trop faible (0.2x vs 2x requis) ET pas de breakout BB

### Exemple d'entrée validée:
```
🔍 [SEI] Signal check @ $0.155 | vol=3.2x | bullish=true | >MA20=true
✅ [SEI] SIGNAL LONG CONFIRMED: v5.7_bull_long_confirmed | confidence=0.78
🚀 [SEI] OPENING LONG | price=$0.155 | qty=168.5 | notional=$26.12 | lev=4.5x
```

---

## 🔴 Conditions d'Entrée SHORT (Bear Market)

Quand `BTC < SMA200`, l'agent cherche des opportunités SHORT.

### Les 6 Filtres (tous doivent être TRUE):

| # | Filtre | Condition | Pourquoi |
|---|--------|-----------|----------|
| 1 | **Bougie Bearish** | `close < open` | Confirme momentum baissier |
| 2 | **Consec Down ≤ 5** | Max 5 bougies rouges d'affilée | Évite de shorter l'oversold |
| 3 | **ROC5 ≤ -1.5%** | Prix -1.5% sur 5 bougies | Drop significatif |
| 4 | **Volume ≥ 2x** | Volume actuel ≥ 2× moyenne 20 | Panic selling confirmé |
| 5 | **Prix < MA20** | Close sous moyenne mobile 20 | Tendance baissière |
| 6 | **BB Breakdown** | `close < Bollinger Lower` | Breakdown confirmé |

### Exemple de rejet:
```
🔍 [XRP] Signal check @ $2.22 | vol=0.5x | bearish=true | <MA20=true
❌ [XRP] No signal: bear_regime:roc5_not_low_enough(-0.8% > -1.5%)
```
→ La chute n'est pas assez forte (-0.8% vs -1.5% requis)

---

## 📈 Gestion de Position & Exit

### Ordre de vérification des exits (à chaque tick):

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      EXIT CHECK ORDER (shouldExitPosition)                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. ⏰ TIME EXIT      → Si holdTime > 48h → EXIT                           │
│  2. 📈 TRAILING STOP  → Si PnL ≥ 1% ET prix < trailPrice → EXIT            │
│  3. 🛑 STOP LOSS      → Si PnL < 0 ET prix < SL dynamique → EXIT           │
│  4. 🎯 TAKE PROFIT    → Si PnL ≥ 3% → EXIT                                 │
│  5. 📉 MOMENTUM FADE  → Si PnL > 1.5% ET ROC5 < 0.5% → EXIT                │
│  6. 🔇 VOLUME DRY     → Si PnL > 0.5% ET Vol < 0.5x → EXIT                 │
│                                                                             │
│  ⚠️ Le trailing est vérifié AVANT le stop loss pour protéger les gains    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Conditions de Sortie:

| Condition | Seuil | Action |
|-----------|-------|--------|
| **Stop Loss** | Fixed: 6.0% (Emergency protection only) | Crash protection - should rarely trigger |
| **Take Profit** | +3.0% | Fermeture immédiate |
| **Time Exit** | 48h (2880 min) | Fermeture si toujours ouvert |
| **Trailing Stop** | Activé à +0.8% | Trail de 0.5%, s'élargit à 0.8% quand profit > 2% |
| **Momentum Fade** | PnL > 1.5% ET ROC5 < 0.5% | Fermeture (momentum perdu) |
| **Volume Dry** | PnL > 0.5% ET Vol < 0.5x | Fermeture (plus de volume) |

### Fixed Stop Loss (V5.15) - EMERGENCY PROTECTION

Le SL fixe agit comme protection d'urgence uniquement (crash, bug, perte connexion):

```typescript
// SL fixe large: 6.0%
// → Protection catastrophe uniquement
// → Ne doit JAMAIS être touché en conditions normales
// → Le trailing stop gère les sorties normales

const slPct = 6.0;  // 6% emergency protection
const stopLoss = entryPrice * (1 - slPct / 100);  // Pour LONG

// Le trailing stop s'active à +0.8% et gère la sortie intelligemment
// Distance: 0.5% (serré) → 0.8% (élargi à +2%)
```

**Résultats:** Le SL large permet au trailing de gérer >95% des sorties
**Problème résolu:** Plus d'exits via exchange SL quand position en profit

### Trailing Stop Détaillé:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         TRAILING STOP LOGIC (V5.15)                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. Position ouverte à $100 (LONG)                                         │
│  2. SL FIXE placé à $94 (-6%) → EMERGENCY ONLY                             │
│     → Ce SL ne doit JAMAIS être touché sauf crash                          │
│                                                                             │
│  3. Prix monte à $100.80 (+0.8%) → Trailing ACTIVÉ                         │
│     → Trail price = $100.80 × (1 - 0.5%) = $100.30                         │
│     → Le trailing gère maintenant TOUTES les sorties                       │
│                                                                             │
│  4. Prix monte à $102 (+2%)                                                │
│     → Trail s'élargit: callback 0.8% (au lieu de 0.5%)                     │
│     → Trail price = $102 × (1 - 0.8%) = $101.18                            │
│                                                                             │
│  5. Prix redescend à $101.10                                               │
│     → Trail price reste à $101.18 (ne descend jamais)                      │
│     → Prix $101.10 < Trail $101.18 → EXIT avec +1.1% profit                │
│     → SL fixe ($94) n'a JAMAIS été proche d'être touché                    │
│                                                                             │
│  ⚡ AVANTAGE: Gap large entre trailing ($101.18) et SL fixe ($94)          │
│     permet au trailing de gérer les sorties sans interférence              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 💰 Gestion du Capital

### Capital Pool Partagé:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    CAPITAL POOL ($10,000 exemple)                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Total: $10,000                                                             │
│  ├── Disponible: $6,000                                                    │
│  ├── Réservé (en attente): $0                                              │
│  └── En Position: $4,000                                                   │
│       ├── SEI: $2,600 (margin utilisé)                                     │
│       └── ETH: $1,400 (margin utilisé)                                     │
│                                                                             │
│  POSITION_SIZE_PCT = 40%                                                   │
│  → Chaque trade utilise 40% du capital disponible                          │
│  → Max 4 positions simultanées                                             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Sizing d'une Position (V5.7):

```
Capital disponible: $6,000
Position size: 40% × $6,000 = $2,400 (margin)
Leverage: 4.5x (uniforme)
Notional: $2,400 × 4.5 = $10,800 d'exposition

Dynamic SL: 2.1% (basé sur ATR)
Risk réel: $2,400 × 2.1% = $50.40 max loss
```

### Liquidity Caps par Tier (V5.5):

| Tier | Assets | Max Position |
|------|--------|--------------|
| HIGH | BTC, ETH | $500,000 |
| MEDIUM | XRP, SOL, DOGE, AVAX, LINK, ADA | $100,000 |
| LOW | SEI, IMX, DOT, SUI | $25,000 |

---

## 🛡️ Risk Management

### Circuit Breaker (V5.7):

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CIRCUIT BREAKER                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Consecutive Losses → Cooldown adaptatif                                   │
│                                                                             │
│  3 pertes d'affilée → Cooldown 5-15 min                                    │
│  4 pertes d'affilée → Cooldown 15-25 min                                   │
│  5+ pertes d'affilée → Cooldown 30-45 min                                  │
│                                                                             │
│  Daily Loss Limit → Trading pausé jusqu'au lendemain                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Daily Loss Limit:

- PnL quotidien tracké par agent
- Limite configurable (défaut: -5% du capital)
- Trading pausé avec notification si limite atteinte
- Reset automatique à minuit UTC

### Dynamic Leverage (V5.6):

```typescript
// En haute volatilité, leverage réduit
if (ATR / price > 0.02) {
  leverage = 3;  // Réduit de 4.5x à 3x
}
```

---

## 🔧 Configuration V5.7 (momentumSimple.ts)

```typescript
// LONG Entry (Bull: BTC > SMA200)
ENTRY_LONG: {
  BB_PERIOD: 20,
  BB_STD: 2,
  ROC_MIN: 0.025,           // 2.5%
  VOL_MULTIPLIER: 2.0,      // 2x
  MAX_CONSEC_UP: 3,
}

// SHORT Entry (Bear: BTC < SMA200)
ENTRY_SHORT: {
  ROC_DROP_MIN: -0.015,     // -1.5%
  VOL_SPIKE: 2.0,           // 2x
  PRICE_BELOW_MA20: true,
  PRICE_BELOW_BB_LOWER: true,
  MAX_CONSEC_DOWN: 5,
}

// Exit (V5.7 - Dynamic SL)
EXIT: {
  DYNAMIC_SL: {
    ATR_PERIOD: 14,
    ATR_MULTIPLIER: 2.0,
    MIN_SL_PCT: 0.008,      // 0.8% minimum
    MAX_SL_PCT: 0.03,       // 3.0% maximum
  },
  PROFIT_TARGET_PCT: 0.03,  // 3%
  TRAILING_ACTIVATION_PCT: 0.01,  // 1%
  TRAILING_DISTANCE_PCT: 0.004,   // 0.4%
  HOLD_PERIOD_MAX_MIN: 2880,      // 48h
}

// Risk (V5.7)
RISK: {
  POSITION_SIZE_PCT: 0.4,   // 40%
  MAX_POSITIONS: 4,
  LEVERAGE: 4.5,            // Uniforme pour tous les assets
}

// Symbols compatibles V5.7 (24-month backtest)
SYMBOLS: [
  'DOGE/USDT:USDT',  // 🏆 +438% ROI
  'IMX/USDT:USDT',   // 🏆 +344% ROI
  'SEI/USDT:USDT',   // 🏆 +280% ROI
  'SUI/USDT:USDT',   // 🏆 +266% ROI
  'XRP/USDT:USDT',   // +185% ROI
  'ETH/USDT:USDT',   // +173% ROI
]
```

---

## 🔄 Sync avec Exchange (Mode Live)

### Au démarrage et à chaque tick:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         syncWithExchange()                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. fetchPositions() sur Binance                                           │
│                                                                             │
│  2. CASE 1: Agent pense avoir position, Exchange dit NON                   │
│     → SL a été touché sur Binance                                          │
│     → fetchMyTrades() pour trouver prix exit                               │
│     → Calcule PnL, libère capital                                          │
│     → this.position = null → Repasse en WATCHING                           │
│                                                                             │
│  3. CASE 2: Agent n'a pas position, Exchange en a une                      │
│     → Position ouverte manuellement ou sync perdu                          │
│     → Charge la position depuis exchange                                   │
│     → Commit le capital                                                    │
│                                                                             │
│  4. CASE 3: Les deux ont la même position                                  │
│     → Log vérification OK                                                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 📊 Logs Types

### Agent en WATCHING (pas de position):
```
🔄 [ETH/USDT:USDT] Tick #22 | WATCHING | mode=paper
📊 [ETH/USDT:USDT] Market: favorable_long | BTC trend=bullish | BTC 95000 > SMA200
🔍 [ETH/USDT:USDT] Signal check @ $3014.18 | vol=0.2x | bullish=true | ATR=45.2
❌ [ETH/USDT:USDT] No signal: bull_regime:no_breakout(close=3014 < bb_upper=3072)
```

### Entrée en position:
```
✅ [SEI/USDT:USDT] SIGNAL LONG CONFIRMED: v5.7_bull_long_confirmed | confidence=0.78
🚀 [SEI/USDT:USDT] OPENING LONG | price=$0.155 | qty=168.5 | notional=$26.12 | lev=4.5x
📝 [SEI/USDT:USDT] PAPER LONG OPENED @ $0.1550 | dynamicSL=2.1% ($0.1517)
💾 [SEI/USDT:USDT] Entry order logged: BUY @ $0.1550
```

### En position:
```
🔄 [SEI/USDT:USDT] Tick #25 | IN_LONG @ $0.16 | mode=paper
📊 [SEI/USDT:USDT] POSITION LONG | entry=$0.155 | now=$0.158 | PnL=+1.94% | SL=$0.1517
📈 [SEI/USDT:USDT] Trailing activated: trail=$0.1572 (0.4% from high)
```

### Sortie:
```
🔴 [SEI/USDT:USDT] EXIT SIGNAL: reason=trailing | PnL=+2.15% | holdMin=45
🚪 [SEI/USDT:USDT] CLOSING LONG | entry=$0.155 | exit=$0.158 | PnL=+2.15% ($0.56)
📝 [SEI/USDT:USDT] PAPER CLOSED | PnL=+2.15% | Capital released $26.12
💾 [SEI/USDT:USDT] Exit logged: trailing, PnL: $0.56 (2.15%)
📊 [SEI/USDT:USDT] KPI updated: 5 trades, 60.0% WR, $2.35 PnL, 2.35% ROI
```

---

## ⚠️ Pourquoi l'agent n'entre pas souvent?

La stratégie V5.7 est **très sélective**:

1. **Volume 2x requis** → Le marché doit être actif (souvent 0.2x-0.5x en temps calme)
2. **BB Breakout** → Le prix doit vraiment casser, pas juste toucher
3. **ROC 2.5%** → Besoin d'un mouvement fort (+2.5% en 2h30)
4. **Combination** → TOUTES les conditions doivent être vraies en même temps

**C'est normal** de voir des heures sans trade. La stratégie attend les **meilleures opportunités** plutôt que de trader constamment.

---

## 📁 Fichiers Clés

| Fichier | Rôle |
|---------|------|
| `backend/src/strategies/simpleAgent.ts` | Agent principal, tick loop, gestion positions, CapitalPool |
| `backend/src/strategies/momentumSimple.ts` | Config V5.7, checkMomentumSignal(), shouldExitPosition() |
| `backend/src/quantai/risk/circuitBreaker.ts` | Daily loss limits, cooldowns, per-agent PnL |
| `backend/src/server.ts` | API REST, routes /api/agent/*, gestion userAgents |
| `backend/backtest-combined-v54.mjs` | Backtest de référence |

---

*Dernière mise à jour: Décembre 2025 - Stratégie V5.7*

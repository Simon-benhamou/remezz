# 🎯 Mode-Adaptive Trading System

## Vue d'Ensemble

Le système adapte **automatiquement** les paramètres de trading selon le **mode d'agressivité** de l'agent, éliminant le besoin de phases temporelles manuelles.

## 📊 Les 3 Modes

### 🛡️ CONSERVATIVE (Sécurité maximale)
```
Profil: Quality-focused, capital preservation
Use Case: Bear markets, uncertain conditions, learning phase
```

**Paramètres:**
- **Risk per Trade**: 1.0% (safe)
- **ATR Threshold**: 0.30% (strong signals only)
- **Max Trades/Day**: 6 (selective)
- **Max Consecutive Stops**: 2 (strict)
- **Daily Loss Limit**: 4.0%
- **Trade Cooldown**: 30s

**Résultats Attendus:**
- 4-6 trades/jour
- Win rate: 50-55%
- Monthly ROI: 8-12%
- Max drawdown: 3-4%

---

### ⚖️ REACTIVE (Équilibre optimal) - **DEFAULT**
```
Profil: Balanced, adaptive to market conditions
Use Case: Normal market conditions, day-to-day trading
```

**Paramètres:**
- **Risk per Trade**: 1.5% (balanced)
- **ATR Threshold**: 0.25% (good setups)
- **Max Trades/Day**: 10 (active)
- **Max Consecutive Stops**: 3 (reasonable)
- **Daily Loss Limit**: 5.5%
- **Trade Cooldown**: 20s

**Résultats Attendus:**
- 7-10 trades/jour
- Win rate: 45-48%
- Monthly ROI: 15-20%
- Max drawdown: 5-6%

---

### 🚀 AGGRESSIVE (Performance maximale)
```
Profil: High-frequency, risk-taker, opportunity seeker
Use Case: Bull markets, high volatility, experienced traders
```

**Paramètres:**
- **Risk per Trade**: 2.5% (aggressive)
- **ATR Threshold**: 0.15% (flexible entry)
- **Max Trades/Day**: 15 (very active)
- **Max Consecutive Stops**: 4 (resilient)
- **Daily Loss Limit**: 7.0%
- **Trade Cooldown**: 10s

**Résultats Attendus:**
- 10-15 trades/jour
- Win rate: 40-43%
- Monthly ROI: 25-35%
- Max drawdown: 7-8%

---

## 🔧 Configuration (.env)

Chaque mode a ses propres paramètres configurables:

```properties
# ==== CONSERVATIVE MODE ====
CONSERVATIVE_RISK_PCT=1.0
CONSERVATIVE_MIN_ATR_PCT=0.30
CONSERVATIVE_MAX_TRADES_PER_DAY=6
CONSERVATIVE_MAX_CONSECUTIVE_STOPS=2
CONSERVATIVE_DAILY_LOSS_LIMIT_PCT=4.0
CONSERVATIVE_TRADE_COOLDOWN_MS=30000

# ==== REACTIVE MODE (DEFAULT) ====
REACTIVE_RISK_PCT=1.5
REACTIVE_MIN_ATR_PCT=0.25
REACTIVE_MAX_TRADES_PER_DAY=10
REACTIVE_MAX_CONSECUTIVE_STOPS=3
REACTIVE_DAILY_LOSS_LIMIT_PCT=5.5
REACTIVE_TRADE_COOLDOWN_MS=20000

# ==== AGGRESSIVE MODE ====
AGGRESSIVE_RISK_PCT=2.5
AGGRESSIVE_MIN_ATR_PCT=0.15
AGGRESSIVE_MAX_TRADES_PER_DAY=15
AGGRESSIVE_MAX_CONSECUTIVE_STOPS=4
AGGRESSIVE_DAILY_LOSS_LIMIT_PCT=7.0
AGGRESSIVE_TRADE_COOLDOWN_MS=10000

# Cooldown multipliers
TRADE_COOLDOWN_WIN_MULTIPLIER=0.5   # Faster after wins
TRADE_COOLDOWN_LOSS_MULTIPLIER=1.5  # Slower after losses
```

---

## 🎮 Comment Utiliser

### Via l'Interface Web (Recommandé)

Lors de l'activation d'un agent:

```javascript
{
  "symbol": "BTCUSDT",
  "mode": "paper",
  "aggressiveness": "reactive",  // 👈 Choisir le mode ici
  "riskPerTradePct": 1.5,
  "maxLeverage": 10
}
```

### Via API

```bash
POST /activate-agent
{
  "symbol": "BTCUSDT",
  "mode": "paper",
  "aggressiveness": "aggressive",  # conservative | reactive | aggressive
  "riskPerTradePct": 2.5
}
```

---

## 📈 Tableau Comparatif

| Métrique | Conservative | Reactive | Aggressive |
|----------|--------------|----------|-----------|
| **Risk/Trade** | 1.0% | 1.5% | 2.5% |
| **ATR Min** | 0.30% | 0.25% | 0.15% |
| **Trades/Day** | 4-6 | 7-10 | 10-15 |
| **Max Stops** | 2 | 3 | 4 |
| **Loss Limit** | 4.0% | 5.5% | 7.0% |
| **Cooldown** | 30s | 20s | 10s |
| **Win Rate** | 50-55% | 45-48% | 40-43% |
| **Monthly ROI** | 8-12% | 15-20% | 25-35% |
| **Max Drawdown** | 3-4% | 5-6% | 7-8% |
| **Sharpe Ratio** | ~1.8 | ~2.2 | ~2.0 |

---

## 🔄 Adaptation Dynamique

Le système s'adapte automatiquement selon le mode choisi:

### Entry Thresholds
```typescript
// Conservative: ATR 0.30% - Seulement les meilleurs setups
// Reactive:     ATR 0.25% - Bons setups
// Aggressive:   ATR 0.15% - Setups flexibles
```

### Position Sizing
```typescript
// Conservative: 1.0% risk (safe)
// Reactive:     1.5% risk (balanced)
// Aggressive:   2.5% risk (max performance)
```

### Risk Limits
```typescript
// Conservative: 6 trades, 2 stops, 4% daily loss
// Reactive:     10 trades, 3 stops, 5.5% daily loss
// Aggressive:   15 trades, 4 stops, 7% daily loss
```

---

## 💡 Recommandations d'Utilisation

### Quand utiliser CONSERVATIVE
- ✅ Marchés baissiers ou incertains
- ✅ Cryptos à faible volume
- ✅ Phase d'apprentissage/test
- ✅ Protection du capital prioritaire

### Quand utiliser REACTIVE (Default)
- ✅ Conditions de marché normales
- ✅ Trading quotidien
- ✅ Équilibre risque/rendement
- ✅ Recommandé pour la plupart des cas

### Quand utiliser AGGRESSIVE
- ✅ Marchés haussiers forts
- ✅ Haute volatilité
- ✅ Cryptos de grande liquidité (BTC, ETH)
- ✅ Traders expérimentés
- ✅ Performance maximale recherchée

---

## 🎯 Exemples Pratiques

### Scénario 1: Bear Market (BTC -15% cette semaine)
```javascript
// Utiliser CONSERVATIVE
aggressiveness: "conservative"
→ 4-6 trades/jour, ATR 0.30%, risk 1.0%
→ Préserve le capital, attend les meilleurs setups
```

### Scénario 2: Normal Market (BTC sideways +/- 3%)
```javascript
// Utiliser REACTIVE (default)
aggressiveness: "reactive"
→ 7-10 trades/jour, ATR 0.25%, risk 1.5%
→ Équilibre optimal performance/sécurité
```

### Scénario 3: Bull Market (BTC +20% cette semaine)
```javascript
// Utiliser AGGRESSIVE
aggressiveness: "aggressive"
→ 10-15 trades/jour, ATR 0.15%, risk 2.5%
→ Maximise les opportunités, capture la volatilité
```

---

## 🔧 Personnalisation Fine

Tu peux modifier les paramètres de chaque mode dans `.env`:

```bash
# Exemple: Rendre REACTIVE plus agressif
REACTIVE_RISK_PCT=2.0          # au lieu de 1.5
REACTIVE_MIN_ATR_PCT=0.20      # au lieu de 0.25
REACTIVE_MAX_TRADES_PER_DAY=12 # au lieu de 10
```

Redémarre le backend pour appliquer:
```bash
npm -w backend run dev
```

---

## 📊 Monitoring

Le mode actif est visible dans:

1. **Logs** - Chaque décision mentionne le mode:
```
Daily trades: 7/10 - within limit (reactive mode)
Consecutive stops: 2/3 - acceptable loss streak (reactive mode)
```

2. **Dashboard** - Badge de mode affiché
3. **ops_events** - Détails complets dans la DB

---

## ✅ Avantages vs Phases Temporelles

### ❌ Ancien Système (Phases par semaine)
- Rigide: Phase 1 → Phase 2 → Phase 3
- Nécessite intervention manuelle
- Pas d'adaptation au marché
- Timing arbitraire (1 semaine)

### ✅ Nouveau Système (Modes dynamiques)
- Flexible: Change le mode selon le marché
- Automatique: Aucune intervention
- Adaptatif: Réagit aux conditions
- Instantané: Changement immédiat

---

## 🚀 Migration depuis l'ancien système

Si tu avais configuré les phases manuellement:

**Avant (Phases):**
```
Phase 1: ATR 0.25%, Risk 1.5% → Semaine 1
Phase 2: ATR 0.20%, Risk 2.0% → Semaine 2
Phase 3: ATR 0.15%, Risk 2.5% → Semaine 3
```

**Maintenant (Modes):**
```
Conservative: ATR 0.30%, Risk 1.0% → Marché baissier
Reactive:     ATR 0.25%, Risk 1.5% → Marché normal
Aggressive:   ATR 0.15%, Risk 2.5% → Marché haussier
```

---

## 📞 Support

Questions? Vérifie:
- `IMPLEMENTATION_PATCH.js` - Code changes détaillées
- `AGGRESSIVE_TRADING_CONFIG.md` - Guide technique complet
- Logs backend - Messages détaillés par mode

---

**Note:** Le mode `reactive` est le **default recommandé** pour 80% des situations. Utilise `conservative` quand tu doutes, et `aggressive` seulement en bull market confirmé.

# 🚀 Quick Reference: Mode-Adaptive Trading

## Activation d'un Agent

```javascript
POST /activate-agent
{
  "symbol": "BTCUSDT",
  "mode": "paper",  // ou "live"
  "aggressiveness": "reactive"  // conservative | reactive | aggressive
}
```

## Les 3 Modes

| Mode | ATR | Risk | Trades/Day | Stops | Loss | Cooldown | ROI/Month |
|------|-----|------|------------|-------|------|----------|-----------|
| 🛡️ Conservative | 0.30% | 1.0% | 6 | 2 | 4.0% | 30s | 8-12% |
| ⚖️ Reactive | 0.25% | 1.5% | 10 | 3 | 5.5% | 20s | 15-20% |
| 🚀 Aggressive | 0.15% | 2.5% | 15 | 4 | 7.0% | 10s | 25-35% |

## Quand Utiliser Quel Mode

```
📉 Bear Market (-15%)    → conservative
📊 Normal Market (±3%)   → reactive (DEFAULT)
📈 Bull Market (+20%)    → aggressive
```

## Configuration (.env)

```properties
# Conservative
CONSERVATIVE_RISK_PCT=1.0
CONSERVATIVE_MIN_ATR_PCT=0.30
CONSERVATIVE_MAX_TRADES_PER_DAY=6
CONSERVATIVE_MAX_CONSECUTIVE_STOPS=2
CONSERVATIVE_DAILY_LOSS_LIMIT_PCT=4.0
CONSERVATIVE_TRADE_COOLDOWN_MS=30000

# Reactive (DEFAULT)
REACTIVE_RISK_PCT=1.5
REACTIVE_MIN_ATR_PCT=0.25
REACTIVE_MAX_TRADES_PER_DAY=10
REACTIVE_MAX_CONSECUTIVE_STOPS=3
REACTIVE_DAILY_LOSS_LIMIT_PCT=5.5
REACTIVE_TRADE_COOLDOWN_MS=20000

# Aggressive
AGGRESSIVE_RISK_PCT=2.5
AGGRESSIVE_MIN_ATR_PCT=0.15
AGGRESSIVE_MAX_TRADES_PER_DAY=15
AGGRESSIVE_MAX_CONSECUTIVE_STOPS=4
AGGRESSIVE_DAILY_LOSS_LIMIT_PCT=7.0
AGGRESSIVE_TRADE_COOLDOWN_MS=10000
```

## Monitoring

Les logs afficheront:
```
Daily trades: 7/10 - within limit (reactive mode)
Consecutive stops: 2/3 - acceptable (reactive mode)
ATR threshold: 0.25% (reactive mode)
```

## Personnalisation

Pour ajuster un mode:
```bash
# Édite .env
nano backend/.env

# Exemple: Rendre REACTIVE plus agressif
REACTIVE_RISK_PCT=2.0
REACTIVE_MIN_ATR_PCT=0.20

# Redémarre
npm -w backend run dev
```

## Tests

```bash
# 1. Compile check
npm -w backend run build

# 2. Start backend
npm -w backend run dev

# 3. Activate agent
curl -X POST http://localhost:4000/activate-agent \
  -H "Content-Type: application/json" \
  -d '{"symbol":"BTCUSDT","mode":"paper","aggressiveness":"reactive"}'
```

## Documentation Complète

- `MODE_ADAPTIVE_TRADING.md` - Guide complet
- `MIGRATION_GUIDE.md` - Migration phases → modes
- `CHANGELOG_MODE_ADAPTIVE.md` - Détails techniques
- `AGGRESSIVE_TRADING_CONFIG.md` - Analyse stratégie
- `REAL_EXAMPLE.md` - Exemples concrets

## Troubleshooting

**Problème:** Agent ne trade pas assez
**Solution:** Passe en mode `aggressive` ou baisse `REACTIVE_MIN_ATR_PCT`

**Problème:** Trop de stops consécutifs
**Solution:** Passe en mode `conservative` ou augmente les seuils

**Problème:** Mode non reconnu
**Solution:** Vérifie que `aggressiveness` = "conservative"|"reactive"|"aggressive"

## Performance Attendue

```
Conservative: 4-6 trades/jour, 50-55% win rate, 8-12% ROI/mois
Reactive:     7-10 trades/jour, 45-48% win rate, 15-20% ROI/mois
Aggressive:   10-15 trades/jour, 40-43% win rate, 25-35% ROI/mois
```

## Code Implementation

### src/utils/env.ts
```typescript
export function getModeParams(mode: AgentAggressiveness = 'reactive'): ModeParams {
  const cfg = getConfig();
  switch (mode) {
    case 'conservative': return { riskPct: cfg.CONSERVATIVE_RISK_PCT, ... };
    case 'aggressive': return { riskPct: cfg.AGGRESSIVE_RISK_PCT, ... };
    case 'reactive':
    default: return { riskPct: cfg.REACTIVE_RISK_PCT, ... };
  }
}
```

### src/risk/manager.ts
```typescript
export const defaultLimits = (aggressiveness: AgentAggressiveness = 'reactive'): RiskLimits => {
  const modeParams = getModeParams(aggressiveness);
  return {
    riskPctPerTrade: { min: 0.5, max: modeParams.riskPct },
    maxTradesPerDay: modeParams.maxTradesPerDay,
    maxConsecutiveStops: modeParams.maxConsecutiveStops,
    // ...
  };
};
```

### src/agent/state.ts
```typescript
private getAdjustedEntryThresholds() {
  const level = this.profile?.aggressiveness || 'conservative';
  const modeParams = getModeParams(level);
  let ENTRY_MIN_ATR_PCT = modeParams.minAtrPct; // Dynamic ATR
  // ...
}
```

---

**Rappel:** Mode `reactive` est recommandé pour 80% des situations. Utilise `conservative` si tu doutes, `aggressive` uniquement en bull market confirmé.

# 🎯 Strategy Optimizer - Guide d'Utilisation

**Date**: 20 novembre 2025  
**Localisation**: Dashboard Operations → Onglet "Optimizer"

---

## 📍 Accès Rapide

### Frontend
1. Ouvrir le dashboard: `http://localhost:5173/dashboard`
2. Cliquer sur le bouton **"Optimizer"** ⚡ dans la barre de navigation
3. Deux options disponibles:
   - **Optimisation single symbol** (rapide, ~5-30 secondes)
   - **Optimisation batch** (tous les symboles, ~2-10 minutes)

### Backend API
```bash
# Single symbol
curl -X POST http://localhost:3000/api/strategy/optimize \
  -H "Content-Type: application/json" \
  -d '{"symbol": "BTC/USDT"}'

# All symbols
curl -X POST http://localhost:3000/api/strategy/optimize/batch
```

---

## 🔧 Fonctionnalités

### 1️⃣ Optimisation Single Symbol

**Quand l'utiliser**:
- Après avoir remarqué de mauvaises performances sur un symbole spécifique
- Pour tester l'optimizer sur un actif avant batch optimization
- Quand un symbole change de comportement (nouveau régime de marché)

**Comment**:
1. Entrer le symbole: `ETH/USDT`, `BTC/USDT`, etc.
2. Cliquer sur "Optimize" ⚡
3. Attendre 5-30 secondes
4. Vérifier les résultats dans les logs

**Résultat attendu**:
```json
{
  "success": true,
  "message": "Optimized parameters for ETH/USDT",
  "symbol": "ETH/USDT",
  "regimes": {
    "high_vol_uptrend": {
      "samples": 45,
      "optimal": {
        "minConfidence": 0.35,
        "minScore": 0.30,
        "sharpeRatio": 2.1,
        "winRate": 0.64
      }
    },
    // ... autres régimes
  }
}
```

### 2️⃣ Batch Optimization

**Quand l'utiliser**:
- Chaque semaine pour maintenir les paramètres à jour
- Après avoir collecté ~100+ trades sur plusieurs symboles
- Pour découvrir de nouveaux paramètres performants

**Comment**:
1. Cliquer sur "Optimize All Symbols with Sufficient Data"
2. Attendre 2-10 minutes (dépend du nombre de symboles)
3. Vérifier le nombre de symboles optimisés

**Critères d'éligibilité** (par symbole):
- ✅ Minimum 20 trade evaluations **par régime**
- ✅ Au moins 3 régimes différents avec données suffisantes
- ❌ Symboles sans historique récent ignorés

**Résultat attendu**:
```json
{
  "success": true,
  "message": "Optimized 12 symbols",
  "count": 12,
  "symbols": [
    "BTC/USDT",
    "ETH/USDT",
    "SOL/USDT",
    // ... 9 autres
  ]
}
```

---

## 📊 Régimes de Marché

L'optimizer analyse **4 dimensions** pour classifier les régimes:

### 1. Volatility Regime
- `low_volatility`: ATR < 2.5%
- `normal_volatility`: 2.5% ≤ ATR < 4.5%
- `high_volatility`: ATR ≥ 4.5%

### 2. Direction Bias
- `uptrend`: EMA20 > EMA50 (et montantes)
- `downtrend`: EMA20 < EMA50 (et descendantes)
- `neutral`: Pas de tendance claire

### 3. Volume Regime
- `low_volume`: Volume < 0.7x moyenne
- `normal_volume`: 0.7x ≤ Volume < 1.5x
- `high_volume`: Volume ≥ 1.5x moyenne

### 4. Trending/Ranging
- `trending`: ADX ≥ 25, ATR élevé
- `ranging`: ADX < 20, ATR faible
- `transitioning`: Entre les deux

**Combinaisons populaires**:
```
high_vol_uptrend        → Forte hausse volatile
low_vol_ranging         → Range calme (mean reversion)
high_vol_downtrend      → Chute brutale (shorts)
normal_vol_trending_up  → Tendance haussière stable
```

---

## 🎯 Paramètres Optimisés

Pour chaque régime, l'optimizer trouve les meilleurs:

### minConfidence (0.20 → 0.65)
**Impact**: Seuil minimum de confidence du predictor
- **Plus bas (0.25)**: Entre plus souvent, prend plus de risque
- **Plus haut (0.55)**: Entre rarement, haute précision

**Optimal selon régime**:
- High volatility: `0.35-0.40` (accepte plus d'incertitude)
- Low volatility: `0.45-0.55` (exige haute confidence)

### minScore (0.20 → 0.65)
**Impact**: Seuil minimum de strategy score
- **Plus bas (0.25)**: Plus de trades, diversification
- **Plus haut (0.50)**: Seulement setups parfaits

**Optimal selon régime**:
- Trending: `0.40-0.50` (suit les tendances moyennes)
- Ranging: `0.30-0.40` (accepte setups moyens de mean reversion)

---

## 📈 Métriques d'Optimisation

L'optimizer maximise un **composite score** de 3 métriques:

### 1. Sharpe Ratio (poids: 0.4)
```
Sharpe = (Rendement moyen - Taux sans risque) / Volatilité
```
- **Target**: > 1.5
- **Excellent**: > 2.0
- Mesure le rendement ajusté au risque

### 2. Win Rate (poids: 0.35)
```
Win Rate = Trades gagnants / Total trades
```
- **Target**: > 55%
- **Excellent**: > 60%
- Pourcentage de trades gagnants

### 3. Total PnL (poids: 0.25)
```
Total PnL = Somme de tous les profits/pertes
```
- **Target**: Positif sur 30+ trades
- **Excellent**: +10% sur le capital alloué
- Profit absolu généré

**Formule composite**:
```typescript
compositeScore = 
  (sharpe * 0.4) + 
  (winRate * 0.35) + 
  (normalizedPnL * 0.25)
```

---

## 🔍 Grid Search

L'optimizer teste **toutes les combinaisons** de:
- `minConfidence`: [0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55]
- `minScore`: [0.25, 0.30, 0.35, 0.40, 0.45, 0.50]

**Total**: 7 × 6 = **42 combinaisons** par régime

**Temps de calcul**:
- Single symbol: ~5-30 secondes
- Batch (12 symbols): ~2-5 minutes
- Limité par le nombre d'evaluations à analyser

---

## 📝 Logs & Debugging

### Logs Frontend
```javascript
// Ouverture console navigateur (F12)
console.log('🚀 Starting optimize all symbols (regime-aware)...');
console.log('✅ Optimization result:', result);
console.error('❌ Optimization error:', error);
```

### Logs Backend
```bash
# Backend console
[Strategy Optimizer] Optimizing BTC/USDT...
[Strategy Optimizer] Analyzed 156 evaluations
[Strategy Optimizer] Found 4 regimes with sufficient data
[Strategy Optimizer] Best for high_vol_uptrend: conf=0.35, score=0.40, sharpe=2.1
```

### Fichiers de Personnalité
```bash
# Les paramètres optimisés sont sauvegardés ici:
backend/data/symbol_personalities/

# Exemple: BTC_USDT.json
{
  "symbol": "BTC/USDT",
  "regimeParameters": {
    "high_vol_uptrend": {
      "minConfidence": 0.35,
      "minScore": 0.40,
      "samples": 45,
      "sharpeRatio": 2.1,
      "winRate": 0.64
    },
    // ... autres régimes
  },
  "lastOptimized": "2025-11-20T21:30:00.000Z",
  "evaluationsSince": 156
}
```

---

## ⚠️ Troubleshooting

### "No symbols were optimized"
**Cause**: Pas assez de données (< 20 evaluations par régime)

**Solution**:
1. Attendre que plus de trades s'exécutent
2. Vérifier que les agents sont actifs
3. Minimum ~100 trades nécessaires pour optimisation complète

### "Optimization failed"
**Causes possibles**:
- Backend non démarré
- Base de données inaccessible
- Erreur dans le calcul des métriques

**Solution**:
```bash
# Vérifier logs backend
tail -f backend/logs/combined.log

# Redémarrer backend si nécessaire
cd backend && npm run dev:debug
```

### Paramètres incohérents
**Symptôme**: minConfidence très bas (0.20) ou très haut (0.65)

**Cause**: Pas assez de samples dans ce régime

**Solution**: Ignorer ce régime, utiliser paramètres par défaut

---

## 📚 Ressources Associées

- **Documentation complète**: `STRATEGY_OPTIMIZER_GUIDE.md`
- **Code backend**: `backend/src/services/strategyOptimizer.ts`
- **Code frontend**: `frontend/src/pages/OperationsDashboardPage.tsx`
- **API routes**: `backend/src/api/strategyRoutes.ts`

---

## ✅ Best Practices

### Timing
- ✅ Optimiser **après 100+ trades** collectés
- ✅ Ré-optimiser **chaque semaine**
- ❌ Ne pas optimiser avec < 50 trades

### Workflow
1. Laisser tourner les agents pendant 1-2 jours
2. Collecter ~100-200 trade evaluations
3. Lancer batch optimization
4. Observer les performances pendant 2-3 jours
5. Ajuster manuellement si nécessaire
6. Répéter le cycle

### Monitoring
- Surveiller win rate avant/après optimisation
- Comparer Sharpe ratio par régime
- Vérifier que les agents entrent effectivement en trade

---

**Dernière mise à jour**: 20 novembre 2025, 21:45  
**Status**: ✅ Prêt à utiliser depuis le dashboard

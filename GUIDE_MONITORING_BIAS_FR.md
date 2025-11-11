# Guide d'Utilisation - Monitoring du Bias Long/Short

## Vue d'ensemble

Ce guide explique comment utiliser les nouveaux outils de monitoring pour s'assurer que le système ne favorise pas indûment les positions long au détriment des shorts.

## Outils Disponibles

### 1. Rapport de Statistiques de Bias

**Commande:**
```bash
cd backend
npm run report:bias [jours]
```

**Exemples:**
```bash
npm run report:bias 7    # Derniers 7 jours
npm run report:bias 30   # Derniers 30 jours (défaut)
npm run report:bias 90   # Derniers 90 jours
```

**Sortie Exemple:**
```
📊 BIAS STATISTICS (Last 30 days)
================================================================================
Period: 2024-10-12T... to 2024-11-11T...
Total Decisions: 150

🟢 LONG:  68 (45.3%) - Avg Confidence: 64.2%
🔴 SHORT: 71 (47.3%) - Avg Confidence: 61.8%
⚪ NONE:  11 (7.3%)

✅ BALANCED: System showing healthy long/short distribution
================================================================================
```

### 2. Tests Unitaires

**Exécuter les tests de bias:**
```bash
cd backend
npm run test:jest -- long-short-bias-balance.spec.ts
```

**Tests inclus:**
- Détection de tendance baissière (SHORT)
- Détection de tendance haussière (LONG)
- Symétrie des scores
- Cas réel XRP (11/11/25)
- Seuils de confiance équilibrés

## Interprétation des Résultats

### ✅ Distribution Équilibrée
```
LONG:  45-55%
SHORT: 45-55%
NONE:  0-10%
```
→ **Normal**: Le système sélectionne opportunistiquement dans les deux directions

### ⚠️ Bias Modéré
```
LONG:  60-70% OU SHORT: 60-70%
```
→ **Surveiller**: Peut être dû aux conditions de marché (bull run ou bear market)
→ **Action**: Vérifier si cohérent avec le régime de marché global

### 🚨 Bias Significatif
```
LONG:  >70% OU SHORT: >70%
```
→ **Problème**: Bias systémique probable
→ **Actions Recommandées**:

1. **Vérifier les conditions de marché:**
   ```bash
   # Analyser les symboles traités
   SELECT symbol, bias, COUNT(*) 
   FROM DecisionMemory 
   WHERE createdAt > NOW() - INTERVAL '30 days'
   GROUP BY symbol, bias
   ORDER BY COUNT(*) DESC;
   ```

2. **Vérifier la logique de bias:**
   - Examiner `determineOptimalBias()` dans `core.ts`
   - S'assurer que bullScore et bearScore sont équilibrés

3. **Vérifier les paramètres regime-aware:**
   ```bash
   # Vérifier les profils de personnalité
   SELECT symbol, regimeKey, thresholds 
   FROM PersonalityProfile
   WHERE regimeKey IN ('long_bias', 'short_bias');
   ```

4. **Réexécuter les tests:**
   ```bash
   npm run test:jest -- long-short-bias-balance.spec.ts
   ```

## Monitoring en Production

### Daily Check (Premier Mois)
```bash
# Chaque jour pendant le premier mois après déploiement
npm run report:bias 7
```

### Weekly Check (Après Premier Mois)
```bash
# Chaque semaine
npm run report:bias 30
```

### Monthly Deep Dive
```bash
# Analyse approfondie mensuelle
npm run report:bias 90

# Comparer avec métriques de performance
npm run analyze:performance
```

## Logs Détaillés

Les décisions de bias sont loguées avec détails:

```
📊 [2025-11-11T06:30:15.123Z] BIAS: XRP/USDT → SHORT 
    (confidence: 65.2%, bull: 28, bear: 73) 
    | Bearish momentum -3.2% | Strong downtrend
```

**Information disponible:**
- `bull`: Score bullish calculé
- `bear`: Score bearish calculé
- `confidence`: Confiance finale (max des deux scores)
- Signaux ayant contribué à la décision

## Tableaux de Bord

### Grafana / Monitoring Dashboard

Si vous utilisez un dashboard de monitoring, ajoutez ces métriques:

**Requête SQL pour stats journalières:**
```sql
SELECT 
  DATE(createdAt) as date,
  bias,
  COUNT(*) as count,
  AVG(biasConfidence) as avg_confidence
FROM DecisionMemory
WHERE createdAt >= NOW() - INTERVAL '30 days'
GROUP BY DATE(createdAt), bias
ORDER BY date DESC, bias;
```

**Visualisation recommandée:**
- Graphique empilé (stacked bar chart) pour voir la distribution quotidienne
- Ligne pour la confiance moyenne
- Alerte si bias >70% pendant >3 jours consécutifs

## Cas d'Usage: Analyser le Cas XRP

Pour analyser un cas spécifique comme XRP du 11/11/25:

```bash
# 1. Vérifier les décisions XRP récentes
SELECT * FROM DecisionMemory 
WHERE symbol = 'XRP/USDT' 
  AND createdAt >= '2025-11-11' 
  AND createdAt < '2025-11-12'
ORDER BY createdAt;

# 2. Vérifier le bias sélectionné
# Devrait être SHORT si momentum négatif et ADX élevé

# 3. Comparer avec les trades réels
SELECT o.* 
FROM Order o
JOIN DecisionMemory d ON o.sessionId = d.sessionId
WHERE d.symbol = 'XRP/USDT'
  AND d.createdAt >= '2025-11-11'
  AND d.createdAt < '2025-11-12';
```

## Questions Fréquentes

### Q: Le système montre 60% de LONG, est-ce un problème?
**R:** Pas nécessairement. Si le marché est en bull run, c'est normal. Vérifiez:
- La tendance générale du marché (BTC, ETH)
- La distribution sur différents régimes (bear/bull/choppy)
- Si le pourcentage reste stable ou augmente

### Q: Comment savoir si un SHORT manqué était une vraie opportunité?
**R:** Analysez post-mortem:
1. Vérifiez le momentum réel à ce moment
2. Vérifiez l'ADX et le trend strength
3. Simulez avec les nouveaux paramètres
4. Comparez le profit potentiel

### Q: Les tests passent mais le bias persiste en production
**R:** Causes possibles:
- Paramètres regime-aware favorisant les longs
- Seuils de confiance asymétriques
- Liquidité insuffisante pour certains shorts
- Vérifier les rejections d'ordres SHORT

## Support

En cas de problème persistant:

1. **Collecter les données:**
   ```bash
   npm run report:bias 30 > bias_report.txt
   npm run analyze:performance > perf_report.txt
   ```

2. **Exécuter les tests:**
   ```bash
   npm run test:jest -- long-short-bias-balance.spec.ts > test_results.txt
   ```

3. **Ouvrir une issue GitHub** avec:
   - Rapports générés
   - Période concernée
   - Conditions de marché observées
   - Exemples de trades manqués

## Ressources

- **Code source**: `backend/src/services/intelligentAgent/strategies/core.ts`
- **Monitoring**: `backend/src/services/intelligentAgent/biasMonitor.ts`
- **Tests**: `backend/test/unit/long-short-bias-balance.spec.ts`
- **Documentation technique**: `LONG_SHORT_BIAS_FIX_SUMMARY.md`

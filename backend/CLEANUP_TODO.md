# 🗑️ MODULES À SUPPRIMER - Migration Momentum Simple

## Stratégie actuelle: Meta-Adaptive (15,000+ lignes)
## Nouvelle stratégie: Momentum Simple (~300 lignes)

---

## ✅ GARDER (Essentiel)

### Core
- `src/strategies/momentumSimple.ts` - NOUVELLE STRATÉGIE
- `src/db/client.ts` - Prisma DB
- `src/broker/capitalPoolBroker.ts` - Exécution ordres
- `src/broker/live.ts` - Binance live
- `src/broker/paper.ts` - Paper trading
- `src/broker/types.ts` - Types broker
- `src/services/capitalPool.ts` - Gestion capital
- `src/config/capital.ts` - Config capital

### Exchange (simplifier)
- `src/exchange/binance.ts` - GARDER (fetch candles)
- `src/data/marketDataCache.ts` - GARDER (cache)

### WebSocket (optionnel)
- `src/ws/hub.ts` - Frontend updates

### Routes (simplifier)
- `src/routes/sessions.ts` - GARDER
- `src/routes/health.ts` - GARDER

### Server
- `src/server.ts` - GARDER (simplifier)

---

## 🗑️ SUPPRIMER (Non utilisé par Momentum Simple)

### quantai/strategies/metaAdaptive/ (TOUT)
```
❌ accumulationDetection.ts
❌ backtest.ts (remplacé par scripts)
❌ btcCorrelation.ts
❌ comparison.ts
❌ cryptoSelection.ts
❌ dynamicRSILimits.ts
❌ entryFilters.ts
❌ entryIntegration.ts
❌ evaluationLogger.ts
❌ exitManager.ts (remplacé par time+SL simple)
❌ flashCrashDetection.ts
❌ fundingRateDetection.ts
❌ metaAdaptiveAgent.ts (3500 lignes → 300)
❌ metaAdaptiveCalibration.ts
❌ newsDetection.ts (LLM calls)
❌ orderNormalization.ts
❌ portfolioExposure.ts
❌ preciseDecimal.ts
❌ reboundDetection.ts
❌ recognizedStrategies.ts
❌ sessionAwareness.ts
❌ strategyTypes.ts
❌ whaleActivity.ts
```

### learning/ (TOUT)
```
❌ adaptiveThresholds.ts
❌ adaptiveWeights.ts
❌ decisionMemory.ts
❌ optimizerJob.ts
❌ outcomeUpdater.ts
❌ personalityProfile.ts
❌ predictorRetrainer.ts
❌ regimeDetector.ts
❌ reoptimizationScheduler.ts
❌ strategyOptimizer.ts
❌ strategyPerformanceAnalyzer.ts
❌ symbolFamily.ts
❌ tradeEvaluationLogger.ts
❌ trainer.ts
```

### ai/ (Presque tout)
```
❌ analysis.ts
❌ cryptoRanking.ts
❌ evPipeline.ts
❌ execution/ (tout le dossier)
❌ features/ (tout le dossier)
❌ guard.ts
❌ kpi/ (tout le dossier)
❌ labeling/ (tout le dossier)
❌ llm.ts (plus de LLM)
❌ models/ (tout le dossier)
❌ multiTimeframe.ts
❌ orchestrator.ts
❌ performance/ (tout le dossier)
❌ planOrchestrator.ts
❌ prompts.ts
❌ ranking/ (tout le dossier)
❌ regime.ts
❌ routing/ (tout le dossier)
❌ schema.ts
❌ smartRegime.ts
❌ strategyManager.ts
✅ tech.ts (GARDER - indicateurs de base)
```

### agent/ (Presque tout)
```
❌ actions/ (tout le dossier)
❌ bus/ (tout le dossier)
❌ context.ts
❌ decisions/ (tout le dossier)
❌ diagnostics/ (tout le dossier)
❌ executionPlanner.ts
❌ hub.ts (simplifier drastiquement)
❌ loops/ (tout le dossier)
❌ memory/ (tout le dossier)
❌ persistence.ts
❌ planSchema.ts
❌ profilePersistence.ts
❌ state/ (tout le dossier)
❌ state.ts
❌ subagents/ (tout le dossier - 6 agents)
❌ validator.ts
```

### analytics/
```
❌ feeAnalyzer.ts
❌ marketContext.ts
❌ priceAnalytics.ts (garder si besoin)
```

### quantai/regime/
```
❌ marketRegimeDetector.ts (BTC MA50 suffit dans momentumSimple)
```

### diagnostics/
```
❌ regime.ts
❌ tout le dossier
```

### monitoring/
```
❌ incoherenceTracker.ts
❌ tout le dossier
```

### monitor/
```
❌ policy.ts
❌ incoherenceTracker.ts
```

### sentiment/
```
❌ tout le dossier
```

### sim/
```
❌ tout le dossier
```

### arbitrage/
```
❌ tout le dossier
```

---

## 📊 RÉSUMÉ

| Catégorie | Fichiers actuels | Après suppression |
|-----------|------------------|-------------------|
| Core strategy | 23 fichiers | 1 fichier |
| Learning | 14 fichiers | 0 fichier |
| Detection | 12 fichiers | 0 fichier |
| AI/LLM | 20+ fichiers | 1 fichier (tech.ts) |
| Agent | 15+ fichiers | 0-1 fichier |
| **TOTAL** | ~100+ fichiers | ~15 fichiers |

### Lignes de code
- **Avant**: ~15,000+ lignes
- **Après**: ~1,500 lignes
- **Réduction**: 90%

### Appels API externes
- **Avant**: OpenAI/Grok LLM, news APIs
- **Après**: Uniquement Binance

### Complexité
- **Avant**: 4 stratégies, 12 détecteurs, ML adaptatif
- **Après**: 1 stratégie, 0 détecteur, règles fixes

---

## 🚀 ÉTAPES D'IMPLÉMENTATION

1. ✅ Créer `src/strategies/momentumSimple.ts`
2. ⬜ Créer nouveau `src/agent/simpleAgent.ts` (tick loop)
3. ⬜ Modifier `src/server.ts` pour utiliser simpleAgent
4. ⬜ Supprimer les dossiers non utilisés
5. ⬜ Simplifier routes API
6. ⬜ Tester en paper mode
7. ⬜ Déployer

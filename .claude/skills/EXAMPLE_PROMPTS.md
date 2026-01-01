# Exemples de Prompts pour les Skills Claude Code

Ce fichier contient des exemples concrets de prompts pour utiliser efficacement les skills `backtest-analyzer` et `code-consistency-checker`.

---

## 📊 Backtest Analyzer - Exemples de Prompts

### Analyse de Base

#### 1. Analyse rapide d'un backtest
```
Analyze the latest backtest results
```

**Ce que Claude fera**:
- Cherche les fichiers de résultats récents
- Extrait les métriques principales
- Fournit un résumé en 3-5 points clés
- Donne une évaluation globale (EXCELLENT / GOOD / ACCEPTABLE / POOR)

---

#### 2. Analyse approfondie
```
Analyze the backtest results in detail and provide comprehensive recommendations
```

**Ce que Claude fera**:
- Toutes les métriques (ROI, Sharpe, Win Rate, Profit Factor, Max DD)
- Analyse des patterns (exit reasons, symbol performance, time-of-day)
- Recommandations priorisées (CRITICAL → LOW)
- Exemples de trades (meilleur gain, pire perte)

---

### Comparaisons

#### 3. Comparer deux versions de stratégie
```
Compare V5.13 backtest with V5.34 and tell me which one is better for production
```

**Ce que Claude fera**:
- Tableau comparatif côte-à-côte
- Highlight des différences significatives (> 10%)
- Explication des causes de divergence
- Recommandation claire: quelle version déployer

---

#### 4. Comparer plusieurs configurations de paramètres
```
Compare backtest results for different ROC threshold values (1.5%, 1.75%, 2.0%, 2.5%)
and recommend the optimal setting
```

**Ce que Claude fera**:
- Tableau de sensibilité des paramètres
- Trade-off analysis (nombre de trades vs qualité)
- Identification du point optimal
- Recommandation avec justification

---

### Investigations Spécifiques

#### 5. Investiguer la performance d'un symbole
```
Why is DOGE/USDT showing poor performance in the backtest?
Analyze all DOGE trades and suggest if we should remove it.
```

**Ce que Claude fera**:
- Filtre les trades DOGE uniquement
- Compare avec autres symboles
- Identifie les patterns de perte (volatilité, slippage, timing)
- Recommandation: garder/retirer avec impact estimé

---

#### 6. Analyser les exit reasons
```
Analyze the distribution of exit reasons and tell me if the trailing stop is working well
```

**Ce que Claude fera**:
- Graphique de distribution (Trailing: 77%, SL: 7%, etc.)
- Analyse de l'efficacité de chaque exit
- Comparaison avec benchmarks
- Suggestions d'amélioration

---

#### 7. Time-of-day analysis
```
Are there specific hours where the strategy performs poorly?
Should we avoid trading during certain times?
```

**Ce que Claude fera**:
- Groupe trades par heure (UTC)
- Calcule win rate et avg PnL par heure
- Identifie heures à éviter (< 40% WR)
- Recommande filtres temporels si pertinent

---

#### 8. Trade duration analysis
```
Do longer trades have better win rates?
Should we add a minimum hold time?
```

**Ce que Claude fera**:
- Segmente trades par durée (< 1h, 1-3h, > 3h)
- Compare win rates et avg PnL
- Identifie le sweet spot
- Recommande MIN_HOLD_TIME si bénéfique

---

### Validation Pré-Déploiement

#### 9. Validation complète avant production
```
I want to deploy V5.34 to production.
Analyze the backtest thoroughly and tell me if it's safe to deploy.
```

**Ce que Claude fera**:
- Checklist de validation complète
- Vérification des métriques vs benchmarks
- Détection d'anomalies (look-ahead bias, overfitting)
- Go/No-Go recommendation avec justification

---

#### 10. Vérification de robustesse
```
Run Monte Carlo analysis on the backtest to check if results are robust
or just lucky
```

**Ce que Claude fera**:
- Resample des trades (1,000 simulations)
- Calcule percentiles (P5, P50, P95)
- Évalue si même worst case est profitable
- Assess robustesse de la stratégie

---

### Analyse Avancée

#### 11. Pattern discovery
```
What patterns distinguish winning trades from losing trades?
Find actionable insights.
```

**Ce que Claude fera**:
- Compare features entre wins et losses (ROC, volume, BB position, etc.)
- Identifie corrélations significatives
- Suggère nouveaux filtres basés sur patterns
- Estime impact des filtres suggérés

---

#### 12. Drawdown analysis
```
Analyze the equity curve drawdowns.
How long do losing periods last and how can we reduce them?
```

**Ce que Claude fera**:
- Identifie toutes les périodes de drawdown
- Calcule durée moyenne et max
- Analyse les causes (market regime, overtrading)
- Suggère protections (circuit breaker, drawdown limits)

---

#### 13. Entry condition effectiveness
```
Which entry conditions correlate most with winning trades?
```

**Ce que Claude fera**:
- Analyse ROC, volume ratio, BB position par trade
- Calcule corrélation avec outcome (win/loss)
- Identifie seuils optimaux
- Recommande ajustements de filtres

---

## 🔍 Code Consistency Checker - Exemples de Prompts

### Vérifications de Base

#### 14. Check général
```
Check if my backtest and production code are consistent
```

**Ce que Claude fera**:
- Compare backtestService.ts et simpleAgent.ts
- Vérifie imports partagés (momentumSimple.ts, signalRanker.ts)
- Valide paramètres (ROC, BB, SMA200, trailing stop)
- Report: PASS / WARNING / CRITICAL avec détails

---

#### 15. Check rapide avant commit
```
Quick consistency check on the files I just changed
```

**Ce que Claude fera**:
- Focus sur fichiers récemment modifiés
- Vérifie que changements propagent au backtest ET production
- Alerte si divergence introduite
- Suggère fixes si nécessaire

---

### Validations Spécifiques

#### 16. Vérifier entry logic
```
Verify that entry conditions are identical in backtest and production
```

**Ce que Claude fera**:
- Compare fonction checkMomentumSignal() usage
- Vérifie paramètres: ROC_MIN, VOL_MULTIPLIER, BB config
- Valide filtres: consecutive candles, StochRSI
- Report divergences avec impact estimé

---

#### 17. Vérifier exit logic
```
Check if trailing stop implementation is identical in backtest and live trading
```

**Ce que Claude fera**:
- Compare TRAILING_STOP config
- Vérifie: activation threshold, distance, confirmation candles
- Valide adaptive logic (low vol vs high vol)
- Ensure production matches backtest

---

#### 18. Vérifier indicators
```
Are indicator calculations (BB, ROC, SMA200) identical in both implementations?
```

**Ce que Claude fera**:
- Compare calcBollingerBands parameters
- Vérifie ROC lookback periods
- Valide SMA200 pour regime detection
- Report paramètres numériques divergents

---

#### 19. Vérifier signal scoring
```
Verify that signal ranking uses the same scoring function in backtest and production
```

**Ce que Claude fera**:
- Vérifie import de calculateSignalScore()
- Compare weights (roc, volume, bbPosition, atr, trend)
- Valide que ranking est identique
- Critique: divergence ici invalide backtest complètement!

---

### Debugging

#### 20. Investiguer divergence live vs backtest
```
My backtest predicted +200% ROI but I'm down 10% after 2 weeks live.
Find what's different between backtest and production code.
```

**Ce que Claude fera**:
- Check complet ligne par ligne
- Identifie divergences (paramètres, logic, data sources)
- Explique laquelle cause la performance gap
- Fournit fix exact avec code snippets

---

#### 21. Détecter look-ahead bias
```
Check if my backtest has look-ahead bias
(using future data not available in real-time)
```

**Ce que Claude fera**:
- Cherche `close[0]` dans signal generation
- Vérifie que production attend candle close
- Valide timing de signal generation
- Report red flags avec severity

---

#### 22. Vérifier cost model
```
Is my backtest using realistic trading costs?
```

**Ce que Claude fera**:
- Vérifie fees (devrait être 0.04% pour Binance)
- Valide slippage (0.05% est réaliste)
- Check funding rate modeling
- Compare avec coûts réels de production

---

### Validation Post-Changement

#### 23. Après modification de stratégie
```
I just changed the stagnant exit logic.
Verify both backtest and production have the same new implementation.
```

**Ce que Claude fera**:
- Compare STAGNANT_EXIT config
- Vérifie: TRIGGER_TIME, OBSERVATION_WINDOW, thresholds
- Valide state machine identique
- Ensure changements propagés aux deux

---

#### 24. Après ajout de feature
```
I added multi-timeframe confluence.
Check if it's implemented consistently in backtest and production.
```

**Ce que Claude fera**:
- Vérifie fetching de 1h et 4h candles
- Compare checkMultiTimeframeAlignment() usage
- Valide thresholds identiques
- Report si nouvelle feature crée divergence

---

### Validation Architecturale

#### 25. Vérifier shared architecture
```
Verify that my shared strategy file architecture is still intact
(both backtest and production import from momentumSimple.ts)
```

**Ce que Claude fera**:
- Cherche imports de momentumSimple.ts dans les deux
- Détecte code dupliqué (red flag!)
- Valide que changements à momentumSimple.ts affectent les deux
- Protect cette excellente architecture

---

#### 26. Audit complet pré-production
```
Complete architecture audit before production deployment.
Check EVERYTHING: entry, exit, indicators, scoring, sizing, costs, timing.
```

**Ce que Claude fera**:
- Checklist exhaustive (9 étapes)
- Validation de chaque component critique
- Look-ahead bias scan
- State persistence check
- Report détaillé avec go/no-go

---

## 🔄 Workflows Complets

### Workflow 1: Développer Nouvelle Version

```
Conversation complète:

You: "I'm developing V5.35 with multi-timeframe confluence.
      First, check if my current code is consistent."

Claude: [Runs code-consistency-checker]
        ✓ V5.34 code is consistent. Safe to proceed with changes.

You: "Good. I've implemented V5.35.
      Check consistency again to make sure I didn't break anything."

Claude: [Runs code-consistency-checker on new code]
        ✓ PASS - Both backtest and production have multi-timeframe logic
        ✓ Parameters match (1h and 4h alignment required)

You: "Perfect. Now run the backtest."

[You run: npm run analyze:performance]

You: "Analyze V5.35 backtest and compare with V5.34 baseline."

Claude: [Runs backtest-analyzer]
        ## Comparison: V5.35 vs V5.34
        | Metric | V5.34 | V5.35 | Change |
        | ROI | +501% | +687% | +37% ✓ |
        | Win Rate | 59.2% | 72.1% | +13pp ✓ |
        | Trades | 1,089 | 723 | -34% |

        **Conclusion**: V5.35 significantly outperforms with better quality trades

You: "Is V5.35 ready for production?"

Claude: [Validation checks]
        ✓ Code consistent
        ✓ Metrics excellent (72% WR is strong)
        ✓ Costs realistic
        ✓ No look-ahead bias detected

        **Recommendation**: Deploy to paper trading for 1 week validation

You: "Deploy to paper"

[After 1 week]

You: "Compare paper trading results with V5.35 backtest predictions"

Claude: [Compares live vs backtest]
        Paper: 68% WR vs Backtest: 72% WR (-4pp within acceptable range)
        Paper: +12.3% ROI (1 week) vs Backtest pro-rata: +13.2%

        **Assessment**: Results match backtest closely. Safe for live deployment.
```

---

### Workflow 2: Debugging Production Issue

```
Conversation:

You: "Production is underperforming backtest significantly.
      Backtest: 59% WR, Production: 42% WR. What's wrong?"

Claude: [Runs code-consistency-checker immediately]
        🔴 CRITICAL DIVERGENCE FOUND

        PRODUCTION (simpleAgent.ts:892):
        Uses overridden config with ROC_MIN = 2.5%

        BACKTEST (backtestService.ts:456):
        Uses default config with ROC_MIN = 1.75%

        IMPACT: Production requires 43% higher momentum,
                generates fewer signals with lower quality

You: "Fix it"

Claude: [Provides exact fix]
        Change simpleAgent.ts line 892:
        FROM: const config = { ...MomentumConfig, LONG: { ROC_MIN: 2.5 } }
        TO:   const config = MomentumConfig

        [Claude applies fix using Edit tool]

You: "Verify it's fixed"

Claude: [Runs code-consistency-checker again]
        ✓ PASS - ROC_MIN now matches: 1.75% in both

You: "Re-run backtest to validate"

[You run: npm run analyze:performance]

You: "Analyze the corrected backtest"

Claude: [Runs backtest-analyzer]
        Results now match original V5.34:
        - Win Rate: 59.2% ✓
        - ROI: +501% ✓
        - Trade count: 1,089 ✓

        **Recommendation**: Backtest is now accurate.
        Redeploy to production with corrected code.
```

---

## 💡 Pro Tips

### Tip 1: Combiner les Skills

```
"First check code consistency, then analyze the backtest results"
```

Claude exécutera les deux skills en séquence et croiser les insights.

---

### Tip 2: Questions de Suivi

```
You: "Analyze the latest backtest"
Claude: [Full analysis]

You: "Show me the 10 worst losing trades"
Claude: [Filtered analysis]

You: "What do these 10 trades have in common?"
Claude: [Pattern identification]

You: "How can I avoid these losses in V5.36?"
Claude: [Actionable recommendations]
```

---

### Tip 3: Validation Hypothesis

```
"I think trades during high BTC volatility have lower win rates.
Test this hypothesis using the backtest data."
```

Claude va:
1. Calculer BTC volatility par période
2. Grouper trades par niveau de volatility
3. Comparer win rates
4. Valider ou rejeter hypothesis avec données

---

### Tip 4: Demander du Code

```
"Analyze the backtest and suggest code changes to implement your top 3 recommendations"
```

Claude fournira:
1. Recommandations priorisées
2. Code exact à modifier (fichier:ligne)
3. Snippets de remplacement
4. Impact estimé de chaque changement

---

## 📝 Templates de Prompts

### Template: Validation Pré-Déploiement

```
I'm about to deploy [VERSION] to [ENVIRONMENT].
Please:
1. Check code consistency
2. Analyze backtest results
3. Validate metrics are acceptable
4. Check for any red flags
5. Provide go/no-go recommendation
```

---

### Template: Weekly Review

```
Weekly strategy review:
1. Compare this week's backtest with last week
2. Identify any performance degradation
3. Check if code has drifted
4. Recommend actions for next week
```

---

### Template: Root Cause Analysis

```
[SYMPTOM] is happening in [ENVIRONMENT].
Please:
1. Check for code divergences
2. Identify possible causes
3. Suggest fixes with exact code changes
4. Estimate impact of each fix
```

---

## 🎯 Cas d'Usage Réels

### Cas 1: Nouveau Dev rejoint l'équipe

**Prompt**:
```
I'm new to this trading system.
Explain the strategy implementation and validate code quality.
```

**Claude utilisera**:
- code-consistency-checker (pour mapper l'architecture)
- Analyse de momentumSimple.ts, simpleAgent.ts
- Explique le flow: entry → signal ranking → execution → exit

---

### Cas 2: Bug de Production

**Prompt**:
```
Emergency: Production is losing money while backtest was profitable.
Find the bug ASAP.
```

**Claude**:
- Priority 1: code-consistency-checker (divergence?)
- Priority 2: Analyse live logs vs backtest
- Priority 3: Identify root cause
- Provide immediate fix

---

### Cas 3: Optimisation de Paramètres

**Prompt**:
```
I want to optimize trailing stop distance (currently 0.5%).
Test values from 0.3% to 1.0% in 0.1% increments using backtest data.
```

**Claude**:
- Run 8 backtests (si résultats existent) ou guide pour les générer
- Compare métriques
- Trouve optimal (trade-off: exit trop tôt vs trop tard)
- Recommande nouvelle valeur avec justification

---

## 🚀 Utilisation Avancée

### Multi-Symbol Analysis

```
Compare backtest performance across all 19 symbols.
Which symbols should we keep and which should we remove?
```

---

### Regime-Based Analysis

```
Analyze backtest performance separately for:
- Bull regime (BTC > SMA200)
- Bear regime (BTC < SMA200)
Are different parameters needed for each regime?
```

---

### Cost Sensitivity

```
How sensitive are backtest results to trading costs?
Test with fees: 0.02%, 0.04%, 0.06% and slippage: 0.05%, 0.10%, 0.20%
```

---

## 🧠 Pattern Researcher - Exemples de Prompts

### Découverte de Patterns de Base

#### 27. Rechercher pattern de volume
```
Research volume accumulation pattern and test on historical data.
Hypothesis: Trades with 3+ consecutive rising volume candles have higher win rates.
```

**Ce que Claude fera**:
- Analyse préliminaire sur données historiques
- Calcule win rate avec vs sans pattern
- Implémente fonction de détection dans momentumSimple.ts
- Run backtest avec pattern enabled/disabled
- Compare métriques et recommande enable/disable

---

#### 28. Tester multi-timeframe confluence
```
Test if multi-timeframe confluence (15m + 1h + 4h alignment) improves win rate
```

**Ce que Claude fera**:
- Fetch candles 1h et 4h en plus de 15m
- Implémente checkMultiTimeframeAlignment()
- Backtest avec vs sans alignment
- Mesure impact sur trade count et win rate
- Recommande thresholds optimaux

---

#### 29. Analyser order flow imbalance
```
Analyze order flow imbalance patterns.
Can bid/ask ratio > 2:1 predict trade success?
```

**Ce que Claude fera**:
- Utilise depth.ts et bookWalkSlippage.ts existants
- Calcule bid/ask ratio historique
- Groupe trades par imbalance level
- Compare win rates
- Suggère threshold optimal

---

### Pattern Testing Workflow

#### 30. Test complet d'un pattern
```
I want to test the BB Squeeze pattern comprehensively.
1. Analyze if it works in historical data
2. Implement detection code
3. Run backtest validation
4. Document results V5.XX style
5. Recommend enable or disable
```

**Ce que Claude fera**:
- Phase 1: Analyse exploratoire (corrélations, win rates)
- Phase 2: Implementation avec feature flag
- Phase 3: Backtest comparatif (avec vs sans)
- Phase 4: Statistical significance check
- Phase 5: Documentation style V5.XX avec décision

---

#### 31. Valider hypothesis avec données
```
Hypothesis: Trades during high BTC volatility have lower win rates.
Test this on 12 months of data and suggest a filter if validated.
```

**Ce que Claude fera**:
- Calcule BTC ATR par période
- Groupe trades par volatility level (low/medium/high)
- Compare win rates et avg PnL
- Statistical test (chi-square)
- Si validé: implémente volatility filter

---

### Pattern Documentation

#### 32. Documenter pattern discovery
```
Document the volume accumulation pattern discovery process.
Include: hypothesis, test results, code, backtest comparison, decision.
Follow V5.XX versioning style.
```

**Ce que Claude fera**:
- Génère rapport complet avec:
  - Hypothesis formation
  - Preliminary analysis (data)
  - Implementation (code snippets)
  - Backtest results (metrics table)
  - Decision (ENABLED/DISABLED avec raisons)
- Ajoute block de commentaire V5.XX dans code
- Crée commit message détaillé

---

## ⚡ Strategy Optimizer - Exemples de Prompts

### Optimisation de Paramètres

#### 33. Optimiser trailing stop
```
Optimize trailing stop distance parameter.
Test values from 0.3% to 1.0% in 0.1% increments.
Use walk-forward validation to prevent overfitting.
```

**Ce que Claude fera**:
- Define parameter grid: [0.003, 0.004, ..., 0.010]
- Split data: train (70%) / test (30%)
- Run 8 backtests avec chaque valeur
- Compare Sharpe ratios
- Validate best param sur test set (out-of-sample)
- Report optimal value avec confidence

---

#### 34. Grid search multi-paramètres
```
Grid search for optimal entry parameters:
- ROC_MIN: 1.0 to 2.5 (0.25 steps)
- VOL_MULTIPLIER: 1.0 to 2.0 (0.15 steps)
Find combination that maximizes Sharpe ratio.
```

**Ce que Claude fera**:
- Génère 7 × 7 = 49 combinations
- Run backtest pour chaque
- Crée heatmap de sensibilité
- Identifie top 5 combinations
- Valide sur out-of-sample period
- Recommande robust parameters

---

#### 35. Optimisation par régime de marché
```
Test if different parameters work better in different market regimes.
Optimize separately for:
- Bull low vol
- Bull high vol
- Bear low vol
- Bear high vol
```

**Ce que Claude fera**:
- Détecte régimes dans historical data
- Split data par régime
- Run grid search sur chaque régime
- Compare optimal params across regimes
- Décide: single param set ou adaptive params?
- Implémente getAdaptiveConfig() si bénéfique

---

### Validation et Deployment

#### 36. Valider robustesse des paramètres
```
Validate parameter robustness with walk-forward analysis.
Use 3 rolling 6-month windows to test stability.
```

**Ce que Claude fera**:
- Period 1: Train Q1-Q2, Test Q3
- Period 2: Train Q2-Q3, Test Q4
- Period 3: Train Q3-Q4, Test Q1
- Compare performance across periods
- Calculate average out-of-sample retention
- Accept if retention > 80%

---

#### 37. Déployer paramètres optimisés
```
Deploy optimized parameters to V5.36.
Update momentumSimple.ts with:
- ROC_MIN: 1.85 (was 1.75)
- VOL_MULTIPLIER: 1.25 (was 1.15)
Document optimization process and results.
```

**Ce que Claude fera**:
- Update momentumSimple.ts values
- Add V5.36 documentation block avec:
  - Optimization method
  - Test results
  - Performance improvement
  - Validation metrics
- Create commit message
- Generate deployment report

---

### Analyse Avancée

#### 38. Sensitivity analysis
```
Analyze parameter sensitivity.
Which parameters have biggest impact on performance?
Create visualization showing impact of each parameter.
```

**Ce que Claude fera**:
- Run one-at-a-time parameter variation
- Measure impact on Sharpe, ROI, WR
- Create sensitivity charts
- Rank parameters by importance
- Recommande which to optimize first

---

## 🤖 ML Signal Scorer - Exemples de Prompts

### Data Preparation

#### 39. Exporter données pour ML
```
Export historical trades for ML training.
Include all features: ROC, volume, BB position, ATR, trend strength.
Need at least 1,000 trades with outcomes.
```

**Ce que Claude fera**:
- Load backtest results
- Extract features pour chaque trade
- Add target variable (win=1, loss=0)
- Export to CSV: ml_training_data.csv
- Validate data quality (no missing values)
- Report statistics (samples, win rate, features)

---

#### 40. Feature engineering
```
Analyze which features correlate most with winning trades.
Remove low-value features before training.
```

**Ce que Claude fera**:
- Calculate correlations avec target
- Create correlation plot
- Identify important features (|corr| > 0.05)
- Remove redundant features
- Export final feature list

---

### Model Training

#### 41. Entraîner modèle XGBoost
```
Train XGBoost model to predict win probability.
Use 70/30 train/test split (time-based, not random).
Optimize for AUC-ROC score.
```

**Ce que Claude fera**:
- Split data chronologically
- Train XGBoost avec hyperparameters
- Evaluate sur test set
- Report metrics: Accuracy, AUC, Precision, Recall
- Feature importance analysis
- Save model to models/signal_scorer_xgb_v1.pkl

---

#### 42. Valider modèle ML
```
Validate ML model performance.
Check if predictions generalize to unseen data.
Test AUC should be > 0.70 to proceed.
```

**Ce que Claude fera**:
- Predictions sur test set
- Confusion matrix
- ROC curve plot
- Compare test vs train AUC (detect overfitting)
- Calculate confidence intervals
- Go/No-Go decision

---

### Integration

#### 43. Intégrer ML dans signal ranker
```
Integrate ML model into signalRanker.ts.
Combine ML predictions (70%) with manual scoring (30%) for robustness.
Keep manual scoring as fallback.
```

**Ce que Claude fera**:
- Create mlSignalScorer.ts wrapper
- Python inference script
- Update signalRanker.ts
- Add feature flag: USE_ML_SCORING
- Implement graceful degradation
- Test integration

---

#### 44. Backtest avec ML
```
Run backtest with ML-enhanced signal scoring enabled.
Compare with baseline (manual scoring).
ML should improve Sharpe by >10% to justify complexity.
```

**Ce que Claude fera**:
- Enable USE_ML_SCORING = true
- Run full backtest
- Compare ML vs Manual metrics
- Create comparison table
- Analyze which signals ML improved
- Recommend deployment si improvement > 10%

---

### Maintenance

#### 45. Setup retraining pipeline
```
Set up monthly model retraining pipeline.
Automate:
1. Export latest trades
2. Retrain model
3. Validate performance
4. Deploy if better than previous
```

**Ce que Claude fera**:
- Create retrain_ml_model.py script
- Add performance checks (reject if AUC drops > 5%)
- Export new model avec versioning
- Create cron job for monthly execution
- Document retraining process

---

## 🔄 Workflows Combinés (Multi-Skills)

### Workflow: Développer et Optimiser Nouveau Pattern

```
Complete workflow to develop volume accumulation pattern:

1. "Research volume accumulation pattern and test hypothesis"
   → Uses pattern-researcher

2. "If promising, optimize MIN_RISING_CANDLES parameter (test 2, 3, 4, 5)"
   → Uses strategy-optimizer

3. "Check code consistency after implementing pattern"
   → Uses code-consistency-checker

4. "Analyze optimized V5.35 backtest and compare with V5.34 baseline"
   → Uses backtest-analyzer

5. "If successful, document and deploy to production"
```

---

### Workflow: Full ML Integration

```
End-to-end ML integration workflow:

1. "Export 2,000+ historical trades with all features for ML training"
   → Uses ml-signal-scorer (data prep)

2. "Train and validate XGBoost model for signal scoring"
   → Uses ml-signal-scorer (training)

3. "Integrate ML model into signal ranker with fallback to manual scoring"
   → Uses ml-signal-scorer (integration)

4. "Run backtest with ML enabled and compare with manual baseline"
   → Uses backtest-analyzer

5. "Verify ML integration doesn't break backtest-production parity"
   → Uses code-consistency-checker

6. "If improvement > 15%, deploy to paper trading and set up retraining"
```

---

### Workflow: Systematic Strategy Improvement

```
Quarterly optimization cycle:

1. "Analyze last 3 months of live trading performance vs backtest"
   → Uses backtest-analyzer

2. "Research new patterns that could improve identified weaknesses"
   → Uses pattern-researcher

3. "Optimize all key parameters with latest 12 months of data"
   → Uses strategy-optimizer

4. "Validate all changes maintain backtest-production consistency"
   → Uses code-consistency-checker

5. "Document improvements and deploy new version"
```

---

Utilisez ces prompts comme point de départ et adaptez-les à vos besoins spécifiques ! 🎯

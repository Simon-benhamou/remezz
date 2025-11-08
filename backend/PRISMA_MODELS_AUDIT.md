# Audit des Modèles Prisma - Trading Agent IA v3

Date: 8 novembre 2025

## ✅ Modèles Activement Utilisés

### 🔥 Très Utilisés (>50 références)

1. **AgentSession** - Core du système
   - Gestion des sessions de trading
   - Relations avec orders, fills, positions, strategies
   - Utilisé partout dans le système

2. **Order** - Gestion des ordres
   - Création, suivi, mise à jour des ordres
   - Relations avec fills, strategies
   - Largement utilisé dans engine, routes, persistence

3. **Fill** - Exécutions de trades
   - Enregistrement des fills d'ordres
   - Calcul de performance
   - Utilisé dans persistence, performance, routes

4. **User** - Authentification
   - Login, registration, gestion des utilisateurs
   - Relations avec UserApiKey, UserSetting
   - Utilisé dans auth, routes

5. **UserApiKey** - Clés API des exchanges
   - Gestion des credentials pour exchanges
   - Utilisé dans auth, debug, user routes

### ✅ Moyennement Utilisés (10-50 références)

6. **Position** - Positions actives
   - Tracking des positions ouvertes
   - Utilisé dans agent hub, persistence, routes

7. **SessionKpi** - Métriques de performance
   - ROI, winRate, expectancy, drawdown
   - Utilisé dans performance tracking, routes

8. **Strategy** - Stratégies de trading
   - Stockage des plans générés par AI
   - Utilisé dans strategyManager, routes

9. **DecisionMemory** - Apprentissage machine
   - Mémorisation des décisions et résultats
   - Utilisé pour l'amélioration continue
   - Utilisé dans learning/decisionMemory

10. **AdaptiveThreshold** - Seuils adaptatifs
    - Optimisation des poids par famille de crypto
    - Utilisé dans learning, monitor routes

11. **SchedulerJob** - Système de jobs
    - Gestion des tâches planifiées
    - Utilisé dans schedulerJobService, autoUniverse

12. **LeverageConstraint** - Contraintes de levier
    - Caps de levier par symbole/catégorie
    - Utilisé dans risk/leverageCaps

13. **UserSetting** - Paramètres utilisateur
    - Configuration personnalisée
    - Utilisé dans portfolioManager, user routes

14. **TriggerLog** - Logs de triggers
    - Historique des événements de marché
    - Utilisé dans engine/events, routes

15. **DailyReport** - Rapports journaliers
    - Synthèses de performance quotidienne
    - Utilisé dans monitor routes

### ✅ Peu Utilisés mais Utiles (1-10 références)

16. **Alert** - Système d'alertes
    - Alertes pour situations anormales
    - Utilisé dans monitor routes (seulement lecture)

17. **ImprovementItem** - Suivi d'améliorations
    - Gestion des issues et améliorations
    - Utilisé dans improvements routes

18. **DiagnosticsCache** - Cache de diagnostics
    - Stockage temporaire de données de diagnostic
    - Relation avec User (pas trouvé d'utilisation active dans le code)

19. **AutoUniverseSchedule** - Planification auto-universe
    - Gestion des retries pour sélection automatique
    - Utilisé dans autoUniverseScheduler

20. **AuditLog** - Logs d'audit
    - Historique des actions importantes
    - Utilisé dans stopAllAgents

21. **AgentOpsTelemetry** - Télémétrie opérationnelle
    - Suivi des métriques opérationnelles par agent
    - Utilisé dans agent/persistence

22. **TradeEvaluation** - Évaluation des trades (NOUVEAU)
    - Logging des décisions de trade avec contexte
    - Utilisé dans learning/tradeEvaluationLogger, strategyOptimizer

23. **CryptoPersonalityProfile** - Profils de cryptos (NOUVEAU)
    - Paramètres optimisés par symbole
    - Utilisé dans learning/personalityProfile, strategies/core

## ⚠️ Modèles NON Utilisés (Candidats pour Suppression)

### 🗑️ À SUPPRIMER

1. **SentimentSnapshot** ❌
   - **Usage actuel**: Seulement `deleteMany` lors de suppression de session
   - **Raison**: Fonctionnalité de sentiment jamais implémentée
   - **Action recommandée**: SUPPRIMER le modèle et les relations

2. **AiPromptLog** ❌
   - **Usage actuel**: AUCUN (même pas de deleteMany)
   - **Raison**: Logging des prompts AI jamais implémenté
   - **Action recommandée**: SUPPRIMER le modèle et les relations

3. **MarginSnapshot** ❌
   - **Usage actuel**: AUCUN (même pas de deleteMany)
   - **Raison**: Monitoring de marge jamais implémenté
   - **Action recommandée**: SUPPRIMER le modèle et les relations

## ✅ Services de Learning Bien Utilisés

### Ces services SONT utilisés et doivent être conservés:

1. **src/services/adaptiveThresholdLearning.ts** ✅
   - Système d'apprentissage de thresholds
   - Utilisé dans: server.ts (initialisation), entryAnalytics.ts (routes API)
   - Fournit: `initializeAdaptiveLearning()`, `analyzeThresholdPerformance()`, `getAdaptiveLearningState()`
   - **Action**: CONSERVER

2. **src/services/symbolSpecificOptimization.ts** ✅
   - Optimisation par symbole des thresholds
   - Utilisé dans: server.ts (initialisation via `initializeSymbolProfiles()`, `startSymbolOptimizationScheduler()`)
   - **Action**: CONSERVER

3. **src/services/abTesting.ts** ✅
   - Framework de A/B testing pour thresholds
   - Utilisé dans: server.ts (initialisation via `initializeABTesting()`)
   - **Action**: CONSERVER

## 📊 Résumé des Actions Recommandées

### Suppression Immédiate (Gain: Simplification + Performance)

```prisma
// À SUPPRIMER du schema.prisma:

model SentimentSnapshot { ... }
model AiPromptLog { ... }
model MarginSnapshot { ... }
```

**Relations à nettoyer dans AgentSession:**
```prisma
model AgentSession {
  // À SUPPRIMER:
  sentiments SentimentSnapshot[]
  prompts    AiPromptLog[]
  marginSnapshots MarginSnapshot[]
}
```

### ✅ Services de Learning à CONSERVER

Les services suivants sont activement utilisés et ne doivent PAS être supprimés:
- `adaptiveThresholdLearning.ts` - Initialisé dans server.ts, utilisé dans entryAnalytics routes
- `symbolSpecificOptimization.ts` - Initialisé dans server.ts
- `abTesting.ts` - Initialisé dans server.ts

### Nettoyage de Code

Dans `backend/src/routes/agent.ts` (ligne ~1545):
```typescript
// Supprimer cette ligne devenue inutile:
await prisma.sentimentSnapshot.deleteMany({ where: { sessionId: id } });
```

## 💡 Modèles Récents et Bien Intégrés

Les nouveaux modèles **TradeEvaluation** et **CryptoPersonalityProfile** sont:
- ✅ Bien intégrés dans le code
- ✅ Utilisés activement pour l'apprentissage
- ✅ Connectés au système de stratégie
- ✅ À CONSERVER

## 🎯 Impact de la Suppression

### Bénéfices:
1. **Performance**: Moins de tables à indexer/scanner
2. **Clarté**: Schema plus simple et compréhensible
3. **Maintenance**: Moins de code mort à maintenir
4. **Migration**: Base de données plus légère

### Risques:
- **AUCUN** - Ces modèles ne sont pas utilisés dans le code de production

## 🔧 Plan d'Action

1. **Phase 1**: Nettoyer le schema Prisma
   - Supprimer SentimentSnapshot, AiPromptLog, MarginSnapshot
   - Supprimer leurs relations dans AgentSession

2. **Phase 2**: Régénérer et migrer
   ```bash
   npm run prisma:gen
   npx prisma migrate dev --name remove_unused_models
   npm run build  # Vérifier que tout compile
   ```

3. **Phase 3**: Nettoyer les références
   - Supprimer la ligne deleteMany dans routes/agent.ts

## ⚡ Conclusion

**Modèles à garder**: 23 modèles actifs et utiles
**Modèles à supprimer**: 3 modèles (SentimentSnapshot, AiPromptLog, MarginSnapshot)
**Services à supprimer**: AUCUN - tous les services de learning sont utilisés

**Gain estimé**: 
- -12% de complexité du schema
- -3 tables en base de données  
- Meilleure performance des requêtes (moins d'index inutiles)
- Code plus propre (suppression d'une relation morte dans agent.ts)

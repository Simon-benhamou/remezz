# Agent Performance Analysis Tools

Ce dossier contient des outils automatisés pour analyser et surveiller les performances des agents de trading.

## Outils Disponibles

### 1. Agent Performance Analyzer (`agent-performance-analyzer.ts`)

Script d'analyse complète des performances des agents actifs. Fournit des métriques détaillées, un système de notation A-F, et des recommandations d'amélioration.

**Fonctionnalités:**
- Analyse des métriques clés (win rate, profit factor, expectancy, drawdown)
- Système de notation intelligent (A-F) basé sur les performances
- Détection automatique des problèmes et recommandations
- Analyse des conditions de marché globales
- Génération d'alertes critiques et opportunités

**Utilisation:**
```bash
# Analyse unique
npm run analyze:performance

# Ou directement
npx tsx scripts/agent-performance-analyzer.ts
```

### 2. Agent Performance Monitor (`agent-performance-monitor.ts`)

Service de surveillance continue qui exécute l'analyseur de performance à intervalles réguliers et journalise les résultats.

**Fonctionnalités:**
- Surveillance automatisée avec intervalles configurables
- Journalisation structurée des analyses
- Système d'alertes configurables
- Intégration facile avec cron jobs ou services système

**Utilisation:**
```bash
# Démarrer la surveillance continue (toutes les heures par défaut)
npm run monitor:start

# Analyse unique via le monitor
npm run monitor:once

# Arrêter la surveillance
npm run monitor:stop
```

**Variables d'environnement:**
- `MONITOR_INTERVAL_MINUTES`: Intervalle entre les analyses (défaut: 60)
- `DISABLE_ALERTS`: Désactiver les alertes (défaut: false)

## Métriques Analysées

### Métriques de Performance
- **Win Rate**: Taux de réussite des trades
- **Profit Factor**: Ratio profits/pertes
- **Expectancy**: Gain attendu par trade
- **Risk/Reward Ratio**: Ratio risque/récompense moyen
- **Max Drawdown**: Plus grande perte cumulée
- **Sharpe Ratio**: Ratio rendement/risque ajusté
- **Calmar Ratio**: Ratio rendement/drawdown annualisé

### Métriques de Trading
- **Nombre de Trades**: Volume d'activité
- **Série de Gains/Pertes**: Streaks consécutives
- **Temps de Détention Moyen**: Durée moyenne des positions
- **Profit Moyen par Trade**: Gains/pertes moyens

### Analyse de Marché
- **Conditions Globales**: Trend, volatilité
- **Recommandations**: Ajustements stratégiques

## Système de Notation

Le système de notation A-F évalue les agents selon plusieurs critères:

- **A (90-100)**: Performance exceptionnelle
- **B (80-89)**: Bonne performance
- **C (70-79)**: Performance acceptable
- **D (60-69)**: Performance faible
- **F (0-59)**: Performance critique nécessitant intervention

## Alertes et Recommandations

### Alertes Critiques
- Grade F (performance critique)
- Plus de 10 pertes consécutives
- Expectancy négatif
- Drawdown excessif

### Recommandations Automatiques
- Ajustement des seuils d'entrée
- Amélioration du risk/reward
- Modification des stratégies de sortie
- Changements de timeframe

## Intégration Système

### Cron Job (Linux/Mac)
```bash
# Analyse toutes les heures
0 * * * * cd /path/to/backend && npm run monitor:once

# Analyse toutes les 4 heures avec surveillance continue
0 */4 * * * cd /path/to/backend && timeout 300 npm run monitor:start
```

### Systemd Service (Linux)
Créer `/etc/systemd/system/trading-agent-monitor.service`:
```ini
[Unit]
Description=Trading Agent Performance Monitor
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/backend
ExecStart=/usr/bin/npm run monitor:start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### PM2 (Process Manager)
```bash
# Installation
npm install -g pm2

# Démarrage du monitor
pm2 start "npm run monitor:start" --name "trading-agent-monitor"

# Sauvegarde et redémarrage automatique
pm2 save
pm2 startup
```

## Logs et Historique

Les analyses sont journalisées dans `logs/performance-monitor.log` avec le format:
```
[timestamp] LEVEL: message
[timestamp] ANALYSIS: {"globalWinRate": 45.2, "activeAgents": 3, ...}
[timestamp] ALERT: description
```

## Développement et Extension

### Ajout de Nouvelles Métriques
1. Étendre l'interface `AgentMetrics`
2. Implémenter le calcul dans `analyzeAgent()`
3. Ajouter l'évaluation dans `evaluateAgent()`
4. Mettre à jour les rapports de sortie

### Intégration Base de Données
Le système est prêt pour l'intégration avec une table d'historique des analyses. Voir les commentaires `TODO` dans le code pour l'implémentation.

### Notifications
Les alertes peuvent être étendues pour intégrer:
- Email (Nodemailer)
- Slack/Discord webhooks
- SMS (Twilio)
- Push notifications

## Dépannage

### Problèmes Courants
- **Erreur de compilation**: Vérifier que `@types/node` est installé
- **Pas d'agents actifs**: Vérifier que des sessions sont démarrées
- **Permissions logs**: S'assurer que le dossier `logs/` est accessible en écriture

### Debug
```bash
# Test de compilation
npx tsc --noEmit scripts/agent-performance-analyzer.ts

# Exécution avec debug
DEBUG=* npm run analyze:performance
```

## Performance

- **Analyse typique**: 2-5 secondes pour 10 agents
- **Utilisation mémoire**: ~50MB pendant l'analyse
- **Impact base de données**: Requêtes optimisées avec indexes existants

## Sécurité

- Les scripts respectent les permissions utilisateur
- Pas d'exposition de données sensibles dans les logs
- Compatible avec les politiques de sécurité existantes
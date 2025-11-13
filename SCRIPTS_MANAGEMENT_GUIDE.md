# Scripts de Gestion des Agents - Guide Utilisateur

## 📚 Vue d'Ensemble

Deux nouveaux scripts ont été créés pour faciliter la gestion des agents de trading :

1. **cleanup-paper-sessions.ts** - Nettoyage des sessions paper trading
2. **create-batch-agents.ts** - Création en masse d'agents intelligents

---

## 🗑️ Script de Nettoyage (cleanup-paper-sessions.ts)

### Objectif
Supprimer toutes les données de sessions paper trading tout en préservant les comptes utilisateurs et les clés API.

### Tables Nettoyées
- ✅ **Position** - Positions ouvertes/fermées
- ✅ **Order** - Ordres de trading
- ✅ **Fill** - Exécutions d'ordres
- ✅ **Strategy** - Stratégies évaluées
- ✅ **SessionKpi** - KPIs de performance
- ✅ **TriggerLog** - Logs de déclenchement
- ✅ **Alert** - Alertes système
- ✅ **DailyReport** - Rapports quotidiens
- ✅ **AgentOpsTelemetry** - Télémétrie opérationnelle
- ✅ **DecisionMemory** - Mémoire des décisions
- ✅ **AgentSession** - Sessions d'agents

### Tables Préservées
- ✅ **User** - Comptes utilisateurs
- ✅ **UserApiKey** - Clés API

### Utilisation

#### Mode Dry Run (Par Défaut)
Analyse ce qui serait supprimé SANS effectuer de modification :

```bash
npx tsx scripts/cleanup-paper-sessions.ts
```

**Sortie exemple :**
```
🔍 Analyzing paper trading sessions...

📊 Found 15 paper sessions:

   🔴 Stopped BTC/USDT   | $1000      | [User: cmxxx...] | 2025-01-10
   🟢 Running ETH/USDT   | $1000      | [No User]       | 2025-01-12
   ... and 13 more sessions

📈 Counting related records...

   Positions:        45
   Orders:           230
   Fills:            180
   Strategies:       67
   Session KPIs:     15
   Triggers:         342
   Alerts:           8
   Reports:          15
   Ops Telemetry:    15
   Decision Memory:  89
   Agent Sessions:   15

💥 Total records to delete: 1,021

✅ Dry run complete. Review the counts above.

   To execute deletion, run:
   npx tsx scripts/cleanup-paper-sessions.ts --execute
```

#### Mode Exécution (Suppression Réelle)
Effectue la suppression après confirmation :

```bash
npx tsx scripts/cleanup-paper-sessions.ts --execute
```

**Processus de confirmation :**
```
⚠️  WARNING: This action is IRREVERSIBLE!

   Before proceeding, ensure you have:
   1. ✅ Backed up the database (pg_dump)
   2. ✅ Verified you want to delete paper mode sessions
   3. ✅ Confirmed no active agents are running

   Type 'yes' to confirm deletion of 15 paper sessions and all related records: yes

🗑️  Executing deletion...

   Deleting positions...
   Deleting fills...
   Deleting orders...
   Deleting strategies...
   ... [toutes les tables]

✅ Cleanup complete!

✅ Verification passed: No paper sessions remain.

📊 Preserved data:

   Users:     3
   API Keys:  5
```

#### Options Avancées

**Nettoyer les sessions LIVE** (⚠️ DANGEREUX) :
```bash
npx tsx scripts/cleanup-paper-sessions.ts --mode=live --execute
```

**Nettoyer un mode spécifique :**
```bash
npx tsx scripts/cleanup-paper-sessions.ts --mode=testnet --execute
```

### Sécurités Intégrées

1. **Dry Run par Défaut** - Aucune suppression sans `--execute`
2. **Confirmation Obligatoire** - Demande explicite avant suppression
3. **Avertissement de Backup** - Rappel de sauvegarder la DB
4. **Vérification Post-Suppression** - Compte les sessions restantes
5. **Logging Détaillé** - Affiche chaque étape de suppression

---

## 🤖 Script de Création en Masse (create-batch-agents.ts)

### Objectif
Créer automatiquement plusieurs agents intelligents de différents types pour comparer les performances.

### Fonctionnalités
- ✅ Création d'agents par type d'agressivité (conservative, reactive, aggressive)
- ✅ Configuration par défaut optimisée pour chaque type
- ✅ Mode Smart Auto activé automatiquement
- ✅ Leverage configurable (par défaut 7x)
- ✅ Export JSON des résultats

### Types d'Agressivité

#### 1. **Conservative** 🛡️
- **Risk per trade:** 1.0%
- **Daily loss limit:** 3.0%
- **Approche:** Sélectivité maximale, entrées prudentes

#### 2. **Reactive** ⚡
- **Risk per trade:** 1.5%
- **Daily loss limit:** 3.5%
- **Approche:** Équilibre entre sélectivité et réactivité

#### 3. **Aggressive** 🚀
- **Risk per trade:** 2.0%
- **Daily loss limit:** 4.0%
- **Approche:** Entrées rapides, plus de trades

### Utilisation

#### Création Standard (10 agents de chaque type)
```bash
npx tsx scripts/create-batch-agents.ts
```

**Sortie exemple :**
```
═══════════════════════════════════════════════════════
  Batch Intelligent Agent Creation
═══════════════════════════════════════════════════════

⚙️  Configuration:
   Agents per type:  10
   Max leverage:     7x
   Mode:             paper
   Start balance:    $1000
   Types:            conservative, reactive, aggressive
   User ID:          None (system)

📝 Planning to create 30 total agents...

🚀 Creating 10 CONSERVATIVE agents...

   Creating conservative agent 1/10...
      ✅ Success: BTC/USDT (cmxxx...) [1234ms]
   Creating conservative agent 2/10...
      ✅ Success: ETH/USDT (cmyyy...) [1189ms]
   ...

   ✅ CONSERVATIVE: 10/10 successful

🚀 Creating 10 REACTIVE agents...
   ...

🚀 Creating 10 AGGRESSIVE agents...
   ...

═══════════════════════════════════════════════════════
  Batch Creation Summary
═══════════════════════════════════════════════════════

📊 Overall Statistics:
   Total agents created:  30
   ✅ Successful:         30 (100.0%)
   ❌ Failed:             0 (0.0%)

📈 By Aggressiveness Type:

   CONSERVATIVE    | ✅ 10 | ❌  0 | 100.0%
   REACTIVE        | ✅ 10 | ❌  0 | 100.0%
   AGGRESSIVE      | ✅ 10 | ❌  0 | 100.0%

✅ Successfully Created Agents (30):

   CONSERVATIVE:
      🟢 cmxxx... | BTC/USDT     | 1234ms
      🟢 cmyyy... | ETH/USDT     | 1189ms
      ...

   REACTIVE:
      🟢 cmzzz... | SOL/USDT     | 1456ms
      ...

   AGGRESSIVE:
      🟢 cmaaa... | BNB/USDT     | 1567ms
      ...

💾 Results exported to: ./batch-agents-2025-01-12T18-30-00.json

📊 Database Verification:
   Active paper sessions in DB: 30

✅ All agents created successfully!
```

#### Options Personnalisées

**Créer 5 agents de chaque type :**
```bash
npx tsx scripts/create-batch-agents.ts --count 5
```

**Leverage de 10x :**
```bash
npx tsx scripts/create-batch-agents.ts --leverage 10
```

**Mode LIVE :**
```bash
npx tsx scripts/create-batch-agents.ts --mode live
```

**Balance initiale de $5000 :**
```bash
npx tsx scripts/create-batch-agents.ts --balance 5000
```

**Créer uniquement conservative et aggressive :**
```bash
npx tsx scripts/create-batch-agents.ts --types conservative,aggressive
```

**Associer à un utilisateur spécifique :**
```bash
npx tsx scripts/create-batch-agents.ts --user cmxxx...
```

**Combiner plusieurs options :**
```bash
npx tsx scripts/create-batch-agents.ts --count 5 --leverage 8 --mode paper --balance 2000 --types reactive,aggressive
```

### Fichier JSON Exporté

Le script génère un fichier JSON avec tous les détails :

```json
{
  "timestamp": "2025-01-12T18:30:00.000Z",
  "config": {
    "agentsPerType": 10,
    "maxLeverage": 7,
    "mode": "paper",
    "startBalance": 1000,
    "types": ["conservative", "reactive", "aggressive"],
    "userId": null
  },
  "summary": {
    "total": 30,
    "successful": 30,
    "failed": 0,
    "byType": {
      "conservative": { "success": 10, "failed": 0 },
      "reactive": { "success": 10, "failed": 0 },
      "aggressive": { "success": 10, "failed": 0 }
    }
  },
  "agents": [
    {
      "sessionId": "cmxxx...",
      "symbol": "BTC/USDT",
      "aggressiveness": "conservative",
      "state": "ready",
      "config": {
        "riskPerTradePct": 1.0,
        "dailyLossLimitPct": 3.0
      }
    },
    ...
  ]
}
```

### Validation et Sécurités

1. **Validation du Leverage** - Entre 1x et 10x
2. **Validation des Types** - Seulement conservative/reactive/aggressive
3. **Validation Utilisateur** - Vérifie l'existence du user ID
4. **Délai Entre Créations** - 500ms pour éviter les rate limits
5. **Export Automatique** - Sauvegarde JSON horodatée

---

## 📊 Cas d'Usage

### 1. Nettoyage Hebdomadaire
Nettoyer les sessions paper de tests :
```bash
# Analyser d'abord
npx tsx scripts/cleanup-paper-sessions.ts

# Puis exécuter si OK
npx tsx scripts/cleanup-paper-sessions.ts --execute
```

### 2. Test de Performance A/B
Créer 10 agents de chaque type pour comparer :
```bash
npx tsx scripts/create-batch-agents.ts --count 10 --leverage 7
```

Résultat : 30 agents (10 conservative, 10 reactive, 10 aggressive) prêts pour analyse comparative.

### 3. Test de Leverage
Comparer différents niveaux de leverage :
```bash
# Batch 1 : Leverage 5x
npx tsx scripts/create-batch-agents.ts --count 5 --leverage 5

# Batch 2 : Leverage 10x
npx tsx scripts/create-batch-agents.ts --count 5 --leverage 10
```

### 4. Test de Balance Initiale
```bash
# Petits portefeuilles
npx tsx scripts/create-batch-agents.ts --count 5 --balance 500

# Gros portefeuilles
npx tsx scripts/create-batch-agents.ts --count 5 --balance 10000
```

---

## ⚠️ Avertissements Importants

### Cleanup Script
- ⚠️ **SUPPRESSION IRRÉVERSIBLE** - Aucun rollback possible
- ⚠️ **TOUJOURS FAIRE UN BACKUP** - `pg_dump` avant exécution
- ⚠️ **ARRÊTER LES AGENTS** - Stopper tous les agents actifs avant nettoyage
- ⚠️ **VÉRIFIER LE MODE** - Par défaut `--mode=paper`, attention au `--mode=live`

### Creation Script
- ⚠️ **COÛT DE COMPUTATION** - Créer beaucoup d'agents consomme des ressources
- ⚠️ **RATE LIMITING** - Respecter les limites API (délai 500ms intégré)
- ⚠️ **MODE LIVE** - Vérifie bien le mode avant création (par défaut `paper`)
- ⚠️ **MONITORING** - Surveiller les agents créés pour éviter les dérives

---

## 🐛 Dépannage

### Cleanup Script

**Erreur : "session_already_active"**
```bash
# Stopper tous les agents d'abord
curl -X POST http://localhost:3001/api/agent/stop-all
```

**Erreur : "Permission denied"**
```bash
# Vérifier les droits sur le dossier backend
chmod +x scripts/cleanup-paper-sessions.ts
```

### Creation Script

**Erreur : "User with ID 'xxx' does not exist"**
```bash
# Supprimer le flag --user ou fournir un ID valide
npx tsx scripts/create-batch-agents.ts  # Sans --user
```

**Erreur : "Max leverage must be between 1 and 10"**
```bash
# Corriger la valeur de leverage
npx tsx scripts/create-batch-agents.ts --leverage 7
```

**Erreur : "Invalid aggressiveness types"**
```bash
# Utiliser seulement : conservative, reactive, aggressive
npx tsx scripts/create-batch-agents.ts --types conservative,reactive
```

---

## 📝 Logs et Fichiers Générés

### Cleanup Script
- Aucun fichier généré (modifications directes en DB)
- Logs console détaillés de chaque étape

### Creation Script
- **JSON Export :** `batch-agents-YYYY-MM-DDTHH-MM-SS.json`
- **Contenu :** Configuration, résultats, liste des agents créés
- **Emplacement :** `backend/` (racine du projet backend)

---

## 🔗 Ressources

- **Code Source :**
  - `backend/scripts/cleanup-paper-sessions.ts`
  - `backend/scripts/create-batch-agents.ts`

- **Documentation Liée :**
  - `LEVERAGE_AMPLIFICATION_FR.md` - Configuration leverage
  - `GUIDE_MONITORING_BIAS_FR.md` - Monitoring des agents

- **API Endpoints :**
  - POST `/api/agent/creation/prepare` - Création agent
  - POST `/api/agent/stop-all` - Arrêt tous agents
  - GET `/api/agent/sessions` - Liste sessions

---

## ✅ Checklist de Sécurité

### Avant Cleanup
- [ ] Backup de la base de données effectué (`pg_dump`)
- [ ] Tous les agents actifs stoppés
- [ ] Dry run exécuté et vérifié
- [ ] Mode de suppression confirmé (paper/live)
- [ ] Équipe informée si environnement partagé

### Avant Batch Creation
- [ ] Mode vérifié (paper/live)
- [ ] Leverage dans les limites (1-10)
- [ ] Balance initiale appropriée
- [ ] User ID valide (si spécifié)
- [ ] Ressources système suffisantes
- [ ] Monitoring prêt pour nouveaux agents

---

**Date de Création :** 2025-01-12  
**Version :** 1.0  
**Auteur :** Trading Agent System  

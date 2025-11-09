# Guide de Dépannage: Ordres Non Exécutés Malgré Log "executed"

## 🔍 Votre Problème

Vous voyez dans les logs:
- ✅ `decision: "executed"` et `registrationResult: "registered"`
- ✅ Agent en status **ACTIVE**
- ❌ **Aucun ordre visible dans l'interface**

## 🎯 Cause Principale

**Votre agent pense avoir une position ouverte (status ACTIVE), ce qui bloque l'entrée de nouveaux ordres!**

### Statuts d'Agent
- **ARMED** = Surveillance des marchés, pas de position
- **ACTIVE** = Position ouverte (ou l'agent pense en avoir une)

## 🐛 Le Bug des "Positions Fantômes"

Avant notre correction, les ordres étaient exécutés par le broker mais **jamais enregistrés dans la base de données**. Cela crée des situations où:

1. L'agent place un ordre → Status devient ACTIVE
2. L'ordre n'est pas enregistré en base → Pas visible dans l'UI
3. L'agent garde le status ACTIVE → Bloque les nouveaux ordres
4. Résultat: **Position fantôme** qui bloque tout!

## 🔧 Solution Étape par Étape

### Étape 1: Vérifier les Positions Fantômes

Exécutez cette requête SQL:

```sql
SELECT 
  id,
  symbol,
  side,
  qty,
  "entryPrice",
  "openedAt",
  "updatedAt"
FROM "Position" 
WHERE "sessionId" = 'cmhoizqks0006o6666e7r4uwe'  -- Votre session ZEC/USDT
ORDER BY "openedAt" DESC;
```

#### Si vous voyez une position:
```
id | symbol    | side | qty  | entryPrice | openedAt           
---+-----------+------+------+------------+--------------------
123| ZEC/USDT  | buy  | 50   | 45.50      | 2025-01-09 10:00:00
```

**C'est une position fantôme!** Elle bloque les nouveaux ordres.

### Étape 2: Nettoyer les Positions Fantômes

⚠️ **ATTENTION**: Assurez-vous qu'il n'y a PAS de position réelle ouverte chez le broker!

```sql
-- Option 1: Mettre la quantité à 0 (préservation de l'historique)
UPDATE "Position"
SET "qty" = 0
WHERE "sessionId" = 'cmhoizqks0006o6666e7r4uwe';

-- Option 2: Supprimer complètement (si qty déjà à 0)
DELETE FROM "Position" 
WHERE "sessionId" = 'cmhoizqks0006o6666e7r4uwe'
AND "qty" = 0;
```

### Étape 3: Redémarrer l'Agent

1. Arrêtez la session de trading
2. Nettoyez la base de données (étape 2)
3. Redémarrez la session
4. Le status devrait maintenant être **ARMED**

### Étape 4: Déployer la Correction

Le code corrigé ajoute les appels manquants à `recordEnter()` et `recordExit()`:

```bash
cd backend
git pull origin copilot/explain-log-structure
npm install
npm run build
# Redémarrez le serveur backend
```

## 📊 Vérification Post-Correction

Après avoir déployé la correction, surveillez ces logs:

### Logs Attendus pour un Ordre Réussi

```
[MetaOrchestrator] Calling executeEntryTrade for agent=xxx, symbol=ZEC/USDT
[MetaOrchestrator.executeEntryTrade] START: agent=xxx
[MetaOrchestrator.executeEntryTrade] Got broker, fetching balance...
[MetaOrchestrator.executeEntryTrade] Balance: equity=10000.00, free=10000.00
[MetaOrchestrator.executeEntryTrade] Sizing: qty=50, entryPrice=45.50
[MetaOrchestrator.executeEntryTrade] Registration OK, placing order...
[MetaOrchestrator.executeEntryTrade] Calling broker.place(): side=buy, qty=50
[MetaOrchestrator.executeEntryTrade] Order placed! id=paper_xxx, status=filled
[MetaOrchestrator.executeEntryTrade] Position persisted to database  ← NOUVEAU!
```

### Vérification Base de Données

Après un ordre, vérifiez qu'il apparaît:

```sql
-- Vérifier les ordres
SELECT * FROM "Order" 
WHERE "sessionId" = 'cmhoizqks0006o6666e7r4uwe' 
ORDER BY "createdAt" DESC 
LIMIT 5;

-- Vérifier les positions
SELECT * FROM "Position" 
WHERE "sessionId" = 'cmhoizqks0006o6666e7r4uwe' 
ORDER BY "openedAt" DESC;
```

## 🚫 Logs Indiquant un Blocage

Si vous voyez ces logs, l'ordre est bloqué:

### Position Existante
```
[cmhoizqks0006o6666e7r4uwe] Entry signal blocked - existing position present
```
**Solution**: Nettoyez les positions fantômes (Étape 2)

### Capital Insuffisant
```
[CapitalPoolBroker] ❌ REJECTED - capital_reservation_failed
Pool State:
  Total:          $10000.00
  Reserved:       $5000.00
  In Positions:   $4000.00
  Actually Free:  $1000.00
Request:
  Margin Needed:  $2000.00
```
**Solution**: Augmentez le capital ou réduisez les positions existantes

### Sizing à Zéro
```
[MetaOrchestrator.executeEntryTrade] ABORTED: sizing returned qty=0
```
**Solution**: Le stop-loss est trop serré ou le capital insuffisant

## 🎓 Comprendre le Flux

### Le Log "executed" Ne Signifie PAS Ordre Exécuté!

```
meta_entry_checklist (decision: "executed")
  ↓ Signal validé, prêt à exécuter
  ↓ MAIS l'ordre n'est pas encore passé!
  ↓
Vérification position existante en base
  ↓ SI position existe → BLOQUE
  ↓ SI pas de position → Continue
  ↓
broker.place() appelé
  ↓ Ordre envoyé au broker
  ↓
order.status = 'filled'
  ↓ Ordre exécuté avec succès
  ↓
recordEnter() appelé ← NOUVEAU!
  ↓ Ordre et position enregistrés en base
```

## 🛠️ Script de Nettoyage Automatique

Créez un script pour nettoyer périodiquement:

```sql
-- Positions avec quantité 0 (déjà fermées)
DELETE FROM "Position" WHERE "qty" <= 0;

-- Positions ouvertes depuis plus de 24h (probablement fantômes)
SELECT 
  "sessionId",
  symbol,
  "qty",
  "openedAt",
  NOW() - "openedAt" as age
FROM "Position" 
WHERE "openedAt" < NOW() - INTERVAL '24 hours'
AND "qty" > 0;

-- Si confirmé comme fantômes, nettoyer:
UPDATE "Position"
SET "qty" = 0
WHERE "openedAt" < NOW() - INTERVAL '24 hours'
AND "qty" > 0;
```

## ✅ Checklist Complète

1. **Diagnostic**
   - [ ] Vérifier status agent (ACTIVE = suspect)
   - [ ] Chercher positions en base de données
   - [ ] Vérifier logs pour "Entry signal blocked"

2. **Nettoyage**
   - [ ] Identifier positions fantômes
   - [ ] Mettre qty à 0 ou supprimer
   - [ ] Redémarrer agent

3. **Déploiement**
   - [ ] Récupérer code corrigé
   - [ ] Compiler backend
   - [ ] Redémarrer serveur

4. **Vérification**
   - [ ] Tester nouvel ordre
   - [ ] Vérifier logs "Position persisted"
   - [ ] Confirmer ordre en base
   - [ ] Vérifier affichage UI

## 📞 Support Additionnel

Si le problème persiste après ces étapes:

1. **Partagez les logs complets** autour du timestamp du signal
2. **Exportez l'état de la base** (positions, ordres)
3. **Vérifiez le statut du broker** (PaperBroker ou LiveBroker)
4. **Testez avec un nouveau agent** (session fraîche)

## 🎯 Résumé Ultra-Rapide

```
Problème: Agent ACTIVE mais pas d'ordre visible
Cause:    Position fantôme en base bloque nouveaux ordres
Solution: Nettoyer base + déployer correction
```

```sql
-- Nettoyage rapide
UPDATE "Position" SET "qty" = 0 WHERE "sessionId" = 'VOTRE_SESSION_ID';
```

Puis redémarrez l'agent et déployez la correction!

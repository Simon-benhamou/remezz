# ⚠️ Analyse des Risques: Positions Fermées avec Leverage

## Votre Question
> "Je risque pas d'avoir des positions fermées à cause du sizing ou margin alert avec cette amplification de leverage?"

## Réponse Courte
**En Paper Trading: NON** ❌ - Aucun risque de fermeture automatique  
**En Live Trading: OUI** ⚠️ - Risque de liquidation si mal géré, MAIS le système a des protections

## Analyse Détaillée

### 1. En Mode Paper Trading (Simulation)

#### ✅ AUCUN RISQUE de Fermeture Automatique

Le `PaperBroker` **simule** le leverage mais n'a **PAS** de mécanisme de liquidation:

```typescript
// backend/src/broker/paper.ts
// Le paper broker simule les positions mais n'a pas de liquidation
```

**Pourquoi c'est sûr:**
- Pas de vrai exchange qui liquide
- Pas de margin call
- Pas de fermeture forcée
- Seuls les stop-loss manuels s'appliquent

**Résultat:** Vous pouvez tester avec leverage 10x sans crainte de liquidation.

---

### 2. En Mode Live Trading (Vrai Exchange)

#### ⚠️ RISQUES RÉELS de Liquidation

Sur un vrai exchange (Binance, etc.), avec leverage il y a **3 risques**:

#### Risque A: Liquidation par l'Exchange 🔴 CRITIQUE

**Quand:** Le prix bouge contre vous et la maintenance margin n'est plus suffisante

**Exemple:**
```
Position Long BTC avec 10x leverage:
- Entry: $100,000
- Notional: $10,000 (10x leverage)
- Margin initial: $1,000
- Maintenance margin: ~$500 (varie selon exchange)
- Liquidation price: ~$95,000 (5% en dessous)

Si BTC tombe à $95,000 → LIQUIDATION AUTOMATIQUE par l'exchange
```

**Protection dans notre système:**
```typescript
// Le système place TOUJOURS un stop-loss à 2-3% (ATR based)
// Donc dans l'exemple ci-dessus:
stopLoss = $100,000 - (ATR * 2) = ~$98,000 (2% en dessous)

// Le stop-loss se déclenche AVANT la liquidation
```

✅ **Notre stop-loss (2-3%) se déclenche AVANT la liquidation (5-10%)**

---

#### Risque B: Capital Pool Insuffisant 🟡 MODÉRÉ

**Quand:** Tous les agents veulent ouvrir des positions en même temps

**Exemple avec 3 agents et 1000$:**
```
Agent 1: Veut 333$ de marge (3,330$ notional avec 10x)
Agent 2: Veut 333$ de marge (3,330$ notional avec 10x)  
Agent 3: Veut 333$ de marge (3,330$ notional avec 10x)
TOTAL: 999$ de marge utilisée ✅ OK

Mais si Agent 1 a déjà une position de 400$:
- Utilisé: 400$
- Disponible: 600$
- Agent 2 demande 333$ → ✅ OK (reste 267$)
- Agent 3 demande 333$ → ❌ REJETÉ (besoin 333$, disponible 267$)
```

**Ce qui se passe:**
```typescript
// Dans capitalPoolBroker.ts ligne 83-143
if (!reservation) {
  // L'ordre est REJETÉ, PAS de fermeture de positions existantes
  return this.rejectOrder(order, 'capital_reservation_failed');
}
```

✅ **Le système REJETTE les nouveaux ordres, ne ferme PAS les positions existantes**

---

#### Risque C: Margin Monitor Alerts 🟢 FAIBLE

**Quand:** L'utilisation de la marge dépasse les seuils

**Seuils par défaut:**
```typescript
// backend/src/risk/marginGuard.ts
utilisationWarnPct: 55%      // ⚠️ Warning
utilisationCriticalPct: 75%  // 🔴 Critical
minLiquidationDistancePct: 12%  // Distance minimale avant liquidation
```

**Exemple:**
```
Capital: 1000$
Positions: 800$ de marge utilisée
Utilisation: 80% → 🔴 CRITICAL (> 75%)

Le système:
1. ✅ Émet une ALERTE
2. ✅ Log l'événement
3. ❌ NE FERME PAS automatiquement
```

**Code qui émet l'alerte:**
```typescript
// backend/src/services/marginMonitor.ts ligne 100-127
if (utilisationPct >= thresholds.utilisationCriticalPct) {
  breaches.push({
    kind: 'utilisation',
    severity: 'critical',
    detail: `Utilisation ${utilisationPct}% exceeds critical 75%`,
  });
  actions.push({
    label: 'Reduce leverage immediately',  // ⚠️ RECOMMANDATION seulement
    severity: 'critical',
    rationale: 'Decrease position sizes to free margin.',
  });
}
```

✅ **Le margin monitor ALERTE mais ne ferme PAS les positions**

---

## Protection Actives dans le Système

### 1. Stop-Loss Obligatoire ✅

**Chaque trade a un stop-loss:**
```typescript
// metaAdaptiveOrchestrator.ts ligne 353-355
const stopPrice = signal.bias === 'short'
  ? entryPrice + stopDistance
  : entryPrice - stopDistance;

// stopDistance = ATR * 2 (typiquement 2-3% du prix)
```

**Protection:**
- Stop-loss à 2-3% du prix d'entrée
- Se déclenche AVANT la liquidation de l'exchange (5-10%)
- **Perte maximale contrôlée**

---

### 2. Capital Pool avec Leverage ✅

**Le système réserve seulement la MARGE, pas le notional:**
```typescript
// capitalPoolBroker.ts ligne 71-80
const leverage = order.leverage || 1;
const requestedMargin = notional / leverage;

const reservation = await this.capital.reserve({
  requestedUSD: notional,    // Notional complet pour tracking
  leverage,                   // Leverage appliqué
});

// En interne, CapitalManager réserve: margin = notional / leverage
```

**Protection:**
- Avec 1000$ et leverage 10x, peut ouvrir jusqu'à 10,000$ de notional
- Mais réserve seulement 1000$ de marge maximum
- Empêche la sur-allocation

---

### 3. Symbol Cap (50% du capital par symbole) ✅

```typescript
// capitalPoolBroker.ts ligne 96-98
const symbolCapPct = 0.50; // 50% max per symbol
const symbolCap = totalCapital * symbolCapPct;
const symbolRoom = Math.max(0, symbolCap - symbolExposureUsd);
```

**Protection:**
- Maximum 50% du capital sur un seul symbole
- Diversification forcée
- Limite l'exposition

---

### 4. Margin Monitor (Alertes) ✅

**Surveille l'utilisation:**
- Warn à 55%
- Critical à 75%
- Distance liquidation < 12%

**Protection:**
- Vous avertit AVANT que ça devienne critique
- Permet d'agir manuellement
- Ne ferme PAS automatiquement (vous gardez le contrôle)

---

## Scénarios Réalistes

### Scénario 1: Usage Normal ✅

```
Capital: 1000$
3 agents avec leverage 10x

Agent 1: Position BTC 3,000$ notional (300$ marge)
Agent 2: Position ETH 2,500$ notional (250$ marge)
Agent 3: Position XRP 1,500$ notional (250$ marge)

TOTAL: 7,000$ notional, 800$ marge utilisée (80%)
```

**État:**
- ⚠️ Margin alert: Critical (80% > 75%)
- ✅ Positions OUVERTES (pas de fermeture auto)
- ✅ Stop-loss actifs à 2-3%
- ⚠️ Nouveaux ordres peuvent être rejetés

**Que faire:**
- Surveiller les positions
- Attendre que certaines positions se ferment
- Ou réduire manuellement l'exposition

---

### Scénario 2: Mouvement de Prix Défavorable ⚠️

```
Agent 1: Long BTC à $100,000 avec leverage 10x
- Notional: $3,000
- Marge: $300
- Stop-loss: $98,000 (-2%)
- Prix liquidation exchange: ~$95,000 (-5%)

Prix BTC tombe à $98,500
```

**Que se passe-t-il:**
1. ❌ Stop-loss PAS encore touché (à $98,000)
2. ✅ Position encore ouverte
3. ⚠️ Unrealized loss: -$45 (1.5% du notional = -15% du capital!)

**Si prix continue à $98,000:**
1. ✅ **STOP-LOSS SE DÉCLENCHE**
2. ✅ Position fermée par notre système
3. ✅ Perte: ~-$60 (-2% du notional = -20% de la marge)
4. ✅ **AUCUNE liquidation par l'exchange**

---

### Scénario 3: Dépassement de Capital ❌

```
Capital: 1000$
Agent 1: 400$ en position
Agent 2: 350$ en position
Disponible: 250$

Agent 3 essaie d'ouvrir: 300$ de marge nécessaire
```

**Que se passe-t-il:**
```
[CapitalPoolBroker] ❌ REJECTED - capital_reservation_failed
  Pool State:
    Total:          $1000.00
    In Positions:   $750.00
    Actually Free:  $250.00
  Request:
    Margin Needed:  $300.00
  ❌ Rejection Reason:
    Insufficient free capital: available=$250.00 < needed=$300.00
```

**Résultat:**
- ✅ Agent 1 et 2: Positions OUVERTES
- ❌ Agent 3: Ordre REJETÉ
- ✅ **AUCUNE position fermée**

---

## Recommandations pour Éviter les Problèmes

### 1. Commencer en Paper Trading ✅

```bash
POST /api/agent/creation/prepare
{
  "mode": "paper",          # ✅ Pas de liquidation
  "maxLeverage": 10,
  "startBalanceUsd": 1000
}
```

**Avantages:**
- Tester le système sans risque
- Voir comment la marge est utilisée
- Comprendre les alertes

---

### 2. Ajuster les Seuils si Nécessaire ⚙️

Si vous recevez trop d'alertes ou de rejets:

**Option A: Réduire le leverage par défaut**
```typescript
// Dans .env
DEFAULT_MAX_LEVERAGE=6  # Au lieu de 12
```

**Option B: Augmenter les seuils d'alerte**
```typescript
// Dans .env
MARGIN_UTIL_WARN_PCT=65      # Au lieu de 55
MARGIN_UTIL_CRITICAL_PCT=85  # Au lieu de 75
```

---

### 3. Surveiller le Dashboard 📊

**Indicateurs clés à surveiller:**

```typescript
GET /api/capital/snapshot

{
  "freeUSD": 250,           // ⚠️ Surveiller: doit rester > 200$
  "inPositionsUSD": 750,    // ⚠️ Ne devrait pas dépasser 800$
  "totalUSD": 1000,
  "utilization": 75%        // ⚠️ Alert si > 75%
}
```

**Actions si utilization > 75%:**
1. ✅ Attendre qu'une position se ferme
2. ✅ Fermer manuellement une position si nécessaire
3. ❌ Ne PAS paniquer - positions ne se ferment pas automatiquement

---

### 4. Comprendre le Leverage Effectif 📈

**Leverage demandé ≠ Leverage effectif**

```typescript
GET /api/session/:sessionId/orders

{
  "leverage": 10,              // Leverage demandé
  "qty": 0.355,
  "price": 441.37,
  "notionalCapUsd": 1000,      // Limite de capital
  "estLev": 0.26               // ⚠️ Leverage EFFECTIF très bas!
}
```

**Si `estLev` est bas:**
- Le système a appliqué des limites
- Position plus petite que demandée
- **C'est une PROTECTION, pas un bug**

---

## Conclusion

### En Résumé

| Risque | Paper Mode | Live Mode | Protection |
|--------|-----------|-----------|------------|
| **Liquidation Exchange** | ❌ Non | ⚠️ Oui | ✅ Stop-loss à 2-3% (avant liquidation) |
| **Capital Insuffisant** | ✅ Rejette ordre | ✅ Rejette ordre | ✅ Ne ferme PAS positions existantes |
| **Margin Alert** | ℹ️ Alerte seulement | ⚠️ Alerte seulement | ✅ Ne ferme PAS automatiquement |
| **Fermeture Auto** | ❌ Jamais | ⚠️ Seulement via stop-loss | ✅ Contrôlé par vous |

### Réponse Finale à Votre Question

**"Je risque pas d'avoir des positions fermées à cause du sizing ou margin alert?"**

✅ **NON** - Les positions ne seront PAS fermées automatiquement par les margin alerts  
✅ **NON** - Le capital pool rejette les nouveaux ordres, ne ferme pas l'existant  
⚠️ **OUI** - En live mode, risque de liquidation par l'exchange MAIS protégé par stop-loss  

### Actions Recommandées

1. ✅ **Tester en paper trading d'abord** (aucun risque)
2. ✅ **Surveiller les alertes margin** (info, pas automatique)
3. ✅ **Vérifier que les stop-loss sont placés** (protection principale)
4. ✅ **Ne pas utiliser 100% du capital** (garder 20-25% de buffer)
5. ⚠️ **En live mode, commencer avec leverage 5x** avant d'aller à 10x

### Le Plus Important

**Vos positions resteront ouvertes** tant que:
- Le stop-loss n'est pas touché (2-3%)
- L'exchange ne liquide pas (5-10%, mais stop-loss protège)

**Le système NE FERME JAMAIS automatiquement** pour libérer de la marge.  
Il **rejette simplement les nouveaux ordres** jusqu'à ce que du capital se libère.

---

**Vous êtes protégé ! 🛡️**

Les stop-loss sont votre vraie protection, pas les margin alerts.

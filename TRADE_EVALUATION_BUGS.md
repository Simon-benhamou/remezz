# Trade Evaluation - Bugs Identifiés et Corrections

**Date:** November 9, 2024  
**Source:** Analyse de la table `TradeEvaluation`

---

## 🔴 BUG CRITIQUE #1: Capital Check Incorrect

### Symptômes
```
capital_exhausted: free=724.20, requested=141
```
- 10 tentatives bloquées en 15 minutes (17:27-17:42)
- Capital disponible ($724.20) > Capital demandé ($141)
- Devrait PASSER mais est REJETÉ ❌

### Localisation
**Fichier:** `src/broker/capitalPoolBroker.ts` (ligne 75-99)  
**Fonction:** `place()` → `capital.reserve()`

### Problème
```typescript
// capitalPoolBroker.ts ligne 75
const reservation = await this.capital.reserve({
  agentId: this.agentId,
  symbol: order.symbol,
  requestedUSD: desiredUsd,  // 141 USD
  minUSD: this.minOrderUsd,
  leverage,
});

if (!reservation) {
  // Capital check ÉCHOUE alors que free=724 > requested=141
  const snapshot = await this.capital.getBalance();
  console.log(`free=${snapshot.freeUSD.toNumber()}`); // 724.20
}
```

### Hypothèses
1. **Capital déjà réservé pour positions ouvertes** (le plus probable)
   - `freeUSD` inclut le capital en positions
   - Devrait être: `freeUSD - reservedUSD - inPositionsUSD`

2. **Limite par symbole** 
   - Peut-être un cap max par symbole (ex: $200 max sur ZEC)
   - Code de `reserve()` vérifie symbolExposure

3. **Limite par agent**
   - Limite de capital total par agent dépassée

### Solution Proposée
```typescript
// Dans capitalPoolBroker.ts ligne 86
const snapshot = await this.capital.getBalance();

// AJOUTER ce log détaillé:
console.log(`[Capital Debug]`, {
  free: snapshot.freeUSD.toNumber(),
  reserved: snapshot.reservedUSD.toNumber(),
  inPositions: snapshot.inPositionsUSD.toNumber(),
  actuallyAvailable: snapshot.freeUSD.toNumber() - snapshot.reservedUSD.toNumber() - snapshot.inPositionsUSD.toNumber(),
  requested: desiredUsd.toNumber(),
  // Vérifier aussi:
  symbolExposure: await this.capital.getSymbolExposure(order.symbol),
  agentEquity: await this.capital.getAgentEquity(this.agentId),
});
```

### Correction Immédiate
Modifier le message d'erreur pour être plus précis:
```typescript
blockedReason: `capital_exhausted: truly_free=${actuallyFree.toFixed(2)}, reserved=${snapshot.reservedUSD.toNumber().toFixed(2)}, inPositions=${snapshot.inPositionsUSD.toNumber().toFixed(2)}, requested=${desiredUsd.toNumber().toFixed(2)}`,
```

---

## 🟡 BUG MOYEN #2: Cache des Indicateurs Non Rafraîchi

### Symptômes
Métriques techniques **identiques** sur 4 trades espacés de 3-4 minutes:

```json
{
  "adx": 36.80983779182844,
  "cmf": 0.004508437798319691,
  "rsi14": 64.56550041745228,
  "atrPct": 2.405999178276788
}
```

Timestamps: 17:16:58, 17:20:17, 17:23:41, 17:27:02

### Impact
- Décisions de trading basées sur données périmées
- Les indicateurs devraient varier à chaque chandelle

### Localisation Probable
**Fichier:** `src/ai/tech.ts` ou `src/data/market.ts`  
**Fonction:** `buildTechSnapshot()`

### Hypothèses
1. **Cache avec TTL trop long**
2. **Indicateurs calculés une fois puis réutilisés**
3. **Chandelles non mises à jour entre les ticks**

### Solution Proposée
```typescript
// Dans buildTechSnapshot() ou équivalent
// Forcer le refresh à chaque appel:
const candles = await getOHLCV(symbol, timeframe, { 
  useCache: false,  // FORCER refresh
  minBars: 200 
});

// Ou ajouter un timestamp au cache:
if (cache[symbol].timestamp < Date.now() - 60000) { // 1 minute
  cache[symbol] = null; // Invalider
}
```

---

## 🟡 BUG MOYEN #3: InputMetrics Vides sur Capital Block

### Symptômes
```json
{
  "decision": "order_blocked_capital",
  "confidenceScore": 0.5,    // Valeur par défaut
  "inputMetrics": {},        // VIDE ❌
  "regimeContext": null      // VIDE ❌
}
```

### Problème
**Fichier:** `src/broker/capitalPoolBroker.ts` (ligne 90-96)

```typescript
logTradeEvaluation({
  symbol: order.symbol,
  decision: 'order_blocked_capital',
  blockedReason: `capital_exhausted: ...`,
  confidenceScore: 0.5,  // ❌ Devrait être la vraie confiance
  inputMetrics: {},      // ❌ Devrait être rempli
  // ❌ regimeContext manquant
});
```

### Impact
- Impossible d'analyser POURQUOI le trade a été bloqué
- Perte de données pour l'apprentissage
- Pas de traçabilité du contexte de marché

### Solution
Le broker doit recevoir ces infos du niveau supérieur:

```typescript
// Dans metaAdaptiveOrchestrator.ts ou similaire
async place(order, context) {
  // PASSER le contexte au broker
  const enrichedOrder = {
    ...order,
    _evaluationContext: {
      confidence: primary.confidence,
      inputMetrics: {
        adx: tech.adx,
        rsi14: tech.rsi14,
        cmf: tech.cmf20,
        atrPct: tech.atrPct,
      },
      regimeContext: {
        volatilityRegime,
        directionBias,
        volumeRegime,
        trendingRanging,
      },
    },
  };
  
  return broker.place(enrichedOrder);
}

// Dans capitalPoolBroker.ts
logTradeEvaluation({
  symbol: order.symbol,
  decision: 'order_blocked_capital',
  blockedReason: `...`,
  confidenceScore: order._evaluationContext?.confidence ?? 0.5,
  inputMetrics: order._evaluationContext?.inputMetrics ?? {},
  regimeContext: order._evaluationContext?.regimeContext,
});
```

---

## 🟢 BUG MINEUR #4: NEAR/USDT - Rejets Mystérieux

### Symptômes
```
17:01:48 - order_placed     ✅
17:04:38 - order_placed     ✅
17:12:53 - order_rejected   (broker_rejected) ❌
17:14:34 - order_rejected   (broker_rejected) ❌
17:17:23 - order_rejected   (broker_rejected) ❌
```

### Problème
- Pas de détails sur la raison du rejet
- `blockedReason: "broker_rejected"` trop vague

### Solution
```typescript
// Dans le broker, capturer l'erreur détaillée:
try {
  const placed = await this.broker.place(order);
  return placed;
} catch (error) {
  logTradeEvaluation({
    symbol: order.symbol,
    decision: 'order_rejected',
    blockedReason: `broker_rejected: ${error.message}`, // ✅ Détails!
    confidenceScore: context.confidence,
    inputMetrics: context.inputMetrics,
  });
  
  throw error;
}
```

---

## Corrections à Implémenter

### 1. URGENT - Fixer capital check
```typescript
// src/broker/capitalPoolBroker.ts
// Améliorer les logs pour comprendre la vraie raison du rejet
```

### 2. IMPORTANT - Passer le contexte au broker
```typescript
// src/services/metaAdaptiveOrchestrator.ts
// Enrichir l'ordre avec _evaluationContext avant de l'envoyer au broker
```

### 3. MOYEN - Forcer refresh cache indicateurs
```typescript
// src/ai/tech.ts ou src/data/market.ts
// S'assurer que les indicateurs sont recalculés à chaque appel
```

### 4. FACILE - Améliorer messages d'erreur
```typescript
// Tous les rejets doivent inclure le message d'erreur complet
```

---

## Tests de Validation

### Test 1: Capital Check
```bash
# Vérifier qu'avec free=724, requested=141, le trade passe
# Vérifier les vraies raisons de rejet (reserved, inPositions, symbol cap)
```

### Test 2: Cache Indicateurs
```bash
# Faire 3 trades espacés de 1 minute sur le même symbole
# Vérifier que ADX, RSI, CMF sont DIFFÉRENTS à chaque fois
```

### Test 3: Context Preservation
```bash
# Vérifier qu'un trade bloqué pour capital a:
# - confidence > 0.5 (pas la valeur par défaut)
# - inputMetrics rempli
# - regimeContext présent
```

---

## Données Positives Observées

### Trade e7987b16 - Bon exemple
```json
{
  "timestamp": "16:44:30",
  "decision": "order_placed",
  "confidence": 0.7441,
  "inputMetrics": {
    "adx": 39.77,
    "cmf": 0.03,
    "rsi14": 58.57,
    "atrPct": 2.39
  },
  "marketOutcome": {
    "pnl_1h": +2.43%,         // ✅ Profitable
    "max_adverse": -1.76%,    // Risque bien géré
    "max_favorable": +2.87%   // Bon upside
  },
  "regimeContext": {
    "volumeRegime": "normal",
    "directionBias": "long",
    "trendingRanging": "trending",
    "volatilityRegime": "low"
  }
}
```

**Points positifs:**
- ✅ Données complètes
- ✅ Market outcome calculé
- ✅ Trade profitable
- ✅ Context bien tracé

---

## Conclusion

3 bugs principaux à corriger par priorité:
1. 🔴 **Capital check** - Bloque des trades valides
2. 🟡 **Cache indicateurs** - Données périmées
3. 🟡 **Context missing** - Perte d'information

Impact estimé: **~10-20% d'opportunités manquées** à cause du bug #1.

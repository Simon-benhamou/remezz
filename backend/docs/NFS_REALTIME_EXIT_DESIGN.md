# NFS Real-Time Exit System - Design Document

## Objectif

Se rapprocher au maximum du backtest (sortie au trailing stop exact) en utilisant:
- WebSocket pour monitoring temps réel
- NFS (Noise Filter Score) pour valider les vrais signaux
- Ordres LIMIT dynamiques pour sortir au meilleur prix
- Fallbacks robustes pour tous les scénarios d'échec

---

## Architecture Globale

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         POSITION ACTIVE                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐              │
│  │  WebSocket   │───▶│  NFS Engine  │───▶│ Order Manager│              │
│  │  Price Feed  │    │              │    │              │              │
│  └──────────────┘    └──────────────┘    └──────────────┘              │
│         │                   │                   │                        │
│         ▼                   ▼                   ▼                        │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐              │
│  │   Trailing   │    │   Signal     │    │    Exit      │              │
│  │   Calculator │    │   Validator  │    │   Executor   │              │
│  └──────────────┘    └──────────────┘    └──────────────┘              │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## State Machine - États de Sortie Trailing

```
                              ┌─────────────────┐
                              │    MONITORING   │
                              │  (Normal state) │
                              └────────┬────────┘
                                       │
                          Prix approche trailing (0.3%)
                                       │
                                       ▼
                              ┌─────────────────┐
                              │   PRE_BREACH    │
                              │ (Alert mode)    │
                              └────────┬────────┘
                                       │
                            Prix touche trailing
                                       │
                    ┌──────────────────┼──────────────────┐
                    │                  │                  │
              NFS >= 70           NFS < 70          NFS indéterminé
                    │                  │                  │
                    ▼                  ▼                  ▼
           ┌───────────────┐  ┌───────────────┐  ┌───────────────┐
           │ LIMIT_PENDING │  │ BREACH_COUNT  │  │   WAITING     │
           │ (Ordre placé) │  │ (Compteur=1)  │  │ (More data)   │
           └───────┬───────┘  └───────┬───────┘  └───────┬───────┘
                   │                  │                  │
        ┌──────────┼──────────┐       │            Données dispo
        │          │          │       │                  │
     FILLED    NOT_FILLED   REJECTED  │                  │
        │          │          │       │                  │
        ▼          ▼          ▼       ▼                  ▼
   ┌─────────┐ ┌─────────┐ ┌─────────────────────────────────┐
   │  EXITED │ │ MARKET  │ │        FALLBACK_2CLOSE          │
   │ (Done)  │ │ FALLBACK│ │  (Attendre 2ème close breach)   │
   └─────────┘ └────┬────┘ └─────────────────┬───────────────┘
                    │                        │
                    ▼                        │
               ┌─────────┐                   │
               │  EXITED │◀──────────────────┘
               │ (Done)  │
               └─────────┘
```

---

## États Détaillés

### 1. MONITORING
- **Condition d'entrée:** Position ouverte, trailing activé
- **Actions:**
  - WebSocket écoute les prix
  - Recalcule trailing stop à chaque tick (update HWM/LWM)
  - Vérifie distance au trailing
- **Transition vers PRE_BREACH:** prix < trailing + 0.3%

### 2. PRE_BREACH
- **Condition d'entrée:** Prix proche du trailing (< 0.3%)
- **Actions:**
  - Augmente fréquence de monitoring
  - Pré-calcule NFS avec données actuelles
  - Prépare l'ordre LIMIT (mais ne place pas encore)
- **Transition vers BREACH:** prix touche ou traverse trailing

### 3. LIMIT_PENDING (NFS confirme)
- **Condition d'entrée:** Prix breach trailing ET NFS >= 70
- **Actions:**
  - Place ordre LIMIT au prix du trailing stop
  - Timeout: 30 secondes
  - Monitor le fill status
- **Transitions:**
  - FILLED → EXITED
  - NOT_FILLED après timeout → MARKET_FALLBACK
  - REJECTED → MARKET_FALLBACK

### 4. BREACH_COUNT (NFS ne confirme pas)
- **Condition d'entrée:** Prix breach trailing ET NFS < 70
- **Actions:**
  - Incrémente breachCandles counter
  - Continue monitoring
- **Transitions:**
  - 2ème close breach → EXITED (market order)
  - Prix récupère au-dessus trailing → retour MONITORING (reset counter)

### 5. MARKET_FALLBACK
- **Condition d'entrée:** LIMIT non rempli ou rejeté
- **Actions:**
  - Exécute market order immédiat
  - Log le slippage vs trailing
- **Transition:** EXITED

### 6. EXITED
- **État final:** Position fermée
- **Actions:**
  - Log trade details
  - Cleanup state
  - Trigger cooldown

---

## Scénarios Edge Cases

### A. Ordre LIMIT Non Rempli (Prix Continue à Chuter)

```
Scénario: LONG position, prix chute rapidement

Prix:     102 ─── 101.5 ─── 101 ─── 100.5 ─── 100 ─── 99.5
Trailing: ──────────────── 101.2 ────────────────────────
LIMIT:                      ↓ Placé à 101.2
                            │
                            └── Prix passe à travers, LIMIT non filled

Solution:
1. Timeout 30s sur LIMIT
2. Si non filled: cancel LIMIT + market order immédiat
3. Log slippage = (exit_price - trailing_price) / trailing_price
```

**Implémentation:**
```typescript
interface LimitOrderState {
  orderId: string;
  placedAt: number;
  trailingPrice: number;
  timeout: number; // 30000ms
  status: 'PENDING' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED';
}

async function monitorLimitOrder(state: LimitOrderState): Promise<void> {
  const elapsed = Date.now() - state.placedAt;

  if (elapsed > state.timeout && state.status === 'PENDING') {
    await cancelOrder(state.orderId);
    await executeMarketFallback();
  }
}
```

### B. Partial Fill

```
Scénario: LIMIT partiellement rempli

Qty totale: 100
LIMIT fill: 60 @ 101.2
Remaining:  40 unfilled

Solution:
1. Si fill >= 80%: accepter, cancel remaining
2. Si fill < 80%: cancel remaining + market pour le reste
3. Calculer prix moyen pondéré
```

**Implémentation:**
```typescript
async function handlePartialFill(
  order: Order,
  filledQty: number,
  totalQty: number
): Promise<void> {
  const fillRatio = filledQty / totalQty;

  if (fillRatio >= 0.8) {
    // Accepter le partial fill, cancel le reste
    await cancelOrder(order.id);
    logExit({
      qty: filledQty,
      price: order.avgPrice,
      reason: 'TRAIL_NFS_PARTIAL'
    });
  } else {
    // Market order pour le reste
    await cancelOrder(order.id);
    const remainingQty = totalQty - filledQty;
    const marketOrder = await executeMarketOrder(remainingQty);

    // Prix moyen pondéré
    const avgPrice = (filledQty * order.avgPrice + remainingQty * marketOrder.price) / totalQty;
    logExit({
      qty: totalQty,
      price: avgPrice,
      reason: 'TRAIL_NFS_MIXED'
    });
  }
}
```

### C. Ordre Rejeté par l'Exchange

```
Scénario: LIMIT rejeté (insufficient margin, rate limit, etc.)

Solution:
1. Log l'erreur avec détails
2. Fallback immédiat en market order
3. Si market aussi rejeté: retry avec backoff
4. Après 3 échecs: alerter + mode dégradé
```

**Implémentation:**
```typescript
async function placeExitOrder(
  symbol: string,
  side: 'buy' | 'sell',
  qty: number,
  price: number
): Promise<OrderResult> {
  const maxRetries = 3;

  // Essai 1: LIMIT
  try {
    return await exchange.createLimitOrder(symbol, side, qty, price);
  } catch (limitError) {
    logger.warn(`LIMIT rejected: ${limitError.message}`);
  }

  // Essai 2-4: MARKET avec retry
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await exchange.createMarketOrder(symbol, side, qty);
    } catch (marketError) {
      logger.error(`MARKET attempt ${i+1} failed: ${marketError.message}`);
      await sleep(1000 * (i + 1)); // Backoff
    }
  }

  // Échec total
  throw new CriticalExitError(`Cannot exit position after ${maxRetries} attempts`);
}
```

### D. WebSocket Déconnecté au Moment Critique

```
Scénario: WS perd connexion pendant PRE_BREACH ou LIMIT_PENDING

Solution:
1. Heartbeat toutes les 5s pour détecter déconnexion
2. Si déconnecté pendant état critique:
   - Fallback sur REST polling (500ms)
   - Continuer la logique de sortie
3. Reconnexion automatique en background
```

**Implémentation:**
```typescript
class PriceFeed {
  private ws: WebSocket | null = null;
  private lastHeartbeat: number = 0;
  private criticalState: boolean = false;

  async getPrice(symbol: string): Promise<number> {
    // Si WS OK et récent
    if (this.ws && Date.now() - this.lastHeartbeat < 5000) {
      return this.wsPrice;
    }

    // Fallback REST
    logger.warn('WS unavailable, falling back to REST');
    const ticker = await exchange.fetchTicker(symbol);
    return ticker.last;
  }

  setCriticalState(critical: boolean): void {
    this.criticalState = critical;
    if (critical) {
      // Augmenter fréquence de heartbeat
      this.heartbeatInterval = 1000;
    }
  }
}
```

### E. Wick qui Touche et Récupère Rapidement (< 1 seconde)

```
Scénario: Prix touche trailing pendant 200ms puis récupère

T0:     Prix = 101.5 (au-dessus trailing 101.2)
T0+100: Prix = 101.1 (breach!)
T0+200: Prix = 101.3 (récupéré!)

Sans NFS: aurait placé LIMIT et potentiellement sorti
Avec NFS: NFS < 70 car breach trop petit → pas de LIMIT

Solution:
1. NFS calcule breachDepth = très petit → score faible
2. Pas de placement LIMIT immédiat
3. Attendre confirmation close (fallback 2-close)
```

### F. Flash Crash (Prix Chute de 5%+ Instantanément)

```
Scénario: Flash crash, prix passe de 100 à 92 en quelques secondes

Solution:
1. Stop Loss classique se déclenche d'abord (plus prioritaire)
2. Si SL pas atteint mais trailing breach massif:
   - NFS sera très élevé (breach/ATR > 2)
   - LIMIT probablement pas filled
   - Market fallback rapide
3. Protection: max slippage 2%, sinon alert
```

**Implémentation:**
```typescript
const MAX_ACCEPTABLE_SLIPPAGE_PCT = 2.0;

async function executeExitWithProtection(
  expectedPrice: number,
  actualPrice: number
): Promise<void> {
  const slippagePct = Math.abs((actualPrice - expectedPrice) / expectedPrice) * 100;

  if (slippagePct > MAX_ACCEPTABLE_SLIPPAGE_PCT) {
    logger.alert(`EXTREME SLIPPAGE: ${slippagePct.toFixed(2)}% on exit`);
    // Continue quand même - mieux sortir que rester coincé
  }

  await executeMarketOrder();
}
```

### G. Position Multi-Entry (Plusieurs Entrées sur Même Symbole)

```
Scénario: Position avec 3 entrées à différents prix
Entry 1: 100 @ T1
Entry 2: 99 @ T2
Entry 3: 98 @ T3

Prix moyen: 99
HWM global: 102 (atteint après T3)
Trailing: 101.5

Solution:
1. Un seul trailing stop pour la position globale
2. NFS calculé sur la position agrégée
3. Sortie de toute la position en une fois
```

### H. Changement de Régime BTC Pendant Exit

```
Scénario: BTC croise SMA200 pendant que trailing breach est en cours

Solution:
1. REGIME_CHANGE a priorité sur TRAIL
2. Si régime change et trailing breach simultanés:
   - Utiliser la raison qui donne le meilleur prix
   - Généralement TRAIL car on est déjà proche du stop
```

---

## Flow de Décision Complet

```
┌─────────────────────────────────────────────────────────────────┐
│                    ON EACH PRICE UPDATE                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │ Update HWM/LWM  │
                    │ Recalc Trailing │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
              ┌─────│ Check SL First  │─────┐
              │     └─────────────────┘     │
           SL Hit                      SL OK
              │                            │
              ▼                            ▼
         ┌─────────┐              ┌─────────────────┐
         │ EXIT SL │              │ Check Trailing  │
         └─────────┘              └────────┬────────┘
                                           │
                              ┌────────────┼────────────┐
                              │            │            │
                         > 0.3%      0.1-0.3%      <= 0.1%
                         from         from          (BREACH)
                        trailing     trailing           │
                              │            │            │
                              ▼            ▼            ▼
                        ┌─────────┐  ┌─────────┐  ┌───────────┐
                        │MONITOR  │  │PRE_ALERT│  │Calc NFS   │
                        └─────────┘  └─────────┘  └─────┬─────┘
                                                        │
                                          ┌─────────────┼─────────────┐
                                          │             │             │
                                     NFS >= 70     50 <= NFS    NFS < 50
                                          │         < 70             │
                                          ▼             │             │
                                   ┌───────────┐        │             │
                                   │Place LIMIT│        │             │
                                   │@ Trailing │        │             │
                                   └─────┬─────┘        │             │
                                         │              │             │
                              ┌──────────┼──────────┐   │             │
                              │          │          │   │             │
                           FILLED    TIMEOUT    REJECT  │             │
                              │          │          │   │             │
                              ▼          ▼          ▼   ▼             ▼
                         ┌─────────┐ ┌─────────┐ ┌─────────────────────┐
                         │ EXITED  │ │ MARKET  │ │ Wait Close + Count  │
                         │@ Trail  │ │ FALLBACK│ │ (2-close fallback)  │
                         └─────────┘ └─────────┘ └─────────────────────┘
```

---

## Configuration Recommandée

```typescript
const NFS_CONFIG = {
  // Seuils NFS
  HIGH_CONFIDENCE: 70,     // Place LIMIT immédiat
  MEDIUM_CONFIDENCE: 50,   // Pré-alerte, prêt à agir

  // Timeouts
  LIMIT_TIMEOUT_MS: 30000, // 30s avant fallback market
  WS_HEARTBEAT_MS: 5000,   // Check WS toutes les 5s
  REST_FALLBACK_MS: 500,   // Polling REST si WS down

  // Seuils de distance
  PRE_BREACH_DISTANCE_PCT: 0.3, // Passer en mode alerte
  BREACH_TOLERANCE_PCT: 0.05,   // Marge pour considérer breach

  // Protection
  MAX_SLIPPAGE_PCT: 2.0,   // Alert si slippage > 2%
  PARTIAL_FILL_MIN: 0.8,   // Accepter partial si >= 80%

  // Retry
  MAX_ORDER_RETRIES: 3,
  RETRY_BACKOFF_MS: 1000,

  // NFS Weights (basé sur analyse)
  WEIGHTS: {
    breachATR: { threshold: 0.40, weight: 4 },
    breachDepth: { threshold: 0.25, weight: 2 },
    volumeRatio: { threshold: 1.2, weight: 2 },
    candleBody: { threshold: 0.6, weight: 1 },
    momentum: { threshold: -0.5, weight: 1 },
  }
};
```

---

## Métriques à Logger

Pour chaque sortie trailing, logger:

```typescript
interface TrailingExitLog {
  // Identification
  tradeId: string;
  symbol: string;
  side: 'long' | 'short';
  timestamp: number;

  // Prix
  trailingStopPrice: number;
  actualExitPrice: number;
  slippagePct: number;
  slippageUsd: number;

  // NFS
  nfsScore: number;
  nfsComponents: {
    breachATR: number;
    breachDepth: number;
    volumeRatio: number;
    candleBody: number;
    momentum: number;
  };

  // Execution
  exitMethod: 'LIMIT_FILLED' | 'LIMIT_PARTIAL' | 'MARKET_FALLBACK' | 'MARKET_DIRECT' | '2CLOSE_FALLBACK';
  orderAttempts: number;
  timeTakenMs: number;

  // Context
  wasWsConnected: boolean;
  marketCondition: 'NORMAL' | 'HIGH_VOLATILITY' | 'LOW_LIQUIDITY';
}
```

---

## Risques et Mitigations

| Risque | Probabilité | Impact | Mitigation |
|--------|-------------|--------|------------|
| LIMIT non filled | Moyenne | Moyen | Timeout + market fallback |
| WS disconnect | Faible | Moyen | REST fallback automatique |
| Flash crash | Très faible | Élevé | SL prioritaire + max slippage alert |
| Order rejected | Faible | Moyen | Retry avec backoff |
| NFS mal calibré | Moyenne | Moyen | Monitoring + ajustement continu |
| Latence réseau | Moyenne | Faible | Ordres préparés à l'avance |

---

## Plan d'Implémentation

### Phase 1: Infrastructure (1-2 jours)
- [ ] Créer `NfsCalculator` class
- [ ] Créer `TrailingExitStateMachine` class
- [ ] Ajouter WebSocket price monitoring dédié
- [ ] Implémenter logging détaillé

### Phase 2: Logique Core (2-3 jours)
- [ ] Implémenter state machine complète
- [ ] Ajouter gestion LIMIT avec timeout
- [ ] Implémenter fallbacks (market, 2-close)
- [ ] Tests unitaires pour chaque état

### Phase 3: Integration (1-2 jours)
- [ ] Intégrer dans `simpleAgent.ts`
- [ ] Connecter avec exchange (Bybit)
- [ ] Tests sur paper trading

### Phase 4: Validation (3-5 jours)
- [ ] Paper trading 3-5 jours minimum
- [ ] Comparer slippage vs baseline (2-close)
- [ ] Ajuster seuils NFS si nécessaire
- [ ] Monitoring dashboard

### Phase 5: Production
- [ ] Déploiement graduel (1 position d'abord)
- [ ] Monitoring 24/7 première semaine
- [ ] Rollback plan si dégradation

---

## Questions Ouvertes

1. **Seuil NFS optimal:** 70 est-il le bon seuil? Tester 60, 70, 80 en paper.

2. **Timeout LIMIT:** 30s est-il approprié? Trop court = market fréquent, trop long = slippage.

3. **Gestion multi-positions:** Si 2 positions sur même symbole, comment gérer les trailing séparés?

4. **Rate limits exchange:** Combien d'ordres/seconde max? Adapter la fréquence de placement.

5. **Coût des market orders vs LIMIT:** Le slippage market est-il pire que le fill rate du LIMIT?

---

## Conclusion

Ce design vise à se rapprocher du backtest (sortie au trailing exact) tout en gérant tous les scénarios réels. Le NFS agit comme un **filtre intelligent** qui:

1. **Autorise les sorties rapides** quand le signal est fort (score >= 70)
2. **Protège contre les wicks** quand le signal est faible (score < 50)
3. **Fallback robuste** (2-close) quand l'incertitude est élevée

L'implémentation est complexe mais nécessaire pour réduire le gap backtest/live sans introduire de nouveaux risques.

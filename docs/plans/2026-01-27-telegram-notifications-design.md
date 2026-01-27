# Design: Notifications Telegram Intelligentes

## Objectif

Réduire le bruit des notifications Telegram tout en gardant une visibilité sur:
1. Les trades réels (positions ouvertes/fermées)
2. L'état de santé de l'agent (heartbeat)
3. Les raisons de non-trade (top 3 signaux rejetés)

---

## Changements Proposés

### 1. Notifications à SUPPRIMER

| Fonction | Fichier | Action |
|----------|---------|--------|
| `notifyOrderSubmitted` | notifications.ts | Supprimer les appels |
| `notifyOrderFilled` | notifications.ts | Supprimer les appels (sauf exit) |
| `notifyRegimeChangeTelegram` | notifications.ts | Supprimer l'appel (garder en log) |
| `notifySlippageAlert` | notifications.ts | Supprimer les appels (garder en log) |

### 2. Notifications à GARDER

| Fonction | Pourquoi |
|----------|----------|
| `notifyPositionOpened` | Trade réel - pertinent |
| `notifyPositionClosed` | Résultat PnL - pertinent |
| `notifyOrderFailed` | Problème critique |
| `notifySystemAlert` (level: critical/error) | Problème critique |

### 3. NOUVELLES Notifications

#### A. Heartbeat (toutes les 4h)
```
Agent actif depuis 12h
Balance: $1,250.45
Position: ETHUSDT LONG (+2.3%)
Dernière vérification: 14:30
```

#### B. Rapport Top 3 Signaux Rejetés (toutes les 4h)
```
[12h-16h] 47 signaux analysés

Top 3 rejetés:
1. ETHUSDT LONG (score: 72)
   Rejeté: vol_low (1.1x < 1.15x)

2. SOLUSDT SHORT (score: 68)
   Rejeté: bull_regime (BTC > SMA200)

3. BTCUSDT LONG (score: 65)
   Rejeté: roc_low (1.2% < 1.75%)
```

#### C. Alerte Inactivité (si 0 signal en 6h+)
```
Aucun signal depuis 6h
Dernier: ETHUSDT à 08:30
Marché calme ou problème?
```

#### D. Rapport Journalier (8h matin)
```
Rapport 24h - 27 Jan 2026

Trades: 5 (3W / 2L)
PnL: +$127.50 (+2.1%)
Win Rate: 60%
Balance: $1,250.45

Signaux rejetés: 142
- 68 regime_filter
- 45 vol_low
- 29 roc_low
```

---

## Architecture

### Nouveau Service: `telegramReporter.ts`

```typescript
// Stockage des signaux rejetés
interface RejectedSignal {
  timestamp: number;
  symbol: string;
  side: 'long' | 'short';
  score: number;
  reason: string;
  price: number;
}

// Buffer circulaire des 100 derniers signaux rejetés
const rejectedSignals: RejectedSignal[] = [];

// Tracking
let lastHeartbeat = 0;
let lastRejectReport = 0;
let agentStartTime = 0;
```

### Intégration

1. **simpleAgent.ts**: Appeler `trackRejectedSignal()` quand un signal est rejeté avec score > 50
2. **telegramReporter.ts**: Scheduler qui envoie les rapports
3. **notifications.ts**: Ajouter nouvelles fonctions de notification

---

## Implémentation

### Fichiers à modifier:
1. `backend/src/utils/notifications.ts` - Ajouter nouvelles fonctions
2. `backend/src/services/telegramReporter.ts` - NOUVEAU: service de rapports
3. `backend/src/strategies/simpleAgent.ts` - Tracker les rejets, désactiver certaines notifs
4. `backend/src/services/orderQueue.ts` - Supprimer `notifyOrderSubmitted`

### Fichiers à créer:
1. `backend/src/services/telegramReporter.ts`

---

## Implémentation V5.79 (Complétée)

### Changements effectués:

1. **telegramReporter.ts** (nouveau)
   - Service de rapports périodiques
   - Heartbeat toutes les 4h
   - Top 3 signaux rejetés toutes les 4h
   - Rapport journalier à 20h Israël (UTC+2)

2. **simpleAgent.ts**
   - Import de `trackRejectedSignal`, `recordTrade`, `updateAgentState`
   - Suppression des appels `notifySlippageAlert` (2 endroits)
   - Ajout tracking des signaux rejetés avec score
   - Ajout recording des trades (paper + live)
   - Ajout update de l'état agent dans tick()

3. **orderQueue.ts**
   - Suppression de `notifyOrderSubmitted`
   - Suppression de `notifyOrderFilled`
   - Conservation de `notifyOrderFailed` (critique)

4. **notificationService.ts**
   - Suppression de l'appel `notifyRegimeChangeTelegram`
   - Regime change reste en WebSocket uniquement

5. **server.ts**
   - Import et démarrage de `startTelegramReporter`

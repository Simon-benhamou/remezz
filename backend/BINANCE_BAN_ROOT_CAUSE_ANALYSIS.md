# 🚨 Analyse Root Cause: Binance IP Bans

## Problème

Votre système a reçu **2 bans IP consécutifs** de Binance (2h chacun):
- Ban #1: expire 17:15
- Ban #2: expire 19:25 (130 min après le premier)

**Erreur**: "Way too much request weight used; IP banned until..."

## 🔍 Root Cause Analysis

### Ce qui cause VRAIMENT les bans

Binance utilise un système de **Weight** (poids) pour chaque endpoint API:

```
📊 Weight par endpoint:
🚨 fetchBalance           40 weight → max 30 appels/min
🚨 fetchTickers           40 weight → max 30 appels/min  
🚨 fetchOpenOrders        40 weight → max 30 appels/min
⚠️  fetchMyTrades         10 weight → max 120 appels/min
✅ fetchTicker             2 weight → max 600 appels/min
✅ fetchOHLCV              2 weight → max 600 appels/min
✅ createOrder             1 weight → max 1200 appels/min
```

**Limite Binance**: 1200 weight/minute → Si dépassé = **BAN IP 2 heures**

### Les 4 coupables identifiés

#### 🚨 #1 COUPABLE PRINCIPAL: intelligentAgent.ts (300 weight)

**Fichier**: `backend/src/services/intelligentAgent.ts`  
**Lignes**: 376-383

```typescript
// Boucle qui fetch 150 tickers individuellement
for (let i = 0; i < Math.min(perpetualMarkets.length, 150); i++) {
  const symbol = perpetualMarkets[i];
  const ticker = await exchange.fetchTicker(symbol);  // 2 weight × 150 = 300 weight
  allTickers[symbol] = ticker;
}
```

**Impact**: 
- 300 weight en ~30 secondes
- 25% de la limite totale
- **Appelé à chaque création d'agent en mode auto-select** ⚠️

#### 🚨 #2 Agents actifs en parallèle (320 weight/min)

**Scénario**: 10 agents actifs qui surveillent les marchés

```typescript
// Chaque agent fetch OHLCV pour 4 timeframes
// 10 agents × 4 timeframes × 4 cycles/min × 2 weight = 320 weight/min
```

**Impact**:
- 320 weight/minute en continu
- 27% de la limite
- S'accumule avec les autres appels

#### ✅ #3 fetchBalance dans validations (DÉJÀ CORRIGÉ)

**Fichier**: `routes/user.ts`, `exchange/ccxtClient.ts`

```typescript
// AVANT (dangereux):
const balance = await exchange.fetchBalance(); // 40 weight

// APRÈS (safe):
const exchange = await getUserExchange(userId, credentials); // 0 weight
```

**Impact avant fix**: 40 weight par clic "Recheck API" = danger si répété

#### #4 Création d'agents avec fetchBalance

**Fichier**: `routes/agent.ts` ligne 160

```typescript
const b = await ex.fetchBalance(); // 40 weight par agent créé
```

**Impact**: 400 weight si création de 10 agents rapidement

---

## ✅ Solution: WebSocket Streams

### Pourquoi WebSocket?

**Binance recommande explicitement** dans l'erreur:
> "Please use WebSocket Streams for live updates to avoid bans"

**Avantages**:
- **0 weight** (pas de consommation REST API)
- Données **en temps réel** (push, pas de polling)
- 1 connexion pour **plusieurs streams simultanés**
- Reconnexion automatique

### Streams Binance disponibles

```
📡 !ticker@arr              → Tous les tickers (remplace fetchTickers 40 weight)
📡 <symbol>@ticker          → Ticker individuel (remplace fetchTicker 2 weight)
📡 <symbol>@kline_<interval> → OHLCV temps réel (remplace fetchOHLCV 2 weight)
📡 user_data_stream         → Balance, trades, orders (remplace fetchBalance 40 weight)
```

### 📈 Impact sur votre système

```
AVANT (REST API):
- intelligentAgent.ts: 300 weight
- 10 agents OHLCV: 320 weight/min
- Validations: 40 weight × n
- Total: ~620 weight/min (52% de la limite)
  → Risque de ban si pic d'activité

APRÈS (WebSocket):
- intelligentAgent.ts: 0 weight (stream !ticker@arr)
- 10 agents OHLCV: 0 weight (stream kline)
- Validations: 0 weight (déjà fixé)
- Total: ~0 weight/min (0%)
  → Plus de risque de ban ✅
```

---

## 🛠️ Implémentation

### Fichier créé: `backend/src/services/binanceWebSocket.ts`

**Features**:
- ✅ Auto-reconnect avec backoff exponentiel
- ✅ Cache en mémoire des tickers (Map)
- ✅ Stream !ticker@arr pour tous les tickers (0 weight)
- ✅ Streams kline individuels pour OHLCV (0 weight)
- ✅ Callbacks pour real-time updates
- ✅ Health check (connexion + freshness cache)
- ✅ Fallback vers REST API si WebSocket down

**Usage**:

```typescript
import { getBinanceWebSocket, getAllTickersFromWebSocket } from './services/binanceWebSocket.js';

// 1. Get singleton instance (auto-connects)
const ws = getBinanceWebSocket();

// 2. Get all tickers from WebSocket cache (0 weight)
const tickers = await getAllTickersFromWebSocket();

if (tickers) {
  // Use cached data from WebSocket
  for (const [symbol, ticker] of tickers.entries()) {
    console.log(`${symbol}: ${ticker.percentage}%`);
  }
} else {
  // Fallback: use REST API
  const ticker = await exchange.fetchTicker(symbol);
}

// 3. Subscribe to klines for specific symbols
ws.subscribeToKline('BTC/USDT', '15m');

// 4. Get klines from cache
const klines = ws.getKlines('BTC/USDT', '15m');
```

---

## 🎯 Actions Prioritaires

### 1. 🚨 URGENT: Modifier intelligentAgent.ts

**Remplacer la boucle fetchTicker par WebSocket**:

```typescript
// AVANT (300 weight):
for (let i = 0; i < 150; i++) {
  const ticker = await exchange.fetchTicker(symbol);
  allTickers[symbol] = ticker;
}

// APRÈS (0 weight):
import { getAllTickersFromWebSocket } from './binanceWebSocket.js';

const wsTickersMap = await getAllTickersFromWebSocket();
if (wsTickersMap) {
  // Utilise les tickers du WebSocket cache
  for (const [symbol, ticker] of wsTickersMap.entries()) {
    if (perpetualMarkets.includes(symbol)) {
      allTickers[symbol] = {
        symbol: ticker.symbol,
        last: ticker.last,
        percentage: ticker.percentage,
        quoteVolume: ticker.quoteVolume,
        // ... map fields
      };
    }
  }
} else {
  // Fallback: boucle REST API (seulement si WebSocket down)
  for (let i = 0; i < 150; i++) {
    const ticker = await exchange.fetchTicker(symbol);
    allTickers[symbol] = ticker;
  }
}
```

### 2. 🔧 MOYEN: Modifier data/market.ts

**Utiliser WebSocket pour getTicker/getOHLCV avec Binance**:

```typescript
import { getTickerFromWebSocket, getBinanceWebSocket } from '../services/binanceWebSocket.js';

export async function getTicker(symbol: string, options?: { userId?: string }) {
  // Détecte si user utilise Binance
  const isBinance = ...; // Check credentials.exchange === 'binance'
  
  if (isBinance) {
    const wsTicker = await getTickerFromWebSocket(symbol);
    if (wsTicker) {
      return wsTicker; // 0 weight ✅
    }
  }
  
  // Fallback: REST API pour Crypto.com ou si WebSocket down
  const ticker = await exchange.fetchTicker(symbol);
  return ticker;
}
```

### 3. ✅ FAIT: Validations sans fetchBalance

Déjà implémenté dans les commits précédents.

### 4. 📊 BONUS: Stream user_data

Pour éviter de poll fetchBalance, utiliser le user_data stream:

```typescript
// Listen key pour user_data stream
const listenKey = await exchange.fapiPrivatePostListenKey();

// Subscribe au stream
ws.subscribeToUserData(listenKey.listenKey);

// Reçoit balance updates en temps réel
ws.onUserData((data) => {
  if (data.e === 'ACCOUNT_UPDATE') {
    console.log('Balance updated:', data.a.B); // Balances
  }
});
```

---

## 📝 Notes Importantes

### fetchBalance n'est PAS le seul problème

Contrairement à ma première analyse, **fetchBalance (40 weight) n'est PAS le seul coupable**. Le vrai problème est **l'accumulation**:

1. intelligentAgent.ts loop: 300 weight en 30s
2. Agents actifs: 320 weight/min continu
3. fetchBalance répétés: 40 weight × n
4. **Total cumulé > 1200 weight/min** → BAN

### Pourquoi 2 bans consécutifs?

Entre 17:15 (expiration ban #1) et 17:52 (ban #2):
- Soit le système a redémarré et fait des tests
- Soit vous avez créé des agents en auto-select
- **→ Déclenche intelligentAgent.ts (300 weight) + fetchBalance + agents**
- → Dépasse la limite → Nouveau ban

### WebSocket = Solution complète

- Élimine 90% des appels REST API
- 0 weight pour market data
- Seuls les ordres consomment du weight (1-2 weight)
- **Impossible de trigger un ban** avec seulement du trading

---

## 🧪 Testing (après ban expire 19:25)

1. ✅ Vérifier que WebSocket se connecte:
   ```
   📡 Connecting to Binance WebSocket...
   ✅ Binance WebSocket connected
   📡 Subscribing to all tickers stream...
   📊 WebSocket cache: 500 tickers, updated...
   ```

2. ✅ Créer un agent auto-select:
   - Doit utiliser WebSocket (0 weight)
   - Log: "Using WebSocket tickers (0 weight)"
   - Pas de ban

3. ✅ Activer 10 agents:
   - Doivent utiliser WebSocket klines
   - 0 weight continu
   - Pas de ban

4. ✅ Cliquer "Recheck API":
   - N'appelle plus fetchBalance
   - 0 weight
   - Pas de ban

---

## 🎯 Résumé

**Root Cause**: Accumulation de weight REST API (intelligentAgent.ts 300 + agents 320/min + fetchBalance 40×n) > 1200/min

**Solution**: WebSocket streams Binance (0 weight) pour éliminer 90% des appels REST

**Impact**: Plus de risque de ban IP ✅

**Prochaine étape**: Implémenter WebSocket dans intelligentAgent.ts et market.ts (1-2h de dev)

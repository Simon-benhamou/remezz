# 🔍 Volume = 0 Debug Guide

## Problème Observé

L'agent affiche tous les diagnostics **VERTS** (canTrade = true) mais **aucun ordre n'est placé**.

### Cause Racine
```json
"volume": {
    "status": "FAIL",
    "currentVolume": 0,
    "volumeMA": 37.03,
    "ratio": "0.00"
}
```

Le **volume actuel est à 0**, ce qui est **logiquement impossible** pour une crypto activement tradée.

---

## Pourquoi Volume = 0 ?

### 1. Exchange API Issues

**Crypto.com** peut ne pas retourner le volume pour certains symboles:
- Symbole inexistant sur cet exchange
- Format de symbole incorrect (BNB/USDT vs BNBUSDT)
- Market type incorrect (spot vs swap)
- API rate limiting

### 2. Structure OHLCV Non-Standard

Structure attendue:
```typescript
[timestamp, open, high, low, close, volume]
[   0    ,   1 ,  2  ,  3  ,  4  ,    5   ]
```

Certains exchanges peuvent:
- Ne pas inclure le volume (index 5 undefined/null)
- Utiliser une structure différente
- Retourner le volume dans un champ séparé

### 3. Symbol Issues

**BNBUSDT** peut ne pas être disponible sur **crypto.com**:
```bash
# Vérifier les symboles disponibles
# Dans la console exchange crypto.com
await exchange.loadMarkets();
console.log(Object.keys(exchange.markets).filter(s => s.includes('BNB')));
```

---

## Solution Implémentée

### 1. Hard Block sur Volume = 0

**Fichier:** `backend/src/agent/state.ts` (ligne ~2058)

```typescript
// CRITICAL: Block if volume is 0 (no data or illiquid symbol)
if (volume === 0) {
  recordOpsEvent({
    level: 'warn',
    source: 'quality_filter',
    message: 'volume_zero_critical_block',
    sessionId: this.sessionId || undefined,
    symbol: this.profile?.symbol,
    details: { 
      volume, 
      volumeMA, 
      reason: 'No volume data available - possible data issue or illiquid symbol' 
    },
  });
  return false;
}
```

**Impact:**
- Volume = 0 → HARD BLOCK immédiat
- Bypass le scoring system
- canTrade = false
- Log warning dans ops_events

### 2. Debug Logging

**Fichier:** `backend/src/ai/tech.ts` (ligne ~220)

```typescript
// DEBUG: Log volume data for troubleshooting
const latestVolRaw = o15[o15.length - 1]?.[5];
if (latestVolRaw === undefined || latestVolRaw === null || latestVolRaw === 0) {
  console.warn(`[VOLUME DEBUG] ${symbol}: Latest volume is ${latestVolRaw}. Sample OHLCV:`, {
    latestBar: o15[o15.length - 1],
    prev5Bars: o15.slice(-6, -1).map(r => ({ ts: r[0], close: r[4], vol: r[5] })),
    allVolumesZero: volumes15.every(v => v === 0),
    volumesNonZero: volumes15.filter(v => v > 0).length,
  });
}
```

**Ce que ça affiche:**
- Latest bar complet (timestamp, OHLC, volume)
- Les 5 barres précédentes avec leur volume
- Est-ce que TOUS les volumes sont à 0?
- Combien de barres ont du volume?

---

## Diagnostic Steps

### 1. Vérifier les Logs Backend

Redémarre le backend:
```bash
npm -w backend run dev
```

Cherche dans les logs:
```
[VOLUME DEBUG] BNBUSDT: Latest volume is 0
```

Exemple de sortie attendue:
```json
{
  "latestBar": [1759311001000, 588.45, 588.50, 588.40, 588.48, 0],
  "prev5Bars": [
    { "ts": 1759310100000, "close": 588.12, "vol": 0 },
    { "ts": 1759310200000, "close": 588.20, "vol": 0 },
    { "ts": 1759310300000, "close": 588.35, "vol": 0 },
    { "ts": 1759310400000, "close": 588.40, "vol": 0 },
    { "ts": 1759310500000, "close": 588.44, "vol": 0 }
  ],
  "allVolumesZero": true,
  "volumesNonZero": 0
}
```

**Interprétation:**
- Si `allVolumesZero: true` → Exchange ne retourne PAS le volume
- Si `volumesNonZero: 50` → Volume disponible mais actuel = 0 (timing issue)

### 2. Tester un Autre Symbole

Essaie avec **BTCUSDT** (toujours liquide):
```javascript
POST /activate-agent
{
  "symbol": "BTCUSDT",
  "mode": "paper",
  "aggressiveness": "conservative"
}
```

Si BTCUSDT fonctionne → BNBUSDT n'est pas disponible sur crypto.com

### 3. Vérifier l'Exchange

Dans les logs, cherche:
```
EXCHANGE_ID=cryptocom
MARKET_TYPE=swap
```

Vérifie que:
- crypto.com supporte BNBUSDT en mode swap
- Le format du symbole est correct

### 4. Tester un Autre Exchange

Temporairement dans `.env`:
```properties
EXCHANGE_ID=binance
# ou
EXCHANGE_ID=bybit
```

Si ça fonctionne → Problème spécifique à crypto.com

---

## Résolutions Possibles

### Option 1: Utiliser un Symbole Valide

Symboles garantis sur crypto.com:
- BTCUSDT (Bitcoin)
- ETHUSDT (Ethereum)
- SOLUSDT (Solana)

### Option 2: Changer l'Exchange

Dans `.env`:
```properties
EXCHANGE_ID=binance
# Binance a BNBUSDT car BNB est leur token
```

### Option 3: Utiliser un Fallback

Si le volume n'est pas disponible, utiliser une estimation:
```typescript
// Dans tech.ts
const latestVol = volumes15[volumes15.length - 1] || avgVolume || 1;
```

⚠️ **Attention:** Ce n'est PAS recommandé pour le trading réel!

### Option 4: Désactiver le Filtre Volume

**Pour testing uniquement:**

Dans `passesQualityFilters()`:
```typescript
// TEMPORARY: Skip volume check if no data available
if (volumeMA === 0) {
  console.warn('Volume data not available, skipping volume filter');
  // Continue without volume check
} else {
  // Normal volume check
}
```

⚠️ **Dangereux:** Tu trades sans confirmation de liquidité!

---

## Vérification Post-Fix

Après avoir appliqué une solution:

1. **Redémarre le backend:**
   ```bash
   npm -w backend run dev
   ```

2. **Vérifie les logs:**
   ```
   [VOLUME DEBUG] BTCUSDT: ...
   # Devrait montrer volumesNonZero > 0
   ```

3. **Teste l'activation:**
   - canTrade devrait être true
   - Volume devrait être > 0
   - qualityFilters devrait PASS

4. **Observe le premier trade:**
   - L'ordre devrait être placé
   - Volume dans le diagnostic > 0

---

## Conclusion

Le **volume = 0** est un symptôme d'un problème de données, pas d'un problème de stratégie.

**Solutions par ordre de préférence:**
1. ✅ Utiliser un symbole valide (BTCUSDT)
2. ✅ Changer l'exchange (Binance pour BNBUSDT)
3. ⚠️ Fallback volume estimation (risqué)
4. ❌ Désactiver le filtre (très risqué)

**Pour production:**
- Toujours vérifier que le symbole existe sur l'exchange
- Tester avec des symboles majeurs (BTC, ETH) d'abord
- Logger les problèmes de données pour monitoring

---

**Note:** Le hard block sur volume = 0 est une **protection** contre le trading sans données. C'est voulu et devrait rester en place! 🛡️

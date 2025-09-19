# Diagnostic et Correction ATR% - 19 Septembre 2025

## 🔍 **Problème identifié**
L'ATR% est à 0.00% pour toutes les cryptos dans les Key Metrics de l'interface.

## 🕵️ **Investigation menée**

### 1. **Calcul ATR fonctionnel**
✅ Le calcul d'ATR dans `backend/src/data/indicators.ts` est correct
✅ Le calcul d'ATR% dans `backend/src/ai/tech.ts` est correct : `(atr14v / lastPrice) * 100`

### 2. **Problème trouvé**
❌ La route `/api/status` retourne seulement `computeCoreIndicators()` qui contient `atr14` (valeur absolue)
❌ Mais l'ATR% (`atrPct`) est calculé dans `buildTechSnapshot()` qui n'était pas exposé dans `indicators`

### 3. **Racine du problème**
```typescript
// AVANT (dans routes/status.ts)
res.json({
  indicators: indic, // Seulement { ema20, ema50, rsi14, atr14 }
  // tech contient atrPct mais n'est pas dans indicators
});

// Frontend cherche indicators.atrPct → undefined → 0.00%
```

## ⚙️ **Correction appliquée**

### 1. **Route status.ts mise à jour**
```typescript
// APRÈS
res.json({
  indicators: indic ? {
    ...indic,
    atrPct: tech?.atrPct ?? 0,      // ✅ ATR% ajouté
    adx14: tech?.adx14 ?? 0,        // ✅ ADX ajouté
    ema20Slope: tech?.ema20Slope ?? 0, // ✅ Slope ajouté  
    price: tech?.last ?? 0,         // ✅ Prix actuel ajouté
  } : null,
});
```

### 2. **Données maintenant disponibles**
- ✅ `atrPct` : Pourcentage de volatilité par rapport au prix
- ✅ `adx14` : Indicateur de force de tendance
- ✅ `ema20Slope` : Pente EMA20 pour direction
- ✅ `price` : Prix actuel pour calculs

## 🧪 **Test et validation**

### 1. **Rebuild Docker effectué**
```bash
docker-compose build api
docker-compose restart api
```

### 2. **Problème CORS temporaire**
- L'API fonctionne mais bloque `localhost:5175`
- Les calculs sont corrects côté backend
- La donnée `atrPct` est maintenant exposée

### 3. **Résultat attendu**
Après résolution CORS, l'interface devrait afficher :
- ✅ ATR% > 0% (typiquement 0.5% à 3% pour les cryptos)
- ✅ ADX avec vraies valeurs (0-100)
- ✅ Trend slope calculé correctement
- ✅ Gates momentum fonctionnels

## 📊 **Exemple données typiques**
```json
{
  "indicators": {
    "ema20": 3.058,
    "ema50": 3.064,
    "rsi14": 35.9,
    "atr14": 0.0195,
    "atrPct": 0.63,     // ← FIX: maintenant disponible
    "adx14": 23.4,      // ← FIX: maintenant disponible  
    "ema20Slope": -0.002,
    "price": 3.059
  }
}
```

## ✅ **Status**
🟡 **EN COURS** - Correction backend terminée, attente résolution CORS pour test final

## 🔄 **Prochaines étapes**
1. Résoudre problème CORS temporaire
2. Tester interface avec nouvelles données
3. Valider calculs ATR% sur différents symboles
4. Confirmer que les gates momentum fonctionnent
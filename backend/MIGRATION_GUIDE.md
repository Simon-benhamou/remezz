# 🔄 Migration Guide: Phases → Modes

## Résumé Rapide

**Ancien Système:** Phases temporelles (Semaine 1, 2, 3)  
**Nouveau Système:** Modes dynamiques (Conservative, Reactive, Aggressive)

## 🚀 Migration Instantanée

### Correspondance Phases → Modes

| Ancienne Phase | Nouveau Mode | Quand l'utiliser |
|---------------|--------------|------------------|
| Phase 1: Conservative+ (Semaine 1) | `conservative` | Bear market, test |
| Phase 2: Medium (Semaine 2) | `reactive` | Marché normal |
| Phase 3: Aggressive (Semaine 3) | `aggressive` | Bull market |

## 📋 Checklist de Migration

### ✅ Changements Automatiques (Déjà faits)

- [x] `.env` configuré avec paramètres par mode
- [x] `env.ts` avec fonction `getModeParams()`
- [x] `risk/manager.ts` adapte les limites dynamiquement
- [x] `agent/state.ts` utilise les seuils par mode
- [x] Documentation `MODE_ADAPTIVE_TRADING.md` créée

### 🎯 Actions à Faire

1. **Redémarrer le backend:**
   ```bash
   npm -w backend run dev
   ```

2. **Activer un agent avec le mode désiré:**
   ```bash
   # Via l'interface web, sélectionne aggressiveness:
   - conservative: Pour bear market
   - reactive: Pour usage normal (recommandé)
   - aggressive: Pour bull market
   ```

3. **Vérifier les logs:**
   ```bash
   # Tu devrais voir:
   "Daily trades: 7/10 - within limit (reactive mode)"
   "Consecutive stops: 2/3 - acceptable (reactive mode)"
   "ATR threshold: 0.25% (reactive mode)"
   ```

## 🎮 Utilisation Pratique

### Scénario 1: Démarrage Prudent
```javascript
// Active en mode conservative
POST /activate-agent
{
  "symbol": "BTCUSDT",
  "mode": "paper",
  "aggressiveness": "conservative"
}

// Résultat: ATR 0.30%, Risk 1.0%, 4-6 trades/jour
```

### Scénario 2: Usage Quotidien (Recommandé)
```javascript
// Active en mode reactive (default)
POST /activate-agent
{
  "symbol": "BTCUSDT",
  "mode": "paper",
  "aggressiveness": "reactive"
}

// Résultat: ATR 0.25%, Risk 1.5%, 7-10 trades/jour
```

### Scénario 3: Bull Market
```javascript
// Active en mode aggressive
POST /activate-agent
{
  "symbol": "BTCUSDT",
  "mode": "paper",
  "aggressiveness": "aggressive"
}

// Résultat: ATR 0.15%, Risk 2.5%, 10-15 trades/jour
```

## 💡 Avantages du Nouveau Système

### ❌ Ancien (Phases)
- Changement manuel chaque semaine
- Rigide: doit suivre Phase 1 → 2 → 3
- Pas d'adaptation au marché
- Timing arbitraire

### ✅ Nouveau (Modes)
- Changement instantané selon le marché
- Flexible: utilise n'importe quel mode n'importe quand
- S'adapte aux conditions réelles
- Contextuel et intelligent

## 📊 Tableau de Correspondance Détaillé

| Paramètre | Phase 1 | Phase 2 | Phase 3 | Conservative | Reactive | Aggressive |
|-----------|---------|---------|---------|--------------|----------|------------|
| ATR Min % | 0.25 | 0.20 | 0.15 | 0.30 | 0.25 | 0.15 |
| Risk % | 1.5 | 2.0 | 2.5 | 1.0 | 1.5 | 2.5 |
| Max Trades/Day | 6-8 | 10 | 12-15 | 6 | 10 | 15 |
| Max Stops | 2-3 | 3 | 3-4 | 2 | 3 | 4 |
| Loss Limit % | 5.0 | 5.5 | 7.0 | 4.0 | 5.5 | 7.0 |

## 🔧 Personnalisation

Si tu veux ajuster un mode spécifique, édite `.env`:

```bash
# Exemple: Rendre REACTIVE plus agressif
REACTIVE_RISK_PCT=2.0
REACTIVE_MIN_ATR_PCT=0.20
REACTIVE_MAX_TRADES_PER_DAY=12

# Redémarre le backend
npm -w backend run dev
```

## 🚨 Notes Importantes

1. **Mode par défaut:** `reactive` (équilibre optimal)
2. **Changement instantané:** Pas besoin d'attendre une semaine
3. **Multi-agents:** Chaque agent peut avoir un mode différent
4. **Monitoring:** Le mode actif est visible dans les logs

## 📖 Documentation

- **Guide complet:** `MODE_ADAPTIVE_TRADING.md`
- **Configuration:** `.env`
- **Code changes:** `IMPLEMENTATION_PATCH.js`
- **Exemples:** `REAL_EXAMPLE.md`

## ✅ Validation

Pour vérifier que tout fonctionne:

1. Démarre le backend: `npm -w backend run dev`
2. Active un agent en mode `reactive`
3. Vérifie les logs pour voir:
   - `"Daily trades: X/10 - within limit (reactive mode)"`
   - `"ATR threshold: 0.25% (reactive mode)"`
4. Si tu vois ces messages → Migration réussie! 🎉

## 🆘 Support

Si problème, vérifie:
- [ ] `.env` contient tous les paramètres de mode
- [ ] Backend redémarré après modification `.env`
- [ ] `aggressiveness` passé lors de l'activation
- [ ] Logs du backend pour erreurs TypeScript

---

**Note finale:** Le nouveau système est BEAUCOUP plus flexible. Utilise `reactive` par défaut, `conservative` si tu doutes, et `aggressive` seulement en bull market confirmé.

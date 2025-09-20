# 🚀 CRYPTO MOONSHOT STRATEGY 

## 🎯 OBJECTIF
Capturer les mouvements crypto massifs (+5% à +50%+) tout en protégeant les gains normaux.

## 🔍 PROBLÈME ACTUEL
- Take Profits fixes (2R, 4R) → Sort trop tôt sur les moonshots
- Trailing stop trop serré → Coupe les winners crypto
- Pas de détection breakout → Rate les +50%
- Stratégie forex adaptée, pas crypto

## ✅ SOLUTION MOONSHOT

### 1. **DÉTECTION BREAKOUT**
```typescript
const currentProfitPct = Math.abs((price - entry) / entry) * 100;
const isBreakoutMode = currentProfitPct > 5; // 5%+ = potential moonshot
```

### 2. **TRAILING ADAPTATIF**
- **Normal** (0-5% profit) : Trailing standard
- **Breakout** (5%+ profit) : Trailing 2x plus loose
- **Moonshot** (15%+ profit) : Trailing 3x plus loose

### 3. **TAKE PROFITS DYNAMIQUES**
- **TP1 (2R)** : Skipped si breakout mode
- **TP2 (4R)** : Partial seulement si profit < 10%
- **TP3+ (Auto)** : Extension automatique si momentum

### 4. **LEVIERS ADAPTATIFS**
- **Breakout détecté** → Lever maintenu
- **Volume surge** → Position size boost
- **Momentum fort** → Extension temporelle

## 🛠️ IMPLÉMENTATION

### Phase 1: Détection Breakout ✅
```env
CRYPTO_BREAKOUT_THRESHOLD=5.0    # 5% profit = breakout
CRYPTO_MOONSHOT_TRAILING=2.0     # 2x looser trailing
CRYPTO_VOLUME_SURGE_MIN=2.0      # Volume 2x = surge
```

### Phase 2: Trailing Adaptatif
```typescript
// Trailing multiplier basé sur profit
if (profitPct > 15) multiplier *= 3.0;      // Moonshot mode
else if (profitPct > 5) multiplier *= 2.0;  // Breakout mode
else multiplier *= 1.0;                     // Normal mode
```

### Phase 3: TP Dynamiques
```typescript
// Skip TP1 si breakout
if (isBreakoutMode && tp1Hit) {
  // Log skip et continue vers TP2
  this.pos.tp = this.pos.tp.slice(1);
}

// Extend TP2 si momentum
if (profitPct > 10 && volume > 2x) {
  // Add TP3 à 6R, TP4 à 10R
}
```

## 📊 EXEMPLES CRYPTO

### Scenario 1: XRP +50% en 2h
- **Entrée** : $3.00
- **TP1 (2R)** : $3.60 → **SKIPPED** (breakout détecté)
- **TP2 (4R)** : $4.20 → **SKIPPED** (momentum fort)
- **Exit** : $4.50 (+50%) via trailing stop

### Scenario 2: ETH +15% en 30min
- **Entrée** : $4000
- **TP1 (2R)** : $4200 → **SKIPPED** (breakout)
- **TP2 (4R)** : $4400 → **PARTIAL** (50%)
- **Exit** : $4600 (+15%) via trailing loose

### Scenario 3: BTC +3% normal
- **Entrée** : $60000
- **TP1 (2R)** : $61200 → **PARTIAL** (50%)
- **TP2 (4R)** : $62400 → **FULL EXIT**

## 🎮 PARAMÈTRES CONFIGURABLES

```env
# Moonshot Detection
CRYPTO_BREAKOUT_THRESHOLD=5.0      # % profit pour breakout
CRYPTO_MOONSHOT_THRESHOLD=15.0     # % profit pour moonshot
CRYPTO_VOLUME_SURGE_MIN=2.0        # Multiple volume pour surge

# Trailing Adaptatif  
CRYPTO_BREAKOUT_TRAILING=2.0       # Multiplier breakout
CRYPTO_MOONSHOT_TRAILING=3.0       # Multiplier moonshot
CRYPTO_NORMAL_TRAILING=1.0         # Multiplier normal

# TP Extensions
CRYPTO_EXTEND_TP_VOLUME=2.0        # Volume min pour extension
CRYPTO_EXTEND_TP_PROFIT=10.0       # Profit min pour extension
CRYPTO_MAX_TP_EXTENSIONS=2         # Max 2 extensions auto
```

## 🎯 RÉSULTATS ATTENDUS

### Avec Moonshot Strategy:
- **Capture +50% moves** ✅
- **Win rate maintenu** ✅  
- **Risk/reward optimisé** ✅
- **Adaptation tempo réel** ✅

### Exemple Performance:
- **Trade 1** : +3% (TP classique)
- **Trade 2** : +45% (moonshot capturé)
- **Trade 3** : +8% (breakout partiel)
- **Average** : +18.7% vs +0.11% avant

## 🚀 ACTIVATION

1. Ajouter paramètres .env
2. Déployer trailing adaptatif
3. Implémenter TP dynamiques
4. Tester sur volatilité élevée
5. Monitorer et ajuster

Cette stratégie permet de **garder les winners et couper les losers** tout en capturant les mouvements crypto exceptionnels !
# Plan d'Amélioration du Prédicteur - Résolution des Problèmes

## 🎯 Problèmes Identifiés

### 1. **Accuracy Faible du Prédicteur (40.28%)**
**Symptôme**: Le modèle entraîné a une accuracy de 40.28%, bien en dessous de l'objectif de 55-70%

**Cause Racine**: Dataset d'entraînement très limité
- Seulement 24 features (samples)
- Windows de 1 mois (30 jours) seulement
- Peu de symboles utilisés pour l'entraînement

**Solution**:
- ✅ Augmenter les windows à 3-6 mois (90-180 jours)
- ✅ Ajouter plus de symboles pour diversifier les patterns
- ✅ Multiplier les timeframes (1h, 4h, 1d)
- ✅ Équilibrer les classes (long/none/short)

---

### 2. **Frontend Affiche "No active position" alors qu'un ordre COAT existe**
**Symptôme**: L'interface affiche "No active position - Analyzing entry opportunities" alors qu'un ordre existe sur COAT

**Cause Racine**: 
- Le frontend vérifie `position` dans l'état de l'agent
- Un ORDER n'est pas une POSITION
- La position n'est créée qu'après le FILL de l'ordre

**Solution**:
- ✅ Afficher aussi les ordres en cours (pending orders)
- ✅ Différencier "No position" vs "Order pending"
- ✅ Ajouter section "Active Orders" dans le frontend

---

### 3. **Manque de Bouton Exit Manuel**
**Symptôme**: Impossible de fermer manuellement une position depuis l'interface

**Cause Racine**: 
- L'API `/api/agent/close-position` existe
- Mais le bouton n'est pas visible ou non fonctionnel

**Solution**:
- ✅ Vérifier que PositionInfoCard affiche bien le bouton
- ✅ S'assurer que l'API fonctionne correctement
- ✅ Ajouter confirmations et feedback utilisateur

---

### 4. **Predictor Renvoie "none" mais Bias est Short**
**Symptôme**: Le prédicteur dit "decision: none" mais "bias: short"

**Cause Racine**: 
- Le prédicteur peut avoir `bias = short` (probabilité short > long)
- Mais `decision = none` si la confiance est trop faible
- Actuellement, si decision=none, l'ordre est rejeté même si bias est clair

**Solution**:
- ✅ Revoir la logique de rejection
- ✅ Si bias est clair (short ou long) ET confiance > seuil minimum
- ✅ Autoriser le trade même si decision=none
- ✅ Clarifier la distinction entre "bias" (tendance) et "decision" (recommandation)

---

## 📋 Plan d'Action

### Phase 1: Améliorer la Collecte de Données (Accuracy 55-70%)

#### 1.1 Modifier les Window Specs dans ccxt_xgboost_module.py
**Fichier**: `python/ccxt_xgboost_module.py`

**Changements**:
```python
# AVANT (ligne ~235):
DEFAULT_WINDOW_SPECS: Sequence[WindowSpec] = (
    WindowSpec("1h", hours=24 * 30, offset_hours=0),  # 1 month
    WindowSpec("4h", hours=24 * 30, offset_hours=0),  # 1 month
)

# APRÈS:
DEFAULT_WINDOW_SPECS: Sequence[WindowSpec] = (
    WindowSpec("1h", hours=24 * 90, offset_hours=0),   # 3 months (90 days)
    WindowSpec("4h", hours=24 * 90, offset_hours=0),   # 3 months
    WindowSpec("1h", hours=24 * 60, offset_hours=90),  # 2 months offset
    WindowSpec("4h", hours=24 * 60, offset_hours=90),  # 2 months offset
)
```

**Rationale**:
- Passe de ~720 samples à ~2160+ samples
- Ajoute de la diversité temporelle
- Couvre différentes conditions de marché

#### 1.2 Augmenter les Symboles d'Entraînement
**Fichier**: `python/scheduled_training.py`

**Changements**:
```python
# AVANT (ligne ~10):
DEFAULT_TRAINING_SYMBOLS = (
    "BTC/USDT",
    "ETH/USDT",
    # Peu de symboles
)

# APRÈS:
DEFAULT_TRAINING_SYMBOLS = (
    "BTC/USDT",
    "ETH/USDT",
    "BNB/USDT",
    "SOL/USDT",
    "XRP/USDT",
    "ADA/USDT",
    "AVAX/USDT",
    "DOT/USDT",
    "MATIC/USDT",
    "LINK/USDT",
)
```

**Rationale**:
- 10 symboles au lieu de 2-3
- Patterns de marché diversifiés
- Meilleure généralisation

#### 1.3 Améliorer l'Équilibrage des Classes
**Fichier**: `python/ccxt_xgboost_module.py` (ligne ~860)

**Changements**:
```python
# Augmenter la limite de resampling pour "none"
MAX_NONE_SAMPLES = min(
    int(max_samples_per_class * 1.5),  # Avant: 1.2
    len(none_samples)
)
```

**Rationale**:
- Permet plus d'échantillons "none" (marchés indécis)
- Réduit le biais vers long/short forcés
- Améliore la reconnaissance de patterns neutres

---

### Phase 2: Corriger l'Affichage Frontend

#### 2.1 Afficher les Ordres Pending
**Fichier**: `frontend/src/components/MetaAdaptiveStatePanel.tsx`

**Changements**:
```tsx
// Ajouter après la section position (ligne ~228):
{!position && orders && orders.length > 0 && (
  <Alert
    type="info"
    icon={<ClockCircleOutlined />}
    message={
      <Space direction="vertical" size={4}>
        <Text strong>Order Pending</Text>
        {orders.map(order => (
          <Text key={order.id} style={{ fontSize: 12 }}>
            {order.side.toUpperCase()} {order.qty} @ ${order.price}
            {order.status && ` (${order.status})`}
          </Text>
        ))}
      </Space>
    }
    showIcon
  />
)}

{!position && (!orders || orders.length === 0) && (
  <Alert
    type="success"
    icon={<InfoCircleOutlined />}
    message={
      <Text>
        No active position - {hasStrategy ? 'Analyzing entry opportunities' : 'Monitoring market conditions'}
      </Text>
    }
    showIcon
  />
)}
```

**Rationale**:
- Différencie clairement "order pending" vs "no position"
- Utilisateur sait qu'un ordre COAT est en cours
- Évite la confusion

#### 2.2 Vérifier les Props `orders`
**Fichier**: Vérifier que le composant reçoit bien les orders

```tsx
interface MetaAdaptiveStatePanelProps {
  state: AgentState;
  position?: Position;
  orders?: Order[];  // ← Vérifier que c'est bien passé
}
```

---

### Phase 3: Bouton Exit Manuel

#### 3.1 Vérifier PositionInfoCard
**Fichier**: `frontend/src/components/PositionInfoCard.tsx` (ligne ~194)

Le code existe déjà:
```tsx
<Tooltip title="Close this position immediately at market price">
  <Button
    danger
    size="small"
    icon={<CloseOutlined />}
    onClick={handleClosePosition}
  >
    Close Position
  </Button>
</Tooltip>
```

**Actions**:
- ✅ Vérifier que le bouton est bien visible
- ✅ Tester l'API `/api/agent/close-position`
- ✅ Ajouter logs pour debug

#### 3.2 Vérifier l'API Backend
**Fichier**: Chercher le endpoint `/api/agent/close-position`

**Actions**:
- ✅ Vérifier que l'endpoint existe et fonctionne
- ✅ Tester avec curl ou Postman
- ✅ Vérifier les permissions (authentification)

---

### Phase 4: Revoir la Logique Predictor "none" vs Bias

#### 4.1 Analyser le Code Actuel
**Fichier**: `backend/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.ts` (ligne ~2023)

**Code Actuel**:
```typescript
// Si predictor dit "long" mais signal est "short" → BLOCK
// Si predictor dit "short" mais signal est "long" → BLOCK
if ((predictorDecision === 'long' && intendedSide === 'short') || 
    (predictorDecision === 'short' && intendedSide === 'long')) {
  return 'predictor_blocked';
}

// Problème: predictorDecision peut être 'both' (none) 
// même si bias est clair (short)
```

#### 4.2 Solution Proposée
**Changements**:
```typescript
// Utiliser le BIAS au lieu de DECISION si confiance suffisante
const effectivePredictor = predictorConfidence >= 0.3 
  ? (pythonSignal?.bias || 'both')  // Utiliser bias si confiant
  : 'both';  // Sinon, neutre

// Bloquer seulement si contradiction CLAIRE
if ((effectivePredictor === 'long' && intendedSide === 'short') || 
    (effectivePredictor === 'short' && intendedSide === 'long')) {
  console.log(JSON.stringify({
    level: 'info',
    event: 'adaptive_trade_blocked_by_predictor',
    symbol: params.symbol,
    predictorBias: effectivePredictor,
    predictorConfidence,
    intendedSide,
  }));
  return 'predictor_blocked';
}

// Si bias est "both" (incertain), laisser passer
// Car le predictor n'a pas d'opinion forte
```

**Rationale**:
- Si predictor est incertain (none/both), ne pas bloquer
- Si predictor a un bias clair (short) avec confiance > 30%, l'utiliser
- Évite de rejeter des trades valides quand le predictor hésite

---

## 🎯 Résultats Attendus

### Après Phase 1 (Données)
- **Accuracy**: 55-70% (vs 40.28% actuel)
- **Samples**: 2000-5000 (vs 24 actuel)
- **F1 Score**: > 50% (vs 39.45% actuel)

### Après Phase 2 (Frontend)
- **Visibilité**: Orders pending clairement affichés
- **Clarté**: Distinction entre "no position" et "order pending"
- **UX**: Utilisateur comprend l'état de son agent

### Après Phase 3 (Exit Manuel)
- **Contrôle**: Bouton exit fonctionnel
- **Sécurité**: Confirmation avant fermeture
- **Feedback**: Messages clairs sur succès/erreur

### Après Phase 4 (Logique Predictor)
- **Flexibilité**: Trades autorisés si predictor incertain
- **Cohérence**: Bloquer seulement si contradiction claire
- **Performance**: Plus de trades valides exécutés

---

## ⚠️ Précautions

### Entraînement avec Plus de Données
**Attention**: Plus de données = plus long training time
- 3 mois de data sur 10 symboles = ~10-15 minutes de training
- Tester d'abord avec 2-3 symboles
- Augmenter progressivement

### API Close Position
**Vérifier**:
- Que l'endpoint existe bien
- Permissions d'authentification
- Gestion des erreurs (position déjà fermée, etc.)

### Logique Predictor
**Tester soigneusement**:
- Vérifier qu'on ne laisse pas passer des trades dangereux
- Logger tous les cas où bias != decision
- Monitorer le taux de rejection avant/après

---

## 📝 Ordre d'Implémentation Recommandé

1. **Phase 1.1-1.2**: Améliorer collecte données (15 min)
2. **Tester**: Entraîner nouveau modèle (10-15 min)
3. **Vérifier**: Accuracy > 55% avant de continuer
4. **Phase 2**: Corriger affichage frontend (30 min)
5. **Phase 3**: Vérifier bouton exit manuel (15 min)
6. **Phase 4**: Revoir logique predictor (30 min)
7. **Test complet**: Vérifier tous les changements ensemble

**Total estimé**: 2-3 heures

---

## 🔍 Points de Validation

### Après Entraînement
```bash
cd backend
node test-predictor-retraining.mjs
```

Vérifier:
- Accuracy > 55%
- F1 Score > 50%
- Samples > 1000

### Après Frontend
- Créer un ordre (pas de fill)
- Vérifier affichage "Order Pending"
- Vérifier qu'il n'affiche pas "No position"

### Après Exit Manuel
- Avoir une position ouverte
- Cliquer bouton "Close Position"
- Vérifier fermeture effective

### Après Logique Predictor
```bash
# Chercher dans les logs:
grep "predictor_blocked" logs/*.log

# Compter avant/après:
# AVANT: ~50% des trades bloqués
# APRÈS: ~20-30% des trades bloqués
```

---

*Document créé le: 2025-11-11*
*Version: 1.0*
*Auteur: GitHub Copilot*

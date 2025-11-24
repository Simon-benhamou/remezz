# 🧠 Adaptive Learning Card - Integration

## Composant créé

**Fichier**: `/frontend/src/components/AdaptiveLearningCard.tsx`

### Fonctionnalités

✅ Affiche le résumé de l'apprentissage adaptatif pour un symbole  
✅ Montre la performance par niveau de confiance (high/medium/low)  
✅ Affiche le taux de victoire et le nombre de trades  
✅ Recommandation globale basée sur la performance historique  
✅ Barres de progression colorées selon la performance  
✅ Gestion des états de chargement et d'erreur  

### Intégration dans SessionCockpitPage

Le composant a été ajouté à la page **SessionCockpitPage** dans la section "Enhanced Monitoring" aux côtés de:
- **SymbolProfileCard** (col 1)
- **PredictorResultsCard** (col 2)  
- **AdaptiveLearningCard** (col 3) ← **NOUVEAU**

### Layout responsive

- **Desktop (lg)**: 3 colonnes de 8 (33% chacune)
- **Tablet (md)**: 2 colonnes de 12 (50% chacune)
- **Mobile (xs)**: 1 colonne pleine largeur

### Données affichées

1. **Overall Recommendation** - Alert coloré avec recommandation IA
2. **High Confidence Trades** (≥75% predictor)
   - Win rate
   - Nombre de trades
   - Barre de progression
3. **Medium Confidence Trades** (55-75%)
4. **Low Confidence Trades** (<55%)
5. **Adaptive Insights** - Explication du système

### Couleurs des win rates

- **≥60%**: Vert (`#52c41a`) - Excellent
- **≥50%**: Bleu (`#1890ff`) - Bon
- **≥40%**: Orange (`#faad14`) - Moyen
- **<40%**: Rouge (`#ff4d4f`) - Faible

## Utilisation

Le composant se charge automatiquement quand:
- La phase de chargement atteint `SECONDARY_DATA`
- Le symbole est disponible
- Il affiche les 30 derniers jours de données par défaut

## Exemple de rendu

```
╔══════════════════════════════════════════════════╗
║ ⚡ Adaptive Learning              [30 days]     ║
╠══════════════════════════════════════════════════╣
║                                                  ║
║  ✅ Strong edge on SUI/USDT:USDT - can trade   ║
║     aggressively with high predictor confidence  ║
║                                                  ║
║  Performance by Confidence Level                 ║
║  ┌────────────────────────────────────────────┐ ║
║  │ High Confidence (≥75%)                     │ ║
║  │ Win Rate: 73.3%  |  Trades: 15            │ ║
║  │ ████████████████████████████████░░░░░░░░░░│ ║
║  └────────────────────────────────────────────┘ ║
║  ┌────────────────────────────────────────────┐ ║
║  │ Medium Confidence (55-75%)                 │ ║
║  │ Win Rate: 54.5%  |  Trades: 22            │ ║
║  │ ███████████████████████░░░░░░░░░░░░░░░░░░░│ ║
║  └────────────────────────────────────────────┘ ║
║                                                  ║
║  💡 Adaptive Insights                           ║
║  The system adjusts entry thresholds based on   ║
║  proven performance...                           ║
╚══════════════════════════════════════════════════╝
```

## API utilisée

```typescript
api.getAdaptiveSummary(symbol: string, lookbackDays?: number)
```

Endpoint: `POST /api/market-health/adaptive-summary`

## Test

Pour tester le composant:

1. Démarrer le backend: `npm -w backend run dev`
2. Démarrer le frontend: `npm -w frontend run dev`
3. Naviguer vers un agent actif: `/agents/:sessionId`
4. Le composant Adaptive Learning apparaît dans la section "Enhanced Monitoring"

Si aucune donnée historique n'existe, le composant affiche:
> "Insufficient Data - Not enough historical trades to provide adaptive recommendations."

# API POST pour Trading Diagnostics

## 🚀 Solution aux problèmes de slash dans les URLs

### **Nouveau Endpoint POST** (Recommandé)

```bash
POST /api/cache/trading-diagnostics
Content-Type: application/json
Authorization: Bearer <token>

{
  "symbol": "DOT/USDT",
  "force": false  // optionnel: true pour forcer refresh
}
```

### **Exemples d'utilisation :**

#### Analyse DOT/USDT
```bash
curl -X POST https://trading-agent-ia-v3-backend-production.up.railway.app/api/cache/trading-diagnostics \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"symbol": "DOT/USDT"}'
```

#### Analyse ADA/USD avec force refresh
```bash
curl -X POST https://trading-agent-ia-v3-backend-production.up.railway.app/api/cache/trading-diagnostics \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"symbol": "ADA/USD", "force": true}'
```

#### Force refresh endpoint
```bash
POST /api/cache/trading-diagnostics/refresh
Content-Type: application/json
Authorization: Bearer <token>

{
  "symbol": "DOT/USDT"
}
```

### **Avantages de l'API POST :**

✅ **Pas de problème avec les slashes** : `/` dans DOT/USDT est dans le body, pas l'URL  
✅ **Support de tous les symboles** : BTC/USD, ETH/USDT, ADA/EUR, etc.  
✅ **Force refresh** : Parameter `force: true` pour bypass cache  
✅ **Validation robuste** : Symboles validés côté serveur  
✅ **Meilleure sécurité** : Paramètres sensibles dans le body  

### **Format de réponse :**

```json
{
  "data": {
    "symbol": "DOT/USDT",
    "technical": { ... },
    "strategy": { ... },
    "levels": { ... },
    "timestamp": "2025-09-21T07:52:28.568Z",
    "source": "fresh_analysis"
  },
  "cached": false,
  "timestamp": "2025-09-21T07:52:28.568Z",
  "method": "POST",
  "symbol": "DOT/USDT"
}
```

### **Migration depuis GET :**

**Avant (problématique) :**
```bash
GET /api/cache/trading-diagnostics/DOT/USDT  # ❌ Erreur 404
```

**Après (fonctionnel) :**
```bash
POST /api/cache/trading-diagnostics
Body: {"symbol": "DOT/USDT"}  # ✅ Fonctionne parfaitement
```

### **Codes d'erreur :**

- `400` : Symbol manquant ou format invalide
- `429` : Limite quotidienne dépassée (5 calls/jour)
- `401` : Token manquant ou invalide
- `500` : Erreur serveur

Cette API POST résout définitivement tous les problèmes de routing avec les symboles contenant des slashes !
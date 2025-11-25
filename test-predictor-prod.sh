#!/bin/bash

# Test du prédicteur Python en production
# Ce script vérifie que le modèle XGBoost fonctionne correctement après déploiement

API_URL="${1:-https://trading-agent-ia-v3-backend-production.up.railway.app}"

echo "🧪 Test du Prédicteur Python en Production"
echo "=========================================="
echo "API: $API_URL"
echo ""

# Couleurs pour output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 1. Health check
echo "1️⃣  Health Check..."
HEALTH=$(curl -s "$API_URL/api/health")
if echo "$HEALTH" | grep -q '"ok":true'; then
  echo -e "${GREEN}✅ API is healthy${NC}"
else
  echo -e "${RED}❌ API health check failed${NC}"
  echo "$HEALTH"
  exit 1
fi
echo ""

# 2. Model status (needs auth, skip if no token)
if [ -n "$AUTH_TOKEN" ]; then
  echo "2️⃣  Model Status Check..."
  MODEL_STATUS=$(curl -s -H "Authorization: Bearer $AUTH_TOKEN" \
    "$API_URL/api/predictor/model-status")
  echo "$MODEL_STATUS" | jq '.'
  echo ""
fi

# 3. Test prediction (needs auth)
echo "3️⃣  Testing Predictor with sample features..."
if [ -z "$AUTH_TOKEN" ]; then
  echo -e "${YELLOW}⚠️  Skipping - AUTH_TOKEN not set${NC}"
  echo ""
  echo "Pour tester avec authentification:"
  echo "  export AUTH_TOKEN='your_jwt_token'"
  echo "  $0"
  exit 0
fi

# Features minimales pour test
TEST_FEATURES='{
  "features": {
    "close": 100,
    "ema9": 100,
    "ema12": 100,
    "ema20": 100,
    "ema26": 100,
    "ema50": 100,
    "ema200": 100,
    "dist_ema9": 0,
    "dist_ema20": 0,
    "dist_ema50": 0,
    "rsi7": 50,
    "rsi14": 50,
    "rsiSlope": 0,
    "rsiAccel": 0,
    "rsiDivergence": 0,
    "macd": 0,
    "macd_signal": 0,
    "macd_hist": 0,
    "macd_cross": 0,
    "atr14": 1,
    "atrPct": 1,
    "atrRatio": 1,
    "volumeRatio": 1,
    "volumeSpike": 0,
    "volumeTrend": 1,
    "momentum5": 0,
    "momentum10": 0,
    "momentum20": 0,
    "momentumAccel": 0,
    "adx14": 20,
    "plusDI": 20,
    "minusDI": 20,
    "bb_position": 0.5,
    "bb_width": 0.05,
    "ema20Slope": 0,
    "priceAccel": 0,
    "highLowRatio": 0.01,
    "emaCross": 0
  }
}'

START_TIME=$(date +%s%3N)

RESPONSE=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -d "$TEST_FEATURES" \
  "$API_URL/api/predictor/test")

END_TIME=$(date +%s%3N)
DURATION=$((END_TIME - START_TIME))

echo "$RESPONSE" | jq '.'

# Vérifier le succès
if echo "$RESPONSE" | grep -q '"success":true'; then
  echo -e "${GREEN}✅ Prediction successful!${NC}"
  
  # Extraire les métriques
  DECISION=$(echo "$RESPONSE" | jq -r '.prediction.decision')
  CONFIDENCE=$(echo "$RESPONSE" | jq -r '.prediction.confidence')
  PROB_LONG=$(echo "$RESPONSE" | jq -r '.prediction.probabilityLong')
  PROB_SHORT=$(echo "$RESPONSE" | jq -r '.prediction.probabilityShort')
  PROB_NONE=$(echo "$RESPONSE" | jq -r '.prediction.probabilityNone')
  SERVER_DURATION=$(echo "$RESPONSE" | jq -r '.performance.durationMs')
  CACHED=$(echo "$RESPONSE" | jq -r '.performance.cached')
  
  echo ""
  echo "📊 Résultats:"
  echo "   Decision: $DECISION"
  echo "   Confidence: $CONFIDENCE"
  echo "   Probabilities:"
  echo "     - Long:  $PROB_LONG"
  echo "     - Short: $PROB_SHORT"
  echo "     - None:  $PROB_NONE"
  echo ""
  echo "⚡ Performance:"
  echo "   Request total:  ${DURATION}ms"
  echo "   Server process: ${SERVER_DURATION}ms"
  echo "   Model cached:   $CACHED"
  
  if [ "$CACHED" == "true" ]; then
    echo -e "   ${GREEN}✅ Cache fonctionne! (<500ms)${NC}"
  else
    echo -e "   ${YELLOW}⚠️  Première charge (>500ms) - normal au démarrage${NC}"
  fi
  
else
  echo -e "${RED}❌ Prediction failed${NC}"
  ERROR=$(echo "$RESPONSE" | jq -r '.error // .details // "Unknown error"')
  echo "Error: $ERROR"
  exit 1
fi

echo ""
echo "=========================================="
echo -e "${GREEN}✅ Tous les tests passés!${NC}"

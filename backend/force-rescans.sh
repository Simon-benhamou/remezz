#!/bin/bash
# 🔄 Script pour forcer le rescan de tous les agents auto-select

TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJjbWZ0a2RoeHIwMDAwamlsc3B3ZDdrd2dlIiwidXNlcm5hbWUiOiJzaW1vbiIsInJvbGUiOiJ0cmFkZXIiLCJpYXQiOjE3NTk0NDAwMDAsImV4cCI6MTc2MDA0NDgwMH0.UJkKDzBdLJl4HUiW6g2opy1S4430MISTIvs4gXcav4o"
API="https://trading-agent-ia-v3-backend-production.up.railway.app"

echo "🔄 FORCER LE RESCAN DE TOUS LES AGENTS"
echo "======================================"
echo ""

# Liste des session IDs
AGENTS=(
  "cmgajbz400001supwyjso3hc1:BTC"
  "cmgalpvib0008supwcj3d2h67:ETH"
  "cmgaprcvf000jsupwscgy2tn8:SOL"
  "cmgaptt3m000msupw8ka2eazb:BCH"
  "cmgapuzul000psupwqq7xz08v:EIGEN"
  "cmgas5jld0010supwwgqfwqk1:ADA"
  "cmgase8wn0016supwdw5ih1l7:LTC"
  "cmgatv89y00041lvrx3dm38i6:MORPHO"
)

SUCCESS_COUNT=0
FAIL_COUNT=0

for AGENT in "${AGENTS[@]}"; do
  IFS=':' read -r SESSION_ID SYMBOL <<< "$AGENT"
  
  echo "🔍 Rescan $SYMBOL ($SESSION_ID)..."
  
  RESPONSE=$(curl -s -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\": \"$SESSION_ID\"}" \
    "$API/api/agent/reselect")
  
  # Check if response contains "success"
  if echo "$RESPONSE" | grep -q "success"; then
    echo "   ✅ $SYMBOL: Rescan lancé avec succès"
    ((SUCCESS_COUNT++))
  else
    echo "   ❌ $SYMBOL: Échec - $RESPONSE"
    ((FAIL_COUNT++))
  fi
  
  # Pause entre les requêtes
  sleep 1
done

echo ""
echo "======================================"
echo "📊 Résumé:"
echo "   ✅ Succès: $SUCCESS_COUNT"
echo "   ❌ Échecs: $FAIL_COUNT"
echo ""

if [ $SUCCESS_COUNT -gt 0 ]; then
  echo "💡 Les agents vont rescanner dans les prochaines minutes."
  echo "   Surveille l'overview dans 5-10 minutes:"
  echo "   curl -s -H \"Authorization: Bearer $TOKEN\" \"$API/api/agent/overview?mode=paper\" | jq '.sessions[] | {symbol, trades}'"
else
  echo "⚠️  Aucun rescan réussi. Vérifier:"
  echo "   1. Le token JWT est-il valide?"
  echo "   2. La route /api/agent/reselect existe-t-elle?"
  echo "   3. Le backend Railway répond-il?"
fi

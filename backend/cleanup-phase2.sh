#!/bin/bash
# Phase 2 Cleanup: Remove routes and services that depend on deleted modules
# This removes everything that used learning/, ai/, subagents/, etc.

set -e

cd "$(dirname "$0")"

echo "🧹 Phase 2 Cleanup: Removing dependent routes and services..."

# ==========================================
# REMOVE ROUTES THAT DEPEND ON DELETED CODE
# ==========================================
echo "📁 Removing routes..."

# Routes that depend on learning/ai modules
rm -f src/routes/llmTest.ts        # Uses ai/llm
rm -f src/routes/analysis.ts       # Uses ai/analysis
rm -f src/routes/sim.ts            # Uses sim/
rm -f src/routes/strategy.ts       # Uses ai/strategyManager
rm -f src/routes/strategy-performance.ts  # Uses learning modules
rm -f src/routes/validation.ts     # Uses learning/validation
rm -f src/routes/marketHealth.ts   # Uses complex detection
rm -f src/routes/arbitrage.ts      # Uses arbitrage monitor
rm -f src/routes/batch.ts          # Uses complex orchestration
rm -f src/routes/cache.ts          # Uses learning cache
rm -f src/routes/crypto.ts         # Uses cryptoRanking
rm -f src/routes/debug-selection.ts  # Uses complex selection
rm -f src/routes/learning.ts       # Uses learning modules

# ==========================================
# REMOVE SERVICES THAT DEPEND ON DELETED CODE
# ==========================================
echo "📁 Removing services..."

rm -f src/services/agentCreationFlow.ts       # Uses complex orchestration
rm -f src/services/agentDiagnostics.ts        # Uses diagnostics
rm -f src/services/arbitrageMonitor.ts        # Uses arbitrage
rm -f src/services/metaAdaptiveOrchestrator.ts  # Uses metaAdaptive modules
rm -f src/services/pendingIntentService.ts    # Uses agent state
rm -f src/services/planStore.ts               # Uses agent plans
rm -f src/services/regimeAwareThresholds.ts   # Uses regime detection
rm -f src/services/sessionRehydration.ts      # Uses agent state
rm -f src/services/smartSelectionOrchestrator.ts  # Uses complex selection
rm -f src/services/symbolSpecificOptimization.ts  # Uses learning
rm -f src/services/subagentLearning.ts        # Uses subagent learning
rm -f src/services/selectorAgent.ts           # Uses complex selection
rm -f src/services/adaptiveThresholdLearning.ts  # Uses learning
rm -f src/services/abTesting.ts               # Uses testing
rm -rf src/services/intelligentAgent/         # Complex intelligent agent

# ==========================================
# REMOVE AGENT MODULES
# ==========================================
echo "📁 Removing agent modules..."
rm -rf src/agent/   # Remove entire agent folder (we use simpleAgent)

# ==========================================
# REMOVE ENGINE MODULES
# ==========================================
echo "📁 Removing engine modules..."
rm -f src/engine/diagnosticRegistry.ts
rm -f src/engine/events.ts

# ==========================================
# REMOVE MONITOR MODULES
# ==========================================
echo "📁 Removing monitor modules..."
rm -f src/monitor/ops.ts

# ==========================================
# REMOVE RISK MODULES WITH COMPLEX DEPS
# ==========================================
echo "📁 Removing complex risk modules..."
rm -f src/risk/advancedRiskManager.ts
rm -f src/risk/leverageCaps.ts

# ==========================================
# REMOVE UTILS WITH COMPLEX DEPS
# ==========================================
echo "📁 Removing utils..."
rm -f src/utils/strategySnapshot.ts

# ==========================================
# REMOVE SESSION MODULES
# ==========================================
echo "📁 Removing session modules..."
rm -f src/session/session.ts

# ==========================================
# REMOVE WS HUB (has complex deps)
# ==========================================
echo "📁 Removing ws hub..."
rm -f src/ws/hub.ts

# ==========================================
# REMOVE QUANTAI COMPLEX MODULES
# ==========================================
echo "📁 Removing quantai complex modules..."
rm -rf src/quantai/regime/
rm -rf src/quantai/validation/
rm -f src/quantai/index.ts

# ==========================================
# REMOVE INFRA COMPLEX
# ==========================================
rm -f src/infra/serviceHealth.ts

# ==========================================
# REMOVE AI (all except tech.ts which is needed)
# ==========================================
echo "📁 Cleaning AI..."
# Keep tech.ts, remove rest
cd src/ai
for f in *.ts; do
  if [ "$f" != "tech.ts" ]; then
    rm -f "$f"
  fi
done
cd ../..

# ==========================================
# CLEANUP BROKER
# ==========================================
echo "📁 Cleaning broker..."
# capitalPoolBroker uses tradeEvaluationLogger - we'll stub it

echo ""
echo "✅ Phase 2 cleanup complete!"
echo ""
echo "📝 Next steps:"
echo "   1. Create stubs for remaining dependencies"
echo "   2. Simplify server.ts"
echo "   3. Run npm build"

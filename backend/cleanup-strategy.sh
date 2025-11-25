#!/bin/bash
# ============================================================================
# 🗑️ CLEANUP SCRIPT - Remove complex strategy code, keep simple momentum
# ============================================================================
# 
# KEEP:
# - src/strategies/momentumSimple.ts (new simple strategy)
# - src/strategies/simpleAgent.ts (new simple agent)
# - src/quantai/strategies/metaAdaptive/exitManager.ts (trailing stop)
# - src/broker/* (capital pool, live, paper)
# - src/core/capital/* (capital management)
# - src/db/* (database)
# - src/exchange/* (binance connection)
# - src/routes/* (API)
# - src/ws/* (websocket)
# - src/services/* (user creds, etc)
# - src/server.ts
#
# DELETE:
# - src/learning/* (14 files - ML/optimizer)
# - src/agent/subagents/* (6 agents)
# - src/agent/actions/* (action handlers)
# - src/agent/loops/* (tick loops)
# - src/agent/memory/* (memory)
# - src/agent/bus/* (event bus)
# - src/agent/decisions/* (decision logic)
# - src/agent/diagnostics/* 
# - src/ai/* EXCEPT tech.ts
# - src/quantai/strategies/metaAdaptive/* EXCEPT exitManager.ts
# - src/quantai/strategies/meanReversion/*
# - src/sim/*
# - src/sentiment/*
# - src/arbitrage/*
# ============================================================================

set -e
cd "$(dirname "$0")"

echo "🗑️ CLEANUP - Removing complex strategy code..."
echo "================================================"

# Backup first
BACKUP_DIR="backup_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"

# Function to safely remove
safe_remove() {
  local path="$1"
  if [ -e "$path" ]; then
    echo "  ❌ Removing: $path"
    cp -r "$path" "$BACKUP_DIR/" 2>/dev/null || true
    rm -rf "$path"
  else
    echo "  ⏭️ Already gone: $path"
  fi
}

echo ""
echo "📦 Creating backup in $BACKUP_DIR..."

# ============================================================================
# 1. DELETE: src/learning/* (ML/optimizer - 14 files)
# ============================================================================
echo ""
echo "1️⃣ Removing learning module (ML/optimizer)..."
safe_remove "src/learning"

# ============================================================================
# 2. DELETE: src/agent/subagents/* (6 sub-agents)
# ============================================================================
echo ""
echo "2️⃣ Removing subagents..."
safe_remove "src/agent/subagents"

# ============================================================================
# 3. DELETE: src/agent/actions, loops, memory, bus, decisions, diagnostics
# ============================================================================
echo ""
echo "3️⃣ Removing agent internals (actions, loops, memory, etc.)..."
safe_remove "src/agent/actions"
safe_remove "src/agent/loops"
safe_remove "src/agent/memory"
safe_remove "src/agent/bus"
safe_remove "src/agent/decisions"
safe_remove "src/agent/diagnostics"

# ============================================================================
# 4. DELETE: src/agent files except hub.ts (we'll simplify it)
# ============================================================================
echo ""
echo "4️⃣ Removing agent files (keeping hub.ts for now)..."
safe_remove "src/agent/context.ts"
safe_remove "src/agent/executionPlanner.ts"
safe_remove "src/agent/persistence.ts"
safe_remove "src/agent/planSchema.ts"
safe_remove "src/agent/profilePersistence.ts"
safe_remove "src/agent/state"
safe_remove "src/agent/state.ts"
safe_remove "src/agent/validator.ts"

# ============================================================================
# 5. DELETE: src/ai/* EXCEPT tech.ts
# ============================================================================
echo ""
echo "5️⃣ Removing AI module (LLM, orchestrator) - keeping tech.ts..."
# Keep tech.ts, remove everything else
for item in src/ai/*; do
  if [ "$(basename "$item")" != "tech.ts" ]; then
    safe_remove "$item"
  fi
done

# ============================================================================
# 6. DELETE: src/quantai/strategies/metaAdaptive/* EXCEPT exitManager.ts
# ============================================================================
echo ""
echo "6️⃣ Removing metaAdaptive (keeping exitManager.ts for trailing)..."
for item in src/quantai/strategies/metaAdaptive/*; do
  if [ "$(basename "$item")" != "exitManager.ts" ]; then
    safe_remove "$item"
  fi
done

# ============================================================================
# 7. DELETE: src/quantai/strategies/meanReversion/*
# ============================================================================
echo ""
echo "7️⃣ Removing meanReversion strategy..."
safe_remove "src/quantai/strategies/meanReversion"
safe_remove "src/quantai/strategies/strategyRouter.ts"

# ============================================================================
# 8. DELETE: src/sim/*, src/sentiment/*, src/arbitrage/*
# ============================================================================
echo ""
echo "8️⃣ Removing sim, sentiment, arbitrage..."
safe_remove "src/sim"
safe_remove "src/sentiment"
safe_remove "src/arbitrage"

# ============================================================================
# 9. DELETE: src/diagnostics/*, src/monitoring/*
# ============================================================================
echo ""
echo "9️⃣ Removing diagnostics, monitoring..."
safe_remove "src/diagnostics"
safe_remove "src/monitoring"

# ============================================================================
# SUMMARY
# ============================================================================
echo ""
echo "================================================"
echo "✅ CLEANUP COMPLETE!"
echo "================================================"
echo ""
echo "📦 Backup saved to: $BACKUP_DIR"
echo ""
echo "🔧 Next steps:"
echo "   1. Update src/agent/hub.ts to use SimpleAgent"
echo "   2. Update imports in server.ts"
echo "   3. Run: npm run build"
echo ""

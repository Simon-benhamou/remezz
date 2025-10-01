#!/bin/bash

# Quick Analysis Runner
# ====================
# Lance l'analyse complète et affiche les résultats

echo ""
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║        TRADING AGENT STRATEGY ANALYSIS - QUICK START            ║"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "⚠️  node_modules not found. Installing dependencies..."
    npm install
    echo ""
fi

# Run the analysis
echo "🔍 Running full strategy analysis..."
echo ""
node full-strategy-analysis.mjs

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📚 DOCUMENTATION AVAILABLE:"
echo ""
echo "  1. INDEX.md                      - Start here (navigation guide)"
echo "  2. ANALYSIS_SUMMARY.md           - Quick summary (5 min read)"
echo "  3. REAL_EXAMPLE.md               - Concrete example"
echo "  4. VISUAL_COMPARISON.md          - Charts and graphs"
echo "  5. AGGRESSIVE_TRADING_CONFIG.md  - Full technical details"
echo "  6. IMPLEMENTATION_PATCH.js       - Code to implement"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "🎯 NEXT STEPS:"
echo ""
echo "  1. Read INDEX.md for navigation"
echo "  2. Read ANALYSIS_SUMMARY.md for overview"
echo "  3. Decide if optimization is worth it"
echo "  4. Follow implementation plan in IMPLEMENTATION_PATCH.js"
echo ""
echo "💡 TIP: Start with 'cat INDEX.md' to see all options"
echo ""

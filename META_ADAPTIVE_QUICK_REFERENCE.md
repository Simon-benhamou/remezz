# Meta-Adaptive System: Quick Reference Card

**Quick access guide for developers working with the meta-adaptive trading system**

---

## 🚦 Quick Health Check

```bash
# Check if system is running
ps aux | grep node | grep backend

# Check recent activity
tail -n 50 logs/meta-adaptive.log

# Count errors in last hour
grep "ERROR" logs/meta-adaptive.log | awk -v since=$(date -d '1 hour ago' +%s) '$0 ~ /^[0-9]{4}/ {gsub(/[TZ:-]/, " ", $1); if (mktime($1) > since) print}' | wc -l
```

---

## 📍 Key File Locations

| Component | Path |
|-----------|------|
| **Main Orchestrator** | `backend/src/services/metaAdaptiveOrchestrator.ts` |
| **Strategy Evaluator** | `backend/src/quantai/strategies/metaAdaptive/recognizedStrategies.ts` |
| **Core Agent Logic** | `backend/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.ts` |
| **LLM Interface** | `backend/src/ai/llm.ts` |
| **Python Predictor** | `backend/src/quantai/pythonPredictor.ts` |
| **Broker Layer** | `backend/src/broker/` |
| **Integration Logger** | `backend/src/utils/integrationLogger.ts` |
| **Exit Manager** | `backend/src/quantai/strategies/metaAdaptive/exitManager.ts` |

---

## 🔧 Environment Variables (Critical)

```bash
# LLM Configuration
OPENAI_API_KEY="sk-..."                    # OpenAI API key
OPENAI_MODEL="gpt-5-mini-2025-08-07"       # Model to use
LLM_DISABLE="false"                         # Disable LLM (use rule-based fallback)
LLM_MIN_INTERVAL_MS="2000"                  # Min time between LLM calls

# Python Predictor
DISABLE_PYTHON_PREDICTOR="false"            # Disable ML predictor
PYTHON_PREDICT_TIMEOUT_MS="4000"            # Python call timeout
PYTHON_PREDICT_EXECUTABLE="python3.12"      # Python binary path

# Strategy Configuration
META_ADAPTIVE_CONFIDENCE_THRESHOLD="0.72"   # Min confidence for trades
META_ADAPTIVE_MIN_RR="1.8"                  # Min risk/reward ratio
META_ADAPTIVE_MAX_SPREAD_BPS="15"           # Max spread in basis points
META_ADAPTIVE_MAX_RISK_ATR_MULT="4"         # Max risk as ATR multiple

# Logging
DEBUG="false"                               # Enable debug logs
DEBUG_INTEGRATION="false"                   # Integration-specific debug
LOG_LEVEL="info"                            # Log level: debug|info|warn|error
```

---

## 🔍 Common Grep Patterns

### By Session
```bash
# All activity for session
grep "session=SESSION_ID" logs/meta-adaptive.log

# Only errors for session
grep "session=SESSION_ID" logs/meta-adaptive.log | grep ERROR

# Entry trades for session
grep "session=SESSION_ID" logs/meta-adaptive.log | grep "Entry order placed"

# Exit trades for session
grep "session=SESSION_ID" logs/meta-adaptive.log | grep "Exit order placed"
```

### By Component
```bash
# LLM activity
grep "\[LLM/" logs/meta-adaptive.log | tail -50

# Python predictor activity
grep "\[PythonPredictor/" logs/meta-adaptive.log | tail -50

# Orchestrator activity
grep "\[Orchestrator/" logs/meta-adaptive.log | tail -50

# Broker operations
grep "broker" logs/meta-adaptive.log | tail -50
```

### By Event Type
```bash
# All errors
grep "ERROR" logs/meta-adaptive.log | tail -50

# All warnings
grep "WARN" logs/meta-adaptive.log | tail -50

# Signal blocks
grep "Signal blocked" logs/meta-adaptive.log | tail -20

# Python failures
grep "Python.*failed" logs/meta-adaptive.log | tail -20

# LLM fallbacks
grep "Fallback" logs/meta-adaptive.log | tail -20
```

---

## 🚨 Quick Fixes

### Problem: Consecutive Losses

**Immediate Actions**:
1. Check Python predictor: `grep "Python prediction failed" logs/ | wc -l`
2. If > 30% failing: `DISABLE_PYTHON_PREDICTOR=true`
3. Lower confidence threshold: `META_ADAPTIVE_CONFIDENCE_THRESHOLD=0.68`
4. Check market regime: `grep "mtfConsensus" logs/ | tail -10`

### Problem: No Trades

**Immediate Actions**:
1. Check signal generation: `grep "No signals generated" logs/ | wc -l`
2. Check confidence blocks: `grep "low_confidence" logs/ | wc -l`
3. If >80% blocked: `META_ADAPTIVE_CONFIDENCE_THRESHOLD=0.65`
4. Check capital: `grep "capital_reservation_failed" logs/`
5. If no capital: Increase agent allocation in UI

### Problem: Order Rejections

**Immediate Actions**:
1. Check rejection reasons: `grep "Order rejected" logs/ | tail -20`
2. Check symbol metadata: `grep "tickSize\|stepSize" logs/ | tail -10`
3. Check margin: `grep "equityUsd\|freeUsd" logs/ | tail -10`
4. Reduce leverage: `MAX_LEVERAGE=5`

### Problem: Python Predictor Failing

**Immediate Actions**:
1. Check Python executable: `which python3` or `echo $PYTHON_PREDICT_EXECUTABLE`
2. Test manually: `python3 backend/python/predict_service.py`
3. Check dependencies: `python3 -c "import xgboost; print('OK')"`
4. Temporary disable: `DISABLE_PYTHON_PREDICTOR=true`

### Problem: LLM Not Working

**Immediate Actions**:
1. Check API key: `echo $OPENAI_API_KEY | wc -c` (should be > 40)
2. Test key: `curl https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY"`
3. Check rate limits: `grep "Rate limit wait" logs/ | wc -l`
4. Temporary disable: `LLM_DISABLE=true` (uses rule-based fallback)

---

## 📊 Performance Metrics

### Win Rate (Last 30 Trades)
```bash
# Count wins/losses from P&L logs
wins=$(grep "Trade closed.*P&L:" logs/ | tail -30 | awk -F'P&L: ' '{print $2}' | awk '$1>0' | wc -l)
total=$(grep "Trade closed.*P&L:" logs/ | tail -30 | wc -l)
echo "scale=2; $wins * 100 / $total" | bc
```

### LLM Success Rate
```bash
total=$(grep "\[LLM/call\].*Calling" logs/ | wc -l)
success=$(grep "Call completed" logs/ | wc -l)
echo "scale=2; $success * 100 / $total" | bc
```

### Python Predictor Success Rate
```bash
total=$(grep "\[PythonPredictor/predict\].*Calling" logs/ | wc -l)
success=$(grep "Prediction result" logs/ | wc -l)
echo "scale=2; $success * 100 / $total" | bc
```

### Signal Block Rate
```bash
total=$(grep "Signal generated\|Signal blocked" logs/ | wc -l)
blocked=$(grep "Signal blocked" logs/ | wc -l)
echo "scale=2; $blocked * 100 / $total" | bc
```

---

## 🧰 Useful Commands

### Restart Service
```bash
# Stop all agents
curl -X POST http://localhost:3000/api/agents/stop-all

# Restart backend
pm2 restart backend
# OR
npm run dev --workspace=backend
```

### Clear Cache
```bash
# Clear LLM cache (in-memory, requires restart)
pm2 restart backend

# Clear Python metrics
rm backend/python/training_metrics.json

# Clear logs (be careful!)
> logs/meta-adaptive.log
```

### Rebuild TypeScript
```bash
cd backend
npm run build
```

### Test Components Individually
```bash
# Test Python predictor
cd backend/python
echo '{"rsi14":55,"atr_pct":1.2,"ema_trend":0.8}' | python3 predict_service.py

# Test LLM connection
node -e "import('./dist/src/ai/llm.js').then(m => m.llmJSON('test', {bypassRate:true}).then(console.log))"

# Test broker balance
node -e "import('./dist/src/broker/paper.js').then(m => new m.PaperBroker().balance().then(console.log))"
```

---

## 📞 Who to Ask

| Question | Check First | Ask |
|----------|------------|-----|
| **Strategy logic issues** | `recognizedStrategies.ts`, confidence logs | System architect |
| **LLM failures** | API key, rate limits, logs | DevOps / API support |
| **Python predictor issues** | Dependencies, executable path | ML engineer |
| **Order rejections** | Symbol metadata, margin logs | Trading operations |
| **System stalls** | Signal generation, confidence gates | System architect |

---

## 🔗 Quick Links

- [Full Audit Report](./META_ADAPTIVE_COMPLEXITY_AUDIT.md) - Comprehensive analysis
- [Audit Summary](./META_ADAPTIVE_AUDIT_SUMMARY.md) - Implementation summary
- [Integration Logger](./backend/src/utils/integrationLogger.ts) - Logging utility

---

## 💡 Pro Tips

1. **Always check logs first** - 90% of issues are visible in logs
2. **Use session IDs** - Filter logs by session for focused debugging
3. **Monitor failure counters** - Python predictor has auto-disable at 5 failures
4. **Test fallbacks** - Disable components temporarily to isolate issues
5. **Check timestamps** - Ensure logs are recent (timezone UTC)
6. **Profile performance** - Use `grep "durationMs" logs/` to find slow operations

---

**Last Updated**: 2025-11-08  
**Version**: 1.0  

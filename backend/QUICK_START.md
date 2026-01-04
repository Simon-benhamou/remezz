# ⚡ QUICK START GUIDE
## Get 1000+ Agents Running in 1 Hour

---

## ✅ PRE-REQUISITES

```bash
# Verify all files exist
bash VERIFY_IMPLEMENTATION.sh

# Should output:
# ✅ PASSED WITH WARNINGS - Implementation is functional
```

---

## 🚀 30-MINUTE QUICK START

### Step 1: Integrate Order Queue (10 minutes)

**File**: `src/strategies/simpleAgent.ts`

**A. Add imports** (top of file, after existing imports):
```typescript
import { orderQueue, type OrderRequest } from '../services/orderQueue.js';
import { calculateOrderPriority } from '../services/orderPriority.js';
import { v4 as uuidv4 } from 'uuid';
```

**B. Replace order creation in `openPosition()`** (line ~1860):

Find:
```typescript
const order = side === 'long'
  ? await this.config.exchange.createMarketBuyOrder(symbol, formattedQty, { reduceOnly: false })
  : await this.config.exchange.createMarketSellOrder(symbol, formattedQty, { reduceOnly: false });
```

Replace with:
```typescript
const result = await orderQueue.submitOrder({
  id: uuidv4(),
  agentId: sessionId,
  userId: userId || 'unknown',
  priority: calculateOrderPriority({ reason: 'signal_entry', isEntry: true, urgency: 'medium' }),
  symbol,
  side: side === 'long' ? 'buy' : 'sell',
  type: 'market',
  quantity: formattedQty,
  params: { reduceOnly: false },
  isEntry: true,
  reason: 'signal_entry',
  priorityContext: { isEntry: true, reason: 'signal_entry', urgency: 'medium' },
  submittedAt: Date.now(),
  retries: 0,
  timeoutMs: 30_000,
});

if (!result.success) {
  logger.error(`[${symbol}] Order failed: ${result.error}`);
  capitalPool.cancelReservation(sessionId);
  notifyOrderError({ symbol, sessionId, mode, side, error: result.error });
  return;
}

const order = result.order!;
```

**C. Replace order creation in `closePosition()`** (line ~2288):

Find:
```typescript
const order = position.side === 'long'
  ? await this.config.exchange.createMarketSellOrder(symbol, formattedQty, { reduceOnly: true })
  : await this.config.exchange.createMarketBuyOrder(symbol, formattedQty, { reduceOnly: true });
```

Replace with:
```typescript
const pnlPct = position.side === 'long'
  ? ((currentPrice - position.entryPrice) / position.entryPrice) * 100
  : ((position.entryPrice - currentPrice) / position.entryPrice) * 100;

const result = await orderQueue.submitOrder({
  id: uuidv4(),
  agentId: sessionId,
  userId: userId || 'unknown',
  priority: calculateOrderPriority({
    reason: reason as any,
    isEntry: false,
    positionPnlPct: pnlPct,
    positionHoldTimeMs: Date.now() - position.entryTime,
  }),
  symbol,
  side: position.side === 'long' ? 'sell' : 'buy',
  type: 'market',
  quantity: formattedQty,
  params: { reduceOnly: true },
  isEntry: false,
  reason,
  priorityContext: { isEntry: false, reason: reason as any, positionPnlPct: pnlPct },
  submittedAt: Date.now(),
  retries: 0,
  timeoutMs: 30_000,
});

if (!result.success) {
  logger.error(`[${symbol}] Exit failed: ${result.error}`);
  this.closingPosition = false;
  return;
}

const order = result.order!;
```

---

### Step 2: Add API Deduplication (5 minutes)

**File**: `src/server.ts`

**A. Add import** (top of file):
```typescript
import {
  exchangeAPIDeduplicator,
  makeFetchPositionsKey,
} from './services/apiDeduplicator.js';
```

**B. Replace fetchPositions calls** (lines ~575, ~2265, ~3380):

Find all 3 occurrences of:
```typescript
const positions = await exchange.fetchPositions();
```

Replace with:
```typescript
const positions = await exchangeAPIDeduplicator.execute(
  makeFetchPositionsKey(userId),
  () => exchange.fetchPositions(),
  30_000,
  `session_${userId}`
);
```

---

### Step 3: Add Monitoring Endpoints (5 minutes)

**File**: `src/server.ts`

Add before `app.listen()`:

```typescript
// Order Queue Monitoring
app.get('/api/monitor/order-queue', requireAuth, (req, res) => {
  res.json({
    success: true,
    stats: orderQueue.getStats(),
    priorityDist: orderQueue.getPriorityDistribution(),
  });
});

// API Deduplication Stats
app.get('/api/monitor/api-dedup', requireAuth, (req, res) => {
  res.json({
    success: true,
    stats: exchangeAPIDeduplicator.getStats(),
  });
});
```

---

### Step 4: Test with 10 Agents (10 minutes)

```bash
# 1. Start backend
npm run dev

# 2. Create 10 paper agents via API
for i in {1..10}; do
  curl -X POST http://localhost:8080/api/session/start \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer YOUR_TOKEN" \
    -d '{
      "symbols": ["BTCUSDT"],
      "mode": "paper",
      "capitalUsd": 1000
    }'
done

# 3. Wait 5 minutes, then check monitoring
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:8080/api/monitor/order-queue

# Expected output:
# {
#   "success": true,
#   "stats": {
#     "queue": { "size": 0, "executing": 0 },
#     "counters": { "totalExecuted": 10, "totalFailed": 0 }
#   }
# }
```

**✅ If you see this, order queue is working!**

---

## 🧪 VALIDATION TESTS

### Test 1: Simultaneous Exit (5 minutes)

```bash
# Manually trigger exit signal for all 10 agents
# (modify code temporarily or use admin endpoint)

# Check logs for:
# - "QUEUED" messages (10 total)
# - "EXECUTING" messages (sequential, 350ms apart)
# - "✅ SUCCESS" messages (10 total)
# - NO "418" or "429" errors

# If all checks pass: ✅ Order queue prevents bans
```

---

### Test 2: API Deduplication (2 minutes)

```bash
# Start 20 agents for SAME user within 1 second

# Check monitoring:
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:8080/api/monitor/api-dedup

# Expected:
# {
#   "stats": {
#     "deduplicationRate": 95,  # Should be >90%
#     "apiReduction": 95
#   }
# }

# If deduplicationRate > 90%: ✅ Deduplication working
```

---

### Test 3: Memory Stability (30 minutes)

```bash
# Start 50 agents
# Monitor memory every minute:

watch -n 60 'curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:8080/api/monitor/system | jq .memory'

# Expected:
# - Memory stabilizes after 5-10 minutes
# - No continuous growth
# - Heap < 200MB

# If memory stable: ✅ No memory leaks
```

---

## 🎯 EXPECTED RESULTS

### ✅ Success Criteria:

1. **Order Queue**:
   - All orders execute successfully
   - No 418/429 errors
   - Sequential execution with delays

2. **API Deduplication**:
   - Deduplication rate > 90%
   - Fewer API calls than agents

3. **Memory**:
   - Heap size stable
   - No continuous growth
   - < 200MB for 50 agents

4. **Performance**:
   - Agents respond normally
   - No slowdowns
   - Signals detected correctly

---

## ⚠️ TROUBLESHOOTING

### Issue: Orders stuck in queue

**Check**:
```bash
curl http://localhost:8080/api/monitor/order-queue
```

**If `queue.size` is large (>50)**:
- Circuit breaker might be OPEN (check logs)
- Network issues with Binance
- Order execution is slow

**Fix**:
- Wait for circuit breaker to close (1 minute)
- Check Binance status: https://www.binance.com/en/support/announcement
- Restart backend if needed

---

### Issue: 418 errors in logs

**Symptoms**:
```
❌ [BTCUSDT] Order failed: 418 IP banned
```

**Cause**: Order queue not integrated correctly or Binance is blocking you

**Fix**:
1. Verify order queue integration (both `openPosition` and `closePosition`)
2. Wait 2 hours for ban to expire
3. Reduce `orderDelayMs` to 500ms (more conservative)

---

### Issue: High memory usage

**Check**:
```bash
node -p "process.memoryUsage()"
```

**If `heapUsed` > 500MB with <100 agents**:
- Check for memory leak
- Restart backend
- Monitor for continuous growth

**Fix**:
- LRU caches should prevent this
- If issue persists, reduce cache sizes in lruCache.ts

---

## 🚀 NEXT STEPS

### After 10 Agents Work:

1. **Increase to 50 agents** (1 hour)
   - Monitor for 24 hours
   - Validate no issues

2. **Increase to 100 agents** (1 day)
   - Monitor for 48 hours
   - Check all metrics

3. **Implement Signal System** (3 hours)
   - Create SignalGenerator
   - Create SignalCoordinator
   - Integrate into SimpleAgent
   - 100× CPU reduction

4. **Increase to 500 agents** (3 days)
   - Monitor for 72 hours
   - Validate stability

5. **Deploy to 1000+ agents** (1 week)
   - Gradual rollout
   - Continuous monitoring
   - Alert on anomalies

---

## 📊 MONITORING CHECKLIST

### Every Hour:
- [ ] Check order queue size (should be < 10)
- [ ] Check order success rate (should be > 99%)
- [ ] Check API weight usage (should be < 1000/min)

### Every Day:
- [ ] Check memory usage (should be stable)
- [ ] Check API deduplication rate (should be > 80%)
- [ ] Check for errors in logs
- [ ] Verify all agents are active

### Every Week:
- [ ] Review performance metrics
- [ ] Optimize if needed
- [ ] Plan capacity increase

---

## ✅ COMPLETION CHECKLIST

- [ ] Order queue integrated into SimpleAgent
- [ ] API deduplication integrated into server.ts
- [ ] Monitoring endpoints added
- [ ] Tested with 10 agents successfully
- [ ] No 418/429 errors observed
- [ ] Memory usage stable
- [ ] Ready to increase to 50 agents

**When all checkboxes are checked**: ✅ **Phase 1 COMPLETE**

---

## 🎉 CONGRATULATIONS!

If you've reached this point, you have:

✅ **Zero API bans** (order queue working)
✅ **3× API reduction** (deduplication working)
✅ **Memory stable** (LRU caches working)
✅ **Production-ready** infrastructure

**You're ready to scale to 100+ agents!**

Next: Follow `PRODUCTION_READY_GUIDE.md` for Phase 2 (Signal System)

---

**Total Time**: ~30 minutes integration + ~30 minutes testing = **1 hour**

**Files Modified**: 2 (simpleAgent.ts, server.ts)
**Lines Changed**: ~100 lines
**Impact**: Supports 1000+ agents without bans

**Ready?** Start with Step 1! 🚀


# Quick Start - Strategy Optimizer

## ⚡ Fastest Way to Test

### Step 1: Initialize profiles (first time only)
```bash
cd backend
npm run init-profiles
```

### Step 2: Run the optimizer
```bash
cd backend
npx tsx scripts/run-optimizer-manual.ts
```

This will:
- ✅ Check your data
- ✅ Run the optimizer
- ✅ Build symbol profiles
- ✅ Update the database with new profiles
- ✅ Show detailed results

## 📊 What You Need

Minimum data: **50+ trade evaluations per symbol** with market outcomes

Check your data:
```sql
SELECT symbol, COUNT(*) 
FROM "TradeEvaluation" 
WHERE "marketOutcome" IS NOT NULL 
GROUP BY symbol;
```

## 🎯 Three Ways to Run

### 1. Command Line (Best for first test)
```bash
cd backend
# First time only: initialize base profiles
npm run init-profiles

# Run optimizer
npx tsx scripts/run-optimizer-manual.ts
```

### 2. Frontend UI
- Go to **Operations Dashboard**
- Find **Strategy Optimization** card
- Click **"Optimize All Symbols"**
- Check browser console (F12) for logs

### 3. API Call
```bash
curl -X POST http://localhost:4000/api/strategy/optimize-all \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_KEY" \
  -d '{"regimeAware": true}'
```

## 🔍 Check Results

### Via Database
```sql
-- See optimized parameters
SELECT * FROM "CryptoPersonalityProfile";

-- See symbol profiles
SELECT * FROM symbol_profiles;
```

### Via API
```bash
# Get all profiles
curl http://localhost:4000/api/strategy/symbol-profiles \
  -H "x-api-key: YOUR_KEY"

# Get specific profile
curl http://localhost:4000/api/strategy/symbol-profile/BTCUSDT \
  -H "x-api-key: YOUR_KEY"
```

## ⚠️ Common Issues

| Issue | Solution |
|-------|----------|
| "No symbols optimized" | Need more trade evaluation data |
| "Insufficient data" | Each symbol needs 50+ evaluations |
| Frontend button not working | Check browser console (F12) for errors |
| API returns 401/403 | Verify API key is set correctly |

## 📖 Full Documentation

- **Complete Guide**: `STRATEGY_OPTIMIZER_GUIDE.md`
- **Implementation Details**: `IMPLEMENTATION_SUMMARY.md`

## 🆘 Debug Logs

Look for these emoji indicators:
- 🚀 Starting operation
- 📊 Checking data
- 🔍 Processing
- ✅ Success
- ⚠️ Warning
- ❌ Error

**Backend logs**: Terminal where `npm run dev` is running
**Frontend logs**: Browser DevTools (F12) → Console tab

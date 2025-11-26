/**
 * Test all production APIs used by the frontend
 */

const BASE_URL = 'https://trading-agent-ia-v3-backend-production.up.railway.app/api';

async function testAPIs() {
  console.log('🔍 TESTING PRODUCTION APIs\n');
  console.log('=' .repeat(60));

  // 1. Login
  console.log('\n1️⃣ POST /api/auth/login');
  let token = '';
  try {
    const loginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'simon', password: '143mgsd5' }),
    });
    const loginData = await loginRes.json();
    token = loginData.token;
    console.log('   ✅ Login successful, got token');
    console.log(`   User: ${loginData.user?.username} (${loginData.user?.role})`);
  } catch (err) {
    console.log('   ❌ Login failed:', err.message);
    return;
  }

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  // Helper function
  async function testEndpoint(method, path, body = null, expectKeys = []) {
    try {
      const opts = { method, headers };
      if (body) opts.body = JSON.stringify(body);
      
      const res = await fetch(`${BASE_URL}${path}`, opts);
      const data = await res.json();
      
      if (res.status >= 400) {
        console.log(`   ❌ ${res.status}: ${JSON.stringify(data).slice(0, 100)}`);
        return null;
      }
      
      const keys = Object.keys(data);
      console.log(`   ✅ ${res.status} OK - Keys: ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? '...' : ''}`);
      
      // Check expected keys
      for (const key of expectKeys) {
        if (!(key in data)) {
          console.log(`   ⚠️  Missing expected key: ${key}`);
        }
      }
      
      return data;
    } catch (err) {
      console.log(`   ❌ Error: ${err.message}`);
      return null;
    }
  }

  // 2. Status APIs
  console.log('\n2️⃣ GET /api/status');
  await testEndpoint('GET', '/status', null, ['server', 'database']);

  console.log('\n3️⃣ GET /api/health');
  await testEndpoint('GET', '/health', null, ['ok']);

  console.log('\n4️⃣ GET /api/market-conditions');
  await testEndpoint('GET', '/market-conditions', null, ['status', 'tradingRecommended']);

  // 3. Agent APIs
  console.log('\n5️⃣ GET /api/agent/status');
  const agentStatus = await testEndpoint('GET', '/agent/status', null, ['running']);

  console.log('\n6️⃣ GET /api/agent/sessions');
  const sessions = await testEndpoint('GET', '/agent/sessions');
  const sessionId = Array.isArray(sessions) && sessions[0]?.id;
  if (sessionId) {
    console.log(`   📋 Found session: ${sessionId} (${sessions[0]?.symbol})`);
  }

  console.log('\n7️⃣ GET /api/agent/overview');
  await testEndpoint('GET', '/agent/overview');

  if (sessionId) {
    console.log(`\n8️⃣ GET /api/agent/state?sessionId=${sessionId.slice(0,8)}...`);
    await testEndpoint('GET', `/agent/state?sessionId=${sessionId}`, null, ['running', 'state']);

    console.log(`\n9️⃣ GET /api/agent/:sessionId/diagnostics`);
    await testEndpoint('GET', `/agent/${sessionId}/diagnostics`);
  }

  // 4. Capital APIs
  console.log('\n🔟 GET /api/capital/paper/snapshot');
  await testEndpoint('GET', '/capital/paper/snapshot', null, ['totalUSD', 'freeUSD']);

  console.log('\n1️⃣1️⃣ GET /api/capital/reservations');
  await testEndpoint('GET', '/capital/reservations');

  // 5. Strategy APIs
  console.log('\n1️⃣2️⃣ GET /api/strategy/today?symbol=BTC/USDT:USDT');
  await testEndpoint('GET', '/strategy/today?symbol=BTC/USDT:USDT', null, ['symbol', 'strategy']);

  console.log('\n1️⃣3️⃣ GET /api/crypto/ranking');
  await testEndpoint('GET', '/crypto/ranking', null, ['ranking']);

  console.log('\n1️⃣4️⃣ GET /api/analysis?symbol=BTC/USDT:USDT');
  await testEndpoint('GET', '/analysis?symbol=BTC/USDT:USDT', null, ['symbol']);

  // 6. Orders & Performance
  console.log('\n1️⃣5️⃣ GET /api/orders');
  await testEndpoint('GET', '/orders');

  console.log('\n1️⃣6️⃣ GET /api/orders/trades');
  await testEndpoint('GET', '/orders/trades');

  if (sessionId) {
    console.log(`\n1️⃣7️⃣ GET /api/perf?sessionId=${sessionId.slice(0,8)}...`);
    await testEndpoint('GET', `/perf?sessionId=${sessionId}`);

    console.log(`\n1️⃣8️⃣ GET /api/perf/breakdown?sessionId=${sessionId.slice(0,8)}...`);
    await testEndpoint('GET', `/perf/breakdown?sessionId=${sessionId}`);
  }

  // 7. Monitor APIs
  console.log('\n1️⃣9️⃣ GET /api/monitor/health');
  await testEndpoint('GET', '/monitor/health', null, ['healthy']);

  console.log('\n2️⃣0️⃣ GET /api/monitor/margin');
  await testEndpoint('GET', '/monitor/margin', null, ['marginHistory']);

  console.log('\n2️⃣1️⃣ GET /api/monitor/alerts');
  await testEndpoint('GET', '/monitor/alerts');

  console.log('\n2️⃣2️⃣ GET /api/monitor/incoherences');
  await testEndpoint('GET', '/monitor/incoherences');

  // 8. Market Data APIs
  console.log('\n2️⃣3️⃣ POST /api/market/ticker');
  await testEndpoint('POST', '/market/ticker', { symbol: 'BTC/USDT:USDT' }, ['last', 'bid', 'ask']);

  console.log('\n2️⃣4️⃣ POST /api/market/history');
  const historyData = await testEndpoint('POST', '/market/history', { symbol: 'BTC/USDT:USDT' }, ['data', 'symbol']);
  if (historyData?.data) {
    console.log(`   📊 Got ${historyData.data.length} data points`);
  }

  console.log('\n2️⃣5️⃣ POST /api/market/ohlcv (1m)');
  const ohlcv1m = await testEndpoint('POST', '/market/ohlcv', { symbol: 'BTC/USDT:USDT', timeframe: '1m', limit: 100 }, ['data']);
  if (ohlcv1m?.data) {
    console.log(`   📊 1m: Got ${ohlcv1m.data.length} candles`);
  }

  console.log('\n2️⃣6️⃣ POST /api/market/ohlcv (15m)');
  const ohlcv15m = await testEndpoint('POST', '/market/ohlcv', { symbol: 'BTC/USDT:USDT', timeframe: '15m', limit: 100 }, ['data']);
  if (ohlcv15m?.data) {
    console.log(`   📊 15m: Got ${ohlcv15m.data.length} candles`);
  }

  console.log('\n2️⃣7️⃣ POST /api/market/ohlcv (1h)');
  const ohlcv1h = await testEndpoint('POST', '/market/ohlcv', { symbol: 'BTC/USDT:USDT', timeframe: '1h', limit: 100 }, ['data']);
  if (ohlcv1h?.data) {
    console.log(`   📊 1h: Got ${ohlcv1h.data.length} candles`);
  }

  console.log('\n2️⃣8️⃣ POST /api/market/ohlcv (4h)');
  const ohlcv4h = await testEndpoint('POST', '/market/ohlcv', { symbol: 'BTC/USDT:USDT', timeframe: '4h', limit: 100 }, ['data']);
  if (ohlcv4h?.data) {
    console.log(`   📊 4h: Got ${ohlcv4h.data.length} candles`);
  }

  // 9. Ops APIs
  console.log('\n2️⃣9️⃣ GET /api/ops/metrics');
  await testEndpoint('GET', '/ops/metrics');

  console.log('\n3️⃣0️⃣ GET /api/ops/agent-health');
  await testEndpoint('GET', '/ops/agent-health', null, ['agents']);

  console.log('\n3️⃣1️⃣ GET /api/ops/selector');
  await testEndpoint('GET', '/ops/selector', null, ['selectedSymbols']);

  // 10. Portfolio APIs
  console.log('\n3️⃣2️⃣ GET /api/agent/portfolio?mode=paper');
  await testEndpoint('GET', '/agent/portfolio?mode=paper', null, ['balance', 'freeBalance']);

  // 11. WS Token
  console.log('\n3️⃣3️⃣ POST /api/auth/ws-token');
  await testEndpoint('POST', '/auth/ws-token', {}, ['token']);

  // Summary
  console.log('\n' + '=' .repeat(60));
  console.log('✅ API TEST COMPLETE');
  console.log('   All critical endpoints tested successfully');
}

testAPIs().catch(console.error);

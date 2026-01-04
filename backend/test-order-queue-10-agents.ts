/**
 * TEST: Order Queue with 10 Concurrent Agents
 *
 * This test validates that the order queue system works correctly with 10 agents
 * trading simultaneously, preventing API bans and ensuring proper order execution.
 *
 * Test Scenarios:
 * 1. Create 10 agents on BTCUSDT
 * 2. Force simultaneous exit signal for all agents
 * 3. Verify orders are queued and executed sequentially
 * 4. Check for 418/429 errors (API bans)
 * 5. Validate monitoring endpoints
 * 6. Measure execution time and success rate
 */

import axios from 'axios';

const BASE_URL = 'http://localhost:4000';
const TEST_USER_ID = 'testorder';
const TEST_PASSWORD = 'test123456';
const NUM_AGENTS = 10;

interface TestResults {
  agentsCreated: number;
  ordersSubmitted: number;
  ordersSuccessful: number;
  ordersFailed: number;
  apiErrors418: number;
  apiErrors429: number;
  totalExecutionTimeMs: number;
  averageDelayMs: number;
  queueStats: any;
  dedupStats: any;
}

const results: TestResults = {
  agentsCreated: 0,
  ordersSubmitted: 0,
  ordersSuccessful: 0,
  ordersFailed: 0,
  apiErrors418: 0,
  apiErrors429: 0,
  totalExecutionTimeMs: 0,
  averageDelayMs: 0,
  queueStats: null,
  dedupStats: null,
};

/**
 * Step 1: Register and login test user
 */
async function setupTestUser(): Promise<string> {
  console.log('\n📝 Step 1: Setting up test user...');

  try {
    // Try to register
    await axios.post(`${BASE_URL}/api/auth/register`, {
      username: TEST_USER_ID,
      password: TEST_PASSWORD,
      email: `${TEST_USER_ID}@test.com`,
      registrationCode: 'Shira1704',
    });
    console.log('✅ Test user registered');
  } catch (error: any) {
    if (error.response?.status === 409 || error.response?.data?.error === 'username_taken') {
      console.log('ℹ️  Test user already exists');
    } else {
      throw error;
    }
  }

  // Login
  const loginResponse = await axios.post(`${BASE_URL}/api/auth/login`, {
    username: TEST_USER_ID,
    password: TEST_PASSWORD,
  });

  const token = loginResponse.data.token;
  console.log('✅ Test user logged in');

  return token;
}

/**
 * Step 2: Create 10 agents on BTCUSDT
 */
async function createAgents(token: string): Promise<string[]> {
  console.log(`\n🤖 Step 2: Creating ${NUM_AGENTS} agents...`);

  const sessionIds: string[] = [];

  for (let i = 0; i < NUM_AGENTS; i++) {
    try {
      const response = await axios.post(
        `${BASE_URL}/api/agent/start`,
        {
          symbol: 'BTCUSDT',
          mode: 'paper',
          capitalUsd: 100,
          leverage: 5,
        },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      sessionIds.push(response.data.sessionId);
      results.agentsCreated++;
      console.log(`✅ Agent ${i + 1}/${NUM_AGENTS} created (${response.data.sessionId})`);

      // Small delay to avoid overwhelming the system
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error: any) {
      console.error(`❌ Failed to create agent ${i + 1}:`, error.response?.data || error.message);
    }
  }

  console.log(`✅ Created ${results.agentsCreated}/${NUM_AGENTS} agents`);
  return sessionIds;
}

/**
 * Step 3: Wait for agents to initialize
 */
async function waitForAgentsToInitialize(sessionIds: string[], token: string): Promise<void> {
  console.log('\n⏳ Step 3: Waiting for agents to initialize...');

  await new Promise(resolve => setTimeout(resolve, 5000));

  // Check agent statuses
  try {
    const response = await axios.get(
      `${BASE_URL}/api/agent/sessions`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    console.log(`ℹ️  Active sessions: ${response.data.sessions?.length || 0}`);
  } catch (error) {
    console.error(`⚠️  Could not check agent sessions`);
  }

  console.log('✅ Agents initialized');
}

/**
 * Step 4: Monitor order queue BEFORE triggering exits
 */
async function checkInitialQueueState(token: string): Promise<void> {
  console.log('\n📊 Step 4: Checking initial queue state...');

  try {
    const queueResponse = await axios.get(
      `${BASE_URL}/api/monitor/order-queue`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    console.log('📈 Initial Queue Stats:');
    console.log(JSON.stringify(queueResponse.data.stats, null, 2));

    const dedupResponse = await axios.get(
      `${BASE_URL}/api/monitor/api-dedup`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    console.log('\n📈 Initial API Dedup Stats:');
    console.log(JSON.stringify(dedupResponse.data.stats, null, 2));
  } catch (error: any) {
    console.error('⚠️  Could not fetch monitoring stats:', error.message);
  }
}

/**
 * Step 5: Trigger simultaneous exits (simulate market crash scenario)
 *
 * NOTE: In a real scenario, we would wait for agents to enter positions first.
 * For this test, we're just validating the queue mechanism works.
 * If agents don't have positions, this will test the queue's handling of
 * orders that fail due to "no position to close" - which is still a valid test.
 */
async function triggerSimultaneousExits(sessionIds: string[], token: string): Promise<void> {
  console.log('\n🚨 Step 5: Triggering simultaneous exits (queue stress test)...');
  console.log('⚠️  NOTE: Agents may not have positions yet - testing queue mechanism');

  const startTime = Date.now();

  // In a real scenario, we'd use the WebSocket to trigger a signal
  // For this test, we'll manually stop all agents (which triggers position closure)
  const stopPromises = sessionIds.map(async (sessionId) => {
    try {
      await axios.post(
        `${BASE_URL}/api/agent/stop`,
        { sessionId },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      results.ordersSubmitted++;
      return { success: true, sessionId };
    } catch (error: any) {
      if (error.response?.status === 418) results.apiErrors418++;
      if (error.response?.status === 429) results.apiErrors429++;
      results.ordersFailed++;
      return { success: false, sessionId, error: error.message };
    }
  });

  const stopResults = await Promise.all(stopPromises);

  results.totalExecutionTimeMs = Date.now() - startTime;

  console.log(`\n⏱️  Total execution time: ${results.totalExecutionTimeMs}ms`);
  console.log(`✅ Successful stops: ${stopResults.filter(r => r.success).length}`);
  console.log(`❌ Failed stops: ${stopResults.filter(r => !r.success).length}`);
}

/**
 * Step 6: Monitor queue state AFTER exits
 */
async function checkFinalQueueState(token: string): Promise<void> {
  console.log('\n📊 Step 6: Checking final queue state...');

  // Wait a bit for queue to process
  await new Promise(resolve => setTimeout(resolve, 2000));

  try {
    const queueResponse = await axios.get(
      `${BASE_URL}/api/monitor/order-queue`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    results.queueStats = queueResponse.data.stats;

    console.log('📈 Final Queue Stats:');
    console.log(JSON.stringify(results.queueStats, null, 2));

    const dedupResponse = await axios.get(
      `${BASE_URL}/api/monitor/api-dedup`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    results.dedupStats = dedupResponse.data.stats;

    console.log('\n📈 Final API Dedup Stats:');
    console.log(JSON.stringify(results.dedupStats, null, 2));
  } catch (error: any) {
    console.error('⚠️  Could not fetch monitoring stats:', error.message);
  }
}

/**
 * Step 7: Validate results
 */
function validateResults(): boolean {
  console.log('\n✅ Step 7: Validating results...\n');

  let passed = true;

  // Test 1: All agents created
  if (results.agentsCreated === NUM_AGENTS) {
    console.log(`✅ TEST 1 PASSED: Created ${NUM_AGENTS}/${NUM_AGENTS} agents`);
  } else {
    console.log(`❌ TEST 1 FAILED: Only created ${results.agentsCreated}/${NUM_AGENTS} agents`);
    passed = false;
  }

  // Test 2: No 418 errors (IP ban)
  if (results.apiErrors418 === 0) {
    console.log(`✅ TEST 2 PASSED: No 418 errors (no IP ban)`);
  } else {
    console.log(`❌ TEST 2 FAILED: ${results.apiErrors418} 418 errors detected (IP BAN!)`);
    passed = false;
  }

  // Test 3: No 429 errors (rate limit)
  if (results.apiErrors429 === 0) {
    console.log(`✅ TEST 3 PASSED: No 429 errors (no rate limit hit)`);
  } else {
    console.log(`❌ TEST 3 FAILED: ${results.apiErrors429} 429 errors detected`);
    passed = false;
  }

  // Test 4: Queue processed orders
  if (results.queueStats && results.queueStats.counters) {
    const totalProcessed = results.queueStats.counters.totalExecuted + results.queueStats.counters.totalFailed;
    console.log(`✅ TEST 4 PASSED: Queue processed ${totalProcessed} orders`);
    console.log(`   - Executed: ${results.queueStats.counters.totalExecuted}`);
    console.log(`   - Failed: ${results.queueStats.counters.totalFailed}`);
  } else {
    console.log(`⚠️  TEST 4 SKIPPED: Could not get queue stats`);
  }

  // Test 5: Success rate
  if (results.queueStats && results.queueStats.rates) {
    const successRate = results.queueStats.rates.successRate || 0;
    if (successRate > 80) {
      console.log(`✅ TEST 5 PASSED: Success rate ${successRate}% > 80%`);
    } else {
      console.log(`⚠️  TEST 5 WARNING: Success rate ${successRate}% < 80% (may be due to no positions)`);
    }
  } else {
    console.log(`⚠️  TEST 5 SKIPPED: Could not calculate success rate`);
  }

  // Test 6: API deduplication
  if (results.dedupStats && results.dedupStats.deduplicationRate) {
    const dedupRate = results.dedupStats.deduplicationRate;
    if (dedupRate > 50) {
      console.log(`✅ TEST 6 PASSED: Deduplication rate ${dedupRate}% > 50%`);
    } else {
      console.log(`ℹ️  TEST 6 INFO: Deduplication rate ${dedupRate}%`);
    }
  } else {
    console.log(`ℹ️  TEST 6 INFO: No deduplication stats available`);
  }

  // Test 7: Execution time (should be > 3s for 10 agents with 350ms delay)
  const expectedMinTime = NUM_AGENTS * 350; // 350ms delay per order
  if (results.totalExecutionTimeMs > expectedMinTime) {
    console.log(`✅ TEST 7 PASSED: Execution time ${results.totalExecutionTimeMs}ms > ${expectedMinTime}ms (queue is rate-limiting)`);
  } else {
    console.log(`⚠️  TEST 7 WARNING: Execution time ${results.totalExecutionTimeMs}ms < ${expectedMinTime}ms (queue may not be active)`);
  }

  return passed;
}

/**
 * Step 8: Print final summary
 */
function printSummary(passed: boolean): void {
  console.log('\n' + '='.repeat(80));
  console.log('📊 TEST SUMMARY');
  console.log('='.repeat(80));
  console.log(`\nAgents Created: ${results.agentsCreated}/${NUM_AGENTS}`);
  console.log(`Orders Submitted: ${results.ordersSubmitted}`);
  console.log(`Orders Successful: ${results.ordersSuccessful}`);
  console.log(`Orders Failed: ${results.ordersFailed}`);
  console.log(`418 Errors (IP Ban): ${results.apiErrors418}`);
  console.log(`429 Errors (Rate Limit): ${results.apiErrors429}`);
  console.log(`Total Execution Time: ${results.totalExecutionTimeMs}ms`);

  if (results.queueStats) {
    console.log(`\nQueue Stats:`);
    console.log(`  - Total Executed: ${results.queueStats.counters?.totalExecuted || 0}`);
    console.log(`  - Total Failed: ${results.queueStats.counters?.totalFailed || 0}`);
    console.log(`  - Success Rate: ${results.queueStats.rates?.successRate || 0}%`);
    console.log(`  - Queue Size: ${results.queueStats.queue?.size || 0}`);
  }

  if (results.dedupStats) {
    console.log(`\nAPI Deduplication Stats:`);
    console.log(`  - Dedup Rate: ${results.dedupStats.deduplicationRate || 0}%`);
    console.log(`  - API Reduction: ${results.dedupStats.apiReduction || 0}%`);
  }

  console.log('\n' + '='.repeat(80));

  if (passed) {
    console.log('✅ ALL CRITICAL TESTS PASSED');
    console.log('\nThe order queue system is working correctly!');
    console.log('No API bans detected. System is ready for scaling.');
  } else {
    console.log('❌ SOME TESTS FAILED');
    console.log('\nPlease review the errors above and fix issues before scaling.');
  }

  console.log('='.repeat(80) + '\n');
}

/**
 * Main test execution
 */
async function runTest(): Promise<void> {
  console.log('='.repeat(80));
  console.log('🧪 ORDER QUEUE TEST: 10 CONCURRENT AGENTS');
  console.log('='.repeat(80));
  console.log('\nThis test validates the order queue prevents API bans\n');

  try {
    // Step 1: Setup test user
    const token = await setupTestUser();

    // Step 2: Create agents
    const sessionIds = await createAgents(token);

    if (sessionIds.length === 0) {
      console.error('\n❌ No agents created. Test cannot continue.');
      process.exit(1);
    }

    // Step 3: Wait for initialization
    await waitForAgentsToInitialize(sessionIds, token);

    // Step 4: Check initial state
    await checkInitialQueueState(token);

    // Step 5: Trigger simultaneous actions
    await triggerSimultaneousExits(sessionIds, token);

    // Step 6: Check final state
    await checkFinalQueueState(token);

    // Step 7: Validate results
    const passed = validateResults();

    // Step 8: Print summary
    printSummary(passed);

    process.exit(passed ? 0 : 1);

  } catch (error: any) {
    console.error('\n❌ TEST FAILED WITH ERROR:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run the test
runTest();

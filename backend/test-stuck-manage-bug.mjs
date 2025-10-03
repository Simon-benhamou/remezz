#!/usr/bin/env node
/**
 * 🐛 CRITICAL BUG DIAGNOSTIC: Agent stuck in MANAGE state without position
 * 
 * Issue: Agent can enter MANAGE state but if position is closed externally
 * or never existed, agent stays stuck in MANAGE forever.
 * 
 * Root Cause Analysis:
 * 1. Agent transitions to MANAGE state (multiple entry points)
 * 2. Position check ONLY in LIVE mode (lines 3210-3226 in state.ts)
 * 3. PAPER mode has NO position validation in manage()
 * 4. If this.pos = null in MANAGE state → agent stuck forever
 */

console.log('🐛 Critical Bug Diagnostic: MANAGE State Without Position\n');
console.log('='.repeat(100));

// ====================
// BUG REPRODUCTION
// ====================
console.log('\n📋 BUG REPRODUCTION SCENARIO\n');

const scenarios = [
  {
    name: 'Paper Mode - Position Never Created',
    mode: 'paper',
    steps: [
      '1. Agent transitions to MANAGE state (line 790)',
      '2. this.pos = null (entry failed silently)',
      '3. manage() called → early return (line 3197)',
      '4. Agent stays in MANAGE forever',
      '5. tick() → state === MANAGE → manage() → return',
    ],
    bugLine: 'state.ts:3197',
    affectsProduction: '✅ YES - Paper mode agents',
  },
  {
    name: 'Live Mode - Position Closed Externally',
    mode: 'live',
    steps: [
      '1. Agent enters position successfully',
      '2. User manually closes position on exchange',
      '3. manage() checks inspectExposure() (line 3210)',
      '4. ✅ SAFE: Detects closure, exits gracefully',
    ],
    bugLine: 'N/A',
    affectsProduction: '❌ NO - Has protection',
  },
  {
    name: 'Paper Mode - Position Closed by Paper Broker',
    mode: 'paper',
    steps: [
      '1. Agent enters position (this.pos set)',
      '2. Paper broker simulates SL/TP hit',
      '3. this.pos cleared (by exitPosition)',
      '4. But state not reset to IDLE/SCAN',
      '5. Next tick: manage() → return (line 3197)',
      '6. Agent stuck in MANAGE with no position',
    ],
    bugLine: 'state.ts:3197 + missing state reset',
    affectsProduction: '⚠️  POSSIBLE - Race condition',
  },
  {
    name: 'Live Mode - API Failure During Position Check',
    mode: 'live',
    steps: [
      '1. Agent in MANAGE with position',
      '2. inspectExposure() fails (API timeout)',
      '3. Catch block logs warning (line 3226)',
      '4. ✅ SAFE: Continues managing position',
    ],
    bugLine: 'N/A',
    affectsProduction: '❌ NO - Fail-safe behavior',
  },
];

scenarios.forEach((s, i) => {
  console.log(`${i + 1}. ${s.name}`);
  console.log(`   Mode: ${s.mode}`);
  console.log(`   Steps:`);
  s.steps.forEach(step => console.log(`     ${step}`));
  console.log(`   Bug Location: ${s.bugLine}`);
  console.log(`   Production Impact: ${s.affectsProduction}`);
  console.log('');
});

// ====================
// CODE ANALYSIS
// ====================
console.log('='.repeat(100));
console.log('\n🔍 CODE ANALYSIS\n');

console.log('1. Entry Points to MANAGE State:');
console.log('');
const entryPoints = [
  { line: 223, context: 'restorePersistedPosition() → position exists → state = MANAGE' },
  { line: 260, context: 'Live exposure inspection → position exists → state = MANAGE' },
  { line: 290, context: 'tick() → this.pos exists → state = MANAGE' },
  { line: 790, context: 'enter() → order filled → state = MANAGE' },
  { line: 3083, context: 'restorePersistedPosition() → adopt position → state = MANAGE' },
];

entryPoints.forEach((ep, i) => {
  console.log(`   ${i + 1}. Line ${ep.line}: ${ep.context}`);
});

console.log('\n2. Position Validation in manage():');
console.log('');
console.log('   Line 3197: if (!this.pos || !this.plan || !this.profile) return;');
console.log('   ✅ Early return if no position');
console.log('   ❌ BUT state stays MANAGE!');
console.log('');
console.log('   Line 3210-3226: Live mode position check');
console.log('   ✅ Validates position on exchange');
console.log('   ✅ Sets state = EXIT if position closed');
console.log('   ❌ ONLY for mode === "live"!');

console.log('\n3. Paper Mode Gap:');
console.log('');
console.log('   ❌ NO position validation in paper mode');
console.log('   ❌ If this.pos = null → early return → stuck in MANAGE');
console.log('   ❌ No state transition to IDLE/SCAN');

// ====================
// IMPACT ASSESSMENT
// ====================
console.log('\n' + '='.repeat(100));
console.log('\n📊 IMPACT ASSESSMENT\n');

const impact = {
  severity: 'HIGH',
  affectedModes: ['paper'],
  affectedStates: ['MANAGE'],
  symptoms: [
    'Agent shows state=MANAGE but no position',
    'Agent never scans for new opportunities',
    'Agent appears "frozen" in UI',
    'No error messages (silent failure)',
    'Balance shows free but agent inactive',
  ],
  frequency: 'RARE (race condition or entry failure)',
  userImpact: 'Agent stops trading until manual restart',
  dataIntegrity: 'Position state inconsistent',
};

console.log(`Severity: ${impact.severity}`);
console.log(`Affected Modes: ${impact.affectedModes.join(', ')}`);
console.log(`Affected States: ${impact.affectedStates.join(', ')}`);
console.log('');
console.log('Symptoms:');
impact.symptoms.forEach(s => console.log(`  • ${s}`));
console.log('');
console.log(`Frequency: ${impact.frequency}`);
console.log(`User Impact: ${impact.userImpact}`);
console.log(`Data Integrity: ${impact.dataIntegrity}`);

// ====================
// PROPOSED FIX
// ====================
console.log('\n' + '='.repeat(100));
console.log('\n✅ PROPOSED FIX\n');

console.log('Location: backend/src/agent/state.ts, line ~3197 (start of manage() function)');
console.log('');
console.log('Current Code:');
console.log('─'.repeat(80));
console.log(`
  private async manage(price: number, snap: TechnicalSnapshot): Promise<void> {
    if (!this.pos || !this.plan || !this.profile) return; // ❌ BUG: Just returns, state stays MANAGE
    
    // ... rest of manage logic
  }
`);

console.log('Fixed Code:');
console.log('─'.repeat(80));
console.log(`
  private async manage(price: number, snap: TechnicalSnapshot): Promise<void> {
    // ✅ FIX: Validate position exists, reset state if missing
    if (!this.pos || !this.plan || !this.profile) {
      console.warn(\`⚠️  Agent in MANAGE state but missing position/plan/profile - resetting to SCAN\`);
      
      recordOpsEvent({
        level: 'warn',
        source: 'position_validation',
        message: 'manage_without_position',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { 
          hasPos: !!this.pos, 
          hasPlan: !!this.plan, 
          hasProfile: !!this.profile 
        },
      });
      
      // Reset to SCAN to allow new opportunities
      this.state = 'SCAN';
      broadcast('agent_state', { 
        state: this.state, 
        reason: 'no_position_in_manage_state' 
      }, this.profile?.symbol, this.sessionId || undefined);
      
      return;
    }
    
    // ... rest of manage logic (existing code)
  }
`);

console.log('Benefits:');
console.log('  ✅ Prevents stuck agents in MANAGE state');
console.log('  ✅ Logs warning for debugging');
console.log('  ✅ Records ops event for monitoring');
console.log('  ✅ Graceful recovery (resets to SCAN)');
console.log('  ✅ Works for both paper and live modes');
console.log('  ✅ No breaking changes');

// ====================
// ADDITIONAL SAFEGUARDS
// ====================
console.log('\n' + '='.repeat(100));
console.log('\n🛡️  ADDITIONAL SAFEGUARDS\n');

console.log('1. Add Position Validation in Paper Mode (lines 3210-3226):');
console.log('');
console.log('Current: Only checks exposure in live mode');
console.log('Improvement: Add paper mode position validation');
console.log('');
console.log('Code Addition:');
console.log('─'.repeat(80));
console.log(`
    // Check if position is still open (both live and paper modes)
    if (this.profile.mode === 'live') {
      // Existing live mode check...
    } else if (this.profile.mode === 'paper') {
      // ✅ NEW: Paper mode position validation
      try {
        // Verify paper position still exists in agent state
        if (!this.pos || this.pos.qty <= 0) {
          console.log(\`Paper position cleared for \${this.profile.symbol}, transitioning to EXIT\`);
          this.state = 'EXIT';
          this.lastExitTime = Date.now();
          broadcast('agent_state', { 
            state: this.state, 
            reason: 'paper_position_cleared' 
          }, this.profile.symbol, this.sessionId || undefined);
          this.scheduleReactivation('paper_position_cleared');
          return;
        }
      } catch (error) {
        console.warn(\`Failed to validate paper position for \${this.profile.symbol}:\`, error);
      }
    }
`);

console.log('2. Add State Transition Guard in tick() (line ~290):');
console.log('');
console.log('Current: if (this.pos) { this.state = MANAGE; return; }');
console.log('Risk: Assumes position validity');
console.log('');
console.log('Improvement:');
console.log('─'.repeat(80));
console.log(`
    // MANAGE state: only if position truly exists and valid
    if (this.pos && this.pos.qty > 0) { 
      this.state = 'MANAGE'; 
      broadcast('agent_state', { state: this.state, pos: this.pos }, this.profile.symbol, this.sessionId || undefined); 
      return; 
    } else if (this.pos) {
      // ✅ Position object exists but qty invalid
      console.warn(\`Invalid position qty (\${this.pos.qty}) for \${this.profile.symbol}, clearing\`);
      this.pos = null;
      this.state = 'SCAN';
    }
`);

// ====================
// TESTING PLAN
// ====================
console.log('\n' + '='.repeat(100));
console.log('\n🧪 TESTING PLAN\n');

const tests = [
  {
    test: 'Paper Mode - Entry Failure',
    steps: [
      'Create paper agent',
      'Mock broker.place() to fail',
      'Verify agent returns to SCAN (not stuck in MANAGE)',
    ],
    expected: 'State = SCAN, ops event logged',
  },
  {
    test: 'Paper Mode - Position Cleared Mid-Manage',
    steps: [
      'Create paper agent with position',
      'State = MANAGE',
      'Set this.pos = null (simulate paper SL)',
      'Call tick()',
      'Verify state transitions to SCAN',
    ],
    expected: 'State = SCAN, warning logged',
  },
  {
    test: 'Live Mode - Existing Behavior',
    steps: [
      'Create live agent with position',
      'Mock inspectExposure() returns null',
      'Call manage()',
      'Verify state = EXIT',
    ],
    expected: 'State = EXIT (no regression)',
  },
  {
    test: 'Edge Case - Invalid Qty',
    steps: [
      'Create agent with position',
      'Set this.pos.qty = 0',
      'State = MANAGE',
      'Call tick()',
      'Verify state clears to SCAN',
    ],
    expected: 'Position cleared, state = SCAN',
  },
];

tests.forEach((t, i) => {
  console.log(`${i + 1}. ${t.test}`);
  console.log('   Steps:');
  t.steps.forEach(s => console.log(`     • ${s}`));
  console.log(`   Expected: ${t.expected}`);
  console.log('');
});

// ====================
// MONITORING QUERIES
// ====================
console.log('='.repeat(100));
console.log('\n📈 MONITORING QUERIES\n');

console.log('SQL: Check agents stuck in MANAGE without position');
console.log('─'.repeat(80));
console.log(`
SELECT 
  s.id,
  s.symbol,
  s.mode,
  s.state,
  s.balance_usd,
  s.committed_usd,
  s.updated_at,
  COUNT(t.id) as active_trades,
  EXTRACT(EPOCH FROM (NOW() - s.updated_at)) / 60 as minutes_stuck
FROM sessions s
LEFT JOIN trades t ON t.session_id = s.id AND t.closed_at IS NULL
WHERE s.state = 'MANAGE'
  AND s.is_active = true
  AND s.updated_at < NOW() - INTERVAL '5 minutes'
GROUP BY s.id
HAVING COUNT(t.id) = 0  -- No active trades but in MANAGE state
ORDER BY minutes_stuck DESC;
`);

console.log('Expected Result if Bug Present:');
console.log('  • Rows with state=MANAGE, active_trades=0, minutes_stuck > 5');
console.log('');

console.log('OpsEvents Query: Detect the warning');
console.log('─'.repeat(80));
console.log(`
SELECT 
  ts,
  source,
  message,
  symbol,
  details
FROM ops_events
WHERE message = 'manage_without_position'
  AND ts > NOW() - INTERVAL '24 hours'
ORDER BY ts DESC;
`);

// ====================
// FINAL VERDICT
// ====================
console.log('\n' + '='.repeat(100));
console.log('\n🎯 FINAL VERDICT\n');

const verdict = {
  bugExists: true,
  severity: 'HIGH',
  affectedUsers: 'Paper mode agents (all)',
  likelihood: 'LOW (race condition)',
  impact: 'HIGH (agent stops trading)',
  fixComplexity: 'LOW (10-15 lines)',
  fixRisk: 'MINIMAL (defensive code)',
  recommendation: 'IMPLEMENT FIX IMMEDIATELY',
};

console.log(`Bug Exists: ${verdict.bugExists ? '✅ YES' : '❌ NO'}`);
console.log(`Severity: ${verdict.severity}`);
console.log(`Affected Users: ${verdict.affectedUsers}`);
console.log(`Likelihood: ${verdict.likelihood}`);
console.log(`Impact: ${verdict.impact}`);
console.log(`Fix Complexity: ${verdict.fixComplexity}`);
console.log(`Fix Risk: ${verdict.fixRisk}`);
console.log(`Recommendation: ${verdict.recommendation}`);
console.log('');

console.log('🚨 ACTION REQUIRED:');
console.log('  1. Implement primary fix (manage() validation)');
console.log('  2. Add paper mode position check');
console.log('  3. Add monitoring query to dashboard');
console.log('  4. Test with paper agent (force failure)');
console.log('  5. Deploy and monitor ops_events');
console.log('');

console.log('📦 Files to Modify:');
console.log('  • backend/src/agent/state.ts (lines 3197, 3210-3226, 290)');
console.log('  • Add test: backend/test-stuck-manage-bug.mjs');
console.log('  • Add monitoring: frontend dashboard query');
console.log('');

console.log('✅ Expected Outcome:');
console.log('  • Zero agents stuck in MANAGE without position');
console.log('  • Graceful recovery (reset to SCAN)');
console.log('  • Full observability (ops events)');
console.log('  • No production downtime');
console.log('');

console.log('='.repeat(100));
console.log('\n🏁 Diagnostic Complete\n');

process.exit(0);

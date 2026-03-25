/**
 * Check proactive limit configuration and recommend improvements
 */
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import { DEFAULT_NFS_CONFIG } from '../src/services/nfsRealtimeExit.js';

console.log('═══════════════════════════════════════════════════════════════');
console.log('PROACTIVE LIMIT CONFIGURATION CHECK');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log('─── NFS State Machine Config ───');
console.log(`PRE_BREACH_DISTANCE_PCT:          ${DEFAULT_NFS_CONFIG.PRE_BREACH_DISTANCE_PCT}%`);
console.log(`  → Price must be within ${DEFAULT_NFS_CONFIG.PRE_BREACH_DISTANCE_PCT}% of trailing to enter PRE_BREACH`);
console.log(`PROACTIVE_LIMIT_NFS_THRESHOLD:    ${DEFAULT_NFS_CONFIG.PROACTIVE_LIMIT_NFS_THRESHOLD}`);
console.log(`  → NFS score must be >= ${DEFAULT_NFS_CONFIG.PROACTIVE_LIMIT_NFS_THRESHOLD} to place proactive limit`);
console.log(`PROACTIVE_LIMIT_CANCEL_DISTANCE:  ${DEFAULT_NFS_CONFIG.PROACTIVE_LIMIT_CANCEL_DISTANCE_PCT}%`);
console.log(`  → Cancel limit if price moves > ${DEFAULT_NFS_CONFIG.PROACTIVE_LIMIT_CANCEL_DISTANCE_PCT}% away`);

console.log('\n─── Exit Config ───');
const exitConfig = MomentumConfig.EXIT as any;
console.log(`TRAILING_DISTANCE_PCT:            ${exitConfig.TRAILING_DISTANCE_PCT}%`);
console.log(`NFS_ENABLED:                      ${exitConfig.NFS_ENABLED}`);
console.log(`NFS_ADAPTIVE_ENABLED:             ${exitConfig.NFS_ADAPTIVE_ENABLED}`);
console.log(`REALTIME_APP_EXIT_ENABLED:        ${exitConfig.REALTIME_APP_EXIT_ENABLED}`);
console.log(`REALTIME_APP_EXIT_TRAILING_ENABLED: ${exitConfig.REALTIME_APP_EXIT_TRAILING_ENABLED}`);
console.log(`REALTIME_APP_EXIT_TRAILING_MODE:  ${exitConfig.REALTIME_APP_EXIT_TRAILING_MODE}`);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('PROBLEM ANALYSIS');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log('XRP trade analysis shows:');
console.log('- Entry: $1.4062, Low: ~$1.346, Exit: $1.3727');
console.log('- Trailing stop at low: $1.346 × 1.015 = $1.3662');
console.log('- PRE_BREACH zone: $1.3662 × 1.003 = $1.3703 to $1.3662');
console.log('- This is a zone of only ~0.3% = $0.004');
console.log('');
console.log('PROBLEM: The PRE_BREACH zone is very narrow!');
console.log('- If price drops from $1.40 to $1.35 in one 1m candle');
console.log('- The state machine may not catch the PRE_BREACH window');
console.log('');

console.log('═══════════════════════════════════════════════════════════════');
console.log('RECOMMENDATIONS');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log('1. INCREASE PRE_BREACH_DISTANCE_PCT');
console.log(`   Current: ${DEFAULT_NFS_CONFIG.PRE_BREACH_DISTANCE_PCT}% → Recommended: 0.5-0.8%`);
console.log('   This gives more time to place proactive limit before breach');
console.log('');

console.log('2. LOWER PROACTIVE_LIMIT_NFS_THRESHOLD');
console.log(`   Current: ${DEFAULT_NFS_CONFIG.PROACTIVE_LIMIT_NFS_THRESHOLD} → Recommended: 35-40`);
console.log('   This allows limit placement with less conviction');
console.log('   (if cancelled early, no harm done)');
console.log('');

console.log('3. MAKE PAPER MORE REALISTIC');
console.log('   Paper currently uses theoretical trailing stop price');
console.log('   Should use candle close price (like live does before market order)');
console.log('   Or add simulated slippage of 0.5-1%');
console.log('');

console.log('4. IMPLEMENT EARLY LIMIT PLACEMENT');
console.log('   Instead of waiting for PRE_BREACH + high NFS:');
console.log('   - Place limit as soon as trailing activates');
console.log('   - Update limit price as trailing stop moves');
console.log('   - This ensures limit is always ready');

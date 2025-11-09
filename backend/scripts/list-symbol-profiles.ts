/**
 * List all symbol profiles
 */
import { prisma } from '../src/db/client.js';

async function listProfiles() {
  console.log('📊 Symbol Profiles in Database:\n');

  const profiles = await prisma.$queryRaw<any[]>`
    SELECT 
      symbol, 
      tier, 
      optimization_status,
      performance_metrics,
      created_at,
      updated_at,
      notes
    FROM symbol_profiles
    ORDER BY tier ASC, symbol ASC
  `;

  if (profiles.length === 0) {
    console.log('❌ No symbol profiles found');
    return;
  }

  console.log(`Found ${profiles.length} symbol profile(s):\n`);

  for (const profile of profiles) {
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📈 ${profile.symbol}`);
    console.log(`   Tier: ${profile.tier}`);
    console.log(`   Status: ${profile.optimization_status}`);
    console.log(`   Created: ${new Date(profile.created_at).toLocaleString()}`);
    console.log(`   Updated: ${new Date(profile.updated_at).toLocaleString()}`);
    
    if (profile.performance_metrics) {
      const metrics = profile.performance_metrics;
      console.log(`   Performance:`);
      console.log(`     - Total Trades: ${metrics.totalTrades || 0}`);
      console.log(`     - Win Rate: ${((metrics.winRate || 0) * 100).toFixed(1)}%`);
      console.log(`     - Avg PnL: ${(metrics.avgPnl || 0).toFixed(2)}%`);
      console.log(`     - Sharpe Ratio: ${(metrics.sharpeRatio || 0).toFixed(2)}`);
      console.log(`     - Max Drawdown: ${(metrics.maxDrawdown || 0).toFixed(2)}%`);
    }
    
    if (profile.notes) {
      console.log(`   Notes: ${profile.notes}`);
    }
  }

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  console.log(`✅ Total: ${profiles.length} profile(s)`);
}

listProfiles()
  .catch((err) => {
    console.error('❌ Error listing profiles:', err);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });

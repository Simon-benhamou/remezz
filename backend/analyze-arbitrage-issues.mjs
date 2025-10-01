#!/usr/bin/env node

import { getConfig } from './src/utils/env.js';
import { getExchangeStatus } from './src/arbitrage/spreadScanner.js';

async function analyzeArbitrageIssues() {
  console.log('🔍 Analyzing arbitrage scanner issues...\n');

  const cfg = getConfig();

  console.log('📊 Configuration:');
  console.log(`  Enabled: ${cfg.ARBITRAGE_ENABLED}`);
  console.log(`  Exchanges: ${cfg.ARBITRAGE_EXCHANGES.join(', ')}`);
  console.log(`  Symbols: ${cfg.ARBITRAGE_SYMBOLS.join(', ')}`);
  console.log(`  Poll interval: ${cfg.ARBITRAGE_POLL_INTERVAL_SEC}s`);
  console.log(`  Cache TTL: ${cfg.ARBITRAGE_CACHE_TTL_SEC}s`);
  console.log('');

  if (!cfg.ARBITRAGE_ENABLED) {
    console.log('❌ Arbitrage is disabled');
    return;
  }

  console.log('🔌 Exchange Status:');
  const status = getExchangeStatus();

  for (const exchange of cfg.ARBITRAGE_EXCHANGES) {
    const exchangeStatus = status[exchange];
    if (!exchangeStatus) {
      console.log(`  ❌ ${exchange}: Not loaded`);
    } else if (!exchangeStatus.available) {
      const until = new Date(exchangeStatus.rateLimitedUntil).toLocaleString();
      console.log(`  🚫 ${exchange}: Rate limited until ${until}`);
    } else {
      const loaded = new Date(exchangeStatus.loadedAt).toLocaleString();
      console.log(`  ✅ ${exchange}: Available (loaded ${loaded})`);
    }
  }

  console.log('');
  console.log('💡 Recommendations:');

  if (cfg.ARBITRAGE_POLL_INTERVAL_SEC < 300) {
    console.log('  ⚠️  Poll interval is very frequent (< 5min) - consider increasing to reduce API load');
  }

  const rateLimitedCount = Object.values(status).filter(s => !s.available).length;
  if (rateLimitedCount > 0) {
    console.log(`  🚫 ${rateLimitedCount} exchange(s) are rate limited - wait for cooldown or reduce polling`);
  }

  if (cfg.ARBITRAGE_EXCHANGES.length > 3) {
    console.log('  ⚠️  Many exchanges configured - consider reducing to avoid rate limits');
  }

  if (cfg.ARBITRAGE_SYMBOLS.length > 5) {
    console.log('  ⚠️  Many symbols configured - consider focusing on major pairs');
  }

  console.log('');
  console.log('🛠️  Commands:');
  console.log('  Clear caches: curl -X POST http://localhost:4000/api/arbitrage/clear-cache');
  console.log('  Check status: curl http://localhost:4000/api/arbitrage/status');
  console.log('  Force refresh: curl "http://localhost:4000/api/arbitrage/spreads?refresh=true"');
}

analyzeArbitrageIssues().catch(console.error);
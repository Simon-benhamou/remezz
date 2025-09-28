import { checkSmartOpportunities } from './src/services/smartAgent.js';

async function testSleepMode() {
  console.log('🔄 Triggering manual intelligent opportunities check...');
  await checkSmartOpportunities();
  console.log('✅ Manual check completed');
}

testSleepMode().catch(console.error);
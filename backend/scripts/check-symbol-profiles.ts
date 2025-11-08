import { prisma } from '../src/db/client.js';

async function checkTable() {
  try {
    const result = await prisma.$queryRaw<any[]>`SELECT COUNT(*) FROM symbol_profiles`;
    console.log('✅ Table symbol_profiles exists');
    console.log('Rows:', result[0].count);
    
    // Show sample data
    const samples = await prisma.$queryRaw<any[]>`SELECT * FROM symbol_profiles LIMIT 5`;
    console.log('\nSample data:');
    console.log(JSON.stringify(samples, null, 2));
  } catch (error: any) {
    if (error.message?.includes('does not exist')) {
      console.log('❌ Table symbol_profiles does NOT exist');
      console.log('\nYou need to run: npx tsx scripts/run-optimizer-manual.ts');
      console.log('This will create the table and populate it.');
    } else {
      console.error('Error:', error.message);
    }
  } finally {
    await prisma.$disconnect();
  }
}

checkTable();

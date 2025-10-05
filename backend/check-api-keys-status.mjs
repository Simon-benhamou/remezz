import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkApiKeys() {
  console.log('\n=== API KEYS STATUS ===\n');
  
  const users = await prisma.user.findMany({
    include: {
      apiKeys: {
        orderBy: { createdAt: 'desc' }
      }
    }
  });

  users.forEach(user => {
    console.log(`👤 User: ${user.email}`);
    console.log(`   User ID: ${user.id}\n`);
    
    if (user.apiKeys.length === 0) {
      console.log('   ❌ No API keys found\n');
    } else {
      user.apiKeys.forEach((key, idx) => {
        console.log(`   Key #${idx + 1}:`);
        console.log(`      ID: ${key.id}`);
        console.log(`      Exchange: ${key.exchange}`);
        console.log(`      Active: ${key.isActive ? '✅ YES' : '❌ NO'}`);
        console.log(`      Created: ${key.createdAt.toISOString()}`);
        console.log(`      API Key (first 10 chars): ${key.apiKey.substring(0, 10)}...`);
        console.log('');
      });
    }
  });

  await prisma.$disconnect();
}

checkApiKeys();

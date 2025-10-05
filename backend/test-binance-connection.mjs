import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function testBinanceConnection() {
  try {
    console.log('\n=== CHECKING API KEYS IN DATABASE ===\n');
    
    const apiKeys = await prisma.userApiKey.findMany({
      include: {
        user: {
          select: {
            email: true
          }
        }
      },
      orderBy: {
        updatedAt: 'desc'
      }
    });

    console.log(`Found ${apiKeys.length} API keys:\n`);

    apiKeys.forEach((key, idx) => {
      console.log(`Key #${idx + 1}:`);
      console.log(`  User: ${key.user.email}`);
      console.log(`  Exchange: ${key.exchange}`);
      console.log(`  Active: ${key.isActive ? '✅ YES' : '❌ NO'}`);
      console.log(`  Created: ${key.createdAt}`);
      console.log(`  Updated: ${key.updatedAt}`);
      console.log('');
    });

    // Check agents
    const agents = await prisma.agent.findMany({
      where: {
        mode: 'auto',
        isActive: true
      },
      include: {
        user: {
          select: {
            email: true
          }
        }
      }
    });

    console.log(`\n=== ACTIVE AUTO AGENTS ===\n`);
    console.log(`Found ${agents.length} active auto agents:\n`);

    agents.forEach((agent, idx) => {
      console.log(`Agent #${idx + 1}:`);
      console.log(`  User: ${agent.user.email}`);
      console.log(`  Symbol: ${agent.symbol}`);
      console.log(`  User ID: ${agent.userId}`);
      console.log('');
    });

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

testBinanceConnection();

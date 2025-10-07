import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkUser() {
  try {
    // Try by username first
    let user = await prisma.user.findFirst({
      where: { username: 'simon' },
      include: {
        apiKeys: {
          where: { exchange: 'binance', isActive: true }
        }
      }
    });

    if (!user) {
      // Try by email
      user = await prisma.user.findFirst({
        where: { email: 'simon' },
        include: {
          apiKeys: {
            where: { exchange: 'binance', isActive: true }
          }
        }
      });
    }

    if (user) {
      console.log('✅ User found:', user.username || user.email);
      console.log('ID:', user.id);
      console.log('API Keys:', user.apiKeys.length);
      if (user.apiKeys.length > 0) {
        console.log('Binance key exists:', !!user.apiKeys[0].apiKey);
        console.log('API Key preview:', user.apiKeys[0].apiKey.substring(0, 10) + '...');
      } else {
        console.log('❌ No Binance API keys configured');
      }
    } else {
      console.log('❌ User not found');
      // List all users
      const allUsers = await prisma.user.findMany({
        select: { username: true, email: true }
      });
      console.log('Available users:', allUsers);
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkUser();
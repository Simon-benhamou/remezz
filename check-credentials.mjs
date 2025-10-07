import { prisma } from './backend/src/db/client.js';
import { decryptApiKey } from './backend/src/utils/crypto.js';

async function checkCredentials() {
  console.log('🔍 Checking stored credentials for user "simon"\n');

  try {
    const userId = 'cmftkdhxr0000jilspwd7kwge';

    const apiKeys = await prisma.userApiKey.findMany({
      where: {
        userId,
        isActive: true
      }
    });

    console.log(`Found ${apiKeys.length} active API keys for user ${userId}\n`);

    for (const key of apiKeys) {
      console.log(`Exchange: ${key.exchange}`);
      console.log(`Testnet: ${key.testnet}`);
      console.log(`Created: ${key.createdAt}`);
      console.log(`Updated: ${key.updatedAt}`);

      try {
        const decryptedApiKey = decryptApiKey(key.apiKey);
        const decryptedApiSecret = decryptApiKey(key.apiSecret);

        console.log(`API Key: ${decryptedApiKey}`);
        console.log(`API Secret: ${decryptedApiSecret.substring(0, 10)}...`);

        // Check if this matches what user said
        if (decryptedApiKey.startsWith('l2lWNLXpr3')) {
          console.log('✅ This matches the API key from our test!');
        } else {
          console.log('❌ This does not match the API key from our test');
        }

      } catch (error) {
        console.log('❌ Failed to decrypt API key:', error.message);
      }

      console.log('---\n');
    }

  } catch (error) {
    console.error('❌ Error checking credentials:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkCredentials();
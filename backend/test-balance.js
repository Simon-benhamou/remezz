const { PrismaClient } = require('@prisma/client');
const { decrypt } = require('./dist/utils/crypto.js');
const ccxt = require('ccxt');
const prisma = new PrismaClient();

(async () => {
  try {
    const apiKey = await prisma.userApiKey.findFirst({
      where: { userId: 'cmhhhwem70000pe65r748lnlu', exchange: 'binance' }
    });
    
    console.log('API Key found:', !!apiKey);
    if (!apiKey) {
      console.log('No API key');
      await prisma.$disconnect();
      return;
    }
    
    const decryptedKey = decrypt(apiKey.apiKey);
    const decryptedSecret = decrypt(apiKey.apiSecret);
    
    console.log('Decrypted key length:', decryptedKey.length);
    console.log('Decrypted secret length:', decryptedSecret.length);
    console.log('Key starts with:', decryptedKey.substring(0, 10));
    
    const exchange = new ccxt.binance({
      apiKey: decryptedKey,
      secret: decryptedSecret
    });
    
    console.log('Fetching balance...');
    const balance = await exchange.fetchBalance();
    console.log('USDT balance:', balance.total.USDT || 0);
    console.log('Total USD:', balance.total.USD || 0);
    
    await prisma.$disconnect();
  } catch (err) {
    console.error('Error:', err.message);
    console.error('Stack:', err.stack);
    await prisma.$disconnect();
  }
})();

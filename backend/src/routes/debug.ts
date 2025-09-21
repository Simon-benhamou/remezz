import { Router } from 'express';
import { authenticateUser, AuthenticatedRequest } from '../middleware/auth.js';
import { getUserCredentials } from '../services/userCredentials.js';
import { getUserExchange, validateUserCredentials, clearUserExchangeCache } from '../exchange/ccxtClient.js';
import { prisma } from '../db/client.js';
import { encryptApiKey, decryptApiKey } from '../utils/crypto.js';

export const router = Router();

// Apply authentication middleware
router.use(authenticateUser);

// Test API keys and fetch balance
router.get('/test-balance', async (req: AuthenticatedRequest, res) => {
  try {
    if (req.user?.isLegacy) {
      return res.status(403).json({ 
        error: 'legacy_users_no_api_keys',
        message: 'Legacy users cannot test API keys'
      });
    }

    const credentials = await getUserCredentials(req.user!.id, 'crypto.com');
    
    if (!credentials) {
      return res.json({
        success: false,
        error: 'no_api_keys',
        message: 'No API keys configured'
      });
    }

    console.log('Testing API keys for user:', req.user!.id);
    console.log('API Key (first 8 chars):', credentials.apiKey.substring(0, 8) + '...');
    console.log('API Secret (first 8 chars):', credentials.apiSecret.substring(0, 8) + '...');

    // Clear any cached exchange instances for fresh test
    clearUserExchangeCache(req.user!.id);

    // Test 1: Validate credentials
    let isValid = false;
    let validationError = '';
    try {
      isValid = await validateUserCredentials(credentials);
      console.log('Credentials validation result:', isValid);
    } catch (error: any) {
      validationError = error.message || String(error);
      console.error('Credentials validation error:', validationError);
    }

    // Test 2: Try to get exchange instance and fetch balance
    let balance = null;
    let balanceError = '';
    try {
      const exchange = await getUserExchange(req.user!.id, credentials);
      console.log('Exchange instance created successfully');
      
      balance = await exchange.fetchBalance();
      console.log('Balance fetched successfully:', JSON.stringify(balance, null, 2));
    } catch (error: any) {
      balanceError = error.message || String(error);
      console.error('Balance fetch error:', balanceError);
    }

    // Test 3: Try to get markets info (simplified)
    let markets: any = null;
    let marketsError = '';
    try {
      // Use a temporary exchange for public markets data (doesn't need auth)
      const { getConfig } = await import('../utils/env.js');
      const ccxt = await import('ccxt');
      
      const { EXCHANGE_ID } = getConfig();
      const Klass: any = (ccxt as any)[EXCHANGE_ID];
      if (!Klass) throw new Error('Unknown exchange ' + EXCHANGE_ID);
      
      const ex = new Klass({ enableRateLimit: true });
      await ex.loadMarkets();
      
      const btcMarket = ex.markets['BTC/USDT'] || ex.markets['BTC/USD'] || null;
      markets = {
        totalMarkets: Object.keys(ex.markets).length,
        hasBTCUSDT: !!btcMarket,
        btcMarketInfo: btcMarket ? {
          symbol: btcMarket.symbol,
          type: btcMarket.type,
          spot: btcMarket.spot,
          swap: btcMarket.swap,
          future: btcMarket.future
        } : null,
        sampleMarkets: Object.keys(ex.markets).slice(0, 5)
      };
      console.log('Markets info:', markets);
    } catch (error: any) {
      marketsError = error.message || String(error);
      console.error('Markets fetch error:', marketsError);
    }

    res.json({
      success: true,
      tests: {
        validation: {
          success: isValid,
          error: validationError
        },
        balance: {
          success: !!balance,
          data: balance,
          error: balanceError
        },
        markets: {
          success: !!markets,
          data: markets,
          error: marketsError
        }
      },
      credentials: {
        apiKeyLength: credentials.apiKey.length,
        apiSecretLength: credentials.apiSecret.length,
        hasPassphrase: !!credentials.passphrase,
        testnet: credentials.testnet
      }
    });

  } catch (error: any) {
    console.error('Test balance error:', error);
    res.status(500).json({
      success: false,
      error: 'server_error',
      message: error.message || String(error)
    });
  }
});

// Get detailed exchange info
router.get('/exchange-info', async (req: AuthenticatedRequest, res) => {
  try {
    const credentials = await getUserCredentials(req.user!.id, 'crypto.com');
    
    if (!credentials) {
      return res.status(400).json({ error: 'no_api_keys' });
    }

    const exchange = await getUserExchange(req.user!.id, credentials);
    
    const info = {
      id: exchange.id,
      name: exchange.name,
      countries: exchange.countries,
      urls: exchange.urls,
      capabilities: exchange.has,
      requiredCredentials: exchange.requiredCredentials,
      options: exchange.options,
      rateLimit: exchange.rateLimit,
      markets: Object.keys(exchange.markets || {}).length,
      symbols: Object.keys(exchange.markets || {}).slice(0, 10) // First 10 symbols
    };

    res.json({ success: true, info });
  } catch (error: any) {
    console.error('Exchange info error:', error);
    res.status(500).json({
      success: false,
      error: error.message || String(error)
    });
  }
});

// Check raw API keys in database
router.get('/raw-keys', async (req: AuthenticatedRequest, res) => {
  try {
    if (req.user?.isLegacy) {
      return res.json({ hasKeys: false, message: 'Legacy user' });
    }

    // Query database directly
    const rawKeys = await prisma.userApiKey.findMany({
      where: { userId: req.user!.id },
      select: {
        id: true,
        exchange: true,
        keyName: true,
        apiKey: true, // This is encrypted
        apiSecret: true, // This is encrypted
        testnet: true,
        isActive: true,
        createdAt: true
      }
    });

    const decryptionResults: any[] = [];
    for (const key of rawKeys) {
      try {
        const decryptedKey = decryptApiKey(key.apiKey);
        const decryptedSecret = decryptApiKey(key.apiSecret);
        decryptionResults.push({
          id: key.id,
          exchange: key.exchange,
          keyName: key.keyName,
          keyLength: decryptedKey.length,
          secretLength: decryptedSecret.length,
          testnet: key.testnet,
          isActive: key.isActive,
          createdAt: key.createdAt,
          decryptionSuccess: true
        });
      } catch (error: any) {
        decryptionResults.push({
          id: key.id,
          exchange: key.exchange,
          keyName: key.keyName,
          testnet: key.testnet,
          isActive: key.isActive,
          createdAt: key.createdAt,
          decryptionSuccess: false,
          decryptionError: error?.message || String(error)
        });
      }
    }

    res.json({
      success: true,
      totalKeys: rawKeys.length,
      keys: decryptionResults
    });
  } catch (error: any) {
    console.error('Raw keys check error:', error);
    res.status(500).json({
      success: false,
      error: error.message || String(error)
    });
  }
});

// Clear exchange cache for user (useful when API keys are updated)
router.post('/clear-cache', async (req: AuthenticatedRequest, res) => {
  try {
    if (req.user?.isLegacy) {
      return res.status(403).json({ 
        error: 'legacy_users_no_cache',
        message: 'Legacy users have no exchange cache'
      });
    }

    clearUserExchangeCache(req.user!.id);

    res.json({
      success: true,
      message: 'Exchange cache cleared successfully',
      userId: req.user!.id
    });
  } catch (error: any) {
    console.error('Clear cache error:', error);
    res.status(500).json({
      success: false,
      error: error.message || String(error)
    });
  }
});

// Migration route to fix encrypted keys
router.post('/migrate-keys', async (req: AuthenticatedRequest, res) => {
  try {
    if (req.user?.isLegacy) {
      return res.status(403).json({ error: 'legacy_users_no_migration' });
    }

    const { keyId, newApiKey, newApiSecret } = req.body;

    if (!keyId || !newApiKey || !newApiSecret) {
      return res.status(400).json({ error: 'missing_fields' });
    }

    // Update the key with new encryption
    const updatedKey = await prisma.userApiKey.update({
      where: {
        id: keyId,
        userId: req.user!.id // Ensure user owns the key
      },
      data: {
        apiKey: encryptApiKey(newApiKey),
        apiSecret: encryptApiKey(newApiSecret)
      }
    });

    res.json({
      success: true,
      message: 'API key updated successfully',
      keyId: updatedKey.id
    });
  } catch (error: any) {
    console.error('Migration error:', error);
    res.status(500).json({
      success: false,
      error: error.message || String(error)
    });
  }
});
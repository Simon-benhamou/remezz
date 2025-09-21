import { Router } from 'express';
import { authenticateUser, AuthenticatedRequest } from '../middleware/auth.js';
import { getUserCredentials } from '../services/userCredentials.js';
import { getUserExchange, validateUserCredentials, clearUserExchangeCache } from '../exchange/ccxtClient.js';
import { prisma } from '../db/client.js';
import { encryptApiKey, decryptApiKey } from '../utils/crypto.js';

export const router = Router();

// Get server IP address (for whitelist setup)
router.get('/server-ip', async (req, res) => {
  try {
    // Your server's fixed IP
    const fixedIP = '208.77.244.15';
    
    res.json({
      success: true,
      serverIP: fixedIP,
      method: 'fixed_configuration',
      message: `Your fixed server IP is ${fixedIP}. This should already be whitelisted in your Crypto.com API.`,
      status: 'configured',
      note: 'IP should be already configured in Crypto.com API whitelist'
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || String(error),
      fallback: '208.77.244.15'
    });
  }
});

// Get ATR cache statistics  
router.get('/atr-cache-stats', async (req, res) => {
  try {
    // Import dynamically to avoid circular dependency
    const { ReboundRejectionAgent } = await import('../agent/state.js');
    const stats = ReboundRejectionAgent.getATRCacheStats();
    res.json({
      success: true,
      atrCacheStats: stats,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || String(error)
    });
  }
});

// Test exchange connectivity (public endpoint)
router.get('/test-exchange', async (req, res) => {
  try {
    const { getConfig } = await import('../utils/env.js');
    const ccxt = await import('ccxt');
    
    const { EXCHANGE_ID } = getConfig();
    const Klass: any = (ccxt as any)[EXCHANGE_ID];
    
    if (!Klass) {
      return res.json({
        success: false,
        error: `Exchange '${EXCHANGE_ID}' not found in CCXT`,
        availableExchanges: Object.keys(ccxt).filter(x => x.includes('crypto')).slice(0, 10)
      });
    }

    const exchange = new Klass({ enableRateLimit: true });
    
    const info = {
      id: exchange.id,
      name: exchange.name,
      requiredCredentials: exchange.requiredCredentials,
      capabilities: exchange.has,
      rateLimit: exchange.rateLimit
    };

    // Test public market data
    try {
      await exchange.loadMarkets();
      const markets = Object.keys(exchange.markets || {});
      
      res.json({
        success: true,
        exchange: info,
        markets: {
          total: markets.length,
          sample: markets.slice(0, 5),
          hasBTCUSDT: markets.includes('BTC/USDT'),
          hasBTCUSD: markets.includes('BTC/USD')
        }
      });
    } catch (marketError: any) {
      res.json({
        success: false,
        exchange: info,
        error: 'Failed to load markets',
        message: marketError.message || String(marketError)
      });
    }
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || String(error)
    });
  }
});

// Test specific API credentials (POST with credentials in body)
router.post('/test-credentials', async (req, res) => {
  try {
    const { apiKey, apiSecret, passphrase } = req.body;
    
    if (!apiKey || !apiSecret) {
      return res.status(400).json({
        success: false,
        error: 'Missing apiKey or apiSecret'
      });
    }

    console.log('🔍 Starting API credential test...');
    console.log('API Key (first 8 chars):', apiKey.substring(0, 8) + '...');
    console.log('API Secret (first 8 chars):', apiSecret.substring(0, 8) + '...');
    console.log('Server IP: 208.77.244.15');

    const { getConfig } = await import('../utils/env.js');
    const ccxt = await import('ccxt');
    
    const { EXCHANGE_ID } = getConfig();
    console.log('Exchange ID:', EXCHANGE_ID);
    
    const Klass: any = (ccxt as any)[EXCHANGE_ID];
    
    if (!Klass) {
      return res.json({
        success: false,
        error: `Exchange '${EXCHANGE_ID}' not found`
      });
    }

    // Check required credentials
    const tempExchange = new Klass();
    const requiredCreds = tempExchange.requiredCredentials || {};
    console.log('Required credentials:', requiredCreds);
    
    const config: any = {
      apiKey,
      secret: apiSecret,
      enableRateLimit: true,
    };

    // Only add password if required
    if (requiredCreds.password && passphrase) {
      config.password = passphrase;
      console.log('Added passphrase to config');
    }

    console.log('Creating exchange instance...');
    const exchange = new Klass(config);

    console.log('🚀 Testing balance fetch...');
    
    // Test balance fetch with detailed logging
    const balance = await exchange.fetchBalance();
    
    console.log('✅ Balance fetch successful!');
    console.log('Balance keys:', Object.keys(balance || {}));
    
    res.json({
      success: true,
      message: 'Credentials are valid',
      exchangeId: exchange.id,
      balanceInfo: {
        currencies: Object.keys(balance || {}).length,
        hasFree: !!balance.free,
        hasUsed: !!balance.used,
        hasTotal: !!balance.total,
        sampleCurrencies: Object.keys(balance || {}).slice(0, 5)
      },
      timestamp: new Date().toISOString()
    });

  } catch (error: any) {
    console.error('❌ Credential test failed with detailed error:');
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);
    console.error('Error code:', error.code);
    console.error('Error status:', error.status);
    console.error('Full error object:', JSON.stringify(error, null, 2));
    
    // Extract detailed error information
    const errorDetails = {
      name: error.name || 'Unknown',
      message: error.message || String(error),
      code: error.code || null,
      status: error.status || null,
      statusText: error.statusText || null,
      url: error.url || null,
      headers: error.headers || null,
      stack: error.stack ? error.stack.split('\n').slice(0, 5).join('\n') : null
    };

    // Check for common Crypto.com API errors
    const troubleshooting: string[] = [];
    
    if (error.message?.includes('IP') || error.message?.includes('whitelist') || error.status === 403) {
      troubleshooting.push('❌ IP not whitelisted: Your IP 208.77.244.15 might not be in Crypto.com whitelist');
      troubleshooting.push('🔧 Double-check that 208.77.244.15 is added to your API key whitelist');
    }
    
    if (error.message?.includes('Invalid API key') || error.message?.includes('authentication') || error.status === 401) {
      troubleshooting.push('❌ Invalid credentials: Check your API key and secret are correct');
      troubleshooting.push('🔧 Verify you copied the full API key and secret without spaces');
    }
    
    if (error.message?.includes('permissions') || error.message?.includes('scope')) {
      troubleshooting.push('❌ Insufficient permissions: Your API key needs trading permissions');
      troubleshooting.push('🔧 Enable "Trade" permission on your Crypto.com API key');
    }
    
    if (error.message?.includes('rate') || error.message?.includes('limit')) {
      troubleshooting.push('⏰ Rate limit exceeded: Too many requests');
      troubleshooting.push('🔧 Wait a few minutes before testing again');
    }

    if (troubleshooting.length === 0) {
      troubleshooting.push('🔍 Check Crypto.com API status and your account settings');
      troubleshooting.push('📞 Contact Crypto.com support if the issue persists');
    }
    
    res.json({
      success: false,
      error: 'Credential test failed',
      errorDetails,
      troubleshooting,
      serverIP: '208.77.244.15',
      timestamp: new Date().toISOString(),
      note: 'Check the backend logs for detailed error information'
    });
  }
});

// Apply authentication middleware to protected routes
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
    console.log('Has passphrase:', !!credentials.passphrase);
    console.log('Testnet mode:', credentials.testnet);

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

// Fix API keys for current user (endpoint for manual key update)
router.post('/fix-my-keys', async (req: AuthenticatedRequest, res) => {
  try {
    if (req.user?.isLegacy) {
      return res.status(403).json({ error: 'legacy_users_no_migration' });
    }

    const { newApiKey, newApiSecret } = req.body;

    if (!newApiKey || !newApiSecret) {
      return res.status(400).json({ 
        error: 'missing_fields',
        message: 'Provide newApiKey and newApiSecret in request body'
      });
    }

    console.log('🔧 Fixing API keys for user:', req.user!.id);

    // Find existing key
    const existingKey = await prisma.userApiKey.findFirst({
      where: { 
        userId: req.user!.id,
        exchange: 'crypto.com'
      }
    });

    if (existingKey) {
      // Update existing key
      const updatedKey = await prisma.userApiKey.update({
        where: {
          id: existingKey.id
        },
        data: {
          apiKey: encryptApiKey(newApiKey),
          apiSecret: encryptApiKey(newApiSecret),
          isActive: true
        }
      });

      console.log('✅ Updated existing API key');
      
      // Clear cache to force refresh
      clearUserExchangeCache(req.user!.id);

      res.json({
        success: true,
        message: 'API keys updated successfully',
        keyId: updatedKey.id,
        action: 'updated'
      });
    } else {
      // Create new key
      const newKey = await prisma.userApiKey.create({
        data: {
          userId: req.user!.id,
          exchange: 'crypto.com',
          keyName: 'Fixed Working Key',
          apiKey: encryptApiKey(newApiKey),
          apiSecret: encryptApiKey(newApiSecret),
          testnet: false,
          isActive: true
        }
      });

      console.log('✅ Created new API key');

      res.json({
        success: true,
        message: 'API keys created successfully',
        keyId: newKey.id,
        action: 'created'
      });
    }

  } catch (error: any) {
    console.error('Fix keys error:', error);
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

// Diagnose API key issues step by step
router.get('/diagnose-apikeys', async (req: AuthenticatedRequest, res) => {
  try {
    if (req.user?.isLegacy) {
      return res.json({ 
        step: 'user_check',
        success: false,
        message: 'Legacy users cannot use API keys',
        isLegacy: true
      });
    }

    const userId = req.user!.id;
    const results: any[] = [];

    // Step 1: Check if user has API keys in database
    results.push({ step: 'database_check', message: 'Checking for API keys in database...' });
    
    const rawKeys = await prisma.userApiKey.findMany({
      where: { userId, exchange: 'crypto.com' },
      select: {
        id: true,
        keyName: true,
        isActive: true,
        testnet: true,
        createdAt: true
      }
    });

    if (rawKeys.length === 0) {
      return res.json({
        step: 'database_check',
        success: false,
        message: 'No API keys found in database',
        results
      });
    }

    results.push({ 
      step: 'database_check', 
      success: true, 
      message: `Found ${rawKeys.length} API key(s)`,
      keys: rawKeys
    });

    // Step 2: Try to decrypt credentials
    results.push({ step: 'decryption_check', message: 'Attempting to decrypt API keys...' });
    
    const credentials = await getUserCredentials(userId, 'crypto.com');
    
    if (!credentials) {
      return res.json({
        step: 'decryption_check',
        success: false,
        message: 'Failed to decrypt API keys - they may be corrupted',
        results
      });
    }

    results.push({ 
      step: 'decryption_check', 
      success: true, 
      message: 'API keys decrypted successfully',
      keyLength: credentials.apiKey.length,
      secretLength: credentials.apiSecret.length,
      hasPassphrase: !!credentials.passphrase,
      testnet: credentials.testnet
    });

    // Step 3: Test basic exchange connection
    results.push({ step: 'exchange_check', message: 'Testing exchange connection...' });
    
    try {
      const exchange = await getUserExchange(userId, credentials);
      results.push({ 
        step: 'exchange_check', 
        success: true, 
        message: 'Exchange instance created successfully',
        exchangeId: exchange.id,
        marketsCount: Object.keys(exchange.markets || {}).length
      });
    } catch (exchangeError: any) {
      results.push({ 
        step: 'exchange_check', 
        success: false, 
        message: 'Failed to create exchange instance',
        error: exchangeError.message || String(exchangeError)
      });
      return res.json({ step: 'exchange_check', success: false, results });
    }

    // Step 4: Test API credentials validation
    results.push({ step: 'validation_check', message: 'Validating API credentials...' });
    
    const isValid = await validateUserCredentials(credentials);
    results.push({ 
      step: 'validation_check', 
      success: isValid, 
      message: isValid ? 'API credentials are valid' : 'API credentials validation failed'
    });

    if (!isValid) {
      return res.json({ step: 'validation_check', success: false, results });
    }

    // Step 5: Test balance fetch
    results.push({ step: 'balance_check', message: 'Fetching account balance...' });
    
    try {
      const exchange = await getUserExchange(userId, credentials);
      const balance = await exchange.fetchBalance();
      
      results.push({ 
        step: 'balance_check', 
        success: true, 
        message: 'Balance fetched successfully',
        currencies: Object.keys(balance || {}).length,
        hasFree: !!balance.free,
        hasUsed: !!balance.used,
        hasTotal: !!balance.total
      });
    } catch (balanceError: any) {
      results.push({ 
        step: 'balance_check', 
        success: false, 
        message: 'Failed to fetch balance',
        error: balanceError.message || String(balanceError),
        errorCode: balanceError.code,
        errorStatus: balanceError.status
      });
      return res.json({ step: 'balance_check', success: false, results });
    }

    // All checks passed
    res.json({
      step: 'complete',
      success: true,
      message: 'All API key checks passed successfully',
      results
    });

  } catch (error: any) {
    console.error('Diagnose API keys error:', error);
    res.status(500).json({
      step: 'server_error',
      success: false,
      error: error.message || String(error)
    });
  }
});
import { Router } from 'express';
import { authenticateUser, AuthenticatedRequest } from '../middleware/auth.js';
import { getUserCredentials } from '../services/userCredentials.js';
import { getUserExchange, validateUserCredentials } from '../exchange/ccxtClient.js';

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

    // Test 3: Try different API calls
    let status = null;
    let statusError = '';
    try {
      const exchange = await getUserExchange(req.user!.id, credentials);
      status = await exchange.fetchStatus();
      console.log('Exchange status:', status);
    } catch (error: any) {
      statusError = error.message || String(error);
      console.error('Status fetch error:', statusError);
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
        status: {
          success: !!status,
          data: status,
          error: statusError
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
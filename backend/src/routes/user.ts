import { Router } from 'express';
import { authenticateUser, AuthenticatedRequest, requireRole } from '../middleware/auth.js';
import { prisma } from '../db/client.js';
import { encryptApiKey, decryptApiKey } from '../utils/crypto.js';
import { getUserExchange, validateUserCredentials } from '../exchange/ccxtClient.js';
import { getUserCredentials } from '../services/userCredentials.js';

export const router = Router();

function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

// Apply authentication middleware to all routes
router.use(authenticateUser);

// Get user's API keys
router.get('/api-keys', async (req: AuthenticatedRequest, res) => {
  try {
    const apiKeys = await prisma.userApiKey.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' }
    });

    // Return API keys with masked values (for display)
    const decryptedKeys = apiKeys.map(key => {
      let maskedApiKey = '****';
      let decryptError = false;
      try {
        maskedApiKey = maskKey(decryptApiKey(key.apiKey));
      } catch {
        decryptError = true;
        maskedApiKey = '⚠️ re-enter key';
      }
      return {
        id: key.id,
        exchange: key.exchange,
        keyName: key.keyName,
        apiKey: maskedApiKey,
        testnet: key.testnet,
        isActive: key.isActive,
        createdAt: key.createdAt,
        decryptError,
      };
    });

    res.json({ apiKeys: decryptedKeys });
  } catch (error) {
    console.error('Get API keys error:', error);
    res.status(500).json({ error: 'server_error' });
  }
});

// Add new API key
router.post('/api-keys', async (req: AuthenticatedRequest, res) => {
  try {
    const { exchange, keyName, apiKey, apiSecret } = req.body;

    if (!exchange || !apiKey || !apiSecret) {
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    // Allow crypto.com and binance
    const supportedExchanges = ['crypto.com', 'binance'];
    if (!supportedExchanges.includes(exchange)) {
      return res.status(400).json({ 
        error: 'unsupported_exchange',
        message: `Only ${supportedExchanges.join(', ')} are supported`
      });
    }

    // Check if user already has an API key for this exchange
    const existingKey = await prisma.userApiKey.findUnique({
      where: {
        userId_exchange_testnet: {
          userId: req.user!.id,
          exchange,
          testnet: false
        }
      }
    });

    // Encrypt the sensitive data
    const encryptedApiKey = encryptApiKey(apiKey);
    const encryptedApiSecret = encryptApiKey(apiSecret);

    let newApiKey;
    if (existingKey) {
      // Update existing key (re-enter scenario)
      newApiKey = await prisma.userApiKey.update({
        where: { id: existingKey.id },
        data: {
          keyName: keyName || existingKey.keyName,
          apiKey: encryptedApiKey,
          apiSecret: encryptedApiSecret,
          isActive: true,
        }
      });
    } else {
      newApiKey = await prisma.userApiKey.create({
        data: {
          userId: req.user!.id,
          exchange,
          keyName: keyName || null,
          apiKey: encryptedApiKey,
          apiSecret: encryptedApiSecret,
          passphrase: null,
          testnet: false,
          isActive: true
        }
      });
    }

    res.status(201).json({
      apiKey: {
        id: newApiKey.id,
        exchange: newApiKey.exchange,
        keyName: newApiKey.keyName,
        testnet: newApiKey.testnet,
        isActive: newApiKey.isActive,
        createdAt: newApiKey.createdAt
      }
    });
  } catch (error) {
    console.error('Add API key error:', error);
    res.status(500).json({ error: 'server_error' });
  }
});

// Toggle API key active status
router.patch('/api-keys/:keyId/toggle', async (req: AuthenticatedRequest, res) => {
  try {
    const { keyId } = req.params;

    const apiKey = await prisma.userApiKey.findFirst({
      where: {
        id: keyId,
        userId: req.user!.id
      }
    });

    if (!apiKey) {
      return res.status(404).json({ error: 'api_key_not_found' });
    }

    // If activating this key, deactivate all others for this user
    if (!apiKey.isActive) {
      await prisma.userApiKey.updateMany({
        where: {
          userId: req.user!.id,
          id: { not: keyId }
        },
        data: { isActive: false }
      });
    }

    // Toggle the status
    const updated = await prisma.userApiKey.update({
      where: { id: keyId },
      data: { isActive: !apiKey.isActive }
    });

    res.json({
      apiKey: {
        id: updated.id,
        exchange: updated.exchange,
        keyName: updated.keyName,
        testnet: updated.testnet,
        isActive: updated.isActive,
        createdAt: updated.createdAt
      }
    });
  } catch (error) {
    console.error('Toggle API key error:', error);
    res.status(500).json({ error: 'server_error' });
  }
});

// Delete API key
router.delete('/api-keys/:keyId', async (req: AuthenticatedRequest, res) => {
  try {
    const { keyId } = req.params;

    const apiKey = await prisma.userApiKey.findFirst({
      where: {
        id: keyId,
        userId: req.user!.id
      }
    });

    if (!apiKey) {
      return res.status(404).json({ error: 'api_key_not_found' });
    }

    await prisma.userApiKey.delete({
      where: { id: keyId }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Delete API key error:', error);
    res.status(500).json({ error: 'server_error' });
  }
});

// Get user settings
router.get('/settings', async (req: AuthenticatedRequest, res) => {
  try {
    const settings = await prisma.userSetting.findMany({
      where: { userId: req.user!.id },
      orderBy: { category: 'asc' }
    });

    res.json({ settings });
  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({ error: 'server_error' });
  }
});

// Update user setting
router.put('/settings/:key', async (req: AuthenticatedRequest, res) => {
  try {
    const { key } = req.params;
    const { value, category } = req.body;

    if (value === undefined) {
      return res.status(400).json({ error: 'value_required' });
    }

    const setting = await prisma.userSetting.upsert({
      where: {
        userId_key: {
          userId: req.user!.id,
          key
        }
      },
      update: {
        value: String(value)
      },
      create: {
        userId: req.user!.id,
        key,
        value: String(value),
        category: category || 'general'
      }
    });

    res.json({ setting });
  } catch (error) {
    console.error('Update setting error:', error);
    res.status(500).json({ error: 'server_error' });
  }
});

// Check overall API key health status
router.get('/api-keys/health', async (req: AuthenticatedRequest, res) => {
  try {
    const apiKeys = await prisma.userApiKey.findMany({
      where: {
        userId: req.user!.id
      }
    });

    if (apiKeys.length === 0) {
      return res.json({ 
        hasKeys: false, 
        needsDiagnostics: true, 
        needsMigration: false,
        status: 'no_keys' 
      });
    }

    // Test the primary exchange (crypto.com)
    const primaryKey = apiKeys.find(k => k.exchange === 'crypto.com' || k.exchange === 'cryptocom');
    if (!primaryKey) {
      return res.json({ 
        hasKeys: true, 
        needsDiagnostics: true, 
        needsMigration: false,
        status: 'missing_primary_exchange' 
      });
    }

    // Quick validation test
    try {
      const userCredentials = await getUserCredentials(req.user!.id);
      if (userCredentials) {
        const isValid = await validateUserCredentials(userCredentials);
        if (isValid) {
          return res.json({ 
            hasKeys: true, 
            needsDiagnostics: false, 
            needsMigration: false,
            status: 'healthy' 
          });
        } else {
          return res.json({ 
            hasKeys: true, 
            needsDiagnostics: true, 
            needsMigration: false,
            status: 'invalid_credentials' 
          });
        }
      } else {
        return res.json({ 
          hasKeys: true, 
          needsDiagnostics: true, 
          needsMigration: false,
          status: 'no_credentials_found' 
        });
      }
    } catch (error) {
      return res.json({ 
        hasKeys: true, 
        needsDiagnostics: true, 
        needsMigration: false,
        status: 'validation_error' 
      });
    }

  } catch (error) {
    console.error('API key health check error:', error);
    res.status(500).json({ error: 'server_error' });
  }
});

// Get decrypted API key for trading (internal use)
router.get('/api-keys/:exchange/credentials', async (req: AuthenticatedRequest, res) => {
  try {
    const { exchange } = req.params;

    const apiKey = await prisma.userApiKey.findFirst({
      where: {
        userId: req.user!.id,
        exchange,
        testnet: false,
        isActive: true
      }
    });

    if (!apiKey) {
      return res.status(404).json({ error: 'api_key_not_found' });
    }

    // Return masked credentials (never expose full keys via API)
    let maskedKey = '****', maskedSecret = '****';
    try {
      maskedKey = maskKey(decryptApiKey(apiKey.apiKey));
      maskedSecret = maskKey(decryptApiKey(apiKey.apiSecret));
    } catch {
      return res.json({ credentials: { apiKey: '⚠️ re-enter key', apiSecret: '⚠️ re-enter key', passphrase: null, testnet: false, decryptError: true } });
    }

    res.json({ credentials: { apiKey: maskedKey, apiSecret: maskedSecret, passphrase: null, testnet: false } });
  } catch (error) {
    console.error('Get credentials error:', error);
    res.status(500).json({ error: 'server_error' });
  }
});

// Check API keys status and validate them
router.get('/api-keys/status', async (req: AuthenticatedRequest, res) => {
  try {
    // Get active API key (any exchange)
    const credentials = await getUserCredentials(req.user!.id);
    
    if (!credentials) {
      return res.json({ 
        hasApiKeys: false, 
        isValid: false, 
        canUseLive: false,
        message: 'No API keys configured. Please add your exchange API keys to enable live trading.' 
      });
    }

    // ✅ SAFE API KEY VALIDATION (0 weight for Binance)
    let isValid = false;
    let errorDetails = '';
    
    try {
      // Use exchange-specific lightweight validation
      if (credentials.exchange === 'binance') {
        // Binance: Use listenKey endpoint (0 weight) via WebSocket service
        const { validateBinanceApiKey } = await import('../services/binanceWebSocket.js');
        const result = await validateBinanceApiKey(credentials.apiKey, credentials.apiSecret);
        isValid = result.valid;
        if (!result.valid) {
          errorDetails = result.error || 'Invalid API keys';
        }
      } else if (credentials.exchange === 'crypto.com') {
        // Crypto.com: Safe to use fetchBalance (no aggressive bans)
        const { validateCryptocomApiKey } = await import('../services/binanceWebSocket.js');
        const result = await validateCryptocomApiKey(credentials.apiKey, credentials.apiSecret);
        isValid = result.valid;
        if (!result.valid) {
          errorDetails = result.error || 'Invalid API keys';
        }
      } else {
        // Unknown exchange: skip validation
        isValid = true;
        console.log(`⚠️ Unknown exchange ${credentials.exchange}, validation skipped`);
      }
      
      console.log(`${isValid ? '✅' : '❌'} API key validation for ${credentials.exchange}: ${isValid ? 'SUCCESS' : errorDetails}`);
      
    } catch (error: any) {
      console.error('API key validation error:', error);
      errorDetails = error.message || 'Validation failed';
      isValid = false;
    }

    res.json({
      hasApiKeys: true,
      isValid,
      canUseLive: isValid,
      exchange: credentials.exchange, // Include active exchange
      message: isValid 
        ? `API keys are configured and valid (${credentials.exchange.toUpperCase()})` 
        : `API keys are configured but invalid (${credentials.exchange.toUpperCase()}). ${errorDetails ? `Error: ${errorDetails}` : 'Please check your keys and ensure your server IP is whitelisted'}`
    });
  } catch (error) {
    console.error('API keys status check error:', error);
    res.status(500).json({ error: 'server_error' });
  }
});

// ============================================
// SYSTEM SETTINGS (Global, read-only for users, admin can modify)
// ============================================

// Get all system settings (available to all authenticated users)
router.get('/system-settings', async (req: AuthenticatedRequest, res) => {
  try {
    const settings = await prisma.systemSetting.findMany({
      orderBy: { key: 'asc' }
    });

    res.json({ settings });
  } catch (error) {
    console.error('Get system settings error:', error);
    res.status(500).json({ error: 'server_error' });
  }
});

// Get specific system setting
router.get('/system-settings/:key', async (req: AuthenticatedRequest, res) => {
  try {
    const { key } = req.params;
    
    const setting = await prisma.systemSetting.findUnique({
      where: { key }
    });

    if (!setting) {
      return res.status(404).json({ error: 'setting_not_found' });
    }

    res.json({ setting });
  } catch (error) {
    console.error('Get system setting error:', error);
    res.status(500).json({ error: 'server_error' });
  }
});

// Update system setting (admin only)
router.put('/system-settings/:key', requireRole(['admin']), async (req: AuthenticatedRequest, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;

    if (value === undefined) {
      return res.status(400).json({ error: 'value_required' });
    }

    const setting = await prisma.systemSetting.upsert({
      where: { key },
      update: {
        value: String(value)
      },
      create: {
        key,
        value: String(value)
      }
    });

    res.json({ setting });
  } catch (error) {
    console.error('Update system setting error:', error);
    res.status(500).json({ error: 'server_error' });
  }
});

// Delete system setting (admin only)
router.delete('/system-settings/:key', requireRole(['admin']), async (req: AuthenticatedRequest, res) => {
  try {
    const { key } = req.params;

    await prisma.systemSetting.delete({
      where: { key }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Delete system setting error:', error);
    res.status(500).json({ error: 'server_error' });
  }
});

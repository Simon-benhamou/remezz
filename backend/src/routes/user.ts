import { Router } from 'express';
import { authenticateUser, AuthenticatedRequest } from '../middleware/auth.js';
import { prisma } from '../db/client.js';
import { encryptApiKey, decryptApiKey } from '../utils/crypto.js';
import { getUserExchange, validateUserCredentials } from '../exchange/ccxtClient.js';
import { getUserCredentials } from '../services/userCredentials.js';

export const router = Router();

// Apply authentication middleware to all routes
router.use(authenticateUser);

// Get user's API keys
router.get('/api-keys', async (req: AuthenticatedRequest, res) => {
  try {
    if (req.user?.isLegacy) {
      return res.json({ apiKeys: [] });
    }

    const apiKeys = await prisma.userApiKey.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' }
    });

    // Return API keys with decrypted values (for display)
    const decryptedKeys = apiKeys.map(key => ({
      id: key.id,
      exchange: key.exchange,
      keyName: key.keyName,
      apiKey: decryptApiKey(key.apiKey),
      testnet: key.testnet,
      isActive: key.isActive,
      createdAt: key.createdAt
    }));

    res.json({ apiKeys: decryptedKeys });
  } catch (error) {
    console.error('Get API keys error:', error);
    res.status(500).json({ error: 'server_error' });
  }
});

// Add new API key
router.post('/api-keys', async (req: AuthenticatedRequest, res) => {
  try {
    if (req.user?.isLegacy) {
      return res.status(403).json({ error: 'legacy_users_cannot_add_api_keys' });
    }

    const { exchange, keyName, apiKey, apiSecret } = req.body;

    if (!exchange || !apiKey || !apiSecret) {
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    // Only allow crypto.com for now
    if (exchange !== 'crypto.com') {
      return res.status(400).json({ error: 'only_crypto_com_supported' });
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

    if (existingKey) {
      return res.status(400).json({ error: 'api_key_already_exists_for_exchange' });
    }

    // Encrypt the sensitive data
    const encryptedApiKey = encryptApiKey(apiKey);
    const encryptedApiSecret = encryptApiKey(apiSecret);

    const newApiKey = await prisma.userApiKey.create({
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

// Delete API key
router.delete('/api-keys/:keyId', async (req: AuthenticatedRequest, res) => {
  try {
    if (req.user?.isLegacy) {
      return res.status(403).json({ error: 'legacy_users_cannot_delete_api_keys' });
    }

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
    if (req.user?.isLegacy) {
      return res.json({ settings: [] });
    }

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
    if (req.user?.isLegacy) {
      return res.status(403).json({ error: 'legacy_users_cannot_update_settings' });
    }

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

// Get decrypted API key for trading (internal use)
router.get('/api-keys/:exchange/credentials', async (req: AuthenticatedRequest, res) => {
  try {
    if (req.user?.isLegacy) {
      return res.status(404).json({ error: 'no_api_keys_for_legacy_users' });
    }

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

    // Decrypt for internal use
    const credentials = {
      apiKey: decryptApiKey(apiKey.apiKey),
      apiSecret: decryptApiKey(apiKey.apiSecret),
      passphrase: null,
      testnet: false
    };

    res.json({ credentials });
  } catch (error) {
    console.error('Get credentials error:', error);
    res.status(500).json({ error: 'server_error' });
  }
});

// Check API keys status and validate them
router.get('/api-keys/status', async (req: AuthenticatedRequest, res) => {
  try {
    if (req.user?.isLegacy) {
      return res.json({ 
        hasApiKeys: false, 
        isValid: false, 
        canUseLive: false,
        message: 'Legacy users cannot configure API keys. Please register a new account.' 
      });
    }

    const credentials = await getUserCredentials(req.user!.id, 'crypto.com');
    
    if (!credentials) {
      return res.json({ 
        hasApiKeys: false, 
        isValid: false, 
        canUseLive: false,
        message: 'No API keys configured. Please add your Crypto.com API keys to enable live trading.' 
      });
    }

    // Validate credentials by testing API connection (simple version)
    let isValid = false;
    try {
      // Simple test: try to get user exchange instance
      const exchange = await getUserExchange(req.user!.id, credentials);
      if (exchange) {
        isValid = true;
      }
    } catch (error) {
      console.error('API key validation failed:', error);
      isValid = false;
    }

    res.json({
      hasApiKeys: true,
      isValid,
      canUseLive: isValid,
      message: isValid 
        ? 'API keys are configured and valid' 
        : 'API keys are configured but invalid. Please check your keys and IP whitelist (208.77.244.15)'
    });
  } catch (error) {
    console.error('API keys status check error:', error);
    res.status(500).json({ error: 'server_error' });
  }
});

import { prisma } from '../db/client.js';
import { decryptApiKey } from '../utils/crypto.js';
import { AuthenticatedRequest } from '../middleware/auth.js';

export interface UserCredentials {
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
  testnet: boolean;
}

export async function getUserCredentials(userId: string, exchange: string = 'crypto.com'): Promise<UserCredentials | null> {
  try {
    const apiKey = await prisma.userApiKey.findFirst({
      where: {
        userId,
        exchange,
        testnet: false,
        isActive: true
      }
    });

    if (!apiKey) {
      return null;
    }

    try {
      return {
        apiKey: decryptApiKey(apiKey.apiKey),
        apiSecret: decryptApiKey(apiKey.apiSecret),
        passphrase: apiKey.passphrase ? decryptApiKey(apiKey.passphrase) : undefined,
        testnet: apiKey.testnet
      };
    } catch (decryptError) {
      console.error('Failed to decrypt API keys for user:', userId, decryptError);
      // API key exists but cannot be decrypted - probably due to encryption algorithm change
      return null;
    }
  } catch (error) {
    console.error('Failed to get user credentials:', error);
    return null;
  }
}

export async function requireUserCredentials(req: AuthenticatedRequest, exchange: string = 'crypto.com'): Promise<UserCredentials> {
  if (req.user?.isLegacy) {
    throw new Error('LEGACY_USER_NO_API_KEYS');
  }

  if (!req.user?.id) {
    throw new Error('USER_NOT_AUTHENTICATED');
  }

  const credentials = await getUserCredentials(req.user.id, exchange);
  
  if (!credentials) {
    throw new Error('API_KEYS_NOT_CONFIGURED');
  }

  return credentials;
}

export function createApiKeyRequiredError() {
  return {
    error: 'api_keys_required',
    message: 'You must configure your Crypto.com API keys before using live trading features',
    action: 'configure_api_keys'
  };
}

export function createInvalidApiKeyError() {
  return {
    error: 'invalid_api_keys',
    message: 'Your API keys are invalid or have insufficient permissions',
    action: 'check_api_keys'
  };
}
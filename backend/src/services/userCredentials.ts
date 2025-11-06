import { prisma as defaultPrisma } from '../db/client.js';
import { decryptApiKey as defaultDecryptApiKey } from '../utils/crypto.js';
import { AuthenticatedRequest } from '../middleware/auth.js';

export interface UserCredentials {
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
  testnet: boolean;
  exchange: string;
}

type PrismaClientLike = typeof defaultPrisma;
type DecryptFn = typeof defaultDecryptApiKey;

let prismaClient: PrismaClientLike = defaultPrisma;
let decryptFn: DecryptFn = defaultDecryptApiKey;

export function __setUserCredentialsTestOverrides(overrides?: {
  prisma?: PrismaClientLike;
  decryptApiKey?: DecryptFn;
}): void {
  prismaClient = overrides?.prisma ?? defaultPrisma;
  decryptFn = overrides?.decryptApiKey ?? defaultDecryptApiKey;
}

export function __resetUserCredentialsTestOverrides(): void {
  prismaClient = defaultPrisma;
  decryptFn = defaultDecryptApiKey;
}

export async function getUserCredentials(userId: string, exchange?: string): Promise<UserCredentials | null> {
  try {
    console.log('[getUserCredentials] Looking for API keys:', { userId, exchange });
    
    // If exchange specified, get that specific one
    // Otherwise, get the ACTIVE one (regardless of exchange)
    const apiKey = await prismaClient.userApiKey.findFirst({
      where: {
        userId,
        ...(exchange ? { exchange } : {}), // Optional filter by exchange
        testnet: false,
        isActive: true
      },
      orderBy: {
        updatedAt: 'desc' // Most recently updated first
      }
    });

    console.log('[getUserCredentials] API key found:', !!apiKey, apiKey ? { exchange: apiKey.exchange, testnet: apiKey.testnet, isActive: apiKey.isActive } : null);

    if (!apiKey) {
      console.log('[getUserCredentials] No API key found for user:', userId, 'exchange:', exchange);
      return null;
    }

    try {
      const decrypted = {
        apiKey: decryptFn(apiKey.apiKey),
        apiSecret: decryptFn(apiKey.apiSecret),
        passphrase: apiKey.passphrase ? decryptFn(apiKey.passphrase) : undefined,
        testnet: apiKey.testnet,
        exchange: apiKey.exchange
      };
      console.log('[getUserCredentials] Successfully decrypted API keys for exchange:', apiKey.exchange);
      return decrypted;
    } catch (decryptError) {
      console.error('[getUserCredentials] Failed to decrypt API keys for user:', userId, decryptError);
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

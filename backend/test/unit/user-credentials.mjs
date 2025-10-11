import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

process.env.UNIT_TEST_MODE = 'true';

const serviceModuleUrl = new URL('../../dist/src/services/userCredentials.js', import.meta.url).href;
const cryptoMockUrl = new URL('data:text/javascript,export const decryptApiKey = (...args) => globalThis.__decryptApiKeyMock(...args);', import.meta.url).href;
const prismaMockUrl = new URL('data:text/javascript,export const prisma = globalThis.__prismaMock; export const prismaIsInMemory = true;', import.meta.url).href;

let decryptBehavior = () => {
  throw new Error('decryptApiKey mock not configured');
};
let decryptCallArgs = [];

let findFirstBehavior = async () => {
  throw new Error('findFirst mock not configured');
};
let findFirstCallCount = 0;

const prismaMock = {
  userApiKey: {
    async findFirst(...args) {
      findFirstCallCount += 1;
      return findFirstBehavior(...args);
    }
  }
};

globalThis.__decryptApiKeyMock = (...args) => {
  decryptCallArgs.push(args);
  return decryptBehavior(...args);
};

globalThis.__prismaMock = prismaMock;

const hooks = registerHooks({
  resolve(specifier, context, defaultResolve) {
    if (context.parentURL === serviceModuleUrl && specifier === '../utils/crypto.js') {
      return { url: cryptoMockUrl, shortCircuit: true };
    }
    if (context.parentURL === serviceModuleUrl && specifier === '../db/client.js') {
      return { url: prismaMockUrl, shortCircuit: true };
    }
    return defaultResolve(specifier, context, defaultResolve);
  },
  load(url, context, defaultLoad) {
    if (url === cryptoMockUrl) {
      return {
        shortCircuit: true,
        format: 'module',
        source: 'export const decryptApiKey = (...args) => globalThis.__decryptApiKeyMock(...args);'
      };
    }
    if (url === prismaMockUrl) {
      return {
        shortCircuit: true,
        format: 'module',
        source: 'export const prisma = globalThis.__prismaMock; export const prismaIsInMemory = true;'
      };
    }
    return defaultLoad(url, context, defaultLoad);
  }
});

const { requireUserCredentials } = await import(serviceModuleUrl);

function setDecryptMock(fn) {
  decryptBehavior = fn;
  decryptCallArgs = [];
}

function setFindFirstMock(fn) {
  findFirstBehavior = fn;
  findFirstCallCount = 0;
}

function getDecryptCallCount() {
  return decryptCallArgs.length;
}

function getFindFirstCallCount() {
  return findFirstCallCount;
}

// Success scenario: decrypting active API keys yields credentials
{
  const decryptedValues = new Map([
    ['enc-key', 'live-api-key'],
    ['enc-secret', 'live-api-secret'],
    ['enc-pass', 'live-passphrase']
  ]);

  setDecryptMock((value) => {
    if (!decryptedValues.has(value)) {
      throw new Error(`unexpected encrypted value: ${value}`);
    }
    return decryptedValues.get(value);
  });

  setFindFirstMock(async ({ where }) => {
    assert.equal(where.userId, 'user-123');
    assert.equal(where.exchange, 'crypto.com');
    assert.equal(where.testnet, false);
    assert.equal(where.isActive, true);
    return {
      apiKey: 'enc-key',
      apiSecret: 'enc-secret',
      passphrase: 'enc-pass',
      testnet: false,
      exchange: 'crypto.com'
    };
  });

  const credentials = await requireUserCredentials(
    { user: { id: 'user-123', isLegacy: false } },
    'crypto.com'
  );

  assert.deepEqual(credentials, {
    apiKey: 'live-api-key',
    apiSecret: 'live-api-secret',
    passphrase: 'live-passphrase',
    testnet: false,
    exchange: 'crypto.com'
  });
  assert.equal(getFindFirstCallCount(), 1);
  assert.equal(getDecryptCallCount(), 3);
}

// Legacy user scenario: must throw without hitting the database
{
  setDecryptMock(() => {
    throw new Error('decrypt should not be invoked for legacy users');
  });
  setFindFirstMock(async () => {
    throw new Error('findFirst should not be invoked for legacy users');
  });

  await assert.rejects(
    () => requireUserCredentials({ user: { id: 'legacy-user', isLegacy: true } }),
    (err) => {
      assert.equal(err.message, 'LEGACY_USER_NO_API_KEYS');
      return true;
    }
  );
  assert.equal(getFindFirstCallCount(), 0);
  assert.equal(getDecryptCallCount(), 0);
}

// Missing user id scenario: should raise authentication error
{
  setDecryptMock(() => {
    throw new Error('decrypt should not be invoked when user ID missing');
  });
  setFindFirstMock(async () => {
    throw new Error('findFirst should not be invoked when user ID missing');
  });

  await assert.rejects(
    () => requireUserCredentials({ user: { isLegacy: false } }),
    (err) => {
      assert.equal(err.message, 'USER_NOT_AUTHENTICATED');
      return true;
    }
  );
  assert.equal(getFindFirstCallCount(), 0);
  assert.equal(getDecryptCallCount(), 0);
}

// Missing API keys scenario: database returns nothing -> configuration error
{
  setDecryptMock(() => {
    throw new Error('decrypt should not be invoked when no API keys are stored');
  });
  setFindFirstMock(async () => null);

  await assert.rejects(
    () => requireUserCredentials({ user: { id: 'user-no-keys', isLegacy: false } }),
    (err) => {
      assert.equal(err.message, 'API_KEYS_NOT_CONFIGURED');
      return true;
    }
  );
  assert.equal(getFindFirstCallCount(), 1);
  assert.equal(getDecryptCallCount(), 0);
}

// Undecryptable API keys scenario: decryption throws -> configuration error
{
  setFindFirstMock(async () => ({
    apiKey: 'enc-key',
    apiSecret: 'bad-secret',
    passphrase: null,
    testnet: false,
    exchange: 'crypto.com'
  }));
  setDecryptMock((value) => {
    if (value === 'enc-key') return 'live-api-key';
    if (value === 'bad-secret') throw new Error('cannot decrypt secret');
    throw new Error(`unexpected encrypted value: ${value}`);
  });

  await assert.rejects(
    () => requireUserCredentials({ user: { id: 'user-bad-keys', isLegacy: false } }),
    (err) => {
      assert.equal(err.message, 'API_KEYS_NOT_CONFIGURED');
      return true;
    }
  );
  assert.equal(getFindFirstCallCount(), 1);
  assert.equal(getDecryptCallCount(), 2);
}

hooks.deregister();
delete globalThis.__decryptApiKeyMock;
delete globalThis.__prismaMock;

console.log('✅ user-credentials unit tests passed');

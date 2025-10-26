import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';

const {
  requireUserCredentials,
  __setUserCredentialsTestOverrides,
  __resetUserCredentialsTestOverrides,
} = await import('../../dist/src/services/userCredentials.js');

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
    },
  },
};

const decryptProxy = (...args) => {
  decryptCallArgs.push(args);
  return decryptBehavior(...args);
};

function applyOverrides() {
  __setUserCredentialsTestOverrides({
    prisma: prismaMock,
    decryptApiKey: decryptProxy,
  });
}

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
  applyOverrides();
  const decryptedValues = new Map([
    ['enc-key', 'live-api-key'],
    ['enc-secret', 'live-api-secret'],
    ['enc-pass', 'live-passphrase'],
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
      exchange: 'crypto.com',
    };
  });

  const credentials = await requireUserCredentials(
    { user: { id: 'user-123', isLegacy: false } },
    'crypto.com',
  );

  assert.deepEqual(credentials, {
    apiKey: 'live-api-key',
    apiSecret: 'live-api-secret',
    passphrase: 'live-passphrase',
    testnet: false,
    exchange: 'crypto.com',
  });
  assert.equal(getFindFirstCallCount(), 1);
  assert.equal(getDecryptCallCount(), 3);
}

// Legacy user scenario: must throw without hitting the database
{
  applyOverrides();
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
    },
  );
  assert.equal(getFindFirstCallCount(), 0);
  assert.equal(getDecryptCallCount(), 0);
}

// Missing user id scenario: should raise authentication error
{
  applyOverrides();
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
    },
  );
  assert.equal(getFindFirstCallCount(), 0);
  assert.equal(getDecryptCallCount(), 0);
}

// Missing API keys scenario: database returns nothing -> configuration error
{
  applyOverrides();
  setDecryptMock(() => {
    throw new Error('decrypt should not be invoked when no API keys are stored');
  });
  setFindFirstMock(async () => null);

  await assert.rejects(
    () => requireUserCredentials({ user: { id: 'user-no-keys', isLegacy: false } }),
    (err) => {
      assert.equal(err.message, 'API_KEYS_NOT_CONFIGURED');
      return true;
    },
  );
  assert.equal(getFindFirstCallCount(), 1);
  assert.equal(getDecryptCallCount(), 0);
}

// Undecryptable API keys scenario: decryption throws -> configuration error
{
  applyOverrides();
  setFindFirstMock(async () => ({
    apiKey: 'enc-key',
    apiSecret: 'bad-secret',
    passphrase: null,
    testnet: false,
    exchange: 'crypto.com',
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
    },
  );
  assert.equal(getFindFirstCallCount(), 1);
  assert.equal(getDecryptCallCount(), 2);
}

__resetUserCredentialsTestOverrides();

console.log('✅ user-credentials unit tests passed');

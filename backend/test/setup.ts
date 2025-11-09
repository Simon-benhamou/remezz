/**
 * Jest Test Setup
 * 
 * This file runs before all tests to configure the test environment.
 */

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.UNIT_TEST_MODE = 'true';

// Increase timeout for integration tests
jest.setTimeout(30000);

// Mock console methods to reduce noise in test output (optional)
global.console = {
  ...console,
  // Uncomment to silence logs during tests
  // log: jest.fn(),
  // debug: jest.fn(),
  // info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

// Add custom matchers if needed
expect.extend({
  toBeWithinRange(received: number, floor: number, ceiling: number) {
    const pass = received >= floor && received <= ceiling;
    if (pass) {
      return {
        message: () =>
          `expected ${received} not to be within range ${floor} - ${ceiling}`,
        pass: true,
      };
    } else {
      return {
        message: () =>
          `expected ${received} to be within range ${floor} - ${ceiling}`,
        pass: false,
      };
    }
  },
});

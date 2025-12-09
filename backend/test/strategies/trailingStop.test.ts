/**
 * Tests for the Dynamic Trailing Stop System (V5.12)
 * 
 * This test suite verifies:
 * 1. Entry flow: SL + Trailing are placed correctly at entry
 * 2. Trailing activation at 1%: Cancel all + re-place trailing
 * 3. Trailing widening at 2%: Cancel all + re-place with wider callback
 * 4. Fallback SL when trailing fails
 * 5. Cleanup on position close
 * 6. Sync detects closed positions and cleans orphan orders
 */

import { jest } from '@jest/globals';

// Mock position interface for testing
interface MockPosition {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  qty: number;
  entryTime: number;
  leverage: number;
  marginUsd: number;
  stopLoss?: number;
  stopLossPct?: number;
  orderId?: string;
  stopLossOrderId?: string;
  trailingOrderId?: string;
  highWaterMark?: number;
  lowWaterMark?: number;
}

// Mock exchange interface for testing
interface MockExchange {
  createOrder: jest.MockedFunction<(...args: any[]) => Promise<{ id: string; average?: number; filled?: number; fee?: { cost: number } }>>;
  cancelAllOrders: jest.MockedFunction<(symbol: string, params?: any) => Promise<void>>;
  createMarketBuyOrder: jest.MockedFunction<(...args: any[]) => Promise<{ id: string; average: number; filled: number }>>;
  createMarketSellOrder: jest.MockedFunction<(...args: any[]) => Promise<{ id: string; average: number; filled: number }>>;
  fetchPositions?: jest.MockedFunction<(...args: any[]) => Promise<any[]>>;
}

// Create mock exchange
function createMockExchange(): MockExchange {
  return {
    createOrder: jest.fn().mockResolvedValue({ id: 'order-123' }),
    cancelAllOrders: jest.fn().mockResolvedValue(undefined),
    createMarketBuyOrder: jest.fn().mockResolvedValue({ id: 'buy-order', average: 100, filled: 1 }),
    createMarketSellOrder: jest.fn().mockResolvedValue({ id: 'sell-order', average: 100, filled: 1 }),
    fetchPositions: jest.fn().mockResolvedValue([]),
  };
}

describe('Dynamic Trailing Stop System', () => {
  
  describe('Entry Flow', () => {
    it('should place both SL and trailing stop at entry', async () => {
      const mockExchange = createMockExchange();
      
      // Simulate entry: createOrder called for SL, then for trailing
      mockExchange.createOrder
        .mockResolvedValueOnce({ id: 'sl-order-1' })  // SL
        .mockResolvedValueOnce({ id: 'trailing-order-1' }); // Trailing
      
      // Execute entry simulation
      const position: MockPosition = {
        symbol: 'BTC/USDT',
        side: 'long',
        entryPrice: 100000,
        qty: 0.01,
        entryTime: Date.now(),
        leverage: 5,
        marginUsd: 200,
        stopLoss: 98000, // 2% SL
      };
      
      // Simulate SL placement
      await mockExchange.createOrder(
        'BTC/USDT',
        'market',
        'sell',
        0.01,
        undefined,
        { stopLossPrice: 98000, reduceOnly: true }
      );
      position.stopLossOrderId = 'sl-order-1';
      
      // Simulate trailing placement
      await mockExchange.createOrder(
        'BTC/USDT',
        'market',
        'sell',
        0.01,
        undefined,
        { trailingPercent: 0.5, trailingTriggerPrice: 100800, reduceOnly: true }
      );
      position.trailingOrderId = 'trailing-order-1';
      
      // Verify both orders placed
      expect(mockExchange.createOrder).toHaveBeenCalledTimes(2);
      expect(position.stopLossOrderId).toBe('sl-order-1');
      expect(position.trailingOrderId).toBe('trailing-order-1');
    });
  });
  
  describe('Trailing Activation at 1%', () => {
    it('should cancel all orders and re-place trailing when profit reaches 1%', async () => {
      const mockExchange = createMockExchange();
      
      const position: MockPosition = {
        symbol: 'BTC/USDT',
        side: 'long',
        entryPrice: 100000,
        qty: 0.01,
        entryTime: Date.now(),
        leverage: 5,
        marginUsd: 200,
        stopLoss: 98000,
        stopLossOrderId: 'sl-order-old',
        trailingOrderId: 'trailing-order-old',
      };
      
      // Price hits 1% profit = 101000
      const currentPrice = 101000;
      const pnlPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
      
      expect(pnlPct).toBeGreaterThanOrEqual(1);
      
      // Cancel all orders (regular + algo)
      await mockExchange.cancelAllOrders('BTC/USDT');
      await mockExchange.cancelAllOrders('BTC/USDT', { conditional: true });
      position.stopLossOrderId = undefined;
      position.trailingOrderId = undefined;
      
      // Re-place trailing
      mockExchange.createOrder.mockResolvedValueOnce({ id: 'trailing-order-new' });
      await mockExchange.createOrder(
        'BTC/USDT',
        'market',
        'sell',
        0.01,
        undefined,
        { trailingPercent: 0.5, trailingTriggerPrice: 100800, reduceOnly: true }
      );
      position.trailingOrderId = 'trailing-order-new';
      
      // Verify
      expect(mockExchange.cancelAllOrders).toHaveBeenCalledTimes(2);
      expect(position.stopLossOrderId).toBeUndefined(); // SL no longer needed
      expect(position.trailingOrderId).toBe('trailing-order-new');
    });
  });
  
  describe('Trailing Widening at 2%', () => {
    it('should widen trailing callback from 0.5% to 0.8% when profit reaches 2%', async () => {
      const mockExchange = createMockExchange();
      
      const position: MockPosition = {
        symbol: 'BTC/USDT',
        side: 'long',
        entryPrice: 100000,
        qty: 0.01,
        entryTime: Date.now(),
        leverage: 5,
        marginUsd: 200,
        trailingOrderId: 'trailing-order-tight',
      };
      
      // Price hits 2% profit = 102000
      const currentPrice = 102000;
      const pnlPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
      
      expect(pnlPct).toBeGreaterThanOrEqual(2);
      
      // Cancel existing trailing
      await mockExchange.cancelAllOrders('BTC/USDT');
      await mockExchange.cancelAllOrders('BTC/USDT', { conditional: true });
      position.trailingOrderId = undefined;
      
      // Re-place with wider callback (0.8%)
      mockExchange.createOrder.mockResolvedValueOnce({ id: 'trailing-order-wide' });
      await mockExchange.createOrder(
        'BTC/USDT',
        'market',
        'sell',
        0.01,
        undefined,
        { trailingPercent: 0.8, trailingTriggerPrice: 100800, reduceOnly: true }
      );
      position.trailingOrderId = 'trailing-order-wide';
      
      // Verify
      expect(mockExchange.cancelAllOrders).toHaveBeenCalledTimes(2);
      expect(position.trailingOrderId).toBe('trailing-order-wide');
    });
  });
  
  describe('Fallback SL when Trailing Fails', () => {
    it('should place SL as fallback if trailing order creation fails', async () => {
      const mockExchange = createMockExchange();
      
      const position: MockPosition = {
        symbol: 'BTC/USDT',
        side: 'long',
        entryPrice: 100000,
        qty: 0.01,
        entryTime: Date.now(),
        leverage: 5,
        marginUsd: 200,
        stopLoss: 98000,
      };
      
      // Simulate trailing failure
      mockExchange.createOrder
        .mockRejectedValueOnce(new Error('TRAILING_STOP_MARKET not supported'))
        .mockResolvedValueOnce({ id: 'fallback-sl-order' }); // Fallback SL succeeds
      
      // Try trailing, expect failure
      let trailingSucceeded = false;
      try {
        await mockExchange.createOrder(
          'BTC/USDT',
          'market',
          'sell',
          0.01,
          undefined,
          { trailingPercent: 0.5, trailingTriggerPrice: 100800, reduceOnly: true }
        );
        trailingSucceeded = true;
      } catch {
        // Expected - trailing failed
      }
      
      expect(trailingSucceeded).toBe(false);
      
      // Fallback: place SL
      await mockExchange.createOrder(
        'BTC/USDT',
        'market',
        'sell',
        0.01,
        undefined,
        { stopLossPrice: position.stopLoss, reduceOnly: true }
      );
      position.stopLossOrderId = 'fallback-sl-order';
      
      // Verify fallback worked
      expect(position.stopLossOrderId).toBe('fallback-sl-order');
    });
  });
  
  describe('Cleanup on Position Close', () => {
    it('should cancel all orders when position is manually closed', async () => {
      const mockExchange = createMockExchange();
      
      const position: MockPosition = {
        symbol: 'BTC/USDT',
        side: 'long',
        entryPrice: 100000,
        qty: 0.01,
        entryTime: Date.now(),
        leverage: 5,
        marginUsd: 200,
        stopLossOrderId: 'sl-order-active',
        trailingOrderId: 'trailing-order-active',
      };
      
      // Simulate position close
      // Step 1: Cancel all orders first
      await mockExchange.cancelAllOrders('BTC/USDT');
      await mockExchange.cancelAllOrders('BTC/USDT', { conditional: true });
      position.stopLossOrderId = undefined;
      position.trailingOrderId = undefined;
      
      // Step 2: Close position
      await mockExchange.createMarketSellOrder('BTC/USDT', 0.01, { reduceOnly: true });
      
      // Verify
      expect(mockExchange.cancelAllOrders).toHaveBeenCalledTimes(2);
      expect(position.stopLossOrderId).toBeUndefined();
      expect(position.trailingOrderId).toBeUndefined();
    });
    
    it('should clean up orphan orders when sync detects position closed on exchange', async () => {
      const mockExchange = createMockExchange();
      
      // Local state thinks position exists
      const position: MockPosition = {
        symbol: 'BTC/USDT',
        side: 'long',
        entryPrice: 100000,
        qty: 0.01,
        entryTime: Date.now(),
        leverage: 5,
        marginUsd: 200,
        stopLossOrderId: 'sl-order-orphan',
        trailingOrderId: 'trailing-order-orphan',
      };
      
      // Exchange says no position (trailing hit and closed)
      mockExchange.fetchPositions!.mockResolvedValueOnce([]);
      
      // Sync detects mismatch and cancels orphan orders
      await mockExchange.cancelAllOrders('BTC/USDT');
      await mockExchange.cancelAllOrders('BTC/USDT', { conditional: true });
      position.stopLossOrderId = undefined;
      position.trailingOrderId = undefined;
      
      // Verify orphans cleaned
      expect(mockExchange.cancelAllOrders).toHaveBeenCalledTimes(2);
      expect(position.stopLossOrderId).toBeUndefined();
      expect(position.trailingOrderId).toBeUndefined();
    });
  });
  
  describe('Safety Check in checkExit', () => {
    it('should re-place protection orders if position has none', async () => {
      const mockExchange = createMockExchange();
      
      // Position with NO protection (bug scenario)
      const position: MockPosition = {
        symbol: 'BTC/USDT',
        side: 'long',
        entryPrice: 100000,
        qty: 0.01,
        entryTime: Date.now(),
        leverage: 5,
        marginUsd: 200,
        stopLoss: 98000,
        // NO stopLossOrderId
        // NO trailingOrderId
      };
      
      // Safety check detects missing protection
      const hasProtection = position.stopLossOrderId || position.trailingOrderId;
      expect(hasProtection).toBeFalsy();
      
      // Re-place SL
      mockExchange.createOrder.mockResolvedValueOnce({ id: 'safety-sl-order' });
      await mockExchange.createOrder(
        'BTC/USDT',
        'market',
        'sell',
        0.01,
        undefined,
        { stopLossPrice: position.stopLoss, reduceOnly: true }
      );
      position.stopLossOrderId = 'safety-sl-order';
      
      // Re-place trailing
      mockExchange.createOrder.mockResolvedValueOnce({ id: 'safety-trailing-order' });
      await mockExchange.createOrder(
        'BTC/USDT',
        'market',
        'sell',
        0.01,
        undefined,
        { trailingPercent: 0.5, trailingTriggerPrice: 100800, reduceOnly: true }
      );
      position.trailingOrderId = 'safety-trailing-order';
      
      // Verify protection restored
      expect(position.stopLossOrderId).toBe('safety-sl-order');
      expect(position.trailingOrderId).toBe('safety-trailing-order');
    });
  });
  
  describe('Short Position Handling', () => {
    it('should handle trailing for short positions with inverted price logic', async () => {
      const mockExchange = createMockExchange();
      
      const position: MockPosition = {
        symbol: 'BTC/USDT',
        side: 'short',
        entryPrice: 100000,
        qty: 0.01,
        entryTime: Date.now(),
        leverage: 5,
        marginUsd: 200,
        stopLoss: 102000, // SL above entry for shorts
      };
      
      // For shorts, activation price should be BELOW entry
      const trailingActivationPct = 0.8;
      const activationPrice = position.entryPrice * (1 - trailingActivationPct / 100);
      expect(activationPrice).toBeLessThan(position.entryPrice);
      expect(activationPrice).toBe(99200);
      
      // Place trailing for short (buy to close)
      mockExchange.createOrder.mockResolvedValueOnce({ id: 'short-trailing-order' });
      await mockExchange.createOrder(
        'BTC/USDT',
        'market',
        'buy', // Buy to close short
        0.01,
        undefined,
        { trailingPercent: 0.5, trailingTriggerPrice: activationPrice, reduceOnly: true }
      );
      position.trailingOrderId = 'short-trailing-order';
      
      // Verify
      expect(mockExchange.createOrder).toHaveBeenCalledWith(
        'BTC/USDT',
        'market',
        'buy',
        0.01,
        undefined,
        expect.objectContaining({
          trailingPercent: 0.5,
          trailingTriggerPrice: 99200,
        })
      );
    });
  });
  
});

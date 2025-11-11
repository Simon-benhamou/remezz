/**
 * Test suite for strict capital validation
 * Related to issue: Backend allows placing orders even when free capital is at 0
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { PreciseDecimal } = await import('../../dist/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.js');
const { PaperBalanceProvider } = await import('../../dist/src/core/capital/PaperBalanceProvider.js');
const { CapitalManager } = await import('../../dist/src/core/capital/CapitalManager.js');
const { CapitalPoolBroker } = await import('../../dist/src/broker/capitalPoolBroker.js');
const { capitalConfig } = await import('../../dist/src/config/capital.js');

function decimal(value: string | number) {
  return new PreciseDecimal(value);
}

function cloneDecimal(value: typeof capitalConfig.reserveBufferPct) {
  return PreciseDecimal.fromRaw(value.raw);
}

// Mock broker for testing
class MockBroker {
  public mode: 'paper' | 'live' = 'paper';
  
  async balance() {
    return {
      freeUsd: 1000,
      equityUsd: 1000,
      committedUsd: 0,
    };
  }
  
  async place(order: any) {
    return {
      ...order,
      id: `mock-order-${Date.now()}`,
      status: 'filled',
      ts: Date.now(),
      requestedQty: order.qty,
      requestedPrice: order.price,
      filledQty: order.qty,
      avgPrice: order.price || 50000,
    };
  }
  
  async cancel(_id: string) {
    // Mock cancel
  }
}

describe('Capital Validation', () => {
  it('should reject new orders when free capital is zero', async () => {
    // Create capital manager with zero free capital
    const zero = decimal(0);
    const totalCapital = decimal(1000);
    const snapshot = {
      totalUSD: totalCapital,
      freeUSD: zero, // Zero free capital
      reservedUSD: zero,
      inPositionsUSD: totalCapital, // All capital in positions
      ts: Date.now(),
    };
    
    const provider = new PaperBalanceProvider({ snapshot });
    const manager = new CapitalManager(
      provider,
      {
        reserveTtlMs: capitalConfig.reserveTtlMs,
        reserveBufferPct: cloneDecimal(capitalConfig.reserveBufferPct),
        perSymbolCapPct: cloneDecimal(capitalConfig.perSymbolCapPct),
        maxPositions: capitalConfig.maxPositions,
        minOrderUSD: cloneDecimal(capitalConfig.minOrderUSD),
        validateLiveBalance: false,
      },
      {
        reservations: new Map(),
        symbolExposure: new Map(),
        agentEquity: new Map(),
      }
    );
    
    const mockBroker = new MockBroker();
    const capitalPoolBroker = new CapitalPoolBroker({
      agentId: 'test-agent',
      mode: 'paper',
      capital: manager,
      broker: mockBroker,
      minOrderUsd: cloneDecimal(capitalConfig.minOrderUSD),
    });
    
    // Attempt to place an order when capital is zero
    const result = await capitalPoolBroker.place({
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'market',
      qty: 0.01,
      price: 50000,
      leverage: 1,
    });
    
    // Order should be rejected
    assert.equal(result.status, 'rejected', 'Order should be rejected when free capital is zero');
    assert(result.id.includes('rejected'), 'Rejected order ID should indicate rejection');
  });

  it('should reject new orders when free capital minus reserved is zero', async () => {
    const zero = decimal(0);
    const totalCapital = decimal(1000);
    const reserved = decimal(500);
    const snapshot = {
      totalUSD: totalCapital,
      freeUSD: decimal(500), // Has some free capital
      reservedUSD: reserved, // But it's all reserved
      inPositionsUSD: decimal(500),
      ts: Date.now(),
    };
    
    const provider = new PaperBalanceProvider({ snapshot });
    const manager = new CapitalManager(
      provider,
      {
        reserveTtlMs: capitalConfig.reserveTtlMs,
        reserveBufferPct: cloneDecimal(capitalConfig.reserveBufferPct),
        perSymbolCapPct: cloneDecimal(capitalConfig.perSymbolCapPct),
        maxPositions: capitalConfig.maxPositions,
        minOrderUSD: cloneDecimal(capitalConfig.minOrderUSD),
        validateLiveBalance: false,
      },
      {
        reservations: new Map(),
        symbolExposure: new Map(),
        agentEquity: new Map(),
      }
    );
    
    const mockBroker = new MockBroker();
    const capitalPoolBroker = new CapitalPoolBroker({
      agentId: 'test-agent',
      mode: 'paper',
      capital: manager,
      broker: mockBroker,
      minOrderUsd: cloneDecimal(capitalConfig.minOrderUSD),
    });
    
    const result = await capitalPoolBroker.place({
      symbol: 'ETH/USDT',
      side: 'buy',
      type: 'market',
      qty: 0.1,
      price: 3000,
      leverage: 1,
    });
    
    // Should be rejected because actualFreeCapital (free - reserved) = 0
    assert.equal(result.status, 'rejected', 'Order should be rejected when actual free capital is zero');
  });

  it('should allow orders when free capital is available', async () => {
    const zero = decimal(0);
    const totalCapital = decimal(1000);
    const snapshot = {
      totalUSD: totalCapital,
      freeUSD: decimal(800), // Plenty of free capital
      reservedUSD: zero,
      inPositionsUSD: decimal(200),
      ts: Date.now(),
    };
    
    const provider = new PaperBalanceProvider({ snapshot });
    const manager = new CapitalManager(
      provider,
      {
        reserveTtlMs: capitalConfig.reserveTtlMs,
        reserveBufferPct: cloneDecimal(capitalConfig.reserveBufferPct),
        perSymbolCapPct: cloneDecimal(capitalConfig.perSymbolCapPct),
        maxPositions: capitalConfig.maxPositions,
        minOrderUSD: cloneDecimal(capitalConfig.minOrderUSD),
        validateLiveBalance: false,
      },
      {
        reservations: new Map(),
        symbolExposure: new Map(),
        agentEquity: new Map(),
      }
    );
    
    const mockBroker = new MockBroker();
    const capitalPoolBroker = new CapitalPoolBroker({
      agentId: 'test-agent',
      mode: 'paper',
      capital: manager,
      broker: mockBroker,
      minOrderUsd: cloneDecimal(capitalConfig.minOrderUSD),
    });
    
    const result = await capitalPoolBroker.place({
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'limit', // Use limit order to use specified price
      qty: 0.01, // 0.01 BTC
      price: 50000, // at $50,000 = $500 notional
      leverage: 1,
    });
    
    // Should succeed because we have capital
    assert.notEqual(result.status, 'rejected', 'Order should not be rejected when free capital is available');
    assert(!result.id.includes('rejected'), 'Order ID should not indicate rejection');
  });

  it('should allow reduceOnly orders even when capital is zero', async () => {
    const zero = decimal(0);
    const totalCapital = decimal(1000);
    const snapshot = {
      totalUSD: totalCapital,
      freeUSD: zero, // Zero free capital
      reservedUSD: zero,
      inPositionsUSD: totalCapital,
      ts: Date.now(),
    };
    
    const provider = new PaperBalanceProvider({ snapshot });
    const manager = new CapitalManager(
      provider,
      {
        reserveTtlMs: capitalConfig.reserveTtlMs,
        reserveBufferPct: cloneDecimal(capitalConfig.reserveBufferPct),
        perSymbolCapPct: cloneDecimal(capitalConfig.perSymbolCapPct),
        maxPositions: capitalConfig.maxPositions,
        minOrderUSD: cloneDecimal(capitalConfig.minOrderUSD),
        validateLiveBalance: false,
      },
      {
        reservations: new Map(),
        symbolExposure: new Map(),
        agentEquity: new Map(),
      }
    );
    
    const mockBroker = new MockBroker();
    const capitalPoolBroker = new CapitalPoolBroker({
      agentId: 'test-agent',
      mode: 'paper',
      capital: manager,
      broker: mockBroker,
      minOrderUsd: cloneDecimal(capitalConfig.minOrderUSD),
    });
    
    const result = await capitalPoolBroker.place({
      symbol: 'BTC/USDT',
      side: 'sell',
      type: 'market',
      qty: 0.01,
      reduceOnly: true, // Exit order
      leverage: 1,
    });
    
    // reduceOnly orders should always be allowed
    assert.notEqual(result.status, 'rejected', 'ReduceOnly orders should be allowed even with zero capital');
  });
});

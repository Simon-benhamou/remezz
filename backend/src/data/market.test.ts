import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as binanceWs from '../services/binanceWebSocket.js';
import * as ccxtClient from '../exchange/ccxtClient.js';
import { getTicker } from './market.js';

vi.mock('../services/binanceWebSocket.js');
vi.mock('../exchange/ccxtClient.js');

describe('getTicker', () => {
  const mockWsTicker = {
    last: 100,
    bid: 99.5,
    ask: 100.5,
    percentage: 1.2,
    baseVolume: 1000,
    quoteVolume: 100000,
    high: 105,
    low: 95,
    open: 98,
    timestamp: Date.now(),
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    (binanceWs.waitForWsHealthy as unknown as vi.Mock).mockResolvedValue(true);
    (binanceWs.getTickerFromWebSocket as unknown as vi.Mock).mockResolvedValue({
      ...mockWsTicker,
      symbol: 'BTCUSDT',
    });
  });

  it('returns validated ticker from WebSocket cache', async () => {
    const ticker = await getTicker('BTC/USDT');
    expect(ticker.last).toBe(100);
    expect(ticker.bid).toBe(99.5);
    expect(ticker.ask).toBe(100.5);
  });

  it('falls back to order book when bid/ask missing', async () => {
    (binanceWs.getTickerFromWebSocket as unknown as vi.Mock).mockResolvedValue({
      ...mockWsTicker,
      bid: null,
      ask: null,
    });
    const fetchOrderBook = vi.fn().mockResolvedValue({
      bids: [[99.1, 10]],
      asks: [[100.2, 8]],
    });
    (ccxtClient.createPublicExchange as any) = vi.fn().mockReturnValue({
      fetchTicker: vi.fn().mockResolvedValue({ ...mockWsTicker, bid: 0, ask: 0 }),
      fetchOrderBook,
      options: {},
    });
    const ticker = await getTicker('BTC/USDT');
    expect(ticker.bid).toBe(99.1);
    expect(ticker.ask).toBe(100.2);
  });

  it('throws when ticker invalid and no cache', async () => {
    (binanceWs.getTickerFromWebSocket as unknown as vi.Mock).mockResolvedValue({
      ...mockWsTicker,
      bid: 0,
      ask: 0,
    });
    (ccxtClient.createPublicExchange as any) = vi.fn().mockReturnValue({
      fetchTicker: vi.fn().mockResolvedValue({ ...mockWsTicker, bid: 0, ask: 0 }),
      options: {},
    });
    await expect(getTicker('BTC/USDT')).rejects.toThrow(/invalid_ticker/);
  });
});

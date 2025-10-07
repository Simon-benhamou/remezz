import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { router } from './status.js';

vi.mock('../data/market.js', () => ({
  computeCoreIndicators: vi.fn().mockResolvedValue({
    ema20: 1,
    ema50: 1,
    rsi14: 50,
    atr14: 0.2,
  }),
  getTicker: vi.fn(),
}));

vi.mock('../ai/tech.js', () => ({
  buildTechSnapshot: vi.fn().mockResolvedValue({
    last: 101,
    atrPct: 0.2,
    adx14: 20,
    ema20Slope: 0.1,
    support: [],
    resistance: [],
    supports: [],
    resistances: [],
    pivots: [],
  }),
}));

vi.mock('../db/client.js', () => ({
  prisma: {
    agentSession: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'session1',
        symbol: 'BTC/USDT',
        profileJson: {},
      }),
    },
  },
}));

vi.mock('../services/userCredentials.js', () => ({
  getUserCredentials: vi.fn().mockResolvedValue(null),
}));

const getHandler = () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (router as any).stack.find((l: any) => l.route?.path === '/' && l.route.methods.get);
  return layer.route.stack[0].handle;
};

describe('GET /status', () => {
  const handler = getHandler();
  const mockReq = (query: Record<string, unknown> = {}): Partial<Request> => ({
    query,
    user: { id: 'user1' } as any,
  });

  const mockRes = () => {
    const res: Partial<Response> = {};
    res.status = vi.fn().mockImplementation(function status(this: Response, code: number) {
      (this as any).statusCode = code;
      return this;
    });
    res.json = vi.fn().mockImplementation(() => res);
    return res as Response;
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns ticker data when validation passes', async () => {
    const { getTicker } = await import('../data/market.js');
    (getTicker as unknown as vi.Mock).mockResolvedValue({
      symbol: 'BTC/USDT:USDT',
      last: 100,
      bid: 99,
      ask: 101,
      percentage: 0.5,
      baseVolume: 1000,
      quoteVolume: 100000,
      high: 105,
      low: 95,
      timestamp: Date.now(),
    });

    const req = mockReq();
    const res = mockRes();
    await handler(req as Request, res);

    expect(res.json).toHaveBeenCalled();
    const payload = (res.json as vi.Mock).mock.calls[0][0];
    expect(payload.ticker.last).toBe(100);
    expect(payload.indicators.price).toBe(100);
  });

  it('returns 502 when ticker validation fails', async () => {
    const { getTicker } = await import('../data/market.js');
    (getTicker as unknown as vi.Mock).mockRejectedValue(new Error('invalid_ticker'));

    const req = mockReq();
    const res = mockRes();

    await handler(req as Request, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'ticker_unavailable' }));
  });
});

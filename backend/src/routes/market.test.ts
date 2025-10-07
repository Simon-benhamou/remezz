import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { router } from './market.js';

vi.mock('../data/market.js', () => ({
  getTicker: vi.fn(),
}));

const getTickerMock = async () => {
  const module = await import('../data/market.js');
  return module.getTicker as unknown as vi.Mock;
};

const getHandler = (path: string) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (router as any).stack.find((l: any) => l.route?.path === path && l.route.methods.post);
  return layer.route.stack[0].handle;
};

describe('POST /ticker', () => {
  const handler = getHandler('/ticker');

  const mockRes = () => {
    const res: Partial<Response> = {};
    res.status = vi.fn().mockImplementation(function status(this: Response, code: number) {
      (this as any).statusCode = code;
      return this;
    });
    res.json = vi.fn().mockImplementation(() => res);
    return res as Response;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const mock = await getTickerMock();
    mock.mockReset();
  });

  it('returns ticker payload when valid data', async () => {
    const mock = await getTickerMock();
    mock.mockResolvedValue({
      symbol: 'BTC/USDT:USDT',
      last: 100,
      bid: 99,
      ask: 101,
      high: 105,
      low: 95,
      percentage: 1.5,
      baseVolume: 1000,
      quoteVolume: 100000,
    });

    const req = { body: { symbol: 'BTC/USDT' } } as unknown as Request;
    const res = mockRes();
    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      last: 100,
      bid: 99,
      ask: 101,
    }));
  });

  it('returns 502 when ticker validation fails', async () => {
    const mock = await getTickerMock();
    mock.mockResolvedValue({
      symbol: 'BTC/USDT:USDT',
      last: 0,
      bid: 0,
      ask: 0,
    });

    const req = { body: { symbol: 'BTC/USDT' } } as unknown as Request;
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'ticker_unavailable' }));
  });
});

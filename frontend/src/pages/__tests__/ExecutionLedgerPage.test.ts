import { describe, expect, it } from 'vitest';
import { asOutcome } from '../ExecutionLedgerPage';

type PartialTradeRow = Parameters<typeof asOutcome>[0];

const baseRow: PartialTradeRow = {
  id: 't1',
  createdAt: new Date().toISOString(),
  symbol: 'BTC/USDT',
  positionSide: 'long',
  qty: 1,
};

describe('ExecutionLedgerPage outcome classification', () => {
  it('uses pctChange to classify wins even if fees turn pnl negative', () => {
    const row = {
      ...baseRow,
      pctChange: 0.25,
      realizedPnlUsd: -1.5,
    } as PartialTradeRow;
    expect(asOutcome(row)).toBe('win');
  });

  it('falls back to realized pnl when no percent metrics are present', () => {
    const row = {
      ...baseRow,
      pctChange: null,
      roePct: undefined,
      realizedPnlUsd: -4.2,
    } as PartialTradeRow;
    expect(asOutcome(row)).toBe('loss');
  });

  it('treats near zero results as breakeven', () => {
    const row = {
      ...baseRow,
      pctChange: 0,
      realizedPnlUsd: 0,
    } as PartialTradeRow;
    expect(asOutcome(row)).toBe('breakeven');
  });

  it('considers roePct when pctChange is absent', () => {
    const row = {
      ...baseRow,
      pctChange: undefined,
      roePct: -0.15,
      realizedPnlUsd: 10,
    } as PartialTradeRow;
    expect(asOutcome(row)).toBe('loss');
  });
});

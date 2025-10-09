import { z } from 'zod';

const finiteNumber = z.number().refine(Number.isFinite, {
  message: 'must be a finite number',
});

const ZoneZ = z.object({
  min: finiteNumber,
  max: finiteNumber,
}).superRefine((zone, ctx) => {
  if (zone.min >= zone.max) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'entry zone must have min < max',
      path: ['min'],
    });
  }
});

export const StrategyZ = z.object({
  strategyId: z.string(),
  symbol: z.string(),
  bias: z.enum(['long','short','range']),
  confidence: z.number().min(0).max(1).optional(),
  entry: z.object({
    type: z.enum(['limit','market']),
    // Accept number | null | undefined
    price: z.number().nullable().optional(),
    zone: ZoneZ,
    confirmations: z.array(z.string()).optional(),
  }),
  risk: z.object({
    stop: z.object({ type: z.enum(['percent','price']), value: z.number() }),
    target: z.object({ type: z.enum(['percent','price']), value: z.number() }),
    risk_pct_balance: z.number().min(0).max(5),
    max_leverage: z.number().min(1).max(50),
  }),
  // 'to' can be string | null | undefined
  validity: z.object({ from: z.string().optional(), to: z.string().nullable().optional() }).optional(),
  rationale: z.string().optional(),
  trigger: z.string().optional(),
});

export type StrategyJson = z.infer<typeof StrategyZ>;

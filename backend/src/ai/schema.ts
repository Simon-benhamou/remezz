import { z } from 'zod';

export const StrategyZ = z.object({
  strategyId: z.string(),
  symbol: z.string(),
  bias: z.enum(['long','short','range']),
  confidence: z.number().min(0).max(1).optional(),
  entry: z.object({
    type: z.enum(['limit','market']),
    // ⬇️ accepte number | null | undefined
    price: z.number().nullable().optional(),
    zone: z.object({
      // ⬇️ accepte number | null | undefined
      min: z.number().nullable().optional(),
      max: z.number().nullable().optional(),
    }).optional(),
    confirmations: z.array(z.string()).optional(),
  }),
  risk: z.object({
    stop: z.object({ type: z.enum(['percent','price']), value: z.number() }),
    target: z.object({ type: z.enum(['percent','price']), value: z.number() }),
    risk_pct_balance: z.number().min(0).max(5),
    max_leverage: z.number().min(1).max(50),
  }),
  // ⬇️ 'to' peut être string | null | undefined
  validity: z.object({ from: z.string().optional(), to: z.string().nullable().optional() }).optional(),
  rationale: z.string().optional(),
  trigger: z.string().optional(),
});

export type StrategyJson = z.infer<typeof StrategyZ>;
import { z } from 'zod';

// LLM trade plan JSON (rebound/rejection) per spec
export const PlanZ = z.object({
  name: z.string(),
  symbol: z.string(),
  timeframe: z.enum(['15m','1h','4h','1d']).default('1h'),
  bias: z.enum(['long','short','none']).default('none'),
  zone: z.object({
    type: z.enum(['support','resistance']),
    price: z.number().nullable(),
    from: z.enum(['auto_detect']).default('auto_detect'),
  }),
  entry_rule: z.object({
    type: z.enum(['rebound','rejection']),
    confirm_close: z.boolean().default(true),
    max_distance_pct: z.number().min(0).max(5).default(0.4),
  }),
  risk: z.object({
    stop: z.object({ type: z.enum(['atr']), mult: z.number().min(0.2).max(3) }),
    tp: z.array(z.object({ type: z.enum(['R']), value: z.number().positive() })).min(1),
    max_hold_hours: z.number().min(1).max(72).default(36),
  }),
  position: z.object({
    risk_fraction: z.number().min(0.01).max(0.02), // 1–2%
    max_leverage: z.number().min(1).max(5),
  }),
  notes: z.string().optional(),
});

export type PlanJson = z.infer<typeof PlanZ>;

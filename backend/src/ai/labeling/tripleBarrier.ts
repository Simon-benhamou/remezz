import type { ContextFeatures } from '../features/featureBuilder.js';

export type TripleBarrierLabel = 0 | 1 | null;

export interface LabeledRow {
  x: ContextFeatures;
  y: TripleBarrierLabel;
  meta: {
    symbol: string;
    ts: number;
    side: 'long' | 'short';
  };
}

/**
 * Shim: re-exports momentum config from archive location.
 * Keeps all existing `import { ... } from './config/momentumConfig.js'` working.
 */
export {
  CANDLE_15M_MS,
  calculateExitNowMs,
  MomentumConfig,
  CONFIG,
  type Candle,
  type Position,
  type SignalResult,
  type ExitSignal,
  type MarketConditions,
} from '../_archive/momentum/momentumConfig.js';

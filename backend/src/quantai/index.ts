export { getQuantAIConfig, reloadQuantAIConfig } from './config.js';
export { CircuitBreaker } from './risk/circuitBreaker.js';
export type { CircuitBreakerDecision } from './risk/circuitBreaker.js';
export { PositionSizer } from './risk/positionSizing.js';
export { EntryFilters } from './strategy/entryFilters.js';
export { computeInitialBracket, maybeAdjustOrExit } from './strategy/exitManager.js';
export type { TradeSide, ExitDirective, InitialBracket } from './strategy/exitManager.js';
export { classifyRegime, selectMode } from './regime/regime.js';
export { applyFeesAndSlippage } from './backtest/execution.js';

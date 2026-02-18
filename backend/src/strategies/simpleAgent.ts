/**
 * simpleAgent.ts — BARREL RE-EXPORT FILE
 *
 * V5.108: Architectural refactoring — code extracted into focused modules:
 *   - capitalPool.ts     → CapitalPool class, getCapitalPool, resetCapitalPool
 *   - orchestrator.ts    → AgentOrchestrator (formerly SimpleAgent), factory functions
 *
 * This file re-exports everything so that ALL existing consumers continue to work
 * with zero import changes. Over time, consumers can import directly from the modules.
 *
 * SINGLE SOURCE OF TRUTH: Each piece of logic now lives in exactly ONE file.
 */

// ============================================================================
// CAPITAL POOL: Shared capital management
// ============================================================================
export { CapitalPool, getCapitalPool, resetCapitalPool } from './capitalPool.js';

// ============================================================================
// AGENT ORCHESTRATOR: Trading lifecycle management (exported as SimpleAgent for compat)
// ============================================================================
export { AgentOrchestrator as SimpleAgent } from './orchestrator.js';
export type { SimpleAgentConfig, TickEvent, SignalEvent, TradeEvent } from './orchestrator.js';
export { createSimpleAgent, createAllAgents } from './orchestrator.js';

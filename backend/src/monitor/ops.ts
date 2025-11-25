/**
 * Monitor Ops - Stub
 * Removed complex ops monitoring
 */

import { createLogger } from "../utils/logger.js";

const logger = createLogger("ops");

export interface OpsEvent {
  level?: string;
  source?: string;
  message?: string;
  details?: Record<string, any>;
  [key: string]: any;
}

export function recordOp(_name: string, _data?: any): void {
  // No-op - simplified
}

export function recordOpsEvent(_event: OpsEvent | string, _data?: any): void {
  // No-op - simplified
}

export function getOpStats(): Record<string, number> {
  return {};
}

export function resetOpStats(): void {
  // No-op
}

export function incrementCounter(_name: string): void {
  // No-op
}

export function recordLatency(_name: string, _ms: number): void {
  // No-op
}

export function getLatencyStats(_name: string): { avg: number; p95: number; p99: number } {
  return { avg: 0, p95: 0, p99: 0 };
}

/**
 * Monitor Policy - Stub
 * Removed complex monitoring
 */

import { createLogger } from "../utils/logger.js";

const logger = createLogger("policy");

export function broadcast(_type: string, _data: any, _symbol?: string): void {
  // No-op - removed complex WebSocket broadcasting
}

export function emitAlert(_type: string, _data: any): void {
  // No-op - removed alerts
}

export function checkMonitoringPolicy(): boolean {
  return true;
}

export function setMonitoringPolicy(_policy: any): void {
  // No-op
}

export function getMonitoringStats(): Record<string, any> {
  return {
    enabled: true,
    uptime: process.uptime(),
  };
}

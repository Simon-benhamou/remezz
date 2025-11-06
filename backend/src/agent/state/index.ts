/**
 * Stub file for backward compatibility
 * The intraday ReboundRejectionAgent has been removed
 * System now uses meta-adaptive strategy exclusively
 */

// Re-export types from profilePersistence
export type { ActivationProfile } from '../profilePersistence.js';

// Stub class for type compatibility only - not functional
export class ReboundRejectionAgent {
  sessionId?: string;
  state: string = 'IDLE';
  profile: any = null;
  pos: any = null;

  constructor() {
    console.warn('ReboundRejectionAgent is deprecated. Use meta-adaptive strategy instead.');
  }

  async activate(_profile: any) {
    throw new Error('ReboundRejectionAgent removed. Use meta-adaptive strategy.');
  }

  async onTick() {
    throw new Error('ReboundRejectionAgent removed. Use meta-adaptive strategy.');
  }

  halt(_mode?: string) {
    console.warn('ReboundRejectionAgent halt called on deprecated class');
  }

  static getATRCacheStats() {
    return {
      size: 0,
      hits: 0,
      misses: 0,
      updates: 0,
      hitRate: 0,
      maxSize: 0
    };
  }
}

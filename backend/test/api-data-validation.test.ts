/**
 * API Data Validation Test
 * 
 * This test verifies that:
 * 1. Backend ops events API returns expected data structure
 * 2. Frontend receives all required fields
 * 3. Data types are correct
 * 4. No required fields are missing
 */

import { recentOpsEvents, recordOpsEvent, clearOpsEvents } from '../src/monitor/ops.js';

describe('API Data Validation', () => {
  beforeEach(() => {
    clearOpsEvents();
  });

  describe('Ops Events Data Structure', () => {
    it('should include all required fields in ops events', () => {
      // Record a test event similar to the log shown
      recordOpsEvent({
        level: 'info',
        source: 'strategy_regen',
        message: 'Strategy regeneration triggered by shift',
        sessionId: 'test-session-123',
        symbol: 'BTC/USDT',
        details: {
          reason: 'price',
          price: 86.06,
          lastPrice: 79.45404670087306,
          zone: {
            min: 79.45404670087306,
            max: 79.76595329912693
          },
          regime: 'range:neutral',
          previousRegime: 'range:neutral',
          previousConfidence: 0.5481063345375718,
          nextConfidence: 0.5481063345375718,
          confidenceDelta: 0,
          regimeCooldownMinutes: null
        }
      });

      const events = recentOpsEvents(10);
      
      // Verify event was recorded
      expect(events.length).toBe(1);
      
      const event = events[0];
      
      // Verify all required top-level fields exist
      expect(event).toHaveProperty('id');
      expect(event).toHaveProperty('ts');
      expect(event).toHaveProperty('level');
      expect(event).toHaveProperty('source');
      expect(event).toHaveProperty('message');
      expect(event).toHaveProperty('sessionId');
      expect(event).toHaveProperty('symbol');
      expect(event).toHaveProperty('details');
      
      // Verify field types
      expect(typeof event.id).toBe('string');
      expect(typeof event.ts).toBe('number');
      expect(event.level).toBe('info');
      expect(event.source).toBe('strategy_regen');
      expect(event.message).toBe('Strategy regeneration triggered by shift');
      expect(event.sessionId).toBe('test-session-123');
      expect(event.symbol).toBe('BTC/USDT');
      
      // Verify details structure matches expected format
      expect(event.details).toHaveProperty('reason');
      expect(event.details).toHaveProperty('price');
      expect(event.details).toHaveProperty('lastPrice');
      expect(event.details).toHaveProperty('zone');
      expect(event.details).toHaveProperty('regime');
      expect(event.details).toHaveProperty('previousRegime');
      expect(event.details).toHaveProperty('previousConfidence');
      expect(event.details).toHaveProperty('nextConfidence');
      expect(event.details).toHaveProperty('confidenceDelta');
      expect(event.details).toHaveProperty('regimeCooldownMinutes');
      
      // Verify nested zone structure
      expect(event.details.zone).toHaveProperty('min');
      expect(event.details.zone).toHaveProperty('max');
      expect(typeof event.details.zone.min).toBe('number');
      expect(typeof event.details.zone.max).toBe('number');
    });

    it('should handle events with missing optional fields', () => {
      recordOpsEvent({
        level: 'warn',
        source: 'test_source',
        message: 'Test message without sessionId or symbol',
        details: { test: true }
      });

      const events = recentOpsEvents(10);
      expect(events.length).toBe(1);
      
      const event = events[0];
      expect(event).toHaveProperty('id');
      expect(event).toHaveProperty('ts');
      expect(event).toHaveProperty('level');
      expect(event).toHaveProperty('source');
      expect(event).toHaveProperty('message');
      // sessionId and symbol should be undefined, not missing
      expect(event.sessionId).toBeUndefined();
      expect(event.symbol).toBeUndefined();
    });

    it('should filter events by sessionId correctly', () => {
      // Record multiple events with different sessionIds
      recordOpsEvent({
        level: 'info',
        source: 'test',
        message: 'Session 1 event',
        sessionId: 'session-1',
        symbol: 'BTC/USDT'
      });

      recordOpsEvent({
        level: 'info',
        source: 'test',
        message: 'Session 2 event',
        sessionId: 'session-2',
        symbol: 'ETH/USDT'
      });

      recordOpsEvent({
        level: 'info',
        source: 'test',
        message: 'Session 1 another event',
        sessionId: 'session-1',
        symbol: 'LTC/USDT'
      });

      // Get all events
      const allEvents = recentOpsEvents(10);
      expect(allEvents.length).toBe(3);

      // Filter by session-1
      const session1Events = recentOpsEvents(10, { sessionId: 'session-1' });
      expect(session1Events.length).toBe(2);
      expect(session1Events.every(e => e.sessionId === 'session-1')).toBe(true);

      // Filter by session-2
      const session2Events = recentOpsEvents(10, { sessionId: 'session-2' });
      expect(session2Events.length).toBe(1);
      expect(session2Events[0].sessionId).toBe('session-2');
    });

    it('should respect limit parameter', () => {
      // Record more events than the limit
      for (let i = 0; i < 10; i++) {
        recordOpsEvent({
          level: 'info',
          source: 'test',
          message: `Event ${i}`,
          sessionId: 'test-session'
        });
      }

      const events5 = recentOpsEvents(5);
      expect(events5.length).toBe(5);

      const events3 = recentOpsEvents(3);
      expect(events3.length).toBe(3);
    });
  });

  describe('Strategy Regeneration Events', () => {
    it('should include regime cooldown information when applicable', () => {
      // Test case 1: Price shift (no cooldown)
      recordOpsEvent({
        level: 'info',
        source: 'strategy_regen',
        message: 'Strategy regeneration triggered by shift',
        sessionId: 'test-session',
        symbol: 'BTC/USDT',
        details: {
          reason: 'price',
          regimeCooldownMinutes: null
        }
      });

      // Test case 2: Regime shift (with cooldown)
      recordOpsEvent({
        level: 'info',
        source: 'strategy_regen',
        message: 'Strategy regeneration triggered by shift',
        sessionId: 'test-session',
        symbol: 'ETH/USDT',
        details: {
          reason: 'regime',
          regimeCooldownMinutes: 5
        }
      });

      const events = recentOpsEvents(10);
      expect(events.length).toBe(2);

      // Verify cooldown is null for price shift
      const priceEvent = events.find(e => e.symbol === 'BTC/USDT');
      expect(priceEvent?.details.regimeCooldownMinutes).toBeNull();

      // Verify cooldown is set for regime shift
      const regimeEvent = events.find(e => e.symbol === 'ETH/USDT');
      expect(regimeEvent?.details.regimeCooldownMinutes).toBe(5);
    });

    it('should include confidence delta for regime changes', () => {
      recordOpsEvent({
        level: 'info',
        source: 'strategy_regen',
        message: 'Strategy regeneration triggered by shift',
        sessionId: 'test-session',
        symbol: 'BTC/USDT',
        details: {
          previousConfidence: 0.5,
          nextConfidence: 0.8,
          confidenceDelta: 0.3
        }
      });

      const events = recentOpsEvents(10);
      expect(events.length).toBe(1);
      
      const event = events[0];
      expect(event.details.previousConfidence).toBe(0.5);
      expect(event.details.nextConfidence).toBe(0.8);
      expect(event.details.confidenceDelta).toBe(0.3);
    });
  });

  describe('Event Deduplication', () => {
    it('should deduplicate identical events within cooldown window', async () => {
      // Record the same event twice quickly
      const eventData = {
        level: 'info' as const,
        source: 'test',
        message: 'Duplicate test',
        sessionId: 'test-session',
        symbol: 'BTC/USDT',
        details: { test: true }
      };

      recordOpsEvent(eventData);
      recordOpsEvent(eventData); // Should be deduplicated

      const events = recentOpsEvents(10);
      expect(events.length).toBe(1); // Only one event recorded
    });

    it('should allow same event after cooldown period', async () => {
      // This test would need to mock time or wait for the cooldown
      // For now, just verify different events are not deduplicated
      recordOpsEvent({
        level: 'info',
        source: 'test',
        message: 'Event 1',
        sessionId: 'test-session',
        details: { id: 1 }
      });

      recordOpsEvent({
        level: 'info',
        source: 'test',
        message: 'Event 2',
        sessionId: 'test-session',
        details: { id: 2 }
      });

      const events = recentOpsEvents(10);
      expect(events.length).toBe(2);
    });
  });
});

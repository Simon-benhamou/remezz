import { generateWindows, type WalkForwardConfig } from '../src/services/walkForwardService.js';

const BASE_CONFIG: WalkForwardConfig = {
  fullStartDate: new Date('2023-01-01'),
  fullEndDate: new Date('2024-12-31'),
  trainWindowMonths: 6,
  testWindowMonths: 2,
  stepMonths: 2,
  symbols: ['BTC/USDT:USDT'],
  initialCapital: 2000,
  leverage: 4.5,
};

describe('Walk-Forward Window Generation', () => {
  it('should generate correct number of windows for 24-month range', () => {
    const windows = generateWindows(BASE_CONFIG);
    // 24 months, train=6, test=2, step=2
    // Window 1: 0-6 train, 6-8 test (step to 2)
    // Window 2: 2-8 train, 8-10 test (step to 4)
    // ...continues
    expect(windows.length).toBeGreaterThan(0);
    expect(windows.length).toBeLessThanOrEqual(12);
  });

  it('should ensure test window ends before fullEndDate', () => {
    const windows = generateWindows(BASE_CONFIG);
    for (const w of windows) {
      expect(w.testEnd.getTime()).toBeLessThanOrEqual(BASE_CONFIG.fullEndDate.getTime());
    }
  });

  it('should have non-overlapping train/test periods per window', () => {
    const windows = generateWindows(BASE_CONFIG);
    for (const w of windows) {
      expect(w.trainEnd.getTime()).toBeLessThanOrEqual(w.testStart.getTime());
    }
  });

  it('should step forward by stepMonths between consecutive windows', () => {
    const windows = generateWindows(BASE_CONFIG);
    for (let i = 1; i < windows.length; i++) {
      const prevStart = windows[i - 1].trainStart;
      const currStart = windows[i].trainStart;
      const diffMonths = (currStart.getFullYear() - prevStart.getFullYear()) * 12
        + (currStart.getMonth() - prevStart.getMonth());
      expect(diffMonths).toBe(BASE_CONFIG.stepMonths);
    }
  });

  it('should handle short date range with no valid windows', () => {
    const shortConfig: WalkForwardConfig = {
      ...BASE_CONFIG,
      fullStartDate: new Date('2024-01-01'),
      fullEndDate: new Date('2024-03-01'), // Only 2 months - not enough for train+test
    };
    const windows = generateWindows(shortConfig);
    expect(windows.length).toBe(0);
  });

  it('should handle 1-month step for fine-grained analysis', () => {
    const fineConfig: WalkForwardConfig = {
      ...BASE_CONFIG,
      stepMonths: 1,
    };
    const windows = generateWindows(fineConfig);
    expect(windows.length).toBeGreaterThan(generateWindows(BASE_CONFIG).length);
  });
});

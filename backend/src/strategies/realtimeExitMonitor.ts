/**
 * RealtimeExitMonitor - State definitions for real-time exit detection.
 *
 * Defines the RealtimeExitState interface and factory/reset helpers used by
 * SimpleAgent's checkRealtimeExit() method. The full exit logic (~680 lines)
 * remains in simpleAgent.ts because it is deeply coupled to agent state
 * (NFS state machine, proactive limit tracking, exchange order manager, etc.).
 *
 * Extracting checkRealtimeExit() would require passing 15+ dependencies or
 * creating a god-object context, which adds complexity without reducing coupling.
 */

export interface RealtimeExitState {
  rtBreachSinceMs: number | null;
  rtBreachTicks: number;
  lastAppTrailingStop: number | null;
  lastRtTrailingKlineTs: number | null;
  rtTrailingBreachCandles: number;
  trailingActivatedAt: number | null;
  trailingUpdateCount: number;
  trailingNotified: boolean;
  trailingWidened: boolean;
  stagnantSlUpdated: boolean;
  realtimeExitInProgress: boolean;
}

export function createInitialRealtimeExitState(): RealtimeExitState {
  return {
    rtBreachSinceMs: null,
    rtBreachTicks: 0,
    lastAppTrailingStop: null,
    lastRtTrailingKlineTs: null,
    rtTrailingBreachCandles: 0,
    trailingActivatedAt: null,
    trailingUpdateCount: 0,
    trailingNotified: false,
    trailingWidened: false,
    stagnantSlUpdated: false,
    realtimeExitInProgress: false,
  };
}

export function resetRealtimeExitState(state: RealtimeExitState): void {
  state.rtBreachSinceMs = null;
  state.rtBreachTicks = 0;
  state.lastAppTrailingStop = null;
  state.lastRtTrailingKlineTs = null;
  state.rtTrailingBreachCandles = 0;
  state.realtimeExitInProgress = false;
}

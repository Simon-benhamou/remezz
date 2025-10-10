# Trade Diagnostic – 2025-01-09

- Post-mortem report: [2025-01-09 Losses](./post-mortems/2025-01-09-losses.md)

## Root Cause Synthesis
- **Momentum gating lag** – Across BTC, ETH, SOL, and AVAX exits, ADX and CMF deteriorated well before stops were hit, yet the agent maintained entries until the hard stop fired. Momentum checks flipped only after price breached protective envelopes, allowing deeper drawdowns.
- **Liquidity guard as advisory only** – BNB and SOL trades logged depth and spread warnings, but the guard remained non-blocking. Entries proceeded into thinning order books, magnifying slippage and shrinking the achievable R-multiple.
- **Circuit breaker latency** – ADA loss tripped the breaker only after the exit fill, meaning there was no proactive throttle once the consecutive stop threshold was reached. Subsequent trades still opened during the vulnerable window.
- **Bias drift vs. plan validation** – AVAX exit shows the bias-switch module recommending standby while the active plan stayed long. Without automatic re-validation, the agent held positions against the prevailing regime change.

## Recommended Mitigations
- Tighten live momentum exits: when ADX < 18 and CMF < −0.15 while unrealized R < −0.4, trigger an immediate market exit (or partial reduction) instead of waiting for stop-loss confirmation.
- Promote liquidity guard warnings to hard blockers when spread > 0.10% and depth ratio < 0.5. Abort new entries until the guard resets and shrink position size by 30% if advisory mode must proceed.
- Arm the circuit breaker once consecutive losses reach the penultimate threshold (e.g., 3 of 4). Deny further entries and auto-reduce existing exposure with limit orders before the final stop prints.
- When bias switching disagrees with the current plan, force a fresh plan validation or switch to standby mode; in-flight positions should tighten stops by 0.3 R and remove breakout extensions until alignment returns.

## Instrumentation Follow-Up
- Exit diagnostics now persist in `TriggerLog` (`kind = 'exit_diagnostic'`) with indicator snapshots, gate states, and protective context, enabling automated post-mortem exports without replaying broker telemetry.

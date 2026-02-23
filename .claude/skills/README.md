# PaRDeS Skills for Remezz Trading System

Four skills based on the PaRDeS hermeneutic framework, encoding critical thinking methodologies for building and maintaining the trading system correctly.

Plus one meta-skill for challenging assumptions before they cost money.

## The Four Levels

| Level | Skill | Philosophy | When |
|-------|-------|-----------|------|
| **Pshat** | `pshat-emet` | There is only one truth. Data must be factual. | Data pipeline, candles, WebSocket, caching |
| **Remez** | `remez-binah` | Read the hints, but know their limits. | Indicators, filters, signal detection |
| **Drash** | `drash-chokhmah` | Every decision has consequences across the system. | Entry/exit logic, risk, execution |
| **Sod** | `sod-yichud` | Live and backtest are ONE. Verify the unity. | Pre-commit gate, parity, CLAUDE.md |

## Meta-Skill

| Skill | Philosophy | When |
|-------|-----------|------|
| **Critical Skepticism** | `critical-skepticism` | If it looks too good, find the trap. | Results look amazing, metrics seem clean, deploying on small sample |

## How They Work Together

```
Pshat (data) -> Remez (interpretation) -> Drash (decision) -> Sod (unity)
                                                    ^
                                                    |
                                        Critical Skepticism
                                    (challenge at any stage)
```

- **Pshat** ensures the data is TRUE before anything else
- **Remez** reads patterns from that data, but demands OOS validation
- **Drash** decides how to act, ensuring all code paths are consistent
- **Sod** verifies the whole system is unified before committing
- **Critical Skepticism** challenges any conclusion that seems too clean

## Quick Reference

- Modifying candle fetching? -> `pshat-emet`
- Adding a new filter? -> `remez-binah`
- Changing trailing stop logic? -> `drash-chokhmah`
- About to commit? -> `sod-yichud`
- Results look too good? -> `critical-skepticism`

## Directory Structure

```
.claude/skills/
  pshat-emet/SKILL.md
  remez-binah/SKILL.md
  drash-chokhmah/SKILL.md
  sod-yichud/SKILL.md
  critical-skepticism/SKILL.md
```

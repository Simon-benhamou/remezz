# Historical Replay Runner

The historical replay runner executes the full meta-adaptive pipeline (tech snapshot → orchestrator → broker → Prisma persistence) against an offline candle dataset. The only thing that changes compared to production is the source of OHLCV/ticker data.

## Dataset format

Provide a JSON file that contains either:

- A top-level array of `[timestamp, open, high, low, close, volume]` rows, or
- An object with a `candles` array following the same schema.

Timestamps must be in milliseconds and the data must be sorted ascending. A minimum of ~600 rows is required to satisfy warmup windows (EMA, ATR, pivots, etc.).

Example (trimmed):

```json
[
  [1696118400000, 27000.5, 27120.1, 26990.0, 27085.2, 1834.5],
  [1696119300000, 27085.2, 27110.0, 27012.0, 27044.7, 1512.3]
]
```

## Running a replay

From `backend/`:

```bash
npm run replay:historical -- \
  --symbol BTCUSDT \
  --dataset ../data/btc-15m.json \
  --start-balance 1500 \
  --warmup 400 \
  --max-bars 500 \
  --log-every 50 \
  --json-out ../logs/btcusdt-replay.json
```

Key flags:

| Flag | Description |
| --- | --- |
| `--symbol` | Unified symbol to replay (required). |
| `--dataset` | Path to the JSON candle file (required). |
| `--start-balance` | Optional paper balance seed (defaults to 10k). |
| `--warmup` | Bars to preload before the first tick (default 400). |
| `--max-bars` | Cap on processed bars once warmup is complete. |
| `--log-every` | Emits a progress line every _n_ processed bars. |
| `--cleanup` | Delete the sandbox session data after the run. |
| `--json-out` | Write the replay summary to a file. |

## Output

The CLI prints (and optionally saves) a JSON payload summarizing the replay, e.g.:

```json
{
  "sessionId": "replay_sandbox_123",
  "symbol": "BTCUSDT",
  "candlesProcessed": 480,
  "stats": {
    "totalTrades": 3,
    "wins": 2,
    "losses": 1,
    "winRatePct": 66.67,
    "realizedPnlUsd": 84.21,
    "expectancyR": 0.42,
    "avgHoldingMin": 47.5
  },
  "trades": [
    { "exitReason": "tp2_hit", "realizedPnlUsd": 55.7, "capturedAt": "2024-10-01T12:30:00.000Z" }
  ]
}
```

Inspect Prisma tables (orders, fills, trigger logs, session KPI) for full fidelity metrics, or append `--cleanup` to automatically purge the sandbox artifacts after the summary is generated.

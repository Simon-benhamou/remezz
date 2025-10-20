import unittest
from datetime import datetime, timezone
from unittest import mock

import numpy as np
import pandas as pd

from ccxt_xgboost_module import (
    DEFAULT_LOOKBACK_HOURS,
    DEFAULT_TIMEFRAME,
    PreparedWindow,
    TrainingArtifacts,
    WindowSpec,
    run_training_workflow,
)


class RunTrainingWorkflowTest(unittest.TestCase):
    def test_run_training_basic_defaults_cover_all_symbols(self):
        symbols = ("AAA/BBB", "CCC/DDD", "EEE/FFF")
        rows_per_symbol = 16
        captured_datasets: list[pd.DataFrame] = []

        def fake_collect(exchange, symbols_arg, specs, anchor):
            del anchor
            self.assertEqual(exchange, "binance")
            self.assertEqual(tuple(symbols_arg), symbols)
            self.assertEqual(len(specs), 1)
            spec = specs[0]
            self.assertEqual(spec.timeframe, DEFAULT_TIMEFRAME)
            self.assertEqual(spec.hours, DEFAULT_LOOKBACK_HOURS)
            windows: list[PreparedWindow] = []
            for idx, symbol in enumerate(symbols):
                timestamps = pd.date_range("2024-01-01", periods=rows_per_symbol, freq="15min")
                base = idx * 0.1
                frame = pd.DataFrame(
                    {
                        "timestamp": timestamps,
                        "ema20": np.linspace(1, 2, rows_per_symbol) + base,
                        "ema50": np.linspace(2, 3, rows_per_symbol) + base,
                        "ema100": np.linspace(3, 4, rows_per_symbol) + base,
                        "ema200": np.linspace(4, 5, rows_per_symbol) + base,
                        "rsi14": np.linspace(30, 70, rows_per_symbol),
                        "atr14": np.linspace(0.5, 1.5, rows_per_symbol),
                        "adx14": np.linspace(10, 40, rows_per_symbol),
                        "ema20Slope": np.linspace(-1, 1, rows_per_symbol),
                        "volumeRatio": np.linspace(0.5, 1.5, rows_per_symbol),
                        "target": ([0, 1] * (rows_per_symbol // 2))[:rows_per_symbol],
                    }
                )
                windows.append(PreparedWindow(symbol=symbol, spec=spec, dataset=frame))
            return windows

        def fake_train(data, params):
            del params
            captured_datasets.append(data.copy())
            features = [col for col in data.columns if col not in {"timestamp", "target"}]
            model = mock.Mock()
            model.save_model = mock.Mock()
            return TrainingArtifacts(model=model, features=features, metrics={"accuracy": 0.88, "f1": 0.83})

        with (
            mock.patch("ccxt_xgboost_module.collect_prepared_windows", side_effect=fake_collect) as patched_collect,
            mock.patch("ccxt_xgboost_module.train_model", side_effect=fake_train) as patched_train,
            mock.patch("ccxt_xgboost_module.save_model_and_features") as patched_save,
        ):
            artifacts = run_training_workflow(exchange="binance", symbols=symbols)

        self.assertEqual(patched_collect.call_count, 1)
        self.assertEqual(patched_train.call_count, 1)
        self.assertEqual(patched_save.call_count, 1)
        self.assertEqual(len(captured_datasets), 1)
        combined = captured_datasets[0]
        self.assertEqual(len(combined), rows_per_symbol * len(symbols))
        for feature in ("ema20", "ema50", "ema100", "ema200", "rsi14", "atr14", "adx14", "ema20Slope", "volumeRatio"):
            self.assertIn(feature, artifacts.features)

    def test_run_training_aggregates_multiple_windows(self):
        specs = (
            WindowSpec("15m", hours=24, offset_hours=0),
            WindowSpec("1h", hours=48, offset_hours=24),
        )
        symbols = ("BTC/USDT", "ETH/USDT")
        prepared_rows = 40
        prepare_calls: list[int] = []
        fetch_calls: list[tuple[str, str]] = []
        captured_datasets: list[pd.DataFrame] = []
        fixed_anchor = datetime(2024, 1, 1, tzinfo=timezone.utc)

        def fake_fetch(exchange, symbol, timeframe, start_ts, end_ts):
            del exchange, start_ts, end_ts
            fetch_calls.append((symbol, timeframe))
            timestamps = pd.date_range("2023-12-01", periods=prepared_rows, freq="h")
            return pd.DataFrame(
                {
                    "timestamp": timestamps,
                    "open": np.linspace(100, 105, prepared_rows),
                    "high": np.linspace(101, 106, prepared_rows),
                    "low": np.linspace(99, 104, prepared_rows),
                    "close": np.linspace(100.5, 105.5, prepared_rows),
                    "volume": np.linspace(1000, 1100, prepared_rows),
                }
            )

        def fake_prepare_dataset(frame):
            self.assertEqual(len(frame), prepared_rows)
            base = len(prepare_calls)
            prepare_calls.append(base)
            timestamps = pd.date_range("2023-12-01", periods=prepared_rows, freq="h")
            targets = [0, 1] * (prepared_rows // 2)
            if len(targets) < prepared_rows:
                targets.append(0)
            return pd.DataFrame(
                {
                    "timestamp": timestamps,
                    "ema20": np.linspace(1, 2, prepared_rows) + base,
                    "ema50": np.linspace(2, 3, prepared_rows) + base,
                    "ema100": np.linspace(3, 4, prepared_rows) + base,
                    "ema200": np.linspace(4, 5, prepared_rows) + base,
                    "rsi14": np.linspace(30, 70, prepared_rows),
                    "atr14": np.linspace(0.5, 1.5, prepared_rows),
                    "adx14": np.linspace(10, 40, prepared_rows),
                    "ema20Slope": np.linspace(-1, 1, prepared_rows),
                    "volumeRatio": np.linspace(0.5, 1.5, prepared_rows),
                    "target": targets,
                }
            )

        def fake_train_model(data, params):
            del params
            captured_datasets.append(data.copy())
            features = [col for col in data.columns if col not in {"timestamp", "target"}]
            model = mock.Mock()
            model.save_model = mock.Mock()
            return TrainingArtifacts(model=model, features=features, metrics={"accuracy": 0.9, "f1": 0.85})

        with (
            mock.patch("ccxt_xgboost_module.fetch_ohlcv", side_effect=fake_fetch) as patched_fetch,
            mock.patch("ccxt_xgboost_module.prepare_dataset", side_effect=fake_prepare_dataset) as patched_prepare,
            mock.patch("ccxt_xgboost_module.train_model", side_effect=fake_train_model) as patched_train,
            mock.patch("ccxt_xgboost_module.save_model_and_features") as patched_save,
        ):
            artifacts = run_training_workflow(
                exchange="binance",
                symbols=symbols,
                window_specs=specs,
                anchor=fixed_anchor,
            )

        self.assertEqual(len(fetch_calls), len(specs) * len(symbols))
        self.assertEqual(patched_fetch.call_count, len(specs) * len(symbols))
        self.assertEqual(patched_prepare.call_count, len(specs) * len(symbols))
        self.assertEqual(patched_train.call_count, 1)
        self.assertEqual(patched_save.call_count, 1)
        self.assertAlmostEqual(artifacts.metrics["accuracy"], 0.9)
        self.assertEqual(len(captured_datasets), 1)
        combined = captured_datasets[0]
        expected_rows = len(specs) * len(symbols) * prepared_rows
        self.assertEqual(len(combined), expected_rows)
        for meta in ("symbol", "windowIndex", "timeframeMinutes", "windowOffsetHours", "windowHours"):
            self.assertNotIn(meta, combined.columns)
        for feature in ("ema20", "ema50", "ema100", "ema200", "rsi14", "atr14", "adx14", "ema20Slope", "volumeRatio"):
            self.assertIn(feature, artifacts.features)


if __name__ == "__main__":
    unittest.main()

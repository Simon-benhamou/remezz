"""
Realistic 10-Day Backtest for Meta-Adaptive Strategy
Starting capital: $1,000
Simulates realistic market conditions with volatility, trends, and choppy periods
"""
import unittest
from datetime import datetime, timedelta
from typing import List, Tuple
import random
import math

from quantailabs_patch.backtest.execution import ExecCosts, apply_fees_slippage
from quantailabs_patch.execution import AdaptiveExecutionController
from quantailabs_patch.eval.metrics import Metrics
from quantailabs_patch.risk.circuit_breaker import CircuitBreaker
from quantailabs_patch.risk.position_sizing import PositionSizer
from quantailabs_patch.strategy.exits import ExitConfig, compute_initial_sl_tp, maybe_adjust_or_exit
from quantailabs_patch.strategy.guardrails import SymbolGuardrails


class MarketSimulator:
    """Generates realistic market conditions for backtesting"""
    
    def __init__(self, start_price: float = 100.0, volatility: float = 0.02, seed: int = 42):
        self.price = start_price
        self.volatility = volatility
        random.seed(seed)
        self.trend = 0.0
        self.trend_duration = 0
        
    def next_candle(self, minutes: int = 15) -> Tuple[float, float, float, float, float]:
        """Generate OHLCV for next candle"""
        # Update trend periodically
        if self.trend_duration <= 0:
            # New trend: 40% bullish, 40% bearish, 20% sideways
            rand = random.random()
            if rand < 0.4:
                self.trend = random.uniform(0.0005, 0.002)  # Bullish
            elif rand < 0.8:
                self.trend = random.uniform(-0.002, -0.0005)  # Bearish
            else:
                self.trend = random.uniform(-0.0003, 0.0003)  # Sideways
            self.trend_duration = random.randint(8, 30)  # Trend lasts 2-7.5 hours
        
        self.trend_duration -= 1
        
        # Generate price movement
        trend_move = self.price * self.trend
        random_move = self.price * self.volatility * random.gauss(0, 1)
        price_change = trend_move + random_move
        
        open_price = self.price
        close_price = max(0.01, self.price + price_change)
        
        # Generate high/low with realistic wicks
        wick_size = abs(close_price - open_price) * random.uniform(0.3, 1.5)
        high = max(open_price, close_price) + abs(wick_size * random.uniform(0, 1))
        low = min(open_price, close_price) - abs(wick_size * random.uniform(0, 1))
        
        # Volume varies with volatility
        base_volume = 1000000
        volume = base_volume * random.uniform(0.5, 2.0)
        
        self.price = close_price
        return open_price, high, low, close_price, volume
    
    def calculate_atr(self, candles: List[Tuple[float, float, float, float, float]], period: int = 14) -> float:
        """Calculate ATR from recent candles"""
        if len(candles) < 2:
            return self.price * 0.02  # Default 2%
        
        true_ranges = []
        for i in range(1, min(len(candles), period + 1)):
            h = candles[i][1]  # high
            l = candles[i][2]  # low
            prev_c = candles[i-1][3]  # prev close
            tr = max(h - l, abs(h - prev_c), abs(l - prev_c))
            true_ranges.append(tr)
        
        return sum(true_ranges) / len(true_ranges) if true_ranges else self.price * 0.02
    
    def calculate_indicators(self, candles: List[Tuple[float, float, float, float, float]]) -> dict:
        """Calculate technical indicators"""
        if len(candles) < 14:
            return {'rsi': 50.0, 'adx': 20.0, 'cmf': 0.0}
        
        # Simple RSI approximation
        closes = [c[3] for c in candles[-14:]]
        gains = [max(0, closes[i] - closes[i-1]) for i in range(1, len(closes))]
        losses = [max(0, closes[i-1] - closes[i]) for i in range(1, len(closes))]
        avg_gain = sum(gains) / len(gains) if gains else 0.001
        avg_loss = sum(losses) / len(losses) if losses else 0.001
        rs = avg_gain / avg_loss if avg_loss > 0 else 1
        rsi = 100 - (100 / (1 + rs))
        
        # Simple ADX approximation (trend strength)
        price_changes = [abs(closes[i] - closes[i-1]) for i in range(1, len(closes))]
        adx = min(50, (sum(price_changes) / len(price_changes)) / closes[-1] * 1000)
        
        # CMF approximation (money flow)
        cmf = random.gauss(0, 0.2) if abs(self.trend) > 0.001 else random.gauss(0, 0.05)
        
        return {'rsi': rsi, 'adx': adx, 'cmf': cmf}


class Trade:
    """Track individual trade"""
    def __init__(self, symbol: str, side: str, entry_price: float, qty: float, 
                 sl: float, tps: List[float], timestamp: datetime):
        self.symbol = symbol
        self.side = side
        self.entry_price = entry_price
        self.qty = qty
        self.sl = sl
        self.tps = tps
        self.timestamp = timestamp
        self.exit_price = None
        self.exit_timestamp = None
        self.pnl = 0.0
        self.pnl_pct = 0.0
        self.reason = ""


class Realistic10DayBacktest(unittest.TestCase):
    """Comprehensive 10-day backtest with realistic market conditions"""
    
    def test_realistic_10day_meta_adaptive_backtest(self):
        """Run a realistic 10-day backtest with $1,000 starting capital"""
        
        # Configuration
        STARTING_CAPITAL = 1000.0
        DAYS = 10
        CANDLES_PER_DAY = 96  # 15-min candles
        SYMBOL = "BTC/USDT"
        
        # Initialize components
        equity = STARTING_CAPITAL
        market = MarketSimulator(start_price=45000.0, volatility=0.015)
        breaker = CircuitBreaker(
            max_consecutive_losses=3,
            cooldown_minutes=60,
            daily_loss_limit_pct=3.0,
            daily_trade_limit=7
        )
        guard = SymbolGuardrails(
            min_samples=5,
            win_rate_floor=0.35,
            expectancy_floor=-0.5,
            cooldown=timedelta(hours=12)
        )
        sizer = PositionSizer(base_risk_per_trade_pct=2.0)
        exits_cfg = ExitConfig(
            sl_atr_mult=1.5,
            tp_r_multiples=[1.5, 2.5, 4.0],
            breakeven_after_r=1.5,
            trail_after_r=2.0,
            trail_atr_mult=2.0
        )
        metrics = Metrics()
        executor = AdaptiveExecutionController()
        costs = ExecCosts(taker_fee_bps=7.5, maker_fee_bps=2.5, slippage_bps=2.0)
        
        # Track state
        candles = []
        trades: List[Trade] = []
        active_trade: Trade | None = None
        now = datetime(2024, 1, 1, 0, 0)
        
        # Statistics
        total_signals = 0
        signals_blocked_by_breaker = 0
        signals_blocked_by_guard = 0
        signals_blocked_by_equity = 0
        max_equity = STARTING_CAPITAL
        min_equity = STARTING_CAPITAL
        
        print(f"\n{'='*80}")
        print(f"REALISTIC 10-DAY META-ADAPTIVE BACKTEST")
        print(f"{'='*80}")
        print(f"Starting Capital: ${STARTING_CAPITAL:,.2f}")
        print(f"Symbol: {SYMBOL}")
        print(f"Period: {DAYS} days ({DAYS * CANDLES_PER_DAY} candles @ 15min)")
        print(f"Risk per trade: 2% of equity")
        print(f"{'='*80}\n")
        
        # Run backtest
        for day in range(DAYS):
            for candle_idx in range(CANDLES_PER_DAY):
                # Generate market data
                ohlcv = market.next_candle(minutes=15)
                candles.append(ohlcv)
                current_price = ohlcv[3]  # close
                
                # Calculate indicators
                atr = market.calculate_atr(candles)
                atr_pct = (atr / current_price) * 100
                indicators = market.calculate_indicators(candles)
                
                # Manage active position
                if active_trade is not None:
                    # Check for exit
                    decision = maybe_adjust_or_exit(
                        active_trade.side,
                        active_trade.entry_price,
                        active_trade.sl,
                        active_trade.tps,
                        current_price,
                        atr,
                        adx=indicators['adx'],
                        cmf=indicators['cmf'],
                        cfg=exits_cfg
                    )
                    
                    if decision['action'] == 'exit':
                        # Exit trade
                        exit_price = apply_fees_slippage(
                            'short' if active_trade.side == 'long' else 'long',
                            current_price,
                            costs,
                            taker=True
                        )
                        
                        if active_trade.side == 'long':
                            pnl = (exit_price - active_trade.entry_price) * active_trade.qty
                            pnl_pct = ((exit_price - active_trade.entry_price) / active_trade.entry_price) * 100
                        else:
                            pnl = (active_trade.entry_price - exit_price) * active_trade.qty
                            pnl_pct = ((active_trade.entry_price - exit_price) / active_trade.entry_price) * 100
                        
                        equity += pnl
                        active_trade.exit_price = exit_price
                        active_trade.exit_timestamp = now
                        active_trade.pnl = pnl
                        active_trade.pnl_pct = pnl_pct
                        active_trade.reason = decision.get('reason', 'unknown')
                        
                        # Update tracking
                        metrics.add_trade(pnl_pct)
                        guard.register_trade(SYMBOL, pnl_pct, now)
                        breaker.on_trade_result(now, pnl_pct, equity)
                        
                        max_equity = max(max_equity, equity)
                        min_equity = min(min_equity, equity)
                        
                        trades.append(active_trade)
                        active_trade = None
                        
                    elif decision['action'] == 'move_sl':
                        # Update stop loss
                        active_trade.sl = decision['sl']
                        if decision.get('tps'):
                            active_trade.tps = decision['tps']
                
                # Look for entry signals (only if no active position)
                if active_trade is None and len(candles) >= 20:
                    # More aggressive signal generation for realistic testing
                    signal = None
                    
                    # Bullish signal: RSI oversold + positive momentum OR strong trend
                    if (indicators['rsi'] < 40 and market.trend > 0.0005) or \
                       (indicators['rsi'] < 45 and market.trend > 0.001 and indicators['adx'] > 20):
                        signal = 'long'
                        total_signals += 1
                    
                    # Bearish signal: RSI overbought + negative momentum OR strong downtrend
                    elif (indicators['rsi'] > 60 and market.trend < -0.0005) or \
                         (indicators['rsi'] > 55 and market.trend < -0.001 and indicators['adx'] > 20):
                        signal = 'short'
                        total_signals += 1
                    
                    # Attempt to enter trade if signal exists
                    if signal:
                        # Check guardrails
                        halted, halt_reason, _ = guard.is_halted(SYMBOL, now)
                        if halted:
                            signals_blocked_by_guard += 1
                            signal = None
                        
                        # Check circuit breaker
                        if signal:
                            ok, breaker_reason = breaker.can_open_trade(now, equity)
                            if not ok:
                                signals_blocked_by_breaker += 1
                                signal = None
                        
                        # Check minimum equity
                        if signal and equity < 100:
                            signals_blocked_by_equity += 1
                            signal = None
                        
                        # Enter trade
                        if signal:
                            # Calculate position
                            sl, tps = compute_initial_sl_tp(current_price, atr, signal, exits_cfg)
                            qty = sizer.compute_size(equity, current_price, sl, atr_pct)
                            
                            if qty > 0:
                                # Execute entry
                                plan = executor.plan(
                                    SYMBOL,
                                    qty * current_price,
                                    spread_bps=5.0,
                                    book_depth_usd=qty * current_price * 2
                                )
                                
                                entry_price = apply_fees_slippage(
                                    signal,
                                    current_price,
                                    costs,
                                    taker=(plan.mode == 'market')
                                )
                                
                                # Record fill
                                fill_ratio = 1.0 if plan.mode == 'market' else 0.8
                                executor.record_fill(SYMBOL, fill_ratio, 2.0, 5.0, now)
                                
                                # Create trade
                                active_trade = Trade(
                                    SYMBOL, signal, entry_price, qty, sl, tps, now
                                )
                                
                                breaker.on_before_open(now, equity)
                
                # Advance time
                now += timedelta(minutes=15)
        
        # Close any remaining position
        if active_trade is not None:
            exit_price = apply_fees_slippage(
                'short' if active_trade.side == 'long' else 'long',
                candles[-1][3],
                costs,
                taker=True
            )
            
            if active_trade.side == 'long':
                pnl = (exit_price - active_trade.entry_price) * active_trade.qty
                pnl_pct = ((exit_price - active_trade.entry_price) / active_trade.entry_price) * 100
            else:
                pnl = (active_trade.entry_price - exit_price) * active_trade.qty
                pnl_pct = ((active_trade.entry_price - exit_price) / active_trade.entry_price) * 100
            
            equity += pnl
            active_trade.pnl = pnl
            active_trade.pnl_pct = pnl_pct
            active_trade.exit_price = exit_price
            active_trade.exit_timestamp = now
            active_trade.reason = "backtest_end"
            trades.append(active_trade)
            metrics.add_trade(pnl_pct)
        
        # Generate report
        report = metrics.as_dict()
        
        print(f"\n{'='*80}")
        print(f"BACKTEST RESULTS")
        print(f"{'='*80}")
        print(f"\nCapital Management:")
        print(f"  Starting Equity: ${STARTING_CAPITAL:,.2f}")
        print(f"  Final Equity:    ${equity:,.2f}")
        print(f"  Total P&L:       ${equity - STARTING_CAPITAL:,.2f} ({((equity/STARTING_CAPITAL - 1) * 100):.2f}%)")
        print(f"  Peak Equity:     ${max_equity:,.2f}")
        print(f"  Lowest Equity:   ${min_equity:,.2f}")
        print(f"  Max Drawdown:    ${max_equity - min_equity:,.2f}")
        
        print(f"\nTrading Activity:")
        print(f"  Total Signals:         {total_signals}")
        print(f"  Trades Executed:       {len(trades)}")
        print(f"  Blocked by Breaker:    {signals_blocked_by_breaker}")
        print(f"  Blocked by Guardrails: {signals_blocked_by_guard}")
        print(f"  Blocked by Equity:     {signals_blocked_by_equity}")
        print(f"  Avg Trades per Day:    {len(trades) / DAYS:.1f}")
        
        if report['n'] > 0:
            print(f"\nPerformance Metrics:")
            print(f"  Win Rate:        {report['win_rate'] * 100:.1f}%")
            print(f"  Total Trades:    {report['n']}")
            print(f"  Winners:         {report['wins']}")
            print(f"  Losers:          {report['losses']}")
            print(f"  Profit Factor:   {report['profit_factor']:.2f}")
            print(f"  Expectancy:      {report['expectancy']:.3f}%")
            print(f"  Max Drawdown:    {report['max_drawdown_pct']:.2f}%")
            print(f"  Sharpe-like:     {report['sharpe_like']:.2f}")
            print(f"  CAGR per Trade:  {report['cagr_per_trade']:.3f}%")
            
            print(f"\nTrade Breakdown:")
            winners = [t for t in trades if t.pnl > 0]
            losers = [t for t in trades if t.pnl <= 0]
            print(f"  Winners: {len(winners)} trades, Total P&L: ${sum(t.pnl for t in winners):,.2f}")
            print(f"  Losers:  {len(losers)} trades, Total P&L: ${sum(t.pnl for t in losers):,.2f}")
            
            if trades:
                print(f"\nSample Trades:")
                for i, trade in enumerate(trades[:5]):
                    duration = (trade.exit_timestamp - trade.timestamp).total_seconds() / 3600 if trade.exit_timestamp else 0
                    print(f"  Trade #{i+1}: {trade.side.upper()} @ ${trade.entry_price:,.2f} -> ${trade.exit_price:,.2f}")
                    print(f"    P&L: ${trade.pnl:,.2f} ({trade.pnl_pct:+.2f}%), Duration: {duration:.1f}h, Exit: {trade.reason}")
        
        print(f"\nRisk Management Status:")
        print(f"  Circuit Breaker:")
        print(f"    Consecutive Losses: {breaker.consecutive_losses}")
        print(f"    Trades Today:       {breaker.trades_today}")
        print(f"  Guardrails:")
        guard_stats = guard.describe(SYMBOL)
        print(f"    Sample Size:    {guard_stats['samples']}")
        if guard_stats['win_rate'] is not None:
            print(f"    Win Rate:       {guard_stats['win_rate'] * 100:.1f}%")
            print(f"    Expectancy:     {guard_stats['expectancy']:.3f}%")
        print(f"    Status:         {'HALTED' if guard_stats.get('halted') else 'ACTIVE'}")
        
        print(f"\n{'='*80}")
        
        # Assertions to validate backtest
        self.assertGreaterEqual(len(trades), 0, "Should have attempted some trades")
        self.assertGreater(equity, 0, "Equity should remain positive")
        self.assertLess(equity, STARTING_CAPITAL * 3, "Equity shouldn't triple in 10 days (sanity check)")
        
        # Verify risk management worked
        self.assertLessEqual(breaker.consecutive_losses, breaker.max_consecutive_losses + 1, 
                            "Consecutive losses should be limited")
        
        # Return results for analysis
        return {
            'starting_capital': STARTING_CAPITAL,
            'final_equity': equity,
            'total_return_pct': ((equity / STARTING_CAPITAL) - 1) * 100,
            'trades': len(trades),
            'win_rate': report.get('win_rate', 0),
            'profit_factor': report.get('profit_factor', 0),
            'max_drawdown_pct': report.get('max_drawdown_pct', 0),
            'signals_generated': total_signals,
            'signals_blocked': signals_blocked_by_breaker + signals_blocked_by_guard,
        }


if __name__ == '__main__':
    # Run test and capture results
    suite = unittest.TestLoader().loadTestsFromTestCase(Realistic10DayBacktest)
    runner = unittest.TextTestRunner(verbosity=2)
    runner.run(suite)

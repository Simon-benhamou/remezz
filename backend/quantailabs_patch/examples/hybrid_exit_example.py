"""
Example: Using Hybrid Smart Exit Logic

This example demonstrates how to use the new hybrid exit features:
1. Counter-signal awareness (rotation detection)
2. Adaptive peak drawdown protection
3. Multi-indicator technical reversal detection

The hybrid exit logic works with the trailing stop strategy (EXIT_STRATEGY_MODE = trailing)
and provides intelligent exits when trends reverse or positions rotate.
"""
from datetime import datetime
from quantailabs_patch.strategy.exits import (
    ExitConfig, HybridExitConfig, TechnicalSnapshot,
    compute_initial_sl_tp, maybe_adjust_or_exit
)

# Configure hybrid exit with custom thresholds
hybrid_config = HybridExitConfig(
    # Enable all hybrid features
    enable_counter_signal_exits=True,
    enable_peak_drawdown_protection=True,
    enable_reversal_detection=True,
    
    # Counter-signal thresholds
    counter_signal_exit_confidence=0.7,      # Exit if confidence >= 0.7 and R >= 2.0
    counter_signal_exit_min_r=2.0,
    counter_signal_tighten_confidence=0.6,   # Tighten if confidence >= 0.6 and R >= 1.0
    counter_signal_tighten_min_r=1.0,
    
    # Peak drawdown protection (adaptive by R-multiple)
    peak_drawdown_thresholds={
        1.0: 0.05,   # 5% drawdown allowed at 1R
        2.0: 0.04,   # 4% drawdown allowed at 2R
        3.0: 0.03,   # 3% drawdown allowed at 3R
        5.0: 0.02,   # 2% drawdown allowed at 5R+
    },
    
    # Technical reversal thresholds
    reversal_exit_score=75.0,      # Exit if score >= 75 and R >= 2.0
    reversal_exit_min_r=2.0,
    reversal_tighten_score=60.0,   # Tighten if score >= 60 and R >= 1.0
    reversal_tighten_min_r=1.0,
)

# Create exit config with hybrid settings
exit_config = ExitConfig(
    sl_atr_mult=1.5,
    tp_r_multiples=[2.0, 3.2, 4.6],
    trail_after_r=0.8,
    trail_atr_mult=1.0,
    breakeven_after_r=0.5,
    hybrid=hybrid_config
)

# Example: ZEC/USDT scenario from the issue
def example_zec_usdt_reversal():
    """
    Demonstrates the ZEC/USDT reversal scenario:
    - Entry at 643, peak at 670 (~4R, +4.2%)
    - Strategy rotates LONG -> SHORT while holding
    - Hybrid exit triggers to lock in gains
    """
    print("\n" + "="*80)
    print("EXAMPLE: ZEC/USDT Reversal Scenario")
    print("="*80)
    
    # Position setup
    entry_price = 643.0
    atr = 10.0
    side = 'long'
    
    # Initial bracket
    sl, tps = compute_initial_sl_tp(entry_price, atr, side, exit_config)
    print(f"\nEntry: ${entry_price:.2f}")
    print(f"Initial SL: ${sl:.2f}")
    print(f"Initial TPs: {[f'${tp:.2f}' for tp in tps]}")
    
    # Track peak price
    peak_price = entry_price
    
    # Scenario 1: Price moves to 670 (peak)
    current_price = 670.0
    peak_price = max(peak_price, current_price)
    
    print(f"\n--- Price reaches ${current_price:.2f} (peak) ---")
    decision = maybe_adjust_or_exit(
        side, entry_price, sl, tps, current_price, atr,
        adx=25.0, cmf=0.15, cfg=exit_config,
        peak_price=peak_price
    )
    print(f"Action: {decision['action']}, Reason: {decision['reason']}")
    if decision['action'] == 'move_sl':
        sl = decision['sl']
        print(f"New SL: ${sl:.2f}")
    
    # Scenario 2: Strong counter-signal (rotation to SHORT) at 673
    current_price = 673.0
    peak_price = max(peak_price, current_price)
    
    print(f"\n--- Counter-signal: LONG -> SHORT rotation at ${current_price:.2f} ---")
    print(f"Counter-signal confidence: 0.75 (strong)")
    
    decision = maybe_adjust_or_exit(
        side, entry_price, sl, tps, current_price, atr,
        adx=25.0, cmf=0.1, cfg=exit_config,
        peak_price=peak_price,
        counter_signal_side='short',
        counter_signal_confidence=0.75
    )
    print(f"Action: {decision['action']}, Reason: {decision['reason']}")
    
    if decision['action'] == 'exit':
        pnl_pct = ((current_price - entry_price) / entry_price) * 100
        print(f"\n✓ Position EXITED at ${current_price:.2f}")
        print(f"  P&L: +{pnl_pct:.2f}% (locked in gains before reversal)")
    
    print("\nResult: Hybrid exit protected profits before reversal to 620")

def example_technical_reversal():
    """
    Demonstrates technical reversal detection with multiple indicators
    """
    print("\n" + "="*80)
    print("EXAMPLE: Technical Reversal Detection")
    print("="*80)
    
    # Position setup
    entry_price = 100.0
    atr = 2.5
    side = 'long'
    
    sl, tps = compute_initial_sl_tp(entry_price, atr, side, exit_config)
    peak_price = 112.5  # At 3.3R profit
    current_price = 109.0
    
    print(f"\nEntry: ${entry_price:.2f}")
    print(f"Peak: ${peak_price:.2f} (+12.5%)")
    print(f"Current: ${current_price:.2f}")
    
    # Build technical snapshot showing reversal signals
    current_snapshot = TechnicalSnapshot(
        ema_fast=108.0,     # Fast EMA crossed below slow (bearish)
        ema_slow=110.0,
        macd=-0.5,          # MACD crossed below signal (bearish)
        macd_signal=0.3,
        rsi=72.0,           # Overbought
        volume=45000,       # Volume declining
        support_level=107.0,
        price=109.0
    )
    
    previous_snapshot = TechnicalSnapshot(
        ema_fast=111.0,     # Fast was above slow
        ema_slow=110.0,
        macd=0.4,           # MACD was above signal
        macd_signal=0.3,
        volume=95000,       # Volume was higher
        price=112.0
    )
    
    print("\nTechnical Indicators:")
    print("  - EMA: Fast crossed below slow (bearish)")
    print("  - MACD: Crossed below signal (bearish)")
    print("  - RSI: 72 (overbought)")
    print("  - Volume: -53% decline")
    
    decision = maybe_adjust_or_exit(
        side, entry_price, sl, tps, current_price, atr,
        adx=18.0, cmf=-0.05, cfg=exit_config,
        peak_price=peak_price,
        technical_snapshot=current_snapshot,
        previous_snapshot=previous_snapshot
    )
    
    print(f"\nDecision: {decision['action']}")
    print(f"Reason: {decision['reason']}")
    
    if decision['action'] == 'exit':
        pnl_pct = ((current_price - entry_price) / entry_price) * 100
        print(f"\n✓ Position EXITED at ${current_price:.2f}")
        print(f"  P&L: +{pnl_pct:.2f}%")
        print(f"  Protected against further reversal")

def example_peak_drawdown_protection():
    """
    Demonstrates adaptive peak drawdown protection
    """
    print("\n" + "="*80)
    print("EXAMPLE: Adaptive Peak Drawdown Protection")
    print("="*80)
    
    entry_price = 100.0
    atr = 2.0
    side = 'long'
    
    sl, tps = compute_initial_sl_tp(entry_price, atr, side, exit_config)
    
    print(f"\nEntry: ${entry_price:.2f}")
    print(f"Initial Risk: ${abs(entry_price - sl):.2f}")
    
    # Scenario: Position reaches 5R, then gives back
    peak_price = 115.0  # 5R profit
    
    print(f"\nPeak: ${peak_price:.2f} (5R profit)")
    print(f"Drawdown threshold at 5R: 2%")
    
    # Test different drawdown levels
    test_prices = [
        (114.0, 0.87),  # 0.87% drawdown - should hold
        (113.0, 1.74),  # 1.74% drawdown - should hold
        (112.7, 2.0),   # 2.0% drawdown - at threshold
        (112.5, 2.17),  # 2.17% drawdown - should EXIT
    ]
    
    for price, dd_pct in test_prices:
        decision = maybe_adjust_or_exit(
            side, entry_price, sl, tps, price, atr,
            adx=25.0, cmf=0.1, cfg=exit_config,
            peak_price=peak_price
        )
        
        status = "✓ EXIT" if decision['action'] == 'exit' else "○ Hold"
        print(f"  ${price:.2f} ({dd_pct:.2f}% from peak): {status}")
        
        if decision['action'] == 'exit':
            print(f"    Reason: {decision['reason']}")
            break

def example_progressive_tightening():
    """
    Demonstrates progressive tightening with hybrid signals
    """
    print("\n" + "="*80)
    print("EXAMPLE: Progressive Tightening on Medium Signals")
    print("="*80)
    
    entry_price = 100.0
    atr = 2.0
    side = 'long'
    
    sl, tps = compute_initial_sl_tp(entry_price, atr, side, exit_config)
    current_price = 105.0  # 1.67R profit
    
    print(f"\nEntry: ${entry_price:.2f}")
    print(f"Current: ${current_price:.2f} (1.67R profit)")
    print(f"Current SL: ${sl:.2f}")
    
    # Medium counter-signal triggers aggressive tightening
    print(f"\nMedium counter-signal detected:")
    print(f"  Confidence: 0.65 (>= 0.6 threshold)")
    print(f"  Direction: SHORT (opposite of LONG position)")
    
    decision = maybe_adjust_or_exit(
        side, entry_price, sl, tps, current_price, atr,
        adx=22.0, cmf=0.05, cfg=exit_config,
        counter_signal_side='short',
        counter_signal_confidence=0.65
    )
    
    print(f"\nDecision: {decision['action']}")
    print(f"Reason: {decision['reason']}")
    
    if decision['action'] == 'move_sl':
        print(f"New SL: ${decision['sl']:.2f} (aggressive 0.3x ATR tightening)")
        print(f"Tightening: ${sl:.2f} -> ${decision['sl']:.2f} ({decision['sl'] - sl:+.2f})")

if __name__ == '__main__':
    # Run all examples
    example_zec_usdt_reversal()
    example_technical_reversal()
    example_peak_drawdown_protection()
    example_progressive_tightening()
    
    print("\n" + "="*80)
    print("Hybrid exit logic combines all three mechanisms for maximum protection")
    print("="*80)

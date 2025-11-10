from dataclasses import dataclass, field
from typing import Dict, List, Tuple, Optional

@dataclass
class HybridExitConfig:
    """Configuration for hybrid smart exit logic"""
    # Counter-signal thresholds
    counter_signal_exit_confidence: float = 0.7  # Exit if counter-signal confidence > 0.7 and R > 2
    counter_signal_exit_min_r: float = 2.0
    counter_signal_tighten_confidence: float = 0.6  # Tighten if confidence > 0.6 and R > 1
    counter_signal_tighten_min_r: float = 1.0
    counter_signal_monitor_confidence: float = 0.5  # Monitor below this threshold
    
    # Adaptive peak drawdown thresholds by R-multiple
    peak_drawdown_thresholds: Dict[float, float] = field(default_factory=lambda: {
        1.0: 0.05,   # 5% drawdown from peak at 1R
        2.0: 0.04,   # 4% drawdown from peak at 2R
        3.0: 0.03,   # 3% drawdown from peak at 3R
        5.0: 0.02,   # 2% drawdown from peak at 5R+
    })
    
    # Technical reversal detection
    reversal_exit_score: float = 75.0  # Exit if reversal score > 75 and R > 2
    reversal_exit_min_r: float = 2.0
    reversal_tighten_score: float = 60.0  # Tighten if score > 60 and R > 1
    reversal_tighten_min_r: float = 1.0
    
    # Enable/disable hybrid exit features
    enable_counter_signal_exits: bool = True
    enable_peak_drawdown_protection: bool = True
    enable_reversal_detection: bool = True

@dataclass
class ExitConfig:
    atr_period: int = 14
    sl_atr_mult: float = 1.5
    tp_r_multiples: List[float] = None
    trail_after_r: float = 0.8  # Start trailing earlier at 0.8R instead of 1.0R
    trail_atr_mult: float = 1.0
    early_exit_adx_below: float = 18.0
    early_exit_cmf_negative: bool = True
    tighten_only_if_profit_gt_r: float = 0.2
    cut_if_loss_gt_r: float = 0.5
    breakeven_after_r: float = 0.5  # Move SL to breakeven after 0.5R profit
    
    # Hybrid exit configuration (optional)
    hybrid: Optional[HybridExitConfig] = None

    def __post_init__(self):
        if self.tp_r_multiples is None:
            self.tp_r_multiples = [0.5, 1.0, 2.0]
        if self.hybrid is None:
            self.hybrid = HybridExitConfig()

@dataclass
class TechnicalSnapshot:
    """Technical indicators snapshot for reversal detection"""
    ema_fast: Optional[float] = None
    ema_slow: Optional[float] = None
    macd: Optional[float] = None
    macd_signal: Optional[float] = None
    rsi: Optional[float] = None
    volume: Optional[float] = None
    support_level: Optional[float] = None
    resistance_level: Optional[float] = None
    price: Optional[float] = None

def calculate_reversal_score(
    side: str,
    current_snapshot: TechnicalSnapshot,
    previous_snapshot: Optional[TechnicalSnapshot] = None
) -> float:
    """
    Calculate technical reversal score (0-100) based on multiple indicators.
    Higher score = stronger reversal signal.
    
    Args:
        side: 'long' or 'short' - current position direction
        current_snapshot: Current technical indicators
        previous_snapshot: Previous technical indicators (for crossovers)
    
    Returns:
        Reversal score from 0-100
    """
    score = 0.0
    max_score = 0.0
    
    # EMA crossover detection (25 points)
    if current_snapshot.ema_fast and current_snapshot.ema_slow and previous_snapshot:
        max_score += 25
        if previous_snapshot.ema_fast and previous_snapshot.ema_slow:
            if side.lower() == "long":
                # For longs, bearish cross is a reversal (fast crosses below slow)
                if (previous_snapshot.ema_fast >= previous_snapshot.ema_slow and 
                    current_snapshot.ema_fast < current_snapshot.ema_slow):
                    score += 25
                elif current_snapshot.ema_fast < current_snapshot.ema_slow:
                    # Already in bearish cross
                    score += 15
            else:
                # For shorts, bullish cross is a reversal (fast crosses above slow)
                if (previous_snapshot.ema_fast <= previous_snapshot.ema_slow and 
                    current_snapshot.ema_fast > current_snapshot.ema_slow):
                    score += 25
                elif current_snapshot.ema_fast > current_snapshot.ema_slow:
                    score += 15
    
    # MACD crossover detection (25 points)
    if current_snapshot.macd is not None and current_snapshot.macd_signal is not None:
        max_score += 25
        if previous_snapshot and previous_snapshot.macd is not None and previous_snapshot.macd_signal is not None:
            if side.lower() == "long":
                # For longs, bearish MACD cross is reversal (MACD crosses below signal)
                if (previous_snapshot.macd >= previous_snapshot.macd_signal and 
                    current_snapshot.macd < current_snapshot.macd_signal):
                    score += 25
                elif current_snapshot.macd < current_snapshot.macd_signal:
                    score += 15
            else:
                # For shorts, bullish MACD cross is reversal
                if (previous_snapshot.macd <= previous_snapshot.macd_signal and 
                    current_snapshot.macd > current_snapshot.macd_signal):
                    score += 25
                elif current_snapshot.macd > current_snapshot.macd_signal:
                    score += 15
    
    # RSI extreme/divergence (20 points)
    if current_snapshot.rsi is not None:
        max_score += 20
        if side.lower() == "long":
            # For longs, overbought is a warning
            if current_snapshot.rsi >= 70:
                score += 20
            elif current_snapshot.rsi >= 65:
                score += 10
        else:
            # For shorts, oversold is a warning
            if current_snapshot.rsi <= 30:
                score += 20
            elif current_snapshot.rsi <= 35:
                score += 10
    
    # Volume drop (15 points) - declining volume can signal trend exhaustion
    if current_snapshot.volume and previous_snapshot and previous_snapshot.volume:
        max_score += 15
        volume_decline = (previous_snapshot.volume - current_snapshot.volume) / previous_snapshot.volume
        if volume_decline > 0.3:  # 30%+ volume drop
            score += 15
        elif volume_decline > 0.2:  # 20%+ volume drop
            score += 10
        elif volume_decline > 0.1:  # 10%+ volume drop
            score += 5
    
    # Support/Resistance break (15 points)
    if current_snapshot.price is not None:
        if side.lower() == "long" and current_snapshot.support_level:
            max_score += 15
            # Price breaking support is bearish
            if current_snapshot.price < current_snapshot.support_level:
                score += 15
            elif current_snapshot.price < current_snapshot.support_level * 1.01:  # Within 1%
                score += 10
        elif side.lower() == "short" and current_snapshot.resistance_level:
            max_score += 15
            # Price breaking resistance is bullish
            if current_snapshot.price > current_snapshot.resistance_level:
                score += 15
            elif current_snapshot.price > current_snapshot.resistance_level * 0.99:  # Within 1%
                score += 10
    
    # Normalize to 0-100 scale
    if max_score > 0:
        return min(100.0, (score / max_score) * 100.0)
    return 0.0

def get_peak_drawdown_threshold(r_multiple: float, config: HybridExitConfig) -> float:
    """
    Get the appropriate peak drawdown threshold based on R-multiple.
    Uses the highest threshold that applies (R-multiple >= key).
    """
    applicable_thresholds = [
        (r_threshold, dd_threshold) 
        for r_threshold, dd_threshold in config.peak_drawdown_thresholds.items() 
        if r_multiple >= r_threshold
    ]
    
    if applicable_thresholds:
        # Return the threshold for the highest R level achieved
        return max(applicable_thresholds, key=lambda x: x[0])[1]
    
    # Default: no protection if below minimum R
    return 1.0  # 100% drawdown allowed (effectively disabled)

def check_counter_signal_exit(
    side: str,
    counter_signal_side: Optional[str],
    counter_signal_confidence: Optional[float],
    r_now: float,
    config: HybridExitConfig
) -> Tuple[bool, Optional[str], Optional[str]]:
    """
    Check if a counter-signal should trigger an exit or tightening.
    
    Returns:
        (should_exit, should_tighten, reason)
    """
    if not config.enable_counter_signal_exits:
        return False, None, None
    
    if counter_signal_side is None or counter_signal_confidence is None:
        return False, None, None
    
    # Check if it's truly a counter-signal (opposite direction)
    is_counter = False
    if side.lower() == "long" and counter_signal_side.lower() == "short":
        is_counter = True
    elif side.lower() == "short" and counter_signal_side.lower() == "long":
        is_counter = True
    
    if not is_counter:
        return False, None, None
    
    # Strong counter-signal: exit immediately if R > threshold
    if (counter_signal_confidence >= config.counter_signal_exit_confidence and 
        r_now >= config.counter_signal_exit_min_r):
        reason = f"Counter-signal exit: {counter_signal_side} confidence {counter_signal_confidence:.2f} at {r_now:.2f}R"
        return True, None, reason
    
    # Medium counter-signal: tighten stop
    if (counter_signal_confidence >= config.counter_signal_tighten_confidence and 
        r_now >= config.counter_signal_tighten_min_r):
        reason = f"Counter-signal tighten: {counter_signal_side} confidence {counter_signal_confidence:.2f} at {r_now:.2f}R"
        return False, "tighten", reason
    
    return False, None, None

def check_peak_drawdown_exit(
    side: str,
    entry_price: float,
    peak_price: float,
    current_price: float,
    r_now: float,
    config: HybridExitConfig
) -> Tuple[bool, Optional[str]]:
    """
    Check if peak drawdown protection should trigger an exit.
    
    Returns:
        (should_exit, reason)
    """
    if not config.enable_peak_drawdown_protection:
        return False, None
    
    # Only protect profits (R > 0)
    if r_now <= 0:
        return False, None
    
    # Calculate drawdown from peak
    if side.lower() == "long":
        if peak_price <= entry_price:
            return False, None  # No peak to protect yet
        drawdown_pct = (peak_price - current_price) / peak_price
    else:
        if peak_price >= entry_price:
            return False, None  # No peak to protect yet
        drawdown_pct = (current_price - peak_price) / peak_price
    
    # Get applicable threshold
    threshold = get_peak_drawdown_threshold(r_now, config)
    
    if drawdown_pct > threshold:
        reason = f"Peak drawdown exit: {drawdown_pct*100:.1f}% from peak (threshold {threshold*100:.1f}%) at {r_now:.2f}R"
        return True, reason
    
    return False, None

def check_reversal_exit(
    side: str,
    current_snapshot: TechnicalSnapshot,
    previous_snapshot: Optional[TechnicalSnapshot],
    r_now: float,
    config: HybridExitConfig,
    counter_signal_active: bool = False
) -> Tuple[bool, Optional[str], Optional[str]]:
    """
    Check if technical reversal should trigger an exit or tightening.
    Only acts if no strong counter-signal is present.
    
    Returns:
        (should_exit, should_tighten, reason)
    """
    if not config.enable_reversal_detection:
        return False, None, None
    
    # Don't use technical reversal if counter-signal is already handling it
    if counter_signal_active:
        return False, None, None
    
    reversal_score = calculate_reversal_score(side, current_snapshot, previous_snapshot)
    
    # Strong reversal: exit
    if reversal_score >= config.reversal_exit_score and r_now >= config.reversal_exit_min_r:
        reason = f"Technical reversal exit: score {reversal_score:.0f} at {r_now:.2f}R"
        return True, None, reason
    
    # Medium reversal: tighten
    if reversal_score >= config.reversal_tighten_score and r_now >= config.reversal_tighten_min_r:
        reason = f"Technical reversal tighten: score {reversal_score:.0f} at {r_now:.2f}R"
        return False, "tighten", reason
    
    return False, None, None

def compute_initial_sl_tp(entry_price: float, atr: float, side: str, cfg: ExitConfig) -> Tuple[float, List[float]]:
    if atr is None or atr <= 0:
        raise ValueError("ATR required for SL/TP computation")
    risk = cfg.sl_atr_mult * atr
    if side.lower() == "long":
        sl = entry_price - risk
        # TPs in R multiples
        tps = [entry_price + r * risk for r in cfg.tp_r_multiples]
    else:
        sl = entry_price + risk
        tps = [entry_price - r * risk for r in cfg.tp_r_multiples]
    return sl, tps

def maybe_adjust_or_exit(side: str,
                         entry_price: float,
                         sl: float,
                         tps: List[float],
                         last_price: float,
                         atr: float,
                         adx: Optional[float],
                         cmf: Optional[float],
                         cfg: ExitConfig,
                         # Hybrid exit parameters (optional)
                         peak_price: Optional[float] = None,
                         counter_signal_side: Optional[str] = None,
                         counter_signal_confidence: Optional[float] = None,
                         technical_snapshot: Optional[TechnicalSnapshot] = None,
                         previous_snapshot: Optional[TechnicalSnapshot] = None) -> Dict:
    """
    Returns directive dict: {action: 'hold'|'move_sl'|'take_partial'|'exit', sl: new_sl, reason: str, tp_hit_index: Optional[int]}
    
    This function implements a hybrid exit strategy combining:
    1. Traditional trailing stops (EXIT_STRATEGY_MODE = trailing)
    2. Counter-signal awareness (rotation detection)
    3. Adaptive peak drawdown protection
    4. Multi-indicator technical reversal detection
    
    The hybrid logic is checked first and takes priority when active, otherwise
    defaults to the standard trailing stop behavior.
    
    Args:
        side: 'long' or 'short'
        entry_price: Entry price of the position
        sl: Current stop loss
        tps: List of take profit levels
        last_price: Current market price
        atr: Current ATR value
        adx: Current ADX value (optional)
        cmf: Current CMF value (optional)
        cfg: Exit configuration
        peak_price: Peak price reached (high for long, low for short) - for drawdown protection
        counter_signal_side: Direction of counter-signal if any ('long' or 'short')
        counter_signal_confidence: Confidence of counter-signal (0-1)
        technical_snapshot: Current technical indicators
        previous_snapshot: Previous technical indicators (for crossover detection)
    """
    risk = abs(entry_price - sl)
    result = {"action": "hold", "sl": sl, "reason": "holding", "tp_hit_index": None}

    # Calculate current R-multiple early for hybrid checks
    from . import math_utils
    r_now = math_utils.r_multiple(entry_price, sl, last_price, side)
    
    # === HYBRID EXIT LOGIC (Priority checks - before TP) ===
    # These checks have priority over partial profit taking when there's a clear reversal/rotation
    hybrid_cfg = cfg.hybrid
    if hybrid_cfg:
        # 1. Check counter-signal exit/tighten (highest priority)
        should_exit, should_tighten, reason = check_counter_signal_exit(
            side, counter_signal_side, counter_signal_confidence, r_now, hybrid_cfg
        )
        
        if should_exit:
            result.update({"action": "exit", "reason": reason})
            return result
        
        counter_signal_active = (should_tighten is not None)
        
        # 2. Check peak drawdown protection (high priority)
        if peak_price is not None:
            should_exit, reason = check_peak_drawdown_exit(
                side, entry_price, peak_price, last_price, r_now, hybrid_cfg
            )
            if should_exit:
                result.update({"action": "exit", "reason": reason})
                return result
        
        # 3. Check technical reversal exit/tighten (only if no counter-signal active)
        if technical_snapshot is not None:
            should_exit, rev_tighten, reason = check_reversal_exit(
                side, technical_snapshot, previous_snapshot, r_now, hybrid_cfg, counter_signal_active
            )
            
            if should_exit:
                result.update({"action": "exit", "reason": reason})
                return result
            
            if rev_tighten and not should_tighten:
                should_tighten = rev_tighten
                # reason already set from check_reversal_exit
        
        # Apply aggressive tightening if any hybrid signal triggered it
        if should_tighten and atr and atr > 0:
            if side.lower() == "long":
                # Very tight stop: 0.3x ATR instead of normal 0.5x
                new_sl = max(sl, last_price - 0.3 * cfg.trail_atr_mult * atr)
            else:
                new_sl = min(sl, last_price + 0.3 * cfg.trail_atr_mult * atr)
            if new_sl != sl:
                result.update({"action": "move_sl", "sl": new_sl, "reason": reason})
                return result

    # === TAKE PROFIT CHECKS ===
    # Check TP hits (detect the first/closest TP level hit)
    # Returns the first TP level hit, external code should track which levels are already executed
    if side.lower() == "long":
        # For longs, TPs are ascending, find first one hit
        for i, tp in enumerate(tps):
            if last_price >= tp:
                result.update({"action": "take_partial", "tp_hit_index": i, "reason": f"TP{i+1} hit at {tp:.4f}"})
                return result
    else:
        # For shorts, TPs are descending, find first one hit
        for i, tp in enumerate(tps):
            if last_price <= tp:
                result.update({"action": "take_partial", "tp_hit_index": i, "reason": f"TP{i+1} hit at {tp:.4f}"})
                return result
    
    # === STANDARD TRAILING STOP LOGIC (Default behavior when no hybrid signals) ===
    
    # Move to breakeven after reaching breakeven_after_r profit
    if r_now >= cfg.breakeven_after_r:
        if side.lower() == "long":
            new_sl = max(sl, entry_price)  # Move SL to breakeven (entry price)
        else:
            new_sl = min(sl, entry_price)  # Move SL to breakeven (entry price)
        if new_sl != sl:
            result.update({"action": "move_sl", "sl": new_sl, "reason": f"Breakeven at {r_now:.2f}R"})
            return result
    
    # Trailing stop after R reached
    if r_now >= cfg.trail_after_r and atr and atr > 0:
        if side.lower() == "long":
            new_sl = max(sl, last_price - cfg.trail_atr_mult * atr)
        else:
            new_sl = min(sl, last_price + cfg.trail_atr_mult * atr)
        if new_sl != sl:
            result.update({"action": "move_sl", "sl": new_sl, "reason": f"Trailing after {r_now:.2f}R"})
            return result

    # Early exit logic - cut losses before SL if momentum fails
    # BUG FIX: Original code used "-r_now if r_now < 0" which kept the negative sign,
    # causing the comparison "loss_r >= cfg.cut_if_loss_gt_r" to always fail.
    # We need the absolute value to properly compare loss magnitude.
    loss_r = abs(r_now) if r_now < 0 else 0.0
    momentum_fail = False
    if adx is not None and adx < cfg.early_exit_adx_below:
        momentum_fail = True
    if cfg.early_exit_cmf_negative and cmf is not None and cmf < 0:
        momentum_fail = True
    # Exit early if we're in a loss position and momentum has failed
    if loss_r >= cfg.cut_if_loss_gt_r and momentum_fail:
        result.update({"action": "exit", "reason": f"Early exit: loss {loss_r:.2f}R & momentum fail"})
        return result

    # Tighten SL if small profit but momentum fails
    if r_now >= cfg.tighten_only_if_profit_gt_r and momentum_fail and atr and atr > 0:
        if side.lower() == "long":
            new_sl = max(sl, last_price - 0.5 * cfg.trail_atr_mult * atr)
        else:
            new_sl = min(sl, last_price + 0.5 * cfg.trail_atr_mult * atr)
        if new_sl != sl:
            result.update({"action": "move_sl", "sl": new_sl, "reason": "Tighten due to momentum fail"})
            return result

    return result

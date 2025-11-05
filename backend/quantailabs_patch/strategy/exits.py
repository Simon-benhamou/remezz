from dataclasses import dataclass
from typing import Dict, List, Tuple, Optional

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

    def __post_init__(self):
        if self.tp_r_multiples is None:
            self.tp_r_multiples = [0.5, 1.0, 2.0]

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
                         cfg: ExitConfig) -> Dict:
    """
    Returns directive dict: {action: 'hold'|'move_sl'|'take_partial'|'exit', sl: new_sl, reason: str, tp_hit_index: Optional[int]}
    Trailing starts after reaching trail_after_r.
    Early-exit: if loss worse than cut_if_loss_gt_r and momentum fails (ADX below OR CMF<0), exit.
    """
    risk = abs(entry_price - sl)
    result = {"action": "hold", "sl": sl, "reason": "holding", "tp_hit_index": None}

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

    # Breakeven and trailing stop logic
    from . import math_utils
    r_now = math_utils.r_multiple(entry_price, sl, last_price, side)
    
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
    # Fixed: loss_r should be absolute value when in loss
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

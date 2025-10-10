from dataclasses import dataclass
from typing import Literal

@dataclass
class ExecCosts:
    taker_fee_bps: float = 7.5
    maker_fee_bps: float = 2.5
    slippage_bps: float = 2.0

def apply_fees_slippage(side: Literal["long","short"], intended_price: float, costs: ExecCosts, taker: bool=True) -> float:
    """
    Returns the effective fill price after fees (in price terms) and slippage.
    We model slippage as a directional bps add-on unfavorable to the trader.
    Fees reduce PnL but are approximated as a price adjustment for simplicity.
    """
    if taker:
        fee = costs.taker_fee_bps / 10_000.0
    else:
        fee = costs.maker_fee_bps / 10_000.0
    slip = costs.slippage_bps / 10_000.0

    if side == "long":
        # worse price: higher entry, lower exit
        return intended_price * (1 + slip + fee)
    else:
        # worse price: lower entry (short sell), higher exit (buy back)
        return intended_price * (1 - slip - fee)

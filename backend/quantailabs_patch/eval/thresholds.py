def p_star(loss_avg: float, win_avg: float, costs: float = 0.0) -> float:
    """
    Minimum predicted probability to take a trade:
        p > (L + C) / (W + L)
    where L is average loss (abs, same units as W), W is average win, C is costs.
    Returns threshold in [0,1].
    """
    denom = win_avg + loss_avg
    if denom <= 0:
        return 1.0
    return min(0.99, max(0.0, (loss_avg + costs) / denom))

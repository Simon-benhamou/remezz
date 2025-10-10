def r_multiple(entry: float, stop: float, price: float, side: str) -> float:
    risk = abs(entry - stop)
    if risk <= 0:
        return 0.0
    if side.lower() == "long":
        return (price - entry) / risk
    else:
        return (entry - price) / risk

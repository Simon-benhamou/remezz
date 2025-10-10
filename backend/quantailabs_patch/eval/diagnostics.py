from typing import List, Tuple
def rank(series: List[float]) -> List[float]:
    # simple average-rank for ties
    sorted_pairs = sorted((v,i) for i,v in enumerate(series))
    ranks = [0.0]*len(series)
    i = 0
    while i < len(series):
        j = i
        while j+1 < len(series) and sorted_pairs[j+1][0] == sorted_pairs[i][0]:
            j += 1
        avg_rank = (i + j) / 2 + 1
        for k in range(i, j+1):
            ranks[sorted_pairs[k][1]] = avg_rank
        i = j+1
    return ranks

def spearman_rho(a: List[float], b: List[float]) -> float:
    # 1 - (6*sum(d^2))/(n(n^2-1))
    if len(a) != len(b) or len(a) == 0:
        return 0.0
    ra = rank(a)
    rb = rank(b)
    n = len(a)
    d2 = sum((ra[i]-rb[i])**2 for i in range(n))
    return 1 - (6*d2)/(n*(n*n-1))

def decile_performance(scores: List[float], returns: List[float], deciles: int = 10) -> List[Tuple[int, float]]:
    assert len(scores) == len(returns)
    n = len(scores)
    pairs = list(zip(scores, returns))
    pairs.sort(key=lambda x: x[0])
    bucket_size = max(1, n // deciles)
    out = []
    for d in range(deciles):
        chunk = pairs[d*bucket_size : (d+1)*bucket_size] if d < deciles-1 else pairs[d*bucket_size:]
        if not chunk:
            out.append((d+1, 0.0)); continue
        avg_ret = sum(r for _, r in chunk) / len(chunk)
        out.append((d+1, avg_ret))
    return out

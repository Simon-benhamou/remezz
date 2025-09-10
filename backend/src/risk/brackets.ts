type Side = "buy" | "sell";
type Ref = { type: "percent" | "price"; value: number };
export function levels(entryPrice: number, side: Side, stop: Ref, target: Ref) {
  const s =
    stop.type === "percent"
      ? side === "buy"
        ? entryPrice * (1 - stop.value / 100)
        : entryPrice * (1 + stop.value / 100)
      : stop.value;
  const t =
    target.type === "percent"
      ? side === "buy"
        ? entryPrice * (1 + target.value / 100)
        : entryPrice * (1 - target.value / 100)
      : target.value;
  const r4 = (n:number)=> Math.round(n*1e4)/1e4;
  return { stopPrice: r4(s), takeProfitPrice: r4(t) };
}

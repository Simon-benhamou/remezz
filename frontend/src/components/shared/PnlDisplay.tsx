import { cn } from "@/lib/utils";

interface PnlDisplayProps {
  value: number;
  size?: "sm" | "md" | "lg" | "xl";
  showSign?: boolean;
  showCurrency?: boolean;
  className?: string;
}

const sizeClasses: Record<NonNullable<PnlDisplayProps["size"]>, string> = {
  sm: "text-xs",
  md: "text-sm",
  lg: "text-lg font-semibold",
  xl: "text-2xl font-bold",
};

function PnlDisplay({
  value,
  size = "md",
  showSign = true,
  showCurrency = true,
  className,
}: PnlDisplayProps) {
  const isPositive = value > 0;
  const isZero = value === 0;

  const colorClass = isZero
    ? "text-muted-foreground"
    : isPositive
      ? "text-success"
      : "text-destructive";

  const sign = isZero ? "" : isPositive ? "+" : "";
  const formatted = Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const prefix = showSign && !isZero ? sign : "";
  const negativeMark = value < 0 ? "-" : "";
  const currency = showCurrency ? "$" : "";

  return (
    <span className={cn(colorClass, sizeClasses[size], className)}>
      {prefix}
      {negativeMark}
      {currency}
      {formatted}
    </span>
  );
}

export { PnlDisplay };
export type { PnlDisplayProps };

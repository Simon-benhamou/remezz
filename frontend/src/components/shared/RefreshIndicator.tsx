import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";

interface RefreshIndicatorProps {
  isRefreshing: boolean;
  className?: string;
}

function RefreshIndicator({ isRefreshing, className }: RefreshIndicatorProps) {
  if (!isRefreshing) return null;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full bg-primary/15 px-2.5 py-0.5 text-xs font-medium text-primary border border-primary/25",
        className
      )}
    >
      <Loader2 className="h-3 w-3 animate-spin" />
      Updating...
    </span>
  );
}

export { RefreshIndicator };
export type { RefreshIndicatorProps };

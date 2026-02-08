import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

interface LoadingSkeletonProps {
  rows?: number;
  type?: "text" | "card" | "table";
  className?: string;
}

function LoadingSkeleton({ rows = 3, type = "text", className }: LoadingSkeletonProps) {
  if (type === "card") {
    return (
      <div className={cn("grid gap-4 sm:grid-cols-2 lg:grid-cols-4", className)}>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="rounded-xl border border-border bg-card p-4 space-y-3">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-20" />
            <Skeleton className="h-3 w-32" />
          </div>
        ))}
      </div>
    );
  }

  if (type === "table") {
    return (
      <div className={cn("space-y-2", className)}>
        {/* Header row */}
        <div className="flex gap-4 pb-2 border-b border-border">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-28" />
        </div>
        {/* Data rows */}
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex gap-4 py-2">
            <Skeleton className="h-4" style={{ width: `${120 + (i % 3) * 20}px` }} />
            <Skeleton className="h-4" style={{ width: `${80 + (i % 2) * 16}px` }} />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4" style={{ width: `${100 + (i % 4) * 12}px` }} />
          </div>
        ))}
      </div>
    );
  }

  // Default: text
  return (
    <div className={cn("space-y-3", className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton
          key={i}
          className="h-4"
          style={{ width: `${85 - (i % 3) * 15}%` }}
        />
      ))}
    </div>
  );
}

export { LoadingSkeleton };
export type { LoadingSkeletonProps };

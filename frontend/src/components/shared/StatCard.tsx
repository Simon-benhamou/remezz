import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";

interface StatCardProps {
  label: string;
  value: string | number;
  icon?: React.ReactNode;
  iconColor?: string;
  valueColor?: string;
  subtitle?: string;
  className?: string;
}

function StatCard({ label, value, icon, iconColor, valueColor, subtitle, className }: StatCardProps) {
  return (
    <Card
      className={cn(
        "relative overflow-hidden bg-card p-4 transition-all duration-200",
        "hover:border-primary/30 hover:shadow-md hover:shadow-primary/5",
        className
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {label}
          </p>
          <p className={cn("mt-1 text-2xl font-bold tracking-tight", valueColor)}>
            {value}
          </p>
          {subtitle && (
            <p className="mt-0.5 text-xs text-muted-foreground truncate">{subtitle}</p>
          )}
        </div>
        {icon && (
          <div className={cn("shrink-0 rounded-lg bg-muted p-2", iconColor)}>
            {icon}
          </div>
        )}
      </div>
    </Card>
  );
}

export { StatCard };
export type { StatCardProps };

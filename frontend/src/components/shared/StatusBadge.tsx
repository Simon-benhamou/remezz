import { cn } from "@/lib/utils";

interface StatusBadgeProps {
  variant: "success" | "warning" | "error" | "info" | "default" | "accent";
  children: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
  onClick?: () => void;
}

const variantClasses: Record<StatusBadgeProps["variant"], string> = {
  success: "bg-success/15 text-success border-success/25",
  warning: "bg-warning/15 text-warning border-warning/25",
  error: "bg-destructive/15 text-destructive border-destructive/25",
  info: "bg-primary/15 text-primary border-primary/25",
  default: "bg-muted text-muted-foreground border-border",
  accent: "bg-accent/15 text-accent border-accent/25",
};

function StatusBadge({ variant, children, icon, className, onClick }: StatusBadgeProps) {
  return (
    <span
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
        variantClasses[variant],
        onClick && "cursor-pointer hover:opacity-80",
        className
      )}
    >
      {icon && <span className="shrink-0 [&_svg]:h-3 [&_svg]:w-3">{icon}</span>}
      {children}
    </span>
  );
}

export { StatusBadge };
export type { StatusBadgeProps };

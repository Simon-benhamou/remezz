/**
 * Notification Bell Button
 *
 * Shows current notification status and allows toggling
 */

import React from 'react';
import {
  Bell,
  Volume2,
  CheckCircle,
  Rocket,
  XCircle,
  OctagonX,
  Target,
  Bot,
  Square,
  RefreshCw,
  Zap,
  BarChart3,
  Megaphone,
} from 'lucide-react';
import { useTradeNotifications } from '@/providers/TradeNotificationProvider';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

function formatSymbol(symbol: string): string {
  return symbol.replace('/USDT:USDT', '').replace('/USDT', '');
}

export default function NotificationBell() {
  const {
    enabled,
    soundEnabled,
    setEnabled,
    setSoundEnabled,
    browserPermission,
    requestBrowserPermission,
    recentNotifications,
  } = useTradeNotifications();

  const [open, setOpen] = React.useState(false);

  // Count unviewed notifications (last 5 minutes)
  const recentCount = recentNotifications.filter(
    (n) => Date.now() - n.timestamp < 5 * 60 * 1000
  ).length;

  const getTypeIcon = (item: (typeof recentNotifications)[number]) => {
    const isWin = (item.pnlUsd ?? 0) >= 0;
    const size = 'h-3.5 w-3.5';
    switch (item.type) {
      case 'trade_entry':
        return { icon: <Rocket className={cn(size, 'text-[var(--accent)]')} />, color: 'text-[var(--accent)]' };
      case 'trade_exit':
        return isWin
          ? { icon: <CheckCircle className={cn(size, 'text-[var(--success)]')} />, color: 'text-[var(--success)]' }
          : { icon: <XCircle className={cn(size, 'text-[var(--error)]')} />, color: 'text-[var(--error)]' };
      case 'stop_loss_hit':
        return { icon: <OctagonX className={cn(size, 'text-[var(--error)]')} />, color: 'text-[var(--error)]' };
      case 'take_profit_hit':
        return { icon: <Target className={cn(size, 'text-[var(--success)]')} />, color: 'text-[var(--success)]' };
      case 'agent_started':
        return { icon: <Bot className={cn(size, 'text-[var(--success)]')} />, color: 'text-[var(--success)]' };
      case 'agent_stopped':
        return { icon: <Square className={cn(size, 'text-yellow-500')} />, color: 'text-yellow-500' };
      case 'regime_change':
        return { icon: <RefreshCw className={cn(size, 'text-purple-500')} />, color: 'text-purple-500' };
      case 'high_volatility':
        return { icon: <Zap className={cn(size, 'text-yellow-500')} />, color: 'text-yellow-500' };
      case 'signal_detected':
        return { icon: <BarChart3 className={cn(size, 'text-cyan-500')} />, color: 'text-cyan-500' };
      default:
        return { icon: <Megaphone className={cn(size, 'text-muted-foreground')} />, color: 'text-muted-foreground' };
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="relative flex h-9 w-9 items-center justify-center rounded-lg cursor-pointer transition-all hover:bg-accent"
          type="button"
        >
          <Bell
            className={cn(
              'h-[18px] w-[18px]',
              enabled ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'
            )}
          />
          {recentCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
              {recentCount}
            </span>
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-80 p-0">
        <div className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Bell className="h-4 w-4" />
              <span className="text-sm font-semibold">Trade Notifications</span>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Volume2 className="h-4 w-4" />
              <span className="text-sm">Sound Alerts</span>
            </div>
            <Switch
              checked={soundEnabled}
              onCheckedChange={setSoundEnabled}
              disabled={!enabled}
            />
          </div>

          {browserPermission === 'default' && (
            <button
              onClick={requestBrowserPermission}
              className="w-full rounded-md border border-[var(--accent)] bg-[var(--accent)]/10 px-3 py-1.5 text-xs text-[var(--accent)] cursor-pointer hover:bg-[var(--accent)]/20 transition-colors"
              type="button"
            >
              Enable Browser Notifications
            </button>
          )}

          {browserPermission === 'granted' && (
            <div className="flex items-center gap-1.5 text-xs text-[var(--success)]">
              <CheckCircle className="h-3.5 w-3.5" />
              Browser notifications enabled
            </div>
          )}

          {browserPermission === 'denied' && (
            <p className="text-[11px] text-destructive">
              Browser notifications blocked. Check browser settings.
            </p>
          )}
        </div>

        {recentNotifications.length > 0 && (
          <>
            <Separator />
            <div className="px-4 pt-2 pb-1">
              <span className="text-[11px] text-muted-foreground">Recent Notifications</span>
            </div>
            <div className="max-h-[250px] overflow-y-auto px-4 pb-3">
              {recentNotifications.slice(0, 8).map((item, index) => {
                const isEntry = item.type === 'trade_entry';
                const isExit =
                  item.type === 'trade_exit' ||
                  item.type === 'stop_loss_hit' ||
                  item.type === 'take_profit_hit';
                const isWin = (item.pnlUsd ?? 0) >= 0;
                const typeInfo = getTypeIcon(item);

                return (
                  <div
                    key={`${item.timestamp}-${index}`}
                    className="border-b border-white/5 py-1.5 last:border-b-0"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1">
                        {typeInfo.icon}
                        {item.mode && (
                          <Badge
                            variant={item.mode === 'live' ? 'destructive' : 'default'}
                            className="h-4 px-1 text-[10px] leading-none"
                          >
                            {item.mode.toUpperCase()}
                          </Badge>
                        )}
                        <span className="text-xs font-semibold">
                          {formatSymbol(item.symbol)}
                        </span>
                        {item.side && (
                          <span
                            className={cn(
                              'text-[11px]',
                              item.side === 'long'
                                ? 'text-[var(--success)]'
                                : 'text-[var(--error)]'
                            )}
                          >
                            {item.side.toUpperCase()}
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] text-muted-foreground">
                        {new Date(item.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="text-[11px] text-white/65">
                      {isEntry ? (
                        <>
                          Entry @ ${item.price?.toFixed(4) ?? '0'} &middot; $
                          {item.notionalUsd?.toFixed(0) ?? '0'}
                        </>
                      ) : isExit ? (
                        <span
                          className={cn(
                            isWin ? 'text-[var(--success)]' : 'text-[var(--error)]'
                          )}
                        >
                          {isWin ? '+' : ''}${item.pnlUsd?.toFixed(2) ?? '0'} (
                          {isWin ? '+' : ''}
                          {item.pnlPct?.toFixed(2) ?? '0'}%)
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-[11px]">
                          {(item as any).title ||
                            (item as any).message ||
                            item.type?.replace(/_/g, ' ')}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

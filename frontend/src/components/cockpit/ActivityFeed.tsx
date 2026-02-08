/**
 * V5.72: ActivityFeed Component
 *
 * Real-time activity feed with signal radar events.
 */

import React, { useMemo } from 'react';
import {
  ArrowUpCircle,
  ArrowDownCircle,
  Target,
  Bell,
  Info,
  AlertTriangle,
  XCircle,
  Radio,
  TrendingUp,
  Activity,
  Zap,
} from 'lucide-react';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@/components/ui/tooltip';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/shared/EmptyState';
import { cn } from '@/lib/utils';
import type { ActivityFeedProps, ActivityEvent } from '../../types/cockpit';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

const formatTime = (ts: string): string => {
  const date = new Date(ts);
  if (isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit' });
};

const formatFullTime = (ts: string): string => {
  const date = new Date(ts);
  if (isNaN(date.getTime())) return '—';
  return date.toLocaleString();
};

const getRelativeTime = (ts: string): string => {
  const date = new Date(ts);
  if (isNaN(date.getTime())) return '';
  const now = Date.now();
  const diff = now - date.getTime();

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
};

// ============================================================================
// EVENT ICON & COLOR MAPPING
// ============================================================================

interface EventConfig {
  icon: React.ReactNode;
  color: string;
  tagClasses: string;
  label: string;
}

const getEventConfig = (kind: string, level: string): EventConfig => {
  // Handle error/warn levels first
  if (level === 'error') {
    return {
      icon: <XCircle size={14} />,
      color: 'var(--error)',
      tagClasses: 'bg-red-500/20 text-red-400 ring-1 ring-red-500/30',
      label: 'ERROR',
    };
  }
  if (level === 'warn') {
    return {
      icon: <AlertTriangle size={14} />,
      color: 'var(--warning)',
      tagClasses: 'bg-orange-500/20 text-orange-400 ring-1 ring-orange-500/30',
      label: 'WARN',
    };
  }

  // Handle specific event kinds
  switch (kind) {
    case 'entry':
      return {
        icon: <ArrowUpCircle size={14} />,
        color: 'var(--success)',
        tagClasses: 'bg-green-500/20 text-green-400 ring-1 ring-green-500/30',
        label: 'ENTRY',
      };
    case 'exit':
      return {
        icon: <ArrowDownCircle size={14} />,
        color: 'var(--accent-secondary)',
        tagClasses: 'bg-blue-500/20 text-blue-400 ring-1 ring-blue-500/30',
        label: 'EXIT',
      };
    case 'trail':
      return {
        icon: <Target size={14} />,
        color: '#8b5cf6',
        tagClasses: 'bg-purple-500/20 text-purple-400 ring-1 ring-purple-500/30',
        label: 'TRAIL',
      };
    case 'signal':
      return {
        icon: <Zap size={14} />,
        color: '#eab308',
        tagClasses: 'bg-yellow-500/20 text-yellow-400 ring-1 ring-yellow-500/30',
        label: 'SIGNAL',
      };
    case 'symbol_proximity':
      return {
        icon: <Radio size={14} />,
        color: 'var(--accent)',
        tagClasses: 'bg-cyan-500/20 text-cyan-400 ring-1 ring-cyan-500/30',
        label: 'RADAR',
      };
    case 'market_regime':
      return {
        icon: <TrendingUp size={14} />,
        color: 'var(--text-secondary)',
        tagClasses: 'bg-muted text-muted-foreground ring-1 ring-border',
        label: 'REGIME',
      };
    case 'position_update':
      return {
        icon: <Activity size={14} />,
        color: '#6366f1',
        tagClasses: 'bg-indigo-500/20 text-indigo-400 ring-1 ring-indigo-500/30',
        label: 'UPDATE',
      };
    case 'opportunity_alert':
      return {
        icon: <Bell size={14} />,
        color: '#f97316',
        tagClasses: 'bg-orange-500/20 text-orange-400 ring-1 ring-orange-500/30',
        label: 'ALERT',
      };
    default:
      return {
        icon: <Info size={14} />,
        color: 'var(--text-secondary)',
        tagClasses: 'bg-muted text-muted-foreground ring-1 ring-border',
        label: kind.toUpperCase(),
      };
  }
};

// ============================================================================
// EVENT ITEM COMPONENT
// ============================================================================

interface EventItemProps {
  event: ActivityEvent;
}

const EventItem: React.FC<EventItemProps> = ({ event }) => {
  const config = getEventConfig(event.kind, event.level);
  const relTime = getRelativeTime(event.timestamp);

  return (
    <div className="activity-item">
      <div className="activity-item__icon" style={{ color: config.color }}>
        {config.icon}
      </div>

      <div className="activity-item__content">
        <div className="activity-item__header">
          <span
            className={cn(
              'inline-flex items-center rounded px-[5px] text-[9px] font-semibold leading-4',
              config.tagClasses
            )}
          >
            {config.label}
          </span>
          {event.symbol && (
            <span className="activity-item__symbol">{event.symbol}</span>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="activity-item__time">
                {formatTime(event.timestamp)}
                {relTime && <span className="activity-item__rel-time">{relTime}</span>}
              </span>
            </TooltipTrigger>
            <TooltipContent>{formatFullTime(event.timestamp)}</TooltipContent>
          </Tooltip>
        </div>

        <div className="activity-item__message">{event.message}</div>

        {event.details && Object.keys(event.details).length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="activity-item__details-link">View details</span>
            </TooltipTrigger>
            <TooltipContent>
              <pre style={{ margin: 0, fontSize: 10 }}>
                {JSON.stringify(event.details, null, 2)}
              </pre>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================

const ActivityFeed: React.FC<ActivityFeedProps> = ({ events, loading }) => {
  // Group events by time (today vs older)
  const { todayEvents, olderEvents } = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayTs = today.getTime();

    return events.reduce(
      (acc, event) => {
        const eventDate = new Date(event.timestamp).getTime();
        if (eventDate >= todayTs) {
          acc.todayEvents.push(event);
        } else {
          acc.olderEvents.push(event);
        }
        return acc;
      },
      { todayEvents: [] as ActivityEvent[], olderEvents: [] as ActivityEvent[] }
    );
  }, [events]);

  if (loading) {
    return (
      <div className="activity-feed activity-feed--loading">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-4/5" />
        </div>
        <style>{styles}</style>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="activity-feed">
        <div className="activity-feed__header">
          <Activity size={16} color="var(--text-muted)" />
          <span className="activity-feed__title">Activity</span>
          <span className="activity-feed__count">{events.length} events</span>
        </div>

        {events.length === 0 ? (
          <div className="activity-feed__empty">
            <EmptyState description="No activity yet" />
          </div>
        ) : (
          <div className="activity-feed__list">
            {todayEvents.length > 0 && (
              <>
                <div className="activity-feed__section-label">Today</div>
                {todayEvents.map((event, idx) => (
                  <EventItem key={`${event.timestamp}-${idx}`} event={event} />
                ))}
              </>
            )}

            {olderEvents.length > 0 && (
              <>
                <div className="activity-feed__section-label">Earlier</div>
                {olderEvents.slice(0, 10).map((event, idx) => (
                  <EventItem key={`older-${event.timestamp}-${idx}`} event={event} />
                ))}
              </>
            )}
          </div>
        )}

        <style>{styles}</style>
      </div>
    </TooltipProvider>
  );
};

// ============================================================================
// STYLES
// ============================================================================

const styles = `
  .activity-feed {
    background: var(--bg-primary);
    border-radius: 16px;
    border: 1px solid var(--border-subtle);
    overflow: hidden;
  }

  .activity-feed--loading {
    padding: 20px;
  }

  .activity-feed__header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-subtle);
  }

  .activity-feed__title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .activity-feed__count {
    font-size: 11px;
    color: var(--text-muted);
    font-family: 'JetBrains Mono', monospace;
    margin-left: auto;
  }

  .activity-feed__empty {
    padding: 32px;
  }

  .activity-feed__list {
    max-height: 400px;
    overflow-y: auto;
    padding: 8px 0;
  }

  .activity-feed__list::-webkit-scrollbar {
    width: 6px;
  }

  .activity-feed__list::-webkit-scrollbar-track {
    background: rgba(30, 41, 59, 0.5);
  }

  .activity-feed__list::-webkit-scrollbar-thumb {
    background: rgba(148, 163, 184, 0.3);
    border-radius: 3px;
  }

  .activity-feed__list::-webkit-scrollbar-thumb:hover {
    background: rgba(148, 163, 184, 0.5);
  }

  .activity-feed__section-label {
    padding: 6px 16px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-muted);
    font-weight: 600;
  }

  .activity-item {
    display: flex;
    gap: 10px;
    padding: 10px 16px;
    transition: background 0.15s;
  }

  .activity-item:hover {
    background: rgba(59, 130, 246, 0.06);
  }

  .activity-item__icon {
    flex-shrink: 0;
    margin-top: 2px;
  }

  .activity-item__content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .activity-item__header {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .activity-item__symbol {
    font-size: 11px;
    font-family: 'JetBrains Mono', monospace;
    color: var(--text-muted);
  }

  .activity-item__time {
    font-size: 11px;
    color: var(--text-muted);
    font-family: 'JetBrains Mono', monospace;
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .activity-item__rel-time {
    font-size: 10px;
    color: var(--text-muted);
  }

  .activity-item__message {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.4;
    word-break: break-word;
  }

  .activity-item__details-link {
    font-size: 10px;
    color: var(--accent-secondary);
    cursor: pointer;
    text-decoration: underline;
    text-decoration-color: transparent;
    transition: text-decoration-color 0.15s;
  }

  .activity-item__details-link:hover {
    text-decoration-color: var(--accent-secondary);
  }

  @media (max-width: 640px) {
    .activity-item {
      padding: 8px 12px;
    }

    .activity-item__time {
      flex-basis: 100%;
      margin-left: 0;
      margin-top: 4px;
    }
  }
`;

export default ActivityFeed;

import React from 'react';
import { Button, Typography, Tag, Empty, Tooltip } from 'antd';
import {
  SyncOutlined,
  ThunderboltOutlined,
  DollarOutlined,
  EyeOutlined,
  ExclamationCircleOutlined,
  ReloadOutlined,
  FireOutlined,
  RiseOutlined,
  FallOutlined,
} from '@ant-design/icons';
import { TrendingUp, TrendingDown, Clock, Zap, Target, AlertTriangle, Thermometer, Activity } from 'lucide-react';
import { api } from '../api';
import { useMode } from '../contexts/ModeContext';
import { openWS } from '../ws';

const { Text, Title } = Typography;

interface AgentLog {
  timestamp: string;
  sessionId: string;
  symbol: string;
  kind: string;
  message: string;
  level: 'info' | 'warn' | 'error';
  details?: Record<string, any>;
}

// V5.71: Signal Radar events from WebSocket
interface RadarEvent {
  type: 'symbol_proximity' | 'market_regime' | 'market_volatility' | 'position_update' | 'opportunity_alert';
  severity: 'info' | 'warning' | 'success';
  title: string;
  message: string;
  symbol?: string;
  data?: Record<string, any>;
  timestamp: number;
}

interface AgentState {
  sessionId: string;
  symbol: string;
  running: boolean;
  hasPosition: boolean;
  bias: 'long' | 'short' | null;
}

type FilterType = 'all' | 'futures' | 'exits' | 'orders' | 'triggers';
type BiasFilter = 'all' | 'long' | 'short' | 'watch';

export default function FeedPage() {
  const [logs, setLogs] = React.useState<AgentLog[]>([]);
  const [radarEvents, setRadarEvents] = React.useState<RadarEvent[]>([]);
  const [agentStates, setAgentStates] = React.useState<AgentState[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [filterType, setFilterType] = React.useState<FilterType>('all');
  const [biasFilter, setBiasFilter] = React.useState<BiasFilter>('all');
  const { mode } = useMode();
  const wsRef = React.useRef<ReturnType<typeof openWS> | null>(null);

  // V5.71: WebSocket listener for radar events
  React.useEffect(() => {
    const API_BASE = (import.meta as any).env.VITE_API_BASE || 'http://localhost:4000';
    const apiKey = localStorage.getItem('apiKey') || '';

    if (!apiKey) return;

    wsRef.current = openWS(
      API_BASE,
      apiKey,
      undefined,
      (msg: any) => {
        if (msg?.type === 'radar_event' && msg?.data) {
          const event = msg.data as RadarEvent;
          setRadarEvents(prev => [event, ...prev].slice(0, 50)); // Keep last 50 events
        }
      },
      undefined,
      undefined,
      undefined
    );

    return () => {
      try {
        wsRef.current?.close();
      } catch {}
      wsRef.current = null;
    };
  }, []);

  const loadData = React.useCallback(async () => {
    setLoading(true);
    try {
      const [logsRes, sessionsRes] = await Promise.all([
        api.getAgentLogs?.(mode as 'paper' | 'live', 100, 'memory').catch(() => ({ logs: [] })),
        api.listSessions(mode).catch(() => []),
      ]);
      setLogs(Array.isArray(logsRes) ? logsRes : logsRes?.logs || []);

      // Build agent states from sessions
      const states: AgentState[] = (sessionsRes || [])
        .filter((s: any) => !s.stoppedAt && !s.haltedAt)
        .map((s: any) => ({
          sessionId: s.id,
          symbol: s.symbol?.replace('/USDT:USDT', '/USDT-USDT') || 'Unknown',
          running: true,
          hasPosition: false,
          bias: null,
        }));
      setAgentStates(states);
    } catch (e) {
      console.error('Failed to load feed data:', e);
    }
    setLoading(false);
  }, [mode]);

  React.useEffect(() => {
    void loadData();
    const interval = setInterval(loadData, 5000);
    return () => clearInterval(interval);
  }, [loadData]);

  // Filter logs
  const filteredLogs = React.useMemo(() => {
    let filtered = logs;
    if (filterType === 'futures') filtered = filtered.filter(l => ['entry', 'exit', 'signal'].includes(l.kind));
    if (filterType === 'exits') filtered = filtered.filter(l => l.kind === 'exit');
    if (filterType === 'orders') filtered = filtered.filter(l => l.kind === 'order');
    if (filterType === 'triggers') filtered = filtered.filter(l => ['support-touch', 'resistance-touch', 'volume-spike'].includes(l.kind));
    if (biasFilter === 'long') filtered = filtered.filter(l => l.message?.toLowerCase().includes('long'));
    if (biasFilter === 'short') filtered = filtered.filter(l => l.message?.toLowerCase().includes('short'));
    if (biasFilter === 'watch') filtered = filtered.filter(l => l.kind === 'tick' || l.message?.toLowerCase().includes('watch'));
    return filtered;
  }, [logs, filterType, biasFilter]);

  const formatTime = (ts: string) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const getLogMeta = (log: AgentLog) => {
    const isLoss = log.kind === 'exit' && (log.details?.pnl ?? 0) < 0;
    const isWin = log.kind === 'exit' && (log.details?.pnl ?? 0) > 0;
    switch (log.kind) {
      case 'entry': return { icon: <ThunderboltOutlined />, color: '#4ade80', bg: 'rgba(34, 197, 94, 0.1)', label: 'ENTRY' };
      case 'exit': return { icon: <DollarOutlined />, color: isWin ? '#4ade80' : '#f87171', bg: isWin ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)', label: isWin ? 'WIN' : 'LOSS' };
      case 'signal': return { icon: <Target size={14} />, color: '#fbbf24', bg: 'rgba(251, 191, 36, 0.1)', label: 'SIGNAL' };
      case 'order': return { icon: <SyncOutlined />, color: '#a78bfa', bg: 'rgba(167, 139, 250, 0.1)', label: 'ORDER' };
      case 'tick': return { icon: <Clock size={14} />, color: '#64748b', bg: 'rgba(100, 116, 139, 0.08)', label: 'WATCH' };
      case 'error': return { icon: <AlertTriangle size={14} />, color: '#f87171', bg: 'rgba(239, 68, 68, 0.1)', label: 'ERROR' };
      default: return { icon: <EyeOutlined />, color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.08)', label: log.kind.toUpperCase() };
    }
  };

  // V5.71: Get radar event display info
  const getRadarMeta = (event: RadarEvent) => {
    switch (event.type) {
      case 'symbol_proximity':
        const score = event.data?.newScore as number | undefined;
        if (score && score >= 70) return { icon: <FireOutlined />, color: '#f97316', bg: 'rgba(249, 115, 22, 0.1)', label: 'HOT' };
        if (score && score >= 50) return { icon: <Thermometer size={14} />, color: '#fbbf24', bg: 'rgba(251, 191, 36, 0.1)', label: 'WARM' };
        return { icon: <Activity size={14} />, color: '#64748b', bg: 'rgba(100, 116, 139, 0.08)', label: 'PROXIMITY' };
      case 'market_regime':
        const isBull = event.data?.newRegime === 'BULL';
        return { icon: isBull ? <RiseOutlined /> : <FallOutlined />, color: isBull ? '#4ade80' : '#f87171', bg: isBull ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)', label: isBull ? 'BULL' : 'BEAR' };
      case 'market_volatility':
        const isHigh = event.data?.newVolatility === 'HIGH';
        return { icon: <Zap size={14} />, color: isHigh ? '#f97316' : '#64748b', bg: isHigh ? 'rgba(249, 115, 22, 0.1)' : 'rgba(100, 116, 139, 0.08)', label: 'VOLATILITY' };
      case 'position_update':
        return { icon: <ThunderboltOutlined />, color: event.severity === 'success' ? '#4ade80' : '#fbbf24', bg: event.severity === 'success' ? 'rgba(34, 197, 94, 0.1)' : 'rgba(251, 191, 36, 0.1)', label: 'POSITION' };
      case 'opportunity_alert':
        return { icon: <Target size={14} />, color: '#a78bfa', bg: 'rgba(167, 139, 250, 0.1)', label: 'OPPORTUNITY' };
    }
  };

  const formatRadarTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // Parse tick message to extract status
  const parseTickStatus = (message: string): { status: string; price?: string; bias?: string; sinceCandle?: string } | null => {
    // Match: WATCH AVAX/USDT $14.02 +0.4% LONG 🕯 Dec~1h
    const match = message.match(/WATCH\s+(\S+)\s+\$?([\d.]+)\s+([+-]?[\d.]+%)\s+(LONG|SHORT)\s+🕯\s*(.+)/i);
    if (match) {
      return { status: 'watching', price: match[2], bias: match[4], sinceCandle: match[5] };
    }
    // Match position: [SOL] #1 IN_LONG@$127.00
    const posMatch = message.match(/IN_(LONG|SHORT)@\$?([\d.]+)/i);
    if (posMatch) {
      return { status: 'in_position', price: posMatch[2], bias: posMatch[1] };
    }
    return null;
  };

  const cardStyle: React.CSSProperties = {
    background: 'rgba(15, 23, 42, 0.6)',
    borderRadius: 12,
    border: '1px solid rgba(148, 163, 184, 0.1)',
  };

  return (
    <div style={{ padding: '0 24px 24px', maxWidth: 1400, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <Title level={3} style={{ margin: 0, color: '#f8fafc', display: 'flex', alignItems: 'center', gap: 10 }}>
            <Zap size={24} /> Agent Feed
            <Tag color={mode === 'live' ? 'error' : 'blue'}>{mode?.toUpperCase()}</Tag>
          </Title>
          <Text style={{ color: 'rgba(148, 163, 184, 0.7)', fontSize: 13 }}>
            {agentStates.length} active session(s) • Real-time agent activity ({mode})
          </Text>
        </div>
        <Button icon={<ReloadOutlined />} onClick={loadData} loading={loading} />
      </div>

      {/* Active Agents Bar */}
      {agentStates.length > 0 && (
        <div style={{ ...cardStyle, padding: 16, marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <Zap size={14} style={{ color: '#fbbf24' }} />
            <Text style={{ color: '#f8fafc', fontWeight: 600, fontSize: 13 }}>Active Agents</Text>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {agentStates.map((agent) => (
              <div
                key={agent.sessionId}
                style={{
                  background: agent.hasPosition ? 'rgba(34, 197, 94, 0.08)' : 'rgba(59, 130, 246, 0.08)',
                  border: `1px solid ${agent.hasPosition ? 'rgba(34, 197, 94, 0.2)' : 'rgba(59, 130, 246, 0.2)'}`,
                  borderRadius: 8,
                  padding: '8px 12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: agent.hasPosition ? '#4ade80' : '#60a5fa' }} />
                <Text style={{ color: '#f8fafc', fontWeight: 500, fontSize: 13 }}>{agent.symbol}</Text>
                <Text style={{ color: agent.hasPosition ? '#4ade80' : '#60a5fa', fontSize: 11 }}>
                  {agent.hasPosition ? `Trading ${agent.bias?.toUpperCase()}` : 'Watching'}
                </Text>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      <div style={{ ...cardStyle, padding: 12, marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Text style={{ color: '#64748b', fontSize: 12 }}>Filter by:</Text>
            {(['all', 'futures', 'exits', 'orders', 'triggers'] as FilterType[]).map((f) => (
              <Tag
                key={f}
                onClick={() => setFilterType(f)}
                style={{
                  cursor: 'pointer',
                  background: filterType === f ? 'rgba(59, 130, 246, 0.2)' : 'rgba(148, 163, 184, 0.08)',
                  border: filterType === f ? '1px solid rgba(59, 130, 246, 0.4)' : '1px solid transparent',
                  color: filterType === f ? '#60a5fa' : '#94a3b8',
                  borderRadius: 6,
                  fontSize: 12,
                  textTransform: 'capitalize',
                }}
              >
                {f === 'all' ? 'All' : f}
              </Tag>
            ))}
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {(['all', 'long', 'short', 'watch'] as BiasFilter[]).map((b) => (
              <Tag
                key={b}
                onClick={() => setBiasFilter(b)}
                style={{
                  cursor: 'pointer',
                  background: biasFilter === b
                    ? b === 'long' ? 'rgba(34, 197, 94, 0.15)' : b === 'short' ? 'rgba(239, 68, 68, 0.15)' : 'rgba(59, 130, 246, 0.15)'
                    : 'rgba(148, 163, 184, 0.08)',
                  border: biasFilter === b ? '1px solid' : '1px solid transparent',
                  borderColor: biasFilter === b
                    ? b === 'long' ? 'rgba(34, 197, 94, 0.4)' : b === 'short' ? 'rgba(239, 68, 68, 0.4)' : 'rgba(59, 130, 246, 0.4)'
                    : 'transparent',
                  color: biasFilter === b
                    ? b === 'long' ? '#4ade80' : b === 'short' ? '#f87171' : '#60a5fa'
                    : '#94a3b8',
                  borderRadius: 6,
                  fontSize: 12,
                  textTransform: 'capitalize',
                }}
              >
                {b === 'all' ? 'All Types' : b}
              </Tag>
            ))}
          </div>
        </div>
      </div>

      {/* V5.71: Signal Radar - Real-time market intelligence */}
      <div style={{ ...cardStyle, padding: 0, marginBottom: 20 }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(148, 163, 184, 0.08)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Activity size={14} style={{ color: '#f97316' }} />
            <Text style={{ color: '#f8fafc', fontWeight: 600 }}>Signal Radar</Text>
            <Tag style={{ borderRadius: 4, border: 'none', background: 'rgba(249, 115, 22, 0.1)', color: '#f97316', fontSize: 10, margin: 0 }}>
              LIVE
            </Tag>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#f97316', animation: 'pulse 2s infinite' }} />
            <Text style={{ color: '#64748b', fontSize: 11 }}>WebSocket</Text>
          </div>
        </div>

        {radarEvents.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center' }}>
            <Text style={{ color: '#64748b', fontSize: 13 }}>
              Waiting for market events... Signal changes will appear here in real-time.
            </Text>
          </div>
        ) : (
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            {radarEvents.map((event, idx) => {
              const meta = getRadarMeta(event);
              const symbol = event.symbol?.replace('/USDT:USDT', '').replace('/USDT', '');

              return (
                <div
                  key={`${event.timestamp}-${idx}`}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 12,
                    padding: '10px 20px',
                    borderBottom: '1px solid rgba(148, 163, 184, 0.04)',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(148, 163, 184, 0.03)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  {/* Time */}
                  <Text style={{ color: '#64748b', fontSize: 11, minWidth: 65, fontFamily: 'monospace' }}>
                    {formatRadarTime(event.timestamp)}
                  </Text>

                  {/* Symbol Tag (if present) */}
                  {symbol && (
                    <Tag style={{ borderRadius: 4, border: 'none', background: 'rgba(148, 163, 184, 0.1)', color: '#f8fafc', fontSize: 10, fontWeight: 600, margin: 0 }}>
                      {symbol}
                    </Tag>
                  )}

                  {/* Status Tag */}
                  <Tag style={{ borderRadius: 4, border: 'none', background: meta.bg, color: meta.color, fontSize: 10, fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
                    {meta.icon}
                    {meta.label}
                  </Tag>

                  {/* Content */}
                  <div style={{ flex: 1 }}>
                    <Text style={{ color: '#f8fafc', fontSize: 12 }}>{event.title.replace(/\[.*?\]\s*/, '')}</Text>
                    <div style={{ marginTop: 2 }}>
                      <Text style={{ color: '#94a3b8', fontSize: 11 }}>{event.message}</Text>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Activity Feed */}
      <div style={{ ...cardStyle, padding: 0 }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(148, 163, 184, 0.08)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Clock size={14} style={{ color: '#64748b' }} />
            <Text style={{ color: '#f8fafc', fontWeight: 600 }}>Activity Feed</Text>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#4ade80', animation: 'pulse 2s infinite' }} />
            <Text style={{ color: '#64748b', fontSize: 11 }}>Live updates</Text>
          </div>
        </div>

        {filteredLogs.length === 0 ? (
          <div style={{ padding: 48 }}>
            <Empty
              description={
                <Text style={{ color: '#64748b' }}>
                  {agentStates.length === 0 ? 'No active agents. Start an agent to see the feed.' : 'No activity yet. Waiting for market events...'}
                </Text>
              }
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          </div>
        ) : (
          <div style={{ maxHeight: 600, overflowY: 'auto' }}>
            {filteredLogs.map((log, idx) => {
              const meta = getLogMeta(log);
              const tickStatus = log.kind === 'tick' ? parseTickStatus(log.message) : null;
              const isLoss = meta.label === 'LOSS';

              return (
                <div
                  key={`${log.timestamp}-${idx}`}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 12,
                    padding: '12px 20px',
                    borderBottom: '1px solid rgba(148, 163, 184, 0.04)',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(148, 163, 184, 0.03)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  {/* Time */}
                  <Text style={{ color: '#64748b', fontSize: 12, minWidth: 70, fontFamily: 'monospace' }}>
                    {formatTime(log.timestamp)}
                  </Text>

                  {/* Symbol Tag */}
                  <Tag style={{ borderRadius: 4, border: 'none', background: 'rgba(148, 163, 184, 0.1)', color: '#f8fafc', fontSize: 11, fontWeight: 600, margin: 0 }}>
                    {log.symbol?.replace('/USDT:USDT', '').replace('/USDT', '')}
                  </Tag>

                  {/* Status Tag */}
                  <Tag style={{ borderRadius: 4, border: 'none', background: meta.bg, color: meta.color, fontSize: 10, fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
                    {meta.icon}
                    {meta.label}
                  </Tag>

                  {/* Content */}
                  <div style={{ flex: 1 }}>
                    {log.kind === 'tick' && tickStatus ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <Text style={{ color: '#f8fafc', fontWeight: 500 }}>{log.symbol?.replace('/USDT:USDT', '/USDT')}</Text>
                        <Text style={{ color: '#4ade80', fontWeight: 600 }}>${tickStatus.price}</Text>
                        {tickStatus.bias && (
                          <Tag style={{
                            borderRadius: 4, border: 'none', fontSize: 10, margin: 0,
                            background: tickStatus.bias === 'LONG' ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                            color: tickStatus.bias === 'LONG' ? '#4ade80' : '#f87171',
                            display: 'flex', alignItems: 'center', gap: 4,
                          }}>
                            {tickStatus.bias === 'LONG' ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
                            {tickStatus.bias}
                          </Tag>
                        )}
                        {tickStatus.sinceCandle && (
                          <Tooltip title="Time since last valid candle">
                            <Tag style={{ borderRadius: 4, border: 'none', background: 'rgba(148, 163, 184, 0.06)', color: '#64748b', fontSize: 10, margin: 0 }}>
                              🕯 {tickStatus.sinceCandle}
                            </Tag>
                          </Tooltip>
                        )}
                      </div>
                    ) : log.kind === 'signal' ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Text style={{ color: '#f8fafc' }}>{log.message}</Text>
                      </div>
                    ) : (
                      <Text style={{ color: isLoss ? '#f87171' : '#f8fafc', fontWeight: log.kind === 'entry' || log.kind === 'exit' ? 500 : 400 }}>
                        {log.message}
                      </Text>
                    )}

                    {/* Entry/Exit Details */}
                    {(log.kind === 'entry' || log.kind === 'exit') && log.details && (
                      <div style={{ marginTop: 6, display: 'flex', gap: 12 }}>
                        {log.details.price && <Text style={{ color: '#64748b', fontSize: 11 }}>Price: ${log.details.price}</Text>}
                        {log.details.pnl != null && (
                          <Text style={{ color: log.details.pnl >= 0 ? '#4ade80' : '#f87171', fontSize: 11, fontWeight: 600 }}>
                            PnL: {log.details.pnl >= 0 ? '+' : ''}${log.details.pnl.toFixed(2)}
                          </Text>
                        )}
                        {log.details.leverage && <Text style={{ color: '#64748b', fontSize: 11 }}>Leverage: {log.details.leverage}x</Text>}
                      </div>
                    )}
                  </div>

                  {/* Right side status */}
                  <div style={{ marginLeft: 'auto' }}>
                    {log.kind === 'tick' && (
                      <Tag style={{
                        borderRadius: 4,
                        border: 'none',
                        background: 'rgba(251, 191, 36, 0.1)',
                        color: '#fbbf24',
                        fontSize: 10,
                        fontWeight: 500,
                        margin: 0,
                      }}>
                        WAITING FOR NEW CANDLE
                      </Tag>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
}

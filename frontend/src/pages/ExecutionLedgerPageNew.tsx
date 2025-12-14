import React from 'react';
import { Button, Typography, message, Tag, Input, Spin } from 'antd';
import { ReloadOutlined, DownloadOutlined, SearchOutlined } from '../icons';
import dayjs from 'dayjs';
import { api } from '../api';
import { useMode } from '../contexts/ModeContext';

const { Title, Text } = Typography;

type Outcome = 'win' | 'loss' | 'breakeven';

type TradeRow = {
  id: string;
  createdAt: string;
  symbol: string;
  positionSide: string;
  qty: number;
  entryPrice?: number | null;
  exitPrice?: number | null;
  realizedPnlUsd?: number | null;
  leverage?: number | null;
  sessionSymbol?: string;
  sessionMode?: string;
  sessionId?: string;
  outcome?: Outcome;
  roePct?: number | null;
  notionalUsd?: number | null;
  exitReason?: string | null;
  durationMinutes?: number | null;
  maxPnlPct?: number | null;
  feesUsd?: number | null;
};

function asOutcome(row: TradeRow): Outcome {
  const pnl = Number(row.realizedPnlUsd ?? 0);
  if (Math.abs(pnl) < 0.01) return 'breakeven';
  return pnl > 0 ? 'win' : 'loss';
}

function formatDuration(minutes?: number | null): string {
  if (minutes == null) return '-';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)}h`;
  return `${(minutes / 1440).toFixed(1)}d`;
}

export default function ExecutionLedgerPageNew() {
  const [allTrades, setAllTrades] = React.useState<TradeRow[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [searchText, setSearchText] = React.useState('');
  const { mode } = useMode();

  const trades = React.useMemo(() => {
    return allTrades.filter(t => t.sessionMode === mode);
  }, [allTrades, mode]);

  const summary = React.useMemo(() => {
    if (!trades.length) return null;
    let wins = 0, losses = 0, totalPnl = 0, totalFees = 0;
    trades.forEach(trade => {
      const pnl = Number(trade.realizedPnlUsd ?? 0);
      const fees = Number(trade.feesUsd ?? 0);
      totalPnl += pnl;
      totalFees += fees;
      const outcome = asOutcome(trade);
      if (outcome === 'win') wins++;
      else if (outcome === 'loss') losses++;
    });
    return { total: trades.length, wins, losses, winRate: trades.length ? (wins / trades.length) * 100 : 0, totalPnl, totalFees, netPnl: totalPnl - totalFees };
  }, [trades]);

  const loadTrades = React.useCallback(async () => {
    setLoading(true);
    try {
      // 🔧 FIX: Load ALL sessions (paper + live) to see all trades
      const sessionsList = await api.listSessions(); // No mode filter
      const loadedTrades: TradeRow[] = [];
      for (const session of sessionsList.slice(0, 20)) {
        try {
          const res = await api.getTrades(session.id, { limit: 100 });
          const sessionTrades = Array.isArray(res) ? res : (res?.trades || []);
          loadedTrades.push(...sessionTrades.map((t: any) => ({ ...t, sessionId: session.id, sessionSymbol: session.symbol, sessionMode: session.mode, outcome: asOutcome(t) })));
        } catch {}
      }
      loadedTrades.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setAllTrades(loadedTrades);
    } catch (e: any) {
      message.error(e?.message || 'Failed to load trades');
    }
    setLoading(false);
  }, []);

  React.useEffect(() => { void loadTrades(); }, [loadTrades]);

  const exportCsv = () => {
    if (!trades.length) return;
    const headers = ['Date', 'Symbol', 'Side', 'Qty', 'Entry', 'Exit', 'PnL', 'ROE%', 'Notional', 'Leverage', 'Duration', 'Exit Type', 'MaxPnL%', 'Fees', 'Outcome'];
    const rows = trades.map(t => [
      dayjs(t.createdAt).format('YYYY-MM-DD HH:mm'),
      t.symbol,
      t.positionSide,
      t.qty?.toFixed(4),
      t.entryPrice?.toFixed(4),
      t.exitPrice?.toFixed(4),
      t.realizedPnlUsd?.toFixed(2),
      t.roePct?.toFixed(2),
      t.notionalUsd?.toFixed(0),
      t.leverage?.toFixed(1),
      formatDuration(t.durationMinutes),
      t.exitReason || '',
      t.maxPnlPct?.toFixed(2),
      t.feesUsd?.toFixed(2),
      t.outcome,
    ].join(','));
    const blob = new Blob([[headers.join(','), ...rows].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `trades_${dayjs().format('YYYYMMDD')}.csv`;
    a.click();
  };

  const filteredTrades = React.useMemo(() => {
    if (!searchText) return trades;
    const s = searchText.toLowerCase();
    return trades.filter(t => t.symbol?.toLowerCase().includes(s) || t.sessionSymbol?.toLowerCase().includes(s));
  }, [trades, searchText]);

  const cardStyle: React.CSSProperties = { background: 'rgba(15, 23, 42, 0.6)', borderRadius: 12, border: '1px solid rgba(148, 163, 184, 0.1)', padding: '16px 20px' };
  const headerStyle: React.CSSProperties = { color: 'rgba(148, 163, 184, 0.6)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 };

  return (
    <div style={{ padding: '0 24px 24px', maxWidth: 1600, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <Title level={3} style={{ margin: 0, color: '#f8fafc', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 20 }}>📊</span> Execution Ledger
        </Title>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {/* 🆕 Mode Filter */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Text style={{ color: '#94a3b8', fontSize: 12 }}>Mode:</Text>
            <div style={{ display: 'flex', gap: 4 }}>
         
            </div>
          </div>
          <Input
            placeholder="Search..."
            prefix={<SearchOutlined style={{ color: '#64748b' }} />}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            style={{ width: 200, background: 'rgba(15, 23, 42, 0.8)', borderColor: 'rgba(148, 163, 184, 0.2)' }}
            allowClear
          />
          <Button icon={<ReloadOutlined />} onClick={loadTrades} loading={loading}>Refresh</Button>
          <Button icon={<DownloadOutlined />} onClick={exportCsv} disabled={!trades.length} type="primary">Export CSV</Button>
        </div>
      </div>

      {/* Stats Cards */}
      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 16, marginBottom: 24 }}>
          <div style={cardStyle}>
            <div style={headerStyle}>Total Trades</div>
            <div style={{ color: '#f8fafc', fontSize: 24, fontWeight: 700, marginTop: 4 }}>{summary.total}</div>
          </div>
          <div style={cardStyle}>
            <div style={headerStyle}>Win / Losses</div>
            <div style={{ color: '#f8fafc', fontSize: 24, fontWeight: 700, marginTop: 4 }}>{summary.wins} / {summary.losses}</div>
          </div>
          <div style={cardStyle}>
            <div style={headerStyle}>Win Rate</div>
            <div style={{ color: '#38bdf8', fontSize: 24, fontWeight: 700, marginTop: 4 }}>{summary.winRate.toFixed(1)}%</div>
          </div>
          <div style={cardStyle}>
            <div style={headerStyle}>Total P&L</div>
            <div style={{ color: summary.totalPnl >= 0 ? '#4ade80' : '#f87171', fontSize: 24, fontWeight: 700, marginTop: 4 }}>
              {summary.totalPnl >= 0 ? '+' : '-'}${Math.abs(summary.totalPnl).toFixed(2)}
            </div>
          </div>
          <div style={cardStyle}>
            <div style={headerStyle}>Total Fees</div>
            <div style={{ color: '#f97316', fontSize: 24, fontWeight: 700, marginTop: 4 }}>-${summary.totalFees.toFixed(2)}</div>
          </div>
          <div style={cardStyle}>
            <div style={headerStyle}>Net P&L</div>
            <div style={{ color: summary.netPnl >= 0 ? '#4ade80' : '#f87171', fontSize: 24, fontWeight: 700, marginTop: 4 }}>
              {summary.netPnl >= 0 ? '+' : '-'}${Math.abs(summary.netPnl).toFixed(2)}
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      <div style={{ background: 'rgba(15, 23, 42, 0.6)', borderRadius: 16, border: '1px solid rgba(148, 163, 184, 0.1)', overflow: 'auto' }}>
        {/* Table Header */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '90px 55px 55px 55px 95px 50px 70px 70px 70px 75px 55px 65px 45px 50px 110px 55px 55px',
          padding: '12px 16px',
          borderBottom: '1px solid rgba(148, 163, 184, 0.1)',
          background: 'rgba(15, 23, 42, 0.8)',
          minWidth: 1200,
        }}>
          {['Date', 'Outcome', 'Mode', 'Session', 'Symbol', 'Side', 'Qty', 'Entry', 'Exit', 'P&L', 'ROE%', 'Notional', 'Lev', 'Dur', 'Exit Type', 'MaxP&L', 'Fees'].map((h, i) => (
            <span key={i} style={{ ...headerStyle, textAlign: i >= 6 ? 'right' : 'left', whiteSpace: 'nowrap' }}>{h}</span>
          ))}
        </div>

        {/* Loading */}
        {loading && !trades.length && (
          <div style={{ padding: 48, textAlign: 'center' }}><Spin size="large" /></div>
        )}

        {/* Rows */}
        {filteredTrades.map((trade) => {
          const pnl = Number(trade.realizedPnlUsd ?? 0);
          const roe = Number(trade.roePct ?? 0);
          return (
            <div
              key={trade.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '90px 55px 55px 55px 95px 50px 70px 70px 70px 75px 55px 65px 45px 50px 110px 55px 55px',
                padding: '10px 16px',
                borderBottom: '1px solid rgba(148, 163, 184, 0.05)',
                alignItems: 'center',
                transition: 'background 0.15s',
                minWidth: 1200,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(148, 163, 184, 0.03)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              {/* Date */}
              <div style={{ whiteSpace: 'nowrap' }}>
                <div style={{ color: '#f8fafc', fontSize: 11 }}>{dayjs(trade.createdAt).format('YYYY-MM-DD')}</div>
                <div style={{ color: '#64748b', fontSize: 9 }}>{dayjs(trade.createdAt).format('HH:mm:ss')}</div>
              </div>

              {/* Outcome */}
              <Tag style={{
                borderRadius: 4, border: 'none', fontSize: 9, fontWeight: 600, padding: '2px 4px',
                background: trade.outcome === 'win' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                color: trade.outcome === 'win' ? '#4ade80' : '#f87171',
              }}>
                {trade.outcome?.toUpperCase()}
              </Tag>

              {/* Mode */}
              <Tag style={{
                fontSize: 9, fontWeight: 600, padding: '2px 6px', borderRadius: 4, border: 'none',
                background: trade.sessionMode === 'live' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(59, 130, 246, 0.15)',
                color: trade.sessionMode === 'live' ? '#4ade80' : '#60a5fa',
              }}>
                {(trade.sessionMode || 'unknown').toUpperCase()}
              </Tag>

              {/* Session */}
              <div style={{ whiteSpace: 'nowrap' }}>
                <div style={{ color: '#f8fafc', fontSize: 11 }}>{trade.sessionSymbol?.replace('/USDT:USDT', '')}</div>
              </div>

              {/* Symbol */}
              <Text style={{ color: '#f8fafc', fontSize: 11, whiteSpace: 'nowrap' }}>{trade.symbol?.replace('/USDT:USDT', '/USDT')}</Text>

              {/* Side */}
              <Tag style={{ borderRadius: 3, border: 'none', background: trade.positionSide === 'long' ? 'rgba(34, 197, 94, 0.12)' : 'rgba(239, 68, 68, 0.12)', color: trade.positionSide === 'long' ? '#4ade80' : '#f87171', fontSize: 9, fontWeight: 600, padding: '2px 4px' }}>
                {trade.positionSide?.toUpperCase()}
              </Tag>

              {/* Quantity */}
              <Text style={{ color: '#94a3b8', fontSize: 11, textAlign: 'right', display: 'block' }}>{trade.qty?.toFixed(4)}</Text>

              {/* Entry */}
              <Text style={{ color: '#94a3b8', fontSize: 11, textAlign: 'right', display: 'block' }}>{trade.entryPrice?.toFixed(4)}</Text>

              {/* Exit */}
              <Text style={{ color: '#94a3b8', fontSize: 11, textAlign: 'right', display: 'block' }}>{trade.exitPrice?.toFixed(4)}</Text>

              {/* P&L */}
              <Text style={{ color: pnl >= 0 ? '#4ade80' : '#f87171', fontSize: 12, fontWeight: 600, textAlign: 'right', display: 'block' }}>
                {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
              </Text>

              {/* ROE */}
              <Text style={{ color: roe >= 0 ? '#4ade80' : '#f87171', fontSize: 11, fontWeight: 500, textAlign: 'right', display: 'block' }}>
                {roe >= 0 ? '+' : ''}{roe.toFixed(1)}%
              </Text>

              {/* Notional */}
              <Text style={{ color: '#94a3b8', fontSize: 11, textAlign: 'right', display: 'block' }}>
                ${(trade.notionalUsd ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </Text>

              {/* Leverage */}
              <Text style={{ color: '#94a3b8', fontSize: 11, textAlign: 'right', display: 'block' }}>{trade.leverage?.toFixed(1)}x</Text>

              {/* Duration */}
              <Text style={{ color: '#94a3b8', fontSize: 10, textAlign: 'right', display: 'block' }}>{formatDuration(trade.durationMinutes)}</Text>

              {/* Exit Type */}
              {trade.exitReason ? (
                <Tag style={{
                  borderRadius: 3, border: 'none', fontSize: 8, padding: '2px 4px', whiteSpace: 'nowrap',
                  background: trade.exitReason.includes('PROFIT') || trade.exitReason.includes('TRAILING') ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                  color: trade.exitReason.includes('PROFIT') || trade.exitReason.includes('TRAILING') ? '#4ade80' : '#f87171',
                }}>
                  {trade.exitReason.includes('trailing_stop_exchange') ? '🎯 TRAILING STOP' : trade.exitReason.replace(/_/g, ' ').toUpperCase()}
                </Tag>
              ) : <Text style={{ color: '#64748b', fontSize: 10 }}>-</Text>}

              {/* Max P&L */}
              <Text style={{ color: '#94a3b8', fontSize: 10, textAlign: 'right', display: 'block' }}>
                {trade.maxPnlPct != null ? `+${trade.maxPnlPct.toFixed(1)}%` : '-'}
              </Text>

              {/* Fees */}
              <Text style={{ color: '#f97316', fontSize: 10, textAlign: 'right', display: 'block' }}>
                -${(trade.feesUsd ?? 0).toFixed(2)}
              </Text>
            </div>
          );
        })}

        {!loading && filteredTrades.length === 0 && (
          <div style={{ padding: 48, textAlign: 'center', color: '#64748b' }}>No trades found</div>
        )}
      </div>
    </div>
  );
}

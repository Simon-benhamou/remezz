import React from 'react';
import { Card, Space, Tooltip } from 'antd';

type Props = {
  kpi?: any;
  session?: any;
};

function Metric({ label, value, hint, color, precision = 2 }: { label: string; value: number; hint?: string; color?: string; precision?: number }) {
  const display = Number.isFinite(value) ? value.toFixed(precision) : '—';
  return (
    <div style={{ minWidth: 120 }}>
      <div style={{ fontSize: 12, opacity: 0.85 }}>{label}</div>
      <Tooltip title={hint}>
        <div style={{ fontSize: 24, fontWeight: 700, color: color || 'inherit' }}>{display}</div>
      </Tooltip>
    </div>
  );
}

export default function PerformanceBanner({ kpi, session }: Props) {
  const start = session?.startedAt ? new Date(session.startedAt).toLocaleString() : null;
  const roi = Number(kpi?.roiPct ?? 0);
  const color = roi >= 0 ? '#22c55e' : '#ef4444';
  const stats = (kpi?.stats || {}) as any;
  const expectancy = typeof kpi?.expectancy === 'number' ? kpi.expectancy : 0;
  const stdPct = typeof stats?.stdPct === 'number' ? stats.stdPct : undefined;
  const winRate = Number(kpi?.winRate ?? 0);
  const maxDD = Number(kpi?.maxDrawdownPct ?? 0);

  return (
    <Card
      bodyStyle={{ padding: 16 }}
      style={{
        background: 'linear-gradient(135deg, #0ea5e9 0%, #22c55e 100%)',
        color: 'white',
        border: 'none',
        borderRadius: 12,
        boxShadow: '0 10px 28px rgba(0,0,0,0.12)'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 200 }}>
          <div style={{ opacity: 0.9, fontSize: 12 }}>Performance {start ? `— since ${start}` : ''}</div>
          <div style={{ fontSize: 32, fontWeight: 800, lineHeight: 1, color }}>
            ROI {Number.isFinite(roi) ? roi.toFixed(2) : '—'}%
          </div>
          <div style={{ fontSize: 12, opacity: 0.9 }}>Cumulative return</div>
        </div>

        <Space size={24} wrap>
          <Metric label="Realized PnL (USD)" value={Number(kpi?.realizedPnlUsd ?? 0)} hint="Closed profit/loss since start" precision={2} />
          <Metric label="Unrealized PnL (USD)" value={Number(kpi?.unrealizedPnlUsd ?? 0)} hint="Open PnL on active positions" precision={2} />
          <Metric label="Win rate (%)" value={winRate} hint="Percent of winning trades" precision={1} />
          <Metric label="Max Drawdown (%)" value={maxDD} hint="Largest peak-to-trough drop" precision={1} color={maxDD > 0 ? '#fee2e2' : undefined} />
          <Metric label="Expectancy (%/trade)" value={Number(expectancy)} hint="Average return per trade" precision={2} />
          {stdPct != null && <Metric label="Return Std Dev (%)" value={Number(stdPct)} hint="Volatility of trade returns" precision={2} />}
        </Space>
      </div>
    </Card>
  );
}


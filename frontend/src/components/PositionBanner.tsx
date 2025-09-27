import React from 'react';
import { Card, Space, Tag } from 'antd';

type Props = {
  agent?: any;
  price?: number;
  orders: any[];
  trades: any[];
};

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ minWidth: 110 }}>
      <div style={{ fontSize: 12, opacity: 0.85 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700 }}>{value ?? '—'}</div>
    </div>
  );
}

export default function PositionBanner({ agent, price, orders, trades }: Props) {
  const hasActivity = Boolean(agent?.pos) || (orders?.length || 0) > 0 || (trades?.length || 0) > 0;
  if (!hasActivity) return null;

  const pos = agent?.pos;
  const side = pos?.side ? String(pos.side).toUpperCase() : null;
  const entry = typeof pos?.entry === 'number' ? pos.entry : null;
  const stop = typeof pos?.stop === 'number' ? pos.stop : null;
  const tp1 = Array.isArray(pos?.tp) && pos.tp.length ? pos.tp[0] : null;

  return (
    <Card
      bodyStyle={{ padding: 14 }}
      style={{
        background: 'linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)',
        color: 'white',
        border: 'none',
        borderRadius: 12,
        boxShadow: '0 10px 24px rgba(0,0,0,0.10)'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Position</div>
          {side && (
            <Tag color={side === 'BUY' ? 'green' : 'red'} style={{ borderRadius: 8 }}>
              {side}
            </Tag>
          )}
        </div>

        {pos ? (
          <Space size={20} wrap>
            <Metric label="Entry" value={entry != null ? entry.toFixed(4) : '—'} />
            <Metric label="Stop" value={stop != null ? stop.toFixed(4) : '—'} />
            <Metric label="TP1" value={tp1 != null ? tp1.toFixed(4) : '—'} />
            {typeof price === 'number' && price > 0 && (
              <Metric label="Last" value={price.toFixed(4)} />
            )}
          </Space>
        ) : (
          <Space size={20} wrap>
            <Metric label="Orders" value={(orders?.length || 0).toString()} />
            <Metric label="Trades" value={(trades?.length || 0).toString()} />
          </Space>
        )}
      </div>
    </Card>
  );
}


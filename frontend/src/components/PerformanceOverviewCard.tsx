import React from 'react';
import { Card, Col, Progress, Row, Space, Statistic, Tag, Tooltip, Typography } from 'antd';
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';

const { Text } = Typography;

type Trade = {
  id: string;
  createdAt: string;
  symbol?: string;
  positionSide?: string;
  realizedPnlUsd?: number;
  roePct?: number | null;
  estLev?: number | null;
};

type Props = {
  trades: Trade[];
  totalSessions: number;
  activeSessions: number;
  pnlUsd?: number;
  roiPct?: number;
  aiCallsTotal?: number;
  loading?: boolean;
};

type ChartPoint = {
  time: string;
  label: string;
  pnl: number;
};

function formatUsd(value?: number | null, digits = 2) {
  if (value == null || Number.isNaN(value)) return '$0.00';
  return `$${Number(value).toFixed(digits)}`;
}

function formatPercent(value?: number | null, digits = 1) {
  if (value == null || Number.isNaN(value)) return '0%';
  return `${Number(value).toFixed(digits)}%`;
}

function buildChart(trades: Trade[]): ChartPoint[] {
  if (!Array.isArray(trades) || trades.length === 0) return [];
  const sorted = [...trades].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  let cumulative = 0;
  const intl = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const points: ChartPoint[] = [];
  for (const trade of sorted) {
    cumulative += Number(trade.realizedPnlUsd || 0);
    points.push({
      time: trade.createdAt,
      label: intl.format(new Date(trade.createdAt)),
      pnl: Number(cumulative.toFixed(2)),
    });
  }
  if (points.length > 0) {
    const firstDate = new Date(points[0].time);
    points.unshift({
      time: new Date(firstDate.getTime() - 5 * 60 * 1000).toISOString(),
      label: intl.format(firstDate),
      pnl: 0,
    });
  }
  return points;
}

function aggregateStats(trades: Trade[]) {
  if (!Array.isArray(trades) || trades.length === 0) {
    return {
      totalPnl: 0,
      winRate: 0,
      avgRoe: 0,
      avgLev: 0,
      wins: 0,
      losses: 0,
    };
  }
  let totalPnl = 0;
  let wins = 0;
  let losses = 0;
  let roeSum = 0;
  let levSum = 0;
  let roeCount = 0;
  let levCount = 0;
  for (const trade of trades) {
    const pnl = Number(trade.realizedPnlUsd || 0);
    totalPnl += pnl;
    if (pnl > 0) wins += 1;
    else if (pnl < 0) losses += 1;
    if (trade.roePct != null) {
      roeSum += Number(trade.roePct);
      roeCount += 1;
    }
    if (trade.estLev != null) {
      levSum += Number(trade.estLev);
      levCount += 1;
    }
  }
  const total = wins + losses;
  return {
    totalPnl,
    winRate: total > 0 ? (wins / total) * 100 : 0,
    avgRoe: roeCount > 0 ? roeSum / roeCount : 0,
    avgLev: levCount > 0 ? levSum / levCount : 0,
    wins,
    losses,
  };
}

const PerformanceOverviewCard: React.FC<Props> = ({
  trades,
  totalSessions,
  activeSessions,
  pnlUsd,
  roiPct,
  aiCallsTotal,
  loading,
}) => {
  const chartPoints = React.useMemo(() => buildChart(trades), [trades]);
  const stats = React.useMemo(() => aggregateStats(trades), [trades]);
  const gradientId = React.useId();

  return (
    <Card
      loading={loading}
      style={{ borderRadius: 16, border: '1px solid #1f2937', background: '#0f172a' }}
      bodyStyle={{ padding: 24 }}
      title={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: '#f8fafc' }}>
          <span>Performance & utilisation</span>
          <Tag color='geekblue'>Realtime</Tag>
        </div>
      }
    >
      <Row gutter={[24, 24]}>
        <Col xs={24} md={14}>
          <div style={{ height: 260 }}>
            {chartPoints.length === 0 ? (
              <div
                style={{
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#94a3b8',
                }}
              >
                No realized trades yet.
              </div>
            ) : (
              <ResponsiveContainer width='100%' height='100%'>
                <AreaChart data={chartPoints}>
                  <defs>
                    <linearGradient id={`pnlGradient-${gradientId}`} x1='0' y1='0' x2='0' y2='1'>
                      <stop offset='5%' stopColor='#38bdf8' stopOpacity={0.8} />
                      <stop offset='95%' stopColor='#38bdf8' stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey='label' tick={{ fill: '#cbd5f5', fontSize: 12 }} interval='preserveStartEnd' minTickGap={32} />
                  <YAxis tick={{ fill: '#cbd5f5', fontSize: 12 }} width={80} tickFormatter={(value) => `$${value}`}/>
                  <RechartsTooltip
                    cursor={{ stroke: '#38bdf8', strokeDasharray: '4 4' }}
                    content={({ label, payload }) => {
                      if (!payload || payload.length === 0) return null;
                      const point = payload[0];
                      return (
                        <div
                          style={{
                            background: '#0f172a',
                            padding: '12px 16px',
                            borderRadius: 12,
                            border: '1px solid rgba(56, 189, 248, 0.3)',
                            color: '#e2e8f0',
                          }}
                        >
                          <div style={{ fontWeight: 600 }}>{label}</div>
                          <div style={{ opacity: 0.8 }}>Cumulative PnL: ${point.value?.toFixed?.(2)}</div>
                        </div>
                      );
                    }}
                  />
                  <Area type='monotone' dataKey='pnl' stroke='#38bdf8' strokeWidth={2.6} fill={`url(#pnlGradient-${gradientId})`} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </Col>
        <Col xs={24} md={10}>
          <Space direction='vertical' size={18} style={{ width: '100%' }}>
            <Row gutter={[12, 12]}>
              <Col span={12}>
                <Statistic
                  title={<Tooltip title='Total realized PnL across the last recorded trades'>Realized PnL</Tooltip>}
                  value={formatUsd(stats.totalPnl)}
                  valueStyle={{ color: stats.totalPnl >= 0 ? '#34d399' : '#f87171' }}
                />
              </Col>
              <Col span={12}>
                <Statistic
                  title={<Tooltip title='Win rate computed from the recent trade sample'>Win rate</Tooltip>}
                  value={formatPercent(stats.winRate)}
                  valueStyle={{ color: stats.winRate >= 50 ? '#c084fc' : '#fbbf24' }}
                />
              </Col>
              <Col span={12}>
                <Statistic
                  title={<Tooltip title='Average return on equity per trade'>Avg ROE / trade</Tooltip>}
                  value={formatPercent(stats.avgRoe)}
                />
              </Col>
              <Col span={12}>
                <Statistic
                  title={<Tooltip title='Average leverage inferred from notional usage'>Avg leverage</Tooltip>}
                  value={Number(stats.avgLev || 0).toFixed(2)}
                />
              </Col>
            </Row>
            <Row gutter={[12, 12]}>
              <Col span={12}>
                <Statistic title='Active sessions' value={activeSessions} />
              </Col>
              <Col span={12}>
                <Statistic title='Sessions total' value={totalSessions} />
              </Col>
              <Col span={12}>
                <Statistic
                  title='Portfolio ROI'
                  value={formatPercent(roiPct, 2)}
                  valueStyle={{ color: Number(roiPct || 0) >= 0 ? '#34d399' : '#f87171' }}
                />
              </Col>
              <Col span={12}>
                <Statistic title='AI calls' value={aiCallsTotal || 0} />
              </Col>
            </Row>
            <div style={{ padding: 14, borderRadius: 12, border: '1px solid rgba(148, 163, 184, 0.3)', background: '#1e293b' }}>
              <Text style={{ color: '#e2e8f0', fontWeight: 600 }}>PnL distribution</Text>
              <Progress
                percent={stats.wins + stats.losses > 0 ? (stats.wins / (stats.wins + stats.losses)) * 100 : 0}
                showInfo={false}
                strokeColor={{ from: '#22d3ee', to: '#38bdf8' }}
                style={{ marginTop: 12 }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#cbd5f5' }}>
                <span>{stats.wins} winning trades</span>
                <span>{stats.losses} losing trades</span>
              </div>
            </div>
          </Space>
        </Col>
      </Row>
    </Card>
  );
};

export default PerformanceOverviewCard;

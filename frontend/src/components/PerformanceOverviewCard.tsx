import React from 'react';
import { Card, Col, Divider, Progress, Row, Space, Statistic, Tag, Tooltip, Typography, theme } from 'antd';
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
  qty?: number | null;
};

type Props = {
  trades: Trade[];
  loading?: boolean;
  title?: string;
  subtitle?: string;
  tagLabel?: string;
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
      longs: 0,
      shorts: 0,
      sample: 0,
    };
  }
  let totalPnl = 0;
  let wins = 0;
  let losses = 0;
  let roeSum = 0;
  let levSum = 0;
  let roeCount = 0;
  let levCount = 0;
  let longs = 0;
  let shorts = 0;
  for (const trade of trades) {
    const pnl = Number(trade.realizedPnlUsd || 0);
    totalPnl += pnl;
    if (pnl > 0) wins += 1;
    else if (pnl < 0) losses += 1;
    if (trade.positionSide === 'long') longs += 1;
    else if (trade.positionSide === 'short') shorts += 1;
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
    longs,
    shorts,
    sample: trades.length,
  };
}

function formatRelative(ts?: string) {
  if (!ts) return '—';
  const date = new Date(ts);
  const delta = Date.now() - date.getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return 'Just now';
  if (delta < hour) {
    const mins = Math.round(delta / minute);
    return `${mins} min ago`;
  }
  if (delta < day) {
    const hours = Math.round(delta / hour);
    return `${hours}h ago`;
  }
  const days = Math.round(delta / day);
  return `${days}d ago`;
}

const PerformanceOverviewCard: React.FC<Props> = ({
  trades,
  loading,
  title,
  subtitle,
  tagLabel,
}) => {
  const chartPoints = React.useMemo(() => buildChart(trades), [trades]);
  const stats = React.useMemo(() => aggregateStats(trades), [trades]);
  const gradientId = React.useId();
  const sortedTrades = React.useMemo(
    () => [...(trades || [])].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [trades],
  );
  const latestTrade = sortedTrades[0];
  const { token } = theme.useToken();
  const base = token.colorBgBase.toLowerCase();
  const isDarkTheme = !['#ffffff', '#fff', '#fafafa'].includes(base);
  const cardBg = isDarkTheme ? '#0f172a' : token.colorBgContainer;
  const borderColor = isDarkTheme ? 'rgba(148, 163, 184, 0.2)' : token.colorBorderSecondary;
  const mutedText = isDarkTheme ? 'rgba(226, 232, 240, 0.7)' : token.colorTextSecondary;
  const accentColor = isDarkTheme ? '#38bdf8' : token.colorPrimary;
  const areaFillFrom = isDarkTheme ? 'rgba(56, 189, 248, 0.8)' : `${accentColor}CC`;
  const areaFillTo = isDarkTheme ? 'rgba(56, 189, 248, 0)' : `${accentColor}11`;
  const statCardBg = isDarkTheme ? 'rgba(15, 23, 42, 0.55)' : token.colorFillTertiary;
  const statCardBorder = isDarkTheme ? 'rgba(56, 189, 248, 0.25)' : token.colorBorderSecondary;
  const subtleSurface = isDarkTheme ? 'rgba(30, 41, 59, 0.8)' : token.colorFillQuaternary;

  const headerTitle = title ?? 'Performance & utilisation';
  const headerTag = tagLabel ?? 'Realtime';

  return (
    <Card
      loading={loading}
      style={{ borderRadius: 16, border: `1px solid ${borderColor}`, background: cardBg }}
      bodyStyle={{ padding: 24 }}
      title={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: subtitle ? 'flex-start' : 'center', color: isDarkTheme ? '#f8fafc' : token.colorText }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>{headerTitle}</span>
            {subtitle && <span style={{ color: mutedText, fontSize: 12 }}>{subtitle}</span>}
          </div>
          <Tag color='geekblue'>{headerTag}</Tag>
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
                  color: mutedText,
                }}
              >
                No realized trades yet.
              </div>
            ) : (
              <ResponsiveContainer width='100%' height='100%'>
                <AreaChart data={chartPoints}>
                  <defs>
                    <linearGradient id={`pnlGradient-${gradientId}`} x1='0' y1='0' x2='0' y2='1'>
                      <stop offset='5%' stopColor={areaFillFrom} stopOpacity={1} />
                      <stop offset='95%' stopColor={areaFillTo} stopOpacity={0.2} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey='label' tick={{ fill: mutedText, fontSize: 12 }} interval='preserveStartEnd' minTickGap={32} />
                  <YAxis tick={{ fill: mutedText, fontSize: 12 }} width={80} tickFormatter={(value) => `$${value}`}/>
                  <RechartsTooltip
                    cursor={{ stroke: accentColor, strokeDasharray: '4 4' }}
                    content={({ label, payload }) => {
                      if (!payload || payload.length === 0) return null;
                      const point = payload[0];
                      return (
                        <div
                          style={{
                            background: cardBg,
                            padding: '12px 16px',
                            borderRadius: 12,
                            border: `1px solid ${accentColor}33`,
                            color: isDarkTheme ? '#e2e8f0' : token.colorText,
                          }}
                        >
                          <div style={{ fontWeight: 600 }}>{label}</div>
                          <div style={{ opacity: 0.8 }}>Cumulative PnL: ${point.value?.toFixed?.(2)}</div>
                        </div>
                      );
                    }}
                  />
                  <Area type='monotone' dataKey='pnl' stroke={accentColor} strokeWidth={2.6} fill={`url(#pnlGradient-${gradientId})`} />
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
                  valueStyle={{ color: stats.totalPnl >= 0 ? token.colorSuccess : token.colorError }}
                />
              </Col>
              <Col span={12}>
                <Statistic
                  title={<Tooltip title='Win rate computed from the recent trade sample'>Win rate</Tooltip>}
                  value={formatPercent(stats.winRate)}
                  valueStyle={{ color: stats.winRate >= 50 ? accentColor : token.colorWarning }}
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
            <div
              style={{
                padding: 14,
                borderRadius: 12,
                border: `1px solid ${statCardBorder}`,
                background: statCardBg,
              }}
            >
              <Text style={{ color: isDarkTheme ? '#e2e8f0' : token.colorText, fontWeight: 600 }}>PnL distribution</Text>
              <Progress
                percent={stats.wins + stats.losses > 0 ? (stats.wins / (stats.wins + stats.losses)) * 100 : 0}
                showInfo={false}
                strokeColor={{ from: accentColor, to: accentColor }}
                style={{ marginTop: 12 }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: mutedText }}>
                <span>{stats.wins} winning trades</span>
                <span>{stats.losses} losing trades</span>
              </div>
            </div>
            <Divider style={{ margin: '0 0 8px' }} />
            <Row gutter={[12, 12]}>
              <Col span={12}>
                <Statistic
                  title='Sample size'
                  value={stats.sample}
                />
              </Col>
              <Col span={12}>
                <Statistic
                  title='Direction split'
                  value={`${stats.longs}/${stats.shorts}`}
                  suffix={<span style={{ color: mutedText }}>L/S</span>}
                />
              </Col>
            </Row>
            <div
              style={{
                display: 'flex',
                gap: 12,
                padding: 14,
                borderRadius: 12,
                border: `1px solid ${borderColor}`,
                background: subtleSurface,
              }}
            >
              <div style={{ flex: 1 }}>
                <Text type='secondary' style={{ fontSize: 12, display: 'block', color: mutedText }}>
                  Last trade
                </Text>
                <div style={{ fontWeight: 600, color: isDarkTheme ? '#f8fafc' : token.colorText }}>
                  {latestTrade ? latestTrade.symbol || '—' : 'No trades recorded'}
                </div>
                <div style={{ color: mutedText, fontSize: 12 }}>
                  {latestTrade ? formatRelative(latestTrade.createdAt) : 'Awaiting execution'}
                </div>
              </div>
              <div>
                <Text type='secondary' style={{ fontSize: 12, display: 'block', color: mutedText }}>
                  PnL
                </Text>
                <div
                  style={{
                    fontWeight: 600,
                    color: (latestTrade?.realizedPnlUsd ?? 0) >= 0 ? token.colorSuccess : token.colorError,
                  }}
                >
                  {formatUsd(latestTrade?.realizedPnlUsd ?? 0)}
                </div>
              </div>
            </div>
          </Space>
        </Col>
      </Row>
    </Card>
  );
};

export default PerformanceOverviewCard;

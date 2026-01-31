import React from 'react';
import { Card, Col, Divider, Progress, Row, Space, Statistic, Tag, Tooltip, Typography, theme } from 'antd';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { TrendingUp, TrendingDown, Flame, Trophy } from 'lucide-react';

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
  exitReason?: string;
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
  tradePnl: number;
};

type DailyData = {
  date: string;
  pnl: number;
  trades: number;
  wins: number;
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
    const tradePnl = Number(trade.realizedPnlUsd || 0);
    cumulative += tradePnl;
    points.push({
      time: trade.createdAt,
      label: intl.format(new Date(trade.createdAt)),
      pnl: Number(cumulative.toFixed(2)),
      tradePnl: Number(tradePnl.toFixed(2)),
    });
  }
  if (points.length > 0) {
    const firstDate = new Date(points[0].time);
    points.unshift({
      time: new Date(firstDate.getTime() - 5 * 60 * 1000).toISOString(),
      label: intl.format(firstDate),
      pnl: 0,
      tradePnl: 0,
    });
  }
  return points;
}

function buildDailyData(trades: Trade[]): DailyData[] {
  if (!Array.isArray(trades) || trades.length === 0) return [];
  
  const dailyMap = new Map<string, { pnl: number; trades: number; wins: number }>();
  
  for (const trade of trades) {
    const date = new Date(trade.createdAt).toLocaleDateString('en-CA'); // YYYY-MM-DD
    const existing = dailyMap.get(date) || { pnl: 0, trades: 0, wins: 0 };
    const pnl = Number(trade.realizedPnlUsd || 0);
    existing.pnl += pnl;
    existing.trades += 1;
    if (pnl > 0) existing.wins += 1;
    dailyMap.set(date, existing);
  }
  
  const result: DailyData[] = [];
  const intl = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' });
  
  dailyMap.forEach((data, date) => {
    result.push({
      date: intl.format(new Date(date)),
      pnl: Number(data.pnl.toFixed(2)),
      trades: data.trades,
      wins: data.wins,
    });
  });
  
  return result.sort((a, b) => a.date.localeCompare(b.date));
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
      bestTrade: null as Trade | null,
      worstTrade: null as Trade | null,
      avgWin: 0,
      avgLoss: 0,
      profitFactor: 0,
      currentStreak: 0,
      maxStreak: 0,
      slCount: 0,
      tpCount: 0,
      trailCount: 0,
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
  let totalWinAmount = 0;
  let totalLossAmount = 0;
  let slCount = 0;
  let tpCount = 0;
  let trailCount = 0;
  let bestTrade: Trade | null = null;
  let worstTrade: Trade | null = null;
  
  // For streak calculation
  const sortedTrades = [...trades].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  
  let currentStreak = 0;
  let maxStreak = 0;
  let tempStreak = 0;
  let lastWasWin: boolean | null = null;
  
  for (const trade of trades) {
    const pnl = Number(trade.realizedPnlUsd || 0);
    totalPnl += pnl;
    
    if (pnl > 0) {
      wins += 1;
      totalWinAmount += pnl;
    } else if (pnl < 0) {
      losses += 1;
      totalLossAmount += Math.abs(pnl);
    }
    
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
    
    // Track exit reasons
    const reason = trade.exitReason?.toLowerCase() || '';
    if (reason.includes('sl') || reason.includes('stop')) slCount++;
    else if (reason.includes('tp') || reason.includes('take')) tpCount++;
    else if (reason.includes('trail')) trailCount++;
    
    // Best/worst trades
    if (!bestTrade || pnl > (bestTrade.realizedPnlUsd || 0)) bestTrade = trade;
    if (!worstTrade || pnl < (worstTrade.realizedPnlUsd || 0)) worstTrade = trade;
  }
  
  // Calculate streaks
  for (const trade of sortedTrades) {
    const isWin = (trade.realizedPnlUsd || 0) > 0;
    if (lastWasWin === null) {
      lastWasWin = isWin;
      tempStreak = 1;
    } else if (isWin === lastWasWin) {
      tempStreak++;
    } else {
      maxStreak = Math.max(maxStreak, tempStreak);
      tempStreak = 1;
      lastWasWin = isWin;
    }
  }
  maxStreak = Math.max(maxStreak, tempStreak);
  
  // Current streak from most recent
  currentStreak = 0;
  if (sortedTrades.length > 0) {
    const firstIsWin = (sortedTrades[0].realizedPnlUsd || 0) > 0;
    for (const trade of sortedTrades) {
      const isWin = (trade.realizedPnlUsd || 0) > 0;
      if (isWin === firstIsWin) currentStreak++;
      else break;
    }
    if (!firstIsWin) currentStreak = -currentStreak;
  }
  
  const total = wins + losses;
  const avgWin = wins > 0 ? totalWinAmount / wins : 0;
  const avgLoss = losses > 0 ? totalLossAmount / losses : 0;
  const profitFactor = totalLossAmount > 0 ? totalWinAmount / totalLossAmount : totalWinAmount > 0 ? Infinity : 0;
  
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
    bestTrade,
    worstTrade,
    avgWin,
    avgLoss,
    profitFactor,
    currentStreak,
    maxStreak,
    slCount,
    tpCount,
    trailCount,
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
  const dailyData = React.useMemo(() => buildDailyData(trades), [trades]);
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
  const cardBg = 'var(--bg-primary)';
  const borderColor = 'var(--border-subtle)';
  const mutedText = 'var(--text-muted)';
  const accentColor = isDarkTheme ? '#38bdf8' : token.colorPrimary;
  const areaFillFrom = isDarkTheme ? 'rgba(56, 189, 248, 0.8)' : `${accentColor}CC`;
  const areaFillTo = isDarkTheme ? 'rgba(56, 189, 248, 0)' : `${accentColor}11`;
  const statCardBg = 'var(--bg-primary)';
  const statCardBorder = 'var(--border-subtle)';
  const subtleSurface = 'var(--bg-elevated)';

  const headerTitle = title ?? 'Performance Overview';
  const headerTag = tagLabel ?? 'Realtime';

  return (
    <Card
      loading={loading}
      style={{ borderRadius: 16, border: `1px solid ${borderColor}`, background: cardBg }}
      styles={{ body: { padding: 24 } }}
      title={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: subtitle ? 'flex-start' : 'center', color: 'var(--text-primary)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 16, fontWeight: 600 }}>{headerTitle}</span>
            {subtitle && <span style={{ color: mutedText, fontSize: 12 }}>{subtitle}</span>}
          </div>
          <Tag color='geekblue'>{headerTag}</Tag>
        </div>
      }
    >
      {/* Main Stats Row */}
      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={12} sm={6}>
          <div style={{ padding: 16, borderRadius: 12, background: statCardBg, border: `1px solid ${statCardBorder}` }}>
            <Text style={{ color: mutedText, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>Realized PnL</Text>
            <div style={{ fontSize: 24, fontWeight: 700, color: stats.totalPnl >= 0 ? 'var(--success)' : 'var(--error)', marginTop: 4 }}>
              {stats.totalPnl >= 0 ? '+' : ''}{formatUsd(stats.totalPnl)}
            </div>
          </div>
        </Col>
        <Col xs={12} sm={6}>
          <div style={{ padding: 16, borderRadius: 12, background: statCardBg, border: `1px solid ${statCardBorder}` }}>
            <Text style={{ color: mutedText, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>Win Rate</Text>
            <div style={{ fontSize: 24, fontWeight: 700, color: stats.winRate >= 50 ? 'var(--success)' : 'var(--warning)', marginTop: 4 }}>
              {formatPercent(stats.winRate)}
            </div>
            <Text style={{ color: mutedText, fontSize: 11 }}>{stats.wins}W / {stats.losses}L</Text>
          </div>
        </Col>
        <Col xs={12} sm={6}>
          <div style={{ padding: 16, borderRadius: 12, background: statCardBg, border: `1px solid ${statCardBorder}` }}>
            <Text style={{ color: mutedText, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>Profit Factor</Text>
            <div style={{ fontSize: 24, fontWeight: 700, color: stats.profitFactor >= 1.5 ? 'var(--success)' : stats.profitFactor >= 1 ? 'var(--warning)' : 'var(--error)', marginTop: 4 }}>
              {stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2)}
            </div>
          </div>
        </Col>
        <Col xs={12} sm={6}>
          <div style={{ padding: 16, borderRadius: 12, background: statCardBg, border: `1px solid ${statCardBorder}` }}>
            <Text style={{ color: mutedText, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>Streak</Text>
            <div style={{ fontSize: 24, fontWeight: 700, color: stats.currentStreak >= 0 ? 'var(--success)' : 'var(--error)', marginTop: 4 }}>
              {stats.currentStreak >= 0 ? '+' : ''}{stats.currentStreak}
            </div>
            <Text style={{ color: mutedText, fontSize: 11 }}>Max: {stats.maxStreak}</Text>
          </div>
        </Col>
      </Row>

      <Row gutter={[24, 24]}>
        {/* Cumulative PnL Chart */}
        <Col xs={24} lg={14}>
          <Text style={{ color: mutedText, fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 12 }}>
            Cumulative PnL
          </Text>
          <div style={{ height: 280 }}>
            {chartPoints.length === 0 ? (
              <div
                style={{
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: mutedText,
                  gap: 8,
                }}
              >
                <div style={{ fontSize: 16, fontWeight: 500 }}>No closed trades yet</div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>Trades will appear here once positions are closed</div>
              </div>
            ) : (
              <ResponsiveContainer width='100%' height='100%'>
                <ComposedChart data={chartPoints}>
                  <defs>
                    <linearGradient id={`pnlGradient-${gradientId}`} x1='0' y1='0' x2='0' y2='1'>
                      <stop offset='5%' stopColor={areaFillFrom} stopOpacity={1} />
                      <stop offset='95%' stopColor={areaFillTo} stopOpacity={0.2} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray='3 3' stroke={'var(--border-subtle)'} />
                  <XAxis dataKey='label' tick={{ fill: mutedText, fontSize: 11 }} interval='preserveStartEnd' minTickGap={40} />
                  <YAxis tick={{ fill: mutedText, fontSize: 11 }} width={70} tickFormatter={(value) => `$${value}`}/>
                  <RechartsTooltip
                    cursor={{ stroke: accentColor, strokeDasharray: '4 4' }}
                    content={({ label, payload }) => {
                      if (!payload || payload.length === 0) return null;
                      const point = payload[0]?.payload;
                      return (
                        <div
                          style={{
                            background: cardBg,
                            padding: '12px 16px',
                            borderRadius: 12,
                            border: `1px solid ${accentColor}33`,
                            color: 'var(--text-primary)',
                          }}
                        >
                          <div style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
                          <div>Cumulative: <span style={{ color: point?.pnl >= 0 ? 'var(--success)' : 'var(--error)', fontWeight: 600 }}>${point?.pnl?.toFixed?.(2)}</span></div>
                          {point?.tradePnl !== 0 && (
                            <div style={{ opacity: 0.8, fontSize: 12 }}>
                              Trade: <span style={{ color: point?.tradePnl >= 0 ? 'var(--success)' : 'var(--error)' }}>{point?.tradePnl >= 0 ? '+' : ''}${point?.tradePnl?.toFixed?.(2)}</span>
                            </div>
                          )}
                        </div>
                      );
                    }}
                  />
                  <Area type='monotone' dataKey='pnl' stroke={accentColor} strokeWidth={2.5} fill={`url(#pnlGradient-${gradientId})`} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
        </Col>

        {/* Daily Performance Bar Chart */}
        <Col xs={24} lg={10}>
          <Text style={{ color: mutedText, fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 12 }}>
            Daily Performance
          </Text>
          <div style={{ height: 280 }}>
            {dailyData.length === 0 ? (
              <div
                style={{
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: mutedText,
                  gap: 8,
                }}
              >
                <div style={{ fontSize: 14, opacity: 0.7 }}>No daily data</div>
              </div>
            ) : (
              <ResponsiveContainer width='100%' height='100%'>
                <BarChart data={dailyData}>
                  <CartesianGrid strokeDasharray='3 3' stroke={'var(--border-subtle)'} />
                  <XAxis dataKey='date' tick={{ fill: mutedText, fontSize: 10 }} />
                  <YAxis tick={{ fill: mutedText, fontSize: 10 }} width={60} tickFormatter={(value) => `$${value}`} />
                  <RechartsTooltip
                    content={({ label, payload }) => {
                      if (!payload || payload.length === 0) return null;
                      const data = payload[0]?.payload;
                      return (
                        <div style={{
                          background: cardBg,
                          padding: '10px 14px',
                          borderRadius: 10,
                          border: `1px solid ${borderColor}`,
                          color: 'var(--text-primary)',
                        }}>
                          <div style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
                          <div>PnL: <span style={{ color: data?.pnl >= 0 ? 'var(--success)' : 'var(--error)', fontWeight: 600 }}>${data?.pnl?.toFixed(2)}</span></div>
                          <div style={{ fontSize: 11, opacity: 0.8 }}>{data?.trades} trades ({data?.wins}W)</div>
                        </div>
                      );
                    }}
                  />
                  <Bar dataKey='pnl' radius={[4, 4, 0, 0]}>
                    {dailyData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.pnl >= 0 ? 'var(--success)' : 'var(--error)'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </Col>
      </Row>

      <Divider style={{ margin: '20px 0' }} />

      {/* Additional Stats */}
      <Row gutter={[16, 16]}>
        {/* Win/Loss Distribution */}
        <Col xs={24} sm={8}>
          <div style={{ padding: 16, borderRadius: 12, background: subtleSurface, border: `1px solid ${borderColor}` }}>
            <Text style={{ color: mutedText, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 12 }}>
              Win/Loss Distribution
            </Text>
            <Progress
              percent={stats.wins + stats.losses > 0 ? (stats.wins / (stats.wins + stats.losses)) * 100 : 0}
              showInfo={false}
              strokeColor='var(--success)'
              trailColor='var(--error)'
              style={{ marginBottom: 8 }}
            />
            <Row>
              <Col span={12}>
                <Text style={{ color: 'var(--success)', fontSize: 13, fontWeight: 600 }}>{stats.wins} wins</Text>
                <div style={{ color: mutedText, fontSize: 11 }}>Avg: {formatUsd(stats.avgWin)}</div>
              </Col>
              <Col span={12} style={{ textAlign: 'right' }}>
                <Text style={{ color: 'var(--error)', fontSize: 13, fontWeight: 600 }}>{stats.losses} losses</Text>
                <div style={{ color: mutedText, fontSize: 11 }}>Avg: -{formatUsd(stats.avgLoss)}</div>
              </Col>
            </Row>
          </div>
        </Col>

        {/* Direction Split */}
        <Col xs={24} sm={8}>
          <div style={{ padding: 16, borderRadius: 12, background: subtleSurface, border: `1px solid ${borderColor}` }}>
            <Text style={{ color: mutedText, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 12 }}>
              Direction Split
            </Text>
            <Row gutter={16}>
              <Col span={12}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <TrendingUp size={16} color="var(--success)" />
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>{stats.longs}</div>
                    <div style={{ color: mutedText, fontSize: 11 }}>Longs</div>
                  </div>
                </div>
              </Col>
              <Col span={12}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <TrendingDown size={16} color="var(--error)" />
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>{stats.shorts}</div>
                    <div style={{ color: mutedText, fontSize: 11 }}>Shorts</div>
                  </div>
                </div>
              </Col>
            </Row>
            <div style={{ marginTop: 12 }}>
              <Text style={{ color: mutedText, fontSize: 11 }}>
                Avg ROE: {formatPercent(stats.avgRoe)} • Avg Leverage: {stats.avgLev.toFixed(1)}×
              </Text>
            </div>
          </div>
        </Col>

        {/* Exit Reasons */}
        <Col xs={24} sm={8}>
          <div style={{ padding: 16, borderRadius: 12, background: subtleSurface, border: `1px solid ${borderColor}` }}>
            <Text style={{ color: mutedText, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 12 }}>
              Exit Reasons
            </Text>
            <Space direction='vertical' size={6} style={{ width: '100%' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ color: 'var(--text-primary)' }}>🎯 Take Profit</Text>
                <Tag color='success'>{stats.tpCount}</Tag>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ color: 'var(--text-primary)' }}>📈 Trailing Stop</Text>
                <Tag color='blue'>{stats.trailCount}</Tag>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ color: 'var(--text-primary)' }}>🛑 Stop Loss</Text>
                <Tag color='error'>{stats.slCount}</Tag>
              </div>
            </Space>
          </div>
        </Col>
      </Row>

      <Divider style={{ margin: '20px 0' }} />

      {/* Best/Worst Trades & Last Trade */}
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={8}>
          <div style={{ padding: 14, borderRadius: 12, background: 'rgba(52, 211, 153, 0.1)', border: '1px solid rgba(52, 211, 153, 0.3)' }}>
            <Space size={8} align='center'>
              <Trophy size={18} color="var(--success)" />
              <div>
                <Text style={{ color: mutedText, fontSize: 11, display: 'block' }}>Best Trade</Text>
                <Text style={{ color: 'var(--success)', fontWeight: 700, fontSize: 16 }}>
                  {stats.bestTrade ? `+${formatUsd(stats.bestTrade.realizedPnlUsd)}` : '—'}
                </Text>
                {stats.bestTrade && (
                  <Text style={{ color: mutedText, fontSize: 11, display: 'block' }}>
                    {stats.bestTrade.symbol?.replace('/USDT', '')} • {formatRelative(stats.bestTrade.createdAt)}
                  </Text>
                )}
              </div>
            </Space>
          </div>
        </Col>
        <Col xs={24} sm={8}>
          <div style={{ padding: 14, borderRadius: 12, background: 'rgba(248, 113, 113, 0.1)', border: '1px solid rgba(248, 113, 113, 0.3)' }}>
            <Space size={8} align='center'>
              <Flame size={18} color="var(--error)" />
              <div>
                <Text style={{ color: mutedText, fontSize: 11, display: 'block' }}>Worst Trade</Text>
                <Text style={{ color: 'var(--error)', fontWeight: 700, fontSize: 16 }}>
                  {stats.worstTrade ? formatUsd(stats.worstTrade.realizedPnlUsd) : '—'}
                </Text>
                {stats.worstTrade && (
                  <Text style={{ color: mutedText, fontSize: 11, display: 'block' }}>
                    {stats.worstTrade.symbol?.replace('/USDT', '')} • {formatRelative(stats.worstTrade.createdAt)}
                  </Text>
                )}
              </div>
            </Space>
          </div>
        </Col>
        <Col xs={24} sm={8}>
          <div style={{ padding: 14, borderRadius: 12, border: `1px solid ${borderColor}`, background: subtleSurface }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <Text style={{ color: mutedText, fontSize: 11, display: 'block' }}>Last Trade</Text>
                <Text style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: 14 }}>
                  {latestTrade ? latestTrade.symbol?.replace('/USDT', '') || '—' : 'No trades'}
                </Text>
                <Text style={{ color: mutedText, fontSize: 11, display: 'block' }}>
                  {latestTrade ? formatRelative(latestTrade.createdAt) : 'Awaiting execution'}
                </Text>
              </div>
              <div style={{ textAlign: 'right' }}>
                <Text style={{ color: mutedText, fontSize: 11, display: 'block' }}>PnL</Text>
                <Text style={{ 
                  color: (latestTrade?.realizedPnlUsd ?? 0) >= 0 ? 'var(--success)' : 'var(--error)', 
                  fontWeight: 700, 
                  fontSize: 16 
                }}>
                  {latestTrade ? (latestTrade.realizedPnlUsd ?? 0) >= 0 ? '+' : '' : ''}{formatUsd(latestTrade?.realizedPnlUsd ?? 0)}
                </Text>
              </div>
            </div>
          </div>
        </Col>
      </Row>
    </Card>
  );
};

export default PerformanceOverviewCard;

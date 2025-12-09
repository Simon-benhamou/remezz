import React from 'react';
import { Card, Row, Col, Space, Button, Tag, Typography, Tooltip, Spin } from 'antd';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useMode } from '../contexts/ModeContext';
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';
import { 
  Bot, 
  TrendingUp,
  TrendingDown,
  RefreshCw,
  ArrowRightLeft,
  Activity,
  Percent,
} from 'lucide-react';

const { Text } = Typography;

// Market Conditions types V5
type MarketConditionsStatus = 'favorable_long' | 'favorable_short' | 'neutral' | 'unfavorable' | 'unknown';

interface MarketConditions {
  status: MarketConditionsStatus;
  btcAboveMa50: boolean | null;
  btcAboveSma200?: boolean | null;
  btcMomentum6h: number | null;
  btcTrend: 'bullish' | 'bearish' | 'neutral' | null;
  isTradingDay: boolean | null;
  reason: string;
  tradingRecommended: boolean;
  marketQuality?: 'momentum' | 'consolidation' | 'unknown' | 'analyzing';
  qualityReason?: string;
}

type Trade = {
  id: string;
  createdAt: string;
  symbol?: string;
  positionSide?: string;
  entryPrice?: number | null;
  exitPrice?: number | null;
  realizedPnlUsd?: number;
  feesUsd?: number;
  roePct?: number | null;
  estLev?: number | null;
};

// Styles
const cardStyle: React.CSSProperties = {
  background: '#0f172a',
  borderRadius: 16,
  border: '1px solid rgba(148, 163, 184, 0.15)',
};

const statCardStyle: React.CSSProperties = {
  background: 'linear-gradient(135deg, rgba(15, 23, 42, 0.9), rgba(30, 41, 59, 0.9))',
  borderRadius: 12,
  border: '1px solid rgba(148, 163, 184, 0.15)',
  padding: '16px 20px',
};

export default function DashboardPageCompact() {
  const [ov, setOv] = React.useState<any>({});
  const [loading, setLoading] = React.useState<boolean>(true);
  const [trades, setTrades] = React.useState<Trade[]>([]);
  const [tradesLoading, setTradesLoading] = React.useState<boolean>(false);
  const [marketConditions, setMarketConditions] = React.useState<MarketConditions | null>(null);
  const navigate = useNavigate();
  const { mode } = useMode();

  // Build chart data
  const chartData = React.useMemo(() => {
    if (!trades || trades.length === 0) return [];
    const sorted = [...trades].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    let cumulative = 0;
    const intl = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
    return sorted.map((trade) => {
      cumulative += Number(trade.realizedPnlUsd || 0);
      return {
        date: intl.format(new Date(trade.createdAt)),
        value: Number(cumulative.toFixed(2)),
        fullDate: trade.createdAt,
      };
    });
  }, [trades]);

  // Stats - use ov.todayPnlUsd from backend (already includes fees) for accuracy
  const stats = React.useMemo(() => {
    const totalPnl = trades.reduce((sum, t) => sum + (t.realizedPnlUsd || 0) - (t.feesUsd || 0), 0);
    
    // Today's PnL - filter trades from today (midnight local time)
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTrades = trades.filter(t => new Date(t.createdAt) >= todayStart);
    // Calculate net PnL (after fees) for today
    const todayPnl = todayTrades.reduce((sum, t) => sum + (t.realizedPnlUsd || 0) - (t.feesUsd || 0), 0);
    const todayWins = todayTrades.filter(t => (t.realizedPnlUsd || 0) > 0).length;
    const todayLosses = todayTrades.filter(t => (t.realizedPnlUsd || 0) < 0).length;
    const todayWinRate = (todayWins + todayLosses) > 0 ? (todayWins / (todayWins + todayLosses)) * 100 : 0;
    
    const wins = trades.filter(t => (t.realizedPnlUsd || 0) > 0).length;
    const losses = trades.filter(t => (t.realizedPnlUsd || 0) < 0).length;
    const winRate = (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0;
    const avgRoe = trades.length > 0 
      ? trades.reduce((sum, t) => sum + (t.roePct || 0), 0) / trades.length 
      : 0;
    const avgLev = trades.length > 0 
      ? trades.reduce((sum, t) => sum + (t.estLev || 0), 0) / trades.length 
      : 0;
    const longs = trades.filter(t => t.positionSide === 'long').length;
    const shorts = trades.filter(t => t.positionSide === 'short').length;
    return { totalPnl, todayPnl, todayTrades: todayTrades.length, todayWinRate, wins, losses, winRate, avgRoe, avgLev, longs, shorts };
  }, [trades]);

  async function loadTrades() {
    setTradesLoading(true);
    try {
      const sessionsRes = await api.listSessions(mode);
      const sessions = Array.isArray(sessionsRes) ? sessionsRes : (sessionsRes?.sessions || []);
      const results = await Promise.all(
        sessions.map(async (session: any) => {
          try {
            const tradesRes = await api.getTrades(session.id, { limit: 20 });
            return Array.isArray(tradesRes) ? tradesRes : (tradesRes?.trades || []);
          } catch {
            return [];
          }
        })
      );
      const allTrades = results.flat();
      const validTrades = allTrades
        .filter((t: any) => t.exitPrice != null && t.entryPrice != null && t.realizedPnlUsd != null)
        .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 100);
      setTrades(validTrades);
    } catch (err) {
      console.error('Failed to load trades:', err);
      setTrades([]);
    } finally {
      setTradesLoading(false);
    }
  }

  async function load() {
    setLoading(true);
    try {
      const [overviewRes, conditionsRes] = await Promise.all([
        api.overview(mode),
        api.getMarketConditions().catch(() => null),
      ]);
      setOv(overviewRes || {});
      setMarketConditions(conditionsRes);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    load();
    loadTrades();
    const iv = setInterval(() => {
      load();
      loadTrades();
    }, 30000);
    return () => clearInterval(iv);
  }, [mode]);

  const recentTrades = trades.slice(0, 6);
  const tradingCount = (ov?.sessions || []).filter((s: any) => s.state === 'IN_POSITION').length;
  const watchingCount = (ov?.sessions || []).filter((s: any) => s.state === 'WATCHING').length;

  return (
    <div style={{ padding: '20px', maxWidth: 1400, margin: '0 auto', background: '#020617', minHeight: '100vh' }}>
      
      {/* Top Stats Bar */}
      <Row gutter={[16, 16]} style={{ marginBottom: 20 }}>
        <Col xs={12} sm={6}>
          <div style={statCardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <Bot size={14} color="#38bdf8" />
              <Text style={{ color: '#38bdf8', fontSize: 12, fontWeight: 500 }}>Active Agents</Text>
            </div>
            <div style={{ fontSize: 32, fontWeight: 700, color: '#f8fafc' }}>{ov?.activeCount || 0}</div>
            <Text style={{ color: 'rgba(148, 163, 184, 0.7)', fontSize: 12 }}>{tradingCount} Trading Now</Text>
          </div>
        </Col>
        <Col xs={12} sm={6}>
          <div style={statCardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              {(ov?.todayPnlUsd ?? 0) >= 0 ? <TrendingUp size={14} color="#34d399" /> : <TrendingDown size={14} color="#f87171" />}
              <Text style={{ color: (ov?.todayPnlUsd ?? 0) >= 0 ? '#34d399' : '#f87171', fontSize: 12, fontWeight: 500 }}>Today's PnL</Text>
            </div>
            <div style={{ fontSize: 32, fontWeight: 700, color: (ov?.todayPnlUsd ?? 0) >= 0 ? '#34d399' : '#f87171' }}>
              {(ov?.todayPnlUsd ?? 0) >= 0 ? '+' : '-'}${Math.abs(ov?.todayPnlUsd ?? 0).toFixed(2)}
            </div>
            <Text style={{ color: 'rgba(148, 163, 184, 0.7)', fontSize: 12 }}>{ov?.todayTrades ?? stats.todayTrades} trades today</Text>
          </div>
        </Col>
        <Col xs={12} sm={6}>
          <div style={statCardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ color: '#fbbf24', fontSize: 14 }}>%</span>
              <Text style={{ color: '#fbbf24', fontSize: 12, fontWeight: 500 }}>Today Win Rate</Text>
            </div>
            <div style={{ fontSize: 32, fontWeight: 700, color: stats.todayWinRate >= 50 ? '#34d399' : stats.todayTrades > 0 ? '#f87171' : '#94a3b8' }}>
              {stats.todayTrades > 0 ? `${stats.todayWinRate.toFixed(0)}%` : '—'}
            </div>
            <Text style={{ color: 'rgba(148, 163, 184, 0.7)', fontSize: 12 }}>All-time: {stats.winRate.toFixed(0)}% ({stats.wins}W/{stats.losses}L)</Text>
          </div>
        </Col>
        <Col xs={12} sm={6}>
          <div style={statCardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <Activity size={14} color="#a78bfa" />
              <Text style={{ color: '#a78bfa', fontSize: 12, fontWeight: 500 }}>Total Trades</Text>
            </div>
            <div style={{ fontSize: 32, fontWeight: 700, color: '#f8fafc' }}>{trades.length}</div>
            <Text style={{ color: 'rgba(148, 163, 184, 0.7)', fontSize: 12 }}>Avg ROE: {stats.avgRoe >= 0 ? '+' : ''}{stats.avgRoe.toFixed(1)}%</Text>
          </div>
        </Col>
      </Row>

      {/* Market Conditions */}
      {marketConditions && (
        <Card style={{ ...cardStyle, marginBottom: 20, padding: '20px 24px' }} bodyStyle={{ padding: 0 }}>
          <Text style={{ color: '#f8fafc', fontSize: 16, fontWeight: 600, display: 'block', marginBottom: 20 }}>
            Market Conditions
          </Text>
          <Row gutter={[32, 16]} align="middle">
            <Col xs={24} sm={6}>
              <Text style={{ color: 'rgba(148, 163, 184, 0.7)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 8 }}>
                Overall Sentiment
              </Text>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {marketConditions.status === 'favorable_long' && (
                  <>
                    <TrendingUp size={16} color="#34d399" />
                    <Text style={{ color: '#34d399', fontSize: 16, fontWeight: 700 }}>FAVORABLE LONG</Text>
                  </>
                )}
                {marketConditions.status === 'favorable_short' && (
                  <>
                    <TrendingDown size={16} color="#f87171" />
                    <Text style={{ color: '#f87171', fontSize: 16, fontWeight: 700 }}>FAVORABLE SHORT</Text>
                  </>
                )}
                {marketConditions.status === 'neutral' && (
                  <Text style={{ color: '#fbbf24', fontSize: 16, fontWeight: 700 }}>NEUTRAL</Text>
                )}
                {marketConditions.status === 'unfavorable' && (
                  <Text style={{ color: '#f87171', fontSize: 16, fontWeight: 700 }}>UNFAVORABLE</Text>
                )}
                {marketConditions.status === 'unknown' && (
                  <Text style={{ color: '#94a3b8', fontSize: 16, fontWeight: 700 }}>UNKNOWN</Text>
                )}
              </div>
            </Col>
            <Col xs={12} sm={6}>
              <Text style={{ color: 'rgba(148, 163, 184, 0.7)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 8 }}>
                BTC 24H Momentum
              </Text>
              <Text style={{ 
                color: (marketConditions.btcMomentum6h || 0) >= 0 ? '#34d399' : '#f87171', 
                fontSize: 18, 
                fontWeight: 700 
              }}>
                {(marketConditions.btcMomentum6h || 0) >= 0 ? '+' : ''}{(marketConditions.btcMomentum6h || 0).toFixed(2)}%
              </Text>
            </Col>
            <Col xs={12} sm={6}>
              <Text style={{ color: 'rgba(148, 163, 184, 0.7)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 8 }}>
                BTC vs MA200 (1H)
              </Text>
              <Text style={{ 
                color: marketConditions.btcAboveMa50 ? '#34d399' : '#f87171', 
                fontSize: 18, 
                fontWeight: 700 
              }}>
                {marketConditions.btcAboveMa50 ? 'BULLISH' : 'BEARISH'}
              </Text>
            </Col>
            <Col xs={24} sm={6}>
              <Text style={{ color: 'rgba(148, 163, 184, 0.7)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 8 }}>
                Trade Signal
              </Text>
              <Tag 
                style={{ 
                  background: marketConditions.tradingRecommended ? 'rgba(52, 211, 153, 0.15)' : 'rgba(148, 163, 184, 0.15)',
                  border: marketConditions.tradingRecommended ? '1px solid #34d399' : '1px solid rgba(148, 163, 184, 0.3)',
                  color: marketConditions.tradingRecommended ? '#34d399' : '#94a3b8',
                  fontSize: 13,
                  fontWeight: 600,
                  padding: '6px 16px',
                  borderRadius: 6,
                }}
              >
                {marketConditions.tradingRecommended ? 'RECOMMENDED' : 'WAIT'}
              </Tag>
            </Col>
          </Row>
        </Card>
      )}

      {/* Active Agents Grid */}
      <Card 
        style={{ ...cardStyle, marginBottom: 20 }} 
        bodyStyle={{ padding: 20 }}
        title={
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Space>
              <Bot size={16} color="#38bdf8" />
              <Text style={{ color: '#f8fafc', fontSize: 15, fontWeight: 600 }}>Active Agents</Text>
              <Tag color="gold" style={{ marginLeft: 8 }}>{tradingCount} Trading</Tag>
            </Space>
            <Text style={{ color: 'rgba(148, 163, 184, 0.7)', fontSize: 13 }}>{watchingCount} watching</Text>
          </div>
        }
        headStyle={{ background: 'transparent', borderBottom: '1px solid rgba(148, 163, 184, 0.1)' }}
      >
        {loading ? (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <Spin size="large" />
          </div>
        ) : (ov?.sessions || []).length === 0 ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>
            <Bot size={48} style={{ marginBottom: 16, opacity: 0.5 }} />
            <div>No active agents</div>
            <Button type="primary" style={{ marginTop: 16 }} onClick={() => navigate('/agents')}>
              Create Agent
            </Button>
          </div>
        ) : (
          <Row gutter={[16, 16]}>
            {(ov?.sessions || []).map((session: any) => (
              <Col xs={12} sm={8} md={6} key={session.id}>
                <div
                  onClick={() => navigate(`/agents/${session.id}`)}
                  style={{
                    background: 'rgba(15, 23, 42, 0.6)',
                    borderRadius: 12,
                    border: '1px solid rgba(148, 163, 184, 0.15)',
                    padding: 16,
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                    height: '100%',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(30, 41, 59, 0.8)';
                    e.currentTarget.style.borderColor = 'rgba(56, 189, 248, 0.3)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'rgba(15, 23, 42, 0.6)';
                    e.currentTarget.style.borderColor = 'rgba(148, 163, 184, 0.15)';
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                    <Text style={{ color: '#f8fafc', fontWeight: 600, fontSize: 14 }}>
                      {session.symbol?.replace('/USDT', '').replace(':USDT', '')}
                    </Text>
                    <Tag 
                      color={session.state === 'IN_POSITION' ? 'blue' : 'gold'}
                      style={{ fontSize: 10, padding: '2px 8px', margin: 0 }}
                    >
                      {session.state === 'IN_POSITION' ? 'TRADING' : 'WATCHING'}
                    </Tag>
                  </div>
                  <Text style={{ color: 'rgba(148, 163, 184, 0.6)', fontSize: 11, display: 'block', marginBottom: 8 }}>
                    PnL
                  </Text>
                  <div style={{ 
                    color: (session.pnlUsd || 0) >= 0 ? '#34d399' : '#f87171', 
                    fontSize: 22, 
                    fontWeight: 700,
                    marginBottom: 4
                  }}>
                    {(session.pnlUsd || 0) >= 0 ? '' : '-'}${Math.abs(session.pnlUsd || 0).toFixed(2)}
                  </div>
                  <Text style={{ 
                    color: (session.winRate || 0) >= 50 ? '#34d399' : '#f87171', 
                    fontSize: 12 
                  }}>
                    Win Rate: {(session.winRate || 0).toFixed(0)}%
                  </Text>
                </div>
              </Col>
            ))}
          </Row>
        )}
      </Card>

      {/* Performance Overview + Recent Trades Side by Side */}
      <Row gutter={[20, 20]} style={{ marginBottom: 20 }}>
        {/* Performance Chart */}
        <Col xs={24} lg={14}>
          <Card 
            style={cardStyle} 
            bodyStyle={{ padding: 20 }}
            title={
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <Text style={{ color: '#f8fafc', fontSize: 15, fontWeight: 600, display: 'block' }}>Performance Overview</Text>
                  <Text style={{ color: 'rgba(148, 163, 184, 0.6)', fontSize: 12 }}>Cumulative PnL across all sessions</Text>
                </div>
                <Button 
                  type="text" 
                  icon={<RefreshCw size={16} className={tradesLoading ? 'spin' : ''} />} 
                  onClick={loadTrades}
                  style={{ color: '#94a3b8' }}
                />
              </div>
            }
            headStyle={{ background: 'transparent', borderBottom: '1px solid rgba(148, 163, 184, 0.1)' }}
          >
            {/* Big PnL Display */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ marginBottom: 4 }}>
                <Text style={{ color: 'rgba(148, 163, 184, 0.6)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  Total PnL (All-Time)
                </Text>
              </div>
              <span style={{ fontSize: 36, fontWeight: 700, color: stats.totalPnl >= 0 ? '#34d399' : '#f87171' }}>
                {stats.totalPnl >= 0 ? '+' : '-'}${Math.abs(stats.totalPnl).toFixed(2)}
              </span>
              <span style={{ 
                marginLeft: 12, 
                fontSize: 16, 
                color: 'rgba(148, 163, 184, 0.7)'
              }}>
                {trades.length} trades · {stats.winRate.toFixed(0)}% win rate
              </span>
            </div>

            {/* Chart */}
            <div style={{ height: 220 }}>
              {chartData.length === 0 ? (
                <div style={{ 
                  height: '100%', 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'center',
                  color: '#94a3b8' 
                }}>
                  No trade data available
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData}>
                    <defs>
                      <linearGradient id="pnlGradientPositive" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#34d399" stopOpacity={0.4} />
                        <stop offset="95%" stopColor="#34d399" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="pnlGradientNegative" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#f87171" stopOpacity={0.4} />
                        <stop offset="95%" stopColor="#f87171" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(148, 163, 184, 0.1)" />
                    <XAxis 
                      dataKey="date" 
                      tick={{ fill: '#94a3b8', fontSize: 11 }} 
                      axisLine={{ stroke: 'rgba(148, 163, 184, 0.2)' }}
                    />
                    <YAxis 
                      tick={{ fill: '#94a3b8', fontSize: 11 }} 
                      axisLine={{ stroke: 'rgba(148, 163, 184, 0.2)' }}
                      tickFormatter={(v) => `$${v}`}
                      width={60}
                    />
                    <ReferenceLine y={0} stroke="rgba(148, 163, 184, 0.3)" strokeDasharray="3 3" />
                    <RechartsTooltip
                      content={({ label, payload }) => {
                        if (!payload || payload.length === 0) return null;
                        const value = payload[0]?.value as number;
                        return (
                          <div style={{
                            background: '#1e293b',
                            padding: '10px 14px',
                            borderRadius: 8,
                            border: '1px solid rgba(148, 163, 184, 0.2)',
                            color: '#f8fafc',
                          }}>
                            <div style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
                            <div style={{ color: value >= 0 ? '#34d399' : '#f87171' }}>
                              value : {value >= 0 ? '' : '-'}${Math.abs(value).toFixed(2)}
                            </div>
                          </div>
                        );
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="value"
                      stroke={stats.totalPnl >= 0 ? '#34d399' : '#f87171'}
                      strokeWidth={2}
                      fill={stats.totalPnl >= 0 ? 'url(#pnlGradientPositive)' : 'url(#pnlGradientNegative)'}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Bottom Stats */}
            <Row gutter={[24, 12]} style={{ marginTop: 20, borderTop: '1px solid rgba(148, 163, 184, 0.1)', paddingTop: 16 }}>
              <Col xs={6}>
                <Text style={{ color: 'rgba(148, 163, 184, 0.6)', fontSize: 11, display: 'block', marginBottom: 4 }}>Sample Size</Text>
                <Text style={{ color: '#f8fafc', fontSize: 18, fontWeight: 700 }}>{trades.length}</Text>
              </Col>
              <Col xs={6}>
                <Text style={{ color: 'rgba(148, 163, 184, 0.6)', fontSize: 11, display: 'block', marginBottom: 4 }}>Avg ROE</Text>
                <Text style={{ color: stats.avgRoe >= 0 ? '#34d399' : '#f87171', fontSize: 18, fontWeight: 700 }}>
                  {stats.avgRoe >= 0 ? '+' : ''}{stats.avgRoe.toFixed(1)}%
                </Text>
              </Col>
              <Col xs={6}>
                <Text style={{ color: 'rgba(148, 163, 184, 0.6)', fontSize: 11, display: 'block', marginBottom: 4 }}>Avg Leverage</Text>
                <Text style={{ color: '#f8fafc', fontSize: 18, fontWeight: 700 }}>{stats.avgLev.toFixed(2)}x</Text>
              </Col>
              <Col xs={6}>
                <Text style={{ color: 'rgba(148, 163, 184, 0.6)', fontSize: 11, display: 'block', marginBottom: 4 }}>Direction</Text>
                <Text style={{ color: '#f8fafc', fontSize: 18, fontWeight: 700 }}>{stats.longs}L / {stats.shorts}S</Text>
              </Col>
            </Row>
          </Card>
        </Col>

        {/* Recent Trades Cards */}
        <Col xs={24} lg={10}>
          <Card 
            style={cardStyle} 
            bodyStyle={{ padding: 16 }}
            title={
              <div>
                <Text style={{ color: '#f8fafc', fontSize: 15, fontWeight: 600, display: 'block' }}>Recent Trades</Text>
                <Text style={{ color: 'rgba(148, 163, 184, 0.6)', fontSize: 12 }}>Last {recentTrades.length} executions</Text>
              </div>
            }
            headStyle={{ background: 'transparent', borderBottom: '1px solid rgba(148, 163, 184, 0.1)' }}
          >
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              {recentTrades.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>
                  No recent trades
                </div>
              ) : (
                recentTrades.map((trade) => (
                  <div 
                    key={trade.id}
                    style={{
                      background: 'rgba(30, 41, 59, 0.5)',
                      borderRadius: 10,
                      padding: '12px 14px',
                      border: '1px solid rgba(148, 163, 184, 0.1)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <Text style={{ color: '#f8fafc', fontWeight: 600, fontSize: 14 }}>
                        {trade.symbol?.replace('/USDT', '').replace(':USDT', '')}
                      </Text>
                      <Space size={4}>
                        {(trade.realizedPnlUsd || 0) >= 0 ? (
                          <TrendingUp size={12} color="#34d399" />
                        ) : (
                          <TrendingDown size={12} color="#f87171" />
                        )}
                        <Text style={{ 
                          color: (trade.realizedPnlUsd || 0) >= 0 ? '#34d399' : '#f87171', 
                          fontWeight: 700,
                          fontSize: 14
                        }}>
                          {(trade.realizedPnlUsd || 0) >= 0 ? '+' : ''}${(trade.realizedPnlUsd || 0).toFixed(0)}
                        </Text>
                      </Space>
                    </div>
                    <Row gutter={16}>
                      <Col span={8}>
                        <Text style={{ color: 'rgba(148, 163, 184, 0.5)', fontSize: 10, display: 'block' }}>Entry</Text>
                        <Text style={{ color: '#f8fafc', fontSize: 12 }}>{(trade.entryPrice || 0).toFixed(4)}</Text>
                      </Col>
                      <Col span={8}>
                        <Text style={{ color: 'rgba(148, 163, 184, 0.5)', fontSize: 10, display: 'block' }}>Exit</Text>
                        <Text style={{ color: '#f8fafc', fontSize: 12 }}>{(trade.exitPrice || 0).toFixed(4)}</Text>
                      </Col>
                      <Col span={8} style={{ textAlign: 'right' }}>
                        <Text style={{ color: 'rgba(148, 163, 184, 0.5)', fontSize: 10, display: 'block' }}>&nbsp;</Text>
                        <Text style={{ color: 'rgba(148, 163, 184, 0.6)', fontSize: 11 }}>
                          {new Date(trade.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} {new Date(trade.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}
                        </Text>
                      </Col>
                    </Row>
                    <div style={{ marginTop: 8 }}>
                      <Text style={{ 
                        color: (trade.roePct || 0) >= 0 ? '#34d399' : '#f87171', 
                        fontSize: 12,
                        marginRight: 12
                      }}>
                        {(trade.roePct || 0) >= 0 ? '+' : ''}{(trade.roePct || 0).toFixed(1)}%
                      </Text>
                      <Text style={{ color: 'rgba(148, 163, 184, 0.6)', fontSize: 12 }}>
                        {(trade.estLev || 0).toFixed(0)}x
                      </Text>
                    </div>
                  </div>
                ))
              )}
            </Space>
          </Card>
        </Col>
      </Row>

      {/* Quick Actions Footer */}
      <div style={{ textAlign: 'center', marginTop: 20 }}>
        <Space size={12}>
          <Button 
            onClick={() => navigate('/agents')}
            style={{ 
              background: 'rgba(30, 41, 59, 0.8)', 
              borderColor: 'rgba(148, 163, 184, 0.2)',
              color: '#f8fafc'
            }}
          >
            All Sessions
          </Button>
          <Button 
            type="primary" 
            onClick={() => navigate('/agents')}
            style={{ background: '#3b82f6' }}
          >
            New Agent
          </Button>
          <Button 
            onClick={() => navigate('/feed')}
            style={{ 
              background: 'rgba(30, 41, 59, 0.8)', 
              borderColor: 'rgba(148, 163, 184, 0.2)',
              color: '#f8fafc'
            }}
          >
            Agent Feed
          </Button>
        </Space>
      </div>
    </div>
  );
}

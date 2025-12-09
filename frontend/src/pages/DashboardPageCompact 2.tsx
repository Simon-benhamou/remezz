import React from 'react';
import { Card, Row, Col, Statistic, Space, Button, Tag, List, Badge, Typography, Alert, Table, message, Tooltip } from 'antd';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useMode } from '../contexts/ModeContext';
import RecentTradesTable from '../components/RecentTradesTable';
import PerformanceOverviewCard from '../components/PerformanceOverviewCard';
import { 
  RobotOutlined, 
  DollarOutlined, 
  ThunderboltOutlined,
  WarningOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  PlusOutlined,
  EyeOutlined,
  FireOutlined,
  BulbOutlined,
  LineChartOutlined,
  ThunderboltFilled,
  ArrowUpOutlined,
  ArrowDownOutlined,
  MinusOutlined
} from '@ant-design/icons';

const { Title, Text } = Typography;

// Market Conditions types V5
type MarketConditionsStatus = 'favorable_long' | 'favorable_short' | 'neutral' | 'unfavorable' | 'unknown';

interface MarketConditions {
  status: MarketConditionsStatus;
  btcAboveMa50: boolean | null;  // Legacy - still returned by API but dashboard uses SMA200
  btcAboveSma200?: boolean | null;  // V5: Primary regime filter
  btcMomentum6h: number | null;
  btcTrend: 'bullish' | 'bearish' | 'neutral' | null;
  isTradingDay: boolean | null;
  reason: string;
  tradingRecommended: boolean;
  // V5.5: Market quality
  marketQuality?: 'momentum' | 'consolidation' | 'unknown' | 'analyzing';
  qualityReason?: string;
}

export default function DashboardPageCompact(){
  const [ov, setOv] = React.useState<any>({});
  const [loading, setLoading] = React.useState<boolean>(true);
  const [trades, setTrades] = React.useState<any[]>([]);
  const [tradesLoading, setTradesLoading] = React.useState<boolean>(false);
  const [optimizing, setOptimizing] = React.useState<boolean>(false);
  const [marketConditions, setMarketConditions] = React.useState<MarketConditions | null>(null);
  const navigate = useNavigate();
  const { mode } = useMode();
  
  async function loadTrades(){
    setTradesLoading(true);
    try {
      // Fetch all sessions to ensure we get trades from stopped sessions too
      // This matches the logic in ExecutionLedgerPage to ensure consistency
      const sessionsRes = await api.listSessions(mode);
      const sessions = Array.isArray(sessionsRes) ? sessionsRes : (sessionsRes?.sessions || []);
      
      // Fetch trades for each session in parallel
      const results = await Promise.all(
        sessions.map(async (session: any) => {
          try {
            // Fetch recent trades for this session
            const tradesRes = await api.getTrades(session.id, { limit: 20 });
            return Array.isArray(tradesRes) ? tradesRes : (tradesRes?.trades || []);
          } catch {
            return [];
          }
        })
      );
      
      // Flatten, filter, and sort
      const allTrades = results.flat();
      const validTrades = allTrades
        .filter((t: any) => 
          t.exitPrice != null && 
          t.entryPrice != null &&
          t.realizedPnlUsd != null
        )
        .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 100); // Keep top 100

      setTrades(validTrades);
    } catch(err){
      console.error('Failed to load trades:', err);
      setTrades([]);
    } finally {
      setTradesLoading(false);
    }
  }

  async function load(){
    setLoading(true);
    try {
      const [overviewRes, conditionsRes] = await Promise.all([
        api.overview(mode),
        api.getMarketConditions().catch(() => null),
      ]);
      setOv(overviewRes || {});
      setMarketConditions(conditionsRes);
    } catch(err){
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function runOptimizer(){
    setOptimizing(true);
    try {
      await api.optimizeAllSymbols();
      message.success('Optimizer launched for all symbols!');
    } catch(err: any){
      message.error(err?.response?.data?.error || 'Failed to run optimizer');
    } finally {
      setOptimizing(false);
    }
  }

  React.useEffect(() => {
    load();
    loadTrades();
    const iv = setInterval(() => {
      load();
      loadTrades();
    }, 30000); // Auto-refresh every 30s
    return () => clearInterval(iv);
  }, [mode]);

  const globalHealth = React.useMemo(() => {
    const alertCounts = ov?.alerts?.severityCounts || {};
    const highAlerts = alertCounts.high || 0;
    const medAlerts = alertCounts.med || 0;
    const activeCount = ov?.activeCount || 0;
    
    if (highAlerts > 0) return { status: 'critical', color: '#ff4d4f', icon: <ExclamationCircleOutlined /> };
    if (medAlerts > 2) return { status: 'warning', color: '#faad14', icon: <WarningOutlined /> };
    if (activeCount > 0) return { status: 'healthy', color: '#52c41a', icon: <CheckCircleOutlined /> };
    return { status: 'idle', color: '#d9d9d9', icon: <RobotOutlined /> };
  }, [ov]);

  return (
    <div style={{ padding: '20px', maxWidth: 1400, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <Title level={3} style={{ margin: 0 }}>
          Dashboard Overview
          <Tag color={mode === 'live' ? 'gold' : 'blue'} style={{ marginLeft: 12 }}>
            {mode.toUpperCase()}
          </Tag>
        </Title>
 
      </div>

      {/* KPIs Row - Compact */}
      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={6}>
          <Card size="small" style={{ borderLeft: '3px solid #52c41a' }} hoverable onClick={() => navigate('/sessions')}>
            <Statistic
              title={<Text type="secondary" style={{ fontSize: 11 }}><RobotOutlined /> Active Agents</Text>}
              value={ov?.activeCount || 0}
              suffix={<Text type="secondary" style={{ fontSize: 11 }}>active</Text>}
              valueStyle={{ fontSize: 22, color: '#52c41a' }}
            />
          </Card>
        </Col>
        
        <Col xs={12} sm={6}>
          <Card size="small" style={{ borderLeft: `3px solid ${(ov?.pnlUsd || 0) >= 0 ? '#52c41a' : '#ff4d4f'}` }} hoverable>
            <Statistic
              title={<Text type="secondary" style={{ fontSize: 11 }}><DollarOutlined /> PnL</Text>}
              value={Number(ov?.pnlUsd || 0)}
              precision={2}
              prefix="$"
              valueStyle={{ fontSize: 22, color: (ov?.pnlUsd || 0) >= 0 ? '#52c41a' : '#ff4d4f' }}
            />
          </Card>
        </Col>
        
        <Col xs={12} sm={6}>
          <Card size="small" style={{ borderLeft: '3px solid #1890ff' }} hoverable>
            <Statistic
              title={<Text type="secondary" style={{ fontSize: 11 }}><ThunderboltOutlined /> Win Rate</Text>}
              value={Number(ov?.avgWinRate || 0)}
              precision={1}
              suffix="%"
              valueStyle={{ fontSize: 22, color: (ov?.avgWinRate || 0) >= 60 ? '#52c41a' : (ov?.avgWinRate || 0) >= 50 ? '#faad14' : '#ff4d4f' }}
            />
          </Card>
        </Col>
        
        <Col xs={12} sm={6}>
          <Card size="small" style={{ borderLeft: '3px solid #722ed1' }} hoverable>
            <Statistic
              title={<Text type="secondary" style={{ fontSize: 11 }}><BulbOutlined /> Total Trades</Text>}
              value={Number(ov?.totalTrades || 0)}
              valueStyle={{ fontSize: 22, color: '#722ed1' }}
              suffix={<span style={{ fontSize: 12, color: '#888' }}>{ov?.totalWins || 0} W</span>}
            />
          </Card>
        </Col>
      </Row>

      {/* Market Conditions Banner */}
      {marketConditions && (
        <Card 
          size="small" 
          style={{ 
            marginBottom: 16,
            background: marketConditions.tradingRecommended 
              ? 'linear-gradient(135deg, rgba(34, 197, 94, 0.15), rgba(34, 197, 94, 0.05))'
              : marketConditions.status === 'unfavorable'
              ? 'linear-gradient(135deg, rgba(239, 68, 68, 0.15), rgba(239, 68, 68, 0.05))'
              : 'linear-gradient(135deg, rgba(59, 130, 246, 0.15), rgba(59, 130, 246, 0.05))',
            border: marketConditions.tradingRecommended 
              ? '1px solid rgba(34, 197, 94, 0.3)'
              : marketConditions.status === 'unfavorable'
              ? '1px solid rgba(239, 68, 68, 0.3)'
              : '1px solid rgba(59, 130, 246, 0.3)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
            <Space size={16}>
              <div>
                <Text type="secondary" style={{ fontSize: 11 }}>MARKET CONDITIONS</Text>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                  {marketConditions.status === 'favorable_long' && (
                    <>
                      <ArrowUpOutlined style={{ color: '#22c55e', fontSize: 20 }} />
                      <Text strong style={{ fontSize: 16, color: '#22c55e' }}>FAVORABLE LONG</Text>
                    </>
                  )}
                  {marketConditions.status === 'favorable_short' && (
                    <>
                      <ArrowDownOutlined style={{ color: '#ef4444', fontSize: 20 }} />
                      <Text strong style={{ fontSize: 16, color: '#ef4444' }}>FAVORABLE SHORT</Text>
                    </>
                  )}
                  {marketConditions.status === 'neutral' && (
                    <>
                      <MinusOutlined style={{ color: '#3b82f6', fontSize: 20 }} />
                      <Text strong style={{ fontSize: 16, color: '#3b82f6' }}>NEUTRAL</Text>
                    </>
                  )}
                  {marketConditions.status === 'unfavorable' && (
                    <>
                      <WarningOutlined style={{ color: '#ef4444', fontSize: 20 }} />
                      <Text strong style={{ fontSize: 16, color: '#ef4444' }}>UNFAVORABLE</Text>
                    </>
                  )}
                  {marketConditions.status === 'unknown' && (
                    <>
                      <ExclamationCircleOutlined style={{ color: '#94a3b8', fontSize: 20 }} />
                      <Text strong style={{ fontSize: 16, color: '#94a3b8' }}>UNKNOWN</Text>
                    </>
                  )}
                </div>
              </div>
              
              <div style={{ borderLeft: '1px solid rgba(148, 163, 184, 0.2)', paddingLeft: 16 }}>
                <Text type="secondary" style={{ fontSize: 11 }}>BTC 6H MOMENTUM</Text>
                <div style={{ 
                  color: (marketConditions.btcMomentum6h || 0) > 0 ? '#22c55e' : (marketConditions.btcMomentum6h || 0) < 0 ? '#ef4444' : '#94a3b8',
                  fontSize: 16,
                  fontWeight: 600,
                  marginTop: 4
                }}>
                  {(marketConditions.btcMomentum6h || 0) > 0 ? '+' : ''}{(marketConditions.btcMomentum6h || 0).toFixed(2)}%
                </div>
              </div>
              
              <div style={{ borderLeft: '1px solid rgba(148, 163, 184, 0.2)', paddingLeft: 16 }}>
                <Text type="secondary" style={{ fontSize: 11 }}>BTC vs SMA200 (V5)</Text>
                <div style={{ 
                  color: marketConditions.btcAboveMa50 ? '#22c55e' : '#ef4444',
                  fontSize: 16,
                  fontWeight: 600,
                  marginTop: 4
                }}>
                  {marketConditions.btcAboveMa50 ? '🐂 BULL' : '🐻 BEAR'}
                </div>
              </div>
              
              {/* V5.5: Market Quality indicator */}
              <div style={{ borderLeft: '1px solid rgba(148, 163, 184, 0.2)', paddingLeft: 16 }}>
                <Text type="secondary" style={{ fontSize: 11 }}>MARKET QUALITY</Text>
                <Tooltip title={marketConditions.qualityReason || 'Analyzing...'}>
                  <div style={{ 
                    color: marketConditions.marketQuality === 'momentum' ? '#22c55e' 
                         : marketConditions.marketQuality === 'consolidation' ? '#f59e0b' 
                         : '#94a3b8',
                    fontSize: 16,
                    fontWeight: 600,
                    marginTop: 4,
                    cursor: 'help'
                  }}>
                    {marketConditions.marketQuality === 'momentum' && '🚀 MOMENTUM'}
                    {marketConditions.marketQuality === 'consolidation' && '😴 RANGE'}
                    {(!marketConditions.marketQuality || marketConditions.marketQuality === 'unknown' || marketConditions.marketQuality === 'analyzing') && '⏳ ANALYZING'}
                  </div>
                </Tooltip>
              </div>
            </Space>
            
            <Tooltip 
              title={
                <div style={{ maxWidth: 400 }}>
                  <div style={{ fontWeight: 'bold', marginBottom: 8 }}>📋 Stratégie V5.4 - LONG + SHORT</div>
                  
                  <div style={{ marginBottom: 8 }}>
                    {marketConditions.btcAboveMa50 
                      ? '🐂 BTC > SMA200 (BULL) → LONG activé'
                      : '🐻 BTC < SMA200 (BEAR) → SHORT activé'}
                  </div>
                  
                  <div style={{ borderTop: '1px solid rgba(255,255,255,0.2)', paddingTop: 8, fontSize: 11 }}>
                    <div style={{ marginBottom: 4 }}><strong>📈 LONG (Bull):</strong></div>
                    <div>BB breakout + ROC10&gt;2.5% + Vol&gt;2x</div>
                    
                    <div style={{ marginTop: 8, marginBottom: 4 }}><strong>📉 SHORT (Bear):</strong></div>
                    <div>BB breakdown + ROC5&lt;-1.5% + Vol&gt;2x</div>
                    
                    <div style={{ marginTop: 8 }}><strong>Exit:</strong> SL 1.5% / TP 3% / Trail +1.0%</div>
                  </div>
                  
                  <div style={{ marginTop: 8, fontSize: 10, opacity: 0.7 }}>
                    Backtest 12 mois: +2022% ROI, 67.8% WR, 9/12 mois positifs
                  </div>
                  
                  {marketConditions.reason && (
                    <div style={{ marginTop: 8, fontStyle: 'italic', opacity: 0.8 }}>
                      {marketConditions.reason}
                    </div>
                  )}
                </div>
              }
            >
              <Tag 
                color={marketConditions.tradingRecommended ? 'success' : marketConditions.status === 'unfavorable' ? 'error' : 'default'}
                style={{ fontSize: 12, padding: '4px 12px', cursor: 'help' }}
              >
                {marketConditions.tradingRecommended ? '✅ TRADING RECOMMENDED' : '⏳ WAIT FOR SIGNAL'}
              </Tag>
            </Tooltip>
          </div>
        </Card>
      )}
      
 =
      
      <Row gutter={[12, 12]}>
        <Col xs={24}>
          <Card 
            size="small"
            title={<Space><FireOutlined style={{ color: '#ff4d4f' }} /> Active Agents ({ov?.activeCount || 0})</Space>}
            style={{ height: '100%', width: '100%' }}
          >
            {(ov?.sessions || []).length === 0 ? (
              <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>
                <RobotOutlined style={{ fontSize: 48, marginBottom: 16 }} />
                <div>No active agents</div>
                <Button type="primary" style={{ marginTop: 16 }} onClick={() => navigate('/agents')}>
                  Create Agent
                </Button>
              </div>
            ) : (
              <div style={{ maxHeight: 400, overflowY: 'auto' , overflowX: 'hidden' }}>
                <Row gutter={[12, 12]}>
                  {(ov?.sessions || []).map((session: any) => (
                    <Col xs={24} sm={12} key={session.id}>
                      <div 
                        style={{ 
                          padding: 12,
                          borderLeft: `3px solid ${session.bias === 'long' ? '#52c41a' : session.bias === 'short' ? '#ff4d4f' : '#d9d9d9'}`,
                          backgroundColor: 'rgba(255, 255, 255, 0.04)',
                          borderRadius: 4,
                          cursor: 'pointer',
                          transition: 'background 0.2s',
                          border: '1px solid rgba(255, 255, 255, 0.08)'
                        }}
                        onClick={() => navigate(`/agents/${session.id}`)}
                        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.08)'}
                        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.04)'}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                          <Text strong>{session.symbol}</Text>
                          <Tag color={session.state === 'IN_POSITION' ? 'blue' : session.state === 'WATCHING' ? 'green' : 'default'}>
                            {session.state === 'IN_POSITION' ? '📊 IN POSITION' : session.state === 'WATCHING' ? '👀 WATCHING' : session.state || 'STOPPED'}
                          </Tag>
                        </div>
                        <Space style={{ width: '100%', justifyContent: 'space-between', fontSize: 12 }}>
                          <Text type="secondary">PnL</Text>
                          <Text style={{ color: (session.pnlUsd || 0) >= 0 ? '#52c41a' : '#ff4d4f', fontWeight: 'bold' }}>
                            ${(session.pnlUsd || 0).toFixed(2)} ({(session.winRate || 0).toFixed(0)}%)
                          </Text>
                        </Space>
                      </div>
                    </Col>
                  ))}
                </Row>
              </div>
            )}
          </Card>
        </Col>
      </Row>
      {/* Performance Chart & Recent Trades */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} lg={12}>
          <PerformanceOverviewCard
            trades={trades}
            loading={tradesLoading}
            title="Performance Overview"
            subtitle="Cumulative PnL across all sessions"
            tagLabel={mode.toUpperCase()}
          />
        </Col>
        <Col xs={24} lg={12}>
     
          <RecentTradesTable
            trades={trades}
            loading={tradesLoading}
            onRefresh={loadTrades}
          />
        </Col>
      </Row>

    

      {/* Quick Actions Footer */}
      <Card size="small" style={{ marginTop: 16, textAlign: 'center' }}>
        <Space>
          <Button onClick={() => navigate('/agents')}>
            <EyeOutlined /> All Sessions
          </Button>
          <Button type="primary" onClick={() => navigate('/agents')}>
            <PlusOutlined /> New Agent
          </Button>
          <Button onClick={() => navigate('/feed')}>
            <BulbOutlined /> Agent Feed
          </Button>
        </Space>
      </Card>
    </div>
  );
}

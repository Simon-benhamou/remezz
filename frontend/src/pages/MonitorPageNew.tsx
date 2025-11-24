import { useParams, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { Layout, Card, Spin, Alert, Button, Space, Tag, Row, Col, Statistic, message } from 'antd';
import {
  ArrowLeftOutlined,
  ReloadOutlined,
  DollarOutlined,
  RiseOutlined,
  FallOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons';
import { api } from '../api';
import PriceChart from '../charts/PriceChart';
// Activity Feed component (optional)
import ProfessionalChart from '../components/charts/ProfessionalChart';
import { AgentStateCard } from '../components/monitor/AgentStateCard';
import { StrategyCard } from '../components/monitor/StrategyCard';
import { PredictorCard } from '../components/monitor/PredictorCard';
import { PredictorDecisionsPanel } from '../components/monitor/PredictorDecisionsPanel';
import { OrdersTradesPanel } from '../components/monitor/OrdersTradesPanel';
import { formatPriceDisplay } from '../utils/number';
import LearningProgressPanel from '../components/LearningProgressPanel';
import SubagentStatusCards from '../components/SubagentStatusCards';
import MarketHealthDashboard from '../components/MarketHealthDashboard';
import AdaptiveLearningCard from '../components/AdaptiveLearningCard';

const { Content } = Layout;

export function MonitorPageNew() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchData = async () => {
    if (!sessionId) return;
    
    try {
      const result = await api.getDiagnostics(sessionId);
      setData(result);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to load agent data');
      console.error('Error fetching diagnostics:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    
    if (!autoRefresh) return;
    
    const interval = setInterval(fetchData, 5000); // Refresh every 5s
    return () => clearInterval(interval);
  }, [sessionId, autoRefresh]);

  const handleRefresh = () => {
    setLoading(true);
    fetchData();
  };

  const handleExitOrder = async (orderId: string) => {
    // Implementation depends on your API
    message.info('Exit order functionality - implement with your API');
  };

  const handleCancelOrder = async (orderId: string) => {
    try {
      // TODO: Implement cancel order API
      message.info('Cancel order - API not implemented yet');
      fetchData();
    } catch (err: any) {
      throw new Error(err.message || 'Failed to cancel order');
    }
  };

  const handleStopSession = async () => {
    try {
      await api.stopSession(sessionId!);
      message.success('Agent stopped successfully');
      setTimeout(() => navigate('/'), 1500);
    } catch (err: any) {
      throw new Error(err.message || 'Failed to stop agent');
    }
  };

  const handleDeleteSession = async () => {
    // Implementation depends on your API
    message.info('Delete functionality - implement with your API');
  };

  if (loading && !data) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '400px' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert
        message="Error"
        description={error}
        type="error"
        showIcon
        action={
          <Button size="small" danger onClick={handleRefresh}>
            Retry
          </Button>
        }
      />
    );
  }

  if (!data) {
    return (
      <Alert message="No data available" type="warning" showIcon />
    );
  }

  const symbol = data.symbol || 'N/A';
  const market = data.market || {};
  const position = data.position;

  return (
    <Layout style={{ background: '#f0f2f5', minHeight: '100vh' }}>
      <Content style={{ padding: '16px' }}>
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          {/* Header */}
          <Card size="small">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Space>
                <Button
                  icon={<ArrowLeftOutlined />}
                  onClick={() => navigate('/')}
                >
                  Back
                </Button>
                <Tag color="blue" style={{ fontSize: '14px', padding: '4px 12px' }}>
                  {symbol}
                </Tag>
                {data.sessionId && (
                  <span style={{ fontSize: '12px', color: '#8c8c8c', fontFamily: 'monospace' }}>
                    {data.sessionId.slice(0, 8)}
                  </span>
                )}
              </Space>
              <Space>
                <Button
                  icon={<ReloadOutlined spin={loading} />}
                  onClick={handleRefresh}
                  disabled={loading}
                >
                  Refresh
                </Button>
                <Tag
                  color={autoRefresh ? 'green' : 'default'}
                  style={{ cursor: 'pointer' }}
                  onClick={() => setAutoRefresh(!autoRefresh)}
                >
                  <ClockCircleOutlined /> {autoRefresh ? 'Auto' : 'Manual'}
                </Tag>
              </Space>
            </div>
          </Card>

          {/* Market Snapshot - Slim Bar */}
          <Card size="small" bodyStyle={{ padding: '12px 16px' }}>
            <Row gutter={16} align="middle">
              <Col span={5}>
                <Statistic
                  title="Price"
                  value={formatPriceDisplay(market.last) || 'N/A'}
                  prefix={<DollarOutlined />}
                  valueStyle={{ fontSize: '18px' }}
                />
              </Col>
              <Col span={5}>
                <Statistic
                  title="24h Change"
                  value={`${market.change24h?.toFixed(2) || '0'}%`}
                  prefix={market.change24h >= 0 ? <RiseOutlined /> : <FallOutlined />}
                  valueStyle={{
                    fontSize: '16px',
                    color: market.change24h >= 0 ? '#52c41a' : '#f5222d',
                  }}
                />
              </Col>
              <Col span={5}>
                <Statistic
                  title="Market Bias"
                  value={data.symbolProfile?.directionBias || 'neutral'}
                  valueStyle={{ 
                    fontSize: '14px',
                    textTransform: 'uppercase',
                    color: data.symbolProfile?.directionBias === 'bullish' ? '#52c41a' : 
                           data.symbolProfile?.directionBias === 'bearish' ? '#f5222d' : '#8c8c8c'
                  }}
                />
              </Col>
              <Col span={5}>
                <Statistic
                  title="24h Volume"
                  value={market.volume24h ? `$${(market.volume24h / 1e6).toFixed(2)}M` : 'N/A'}
                  valueStyle={{ fontSize: '14px' }}
                />
              </Col>
              <Col span={4}>
                <Statistic
                  title="Vol Ratio"
                  value={market.volumeRatio?.toFixed(2) || 'N/A'}
                  valueStyle={{ fontSize: '14px' }}
                />
              </Col>
            </Row>
          </Card>

          {/* Professional Trading Chart - Full Width */}
          <Card size="small" style={{ minHeight: '700px', padding: 0 }}>
            <ProfessionalChart
              symbol={symbol}
              sessionId={sessionId!}
              orders={data.orders}
              fills={data.fills}
              position={data.position}
              technicalLevels={data.technicalLevels}
              strategy={data.strategy}
            />
          </Card>

          {/* Agent Info Grid */}
          <Row gutter={[16, 16]}>
            <Col xs={24} lg={12}>
              <AgentStateCard data={data} />
            </Col>
            <Col xs={24} lg={12}>
              <StrategyCard data={data.strategy} />
            </Col>
          </Row>

          {/* Learning Progress - NEW */}
          <LearningProgressPanel sessionId={sessionId!} />

          {/* Subagent Status Cards - NEW */}
          <Card title="Subagent Status" size="small">
            <SubagentStatusCards sessionId={sessionId!} />
          </Card>

          {/* Market Health & Transparency Dashboard */}
          <Card title="🔍 Market Transparency & Decision Analysis" size="small">
            <MarketHealthDashboard symbol={symbol} />
          </Card>

          {/* Adaptive Learning Performance */}
          <AdaptiveLearningCard symbol={symbol} lookbackDays={7} />

          {/* Predictor Analysis */}
          <PredictorCard
            data={data.predictor}
            symbolProfile={data.symbolProfile}
          />

          {/* Predictor Decision History */}
          <PredictorDecisionsPanel symbol={symbol} />

          {/* Orders & Trades */}
          <OrdersTradesPanel
            orders={data.orders || []}
            fills={data.fills || []}
            sessionId={sessionId!}
            onExitOrder={handleExitOrder}
            onCancelOrder={handleCancelOrder}
            onStopSession={handleStopSession}
            onDeleteSession={handleDeleteSession}
          />

          {/* Activity Feed - Optional */}
          {/* <Card title="Activity Feed" size="small">
            <ActivityFeed sessionId={sessionId!} />
          </Card> */}
        </Space>
      </Content>
    </Layout>
  );
}

export default MonitorPageNew;

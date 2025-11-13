import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { 
  Row, Col, Card, Space, Button, Dropdown, Tag, Typography, Alert, Skeleton, message, Tabs 
} from 'antd';
import { 
  ReloadOutlined, MoreOutlined, StopOutlined, DeleteOutlined, 
  LogoutOutlined, BarChartOutlined, InfoCircleOutlined 
} from '@ant-design/icons';
import PriceChart from '../charts/PriceChart';
import { api } from '../api';
import { openWS, wsSend } from '../ws';

const { Title, Text } = Typography;

type AgentDiagnostics = {
  sessionId: string;
  symbol: string;
  symbolProfile?: {
    volatilityRegime: string;
    directionBias: string;
    volumeRegime: string;
    trendingRanging: string;
    atrPct: number;
    adx: number;
    rsi: number;
    trendStrength: number;
  };
  predictor?: {
    available: boolean;
    decision: string;
    bias: string;
    confidence: number;
    probabilities: {
      long: number;
      short: number;
      none: number;
    };
    edge: number;
    source: string;
  };
  strategy?: {
    id: string;
    label: string;
    bias: string;
    confidence: number;
    score: number;
  };
  position: any;
  market: {
    last: number;
    change24h: number;
    volume24h: number;
  };
  timestamp: number;
};

export default function MonitorPageRefactored() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  
  const [loading, setLoading] = React.useState(true);
  const [diagnostics, setDiagnostics] = React.useState<AgentDiagnostics | null>(null);
  const [orders, setOrders] = React.useState<any[]>([]);
  const [trades, setTrades] = React.useState<any[]>([]);
  const [activityFeed, setActivityFeed] = React.useState<any[]>([]);
  const [wsConnected, setWsConnected] = React.useState(false);
  const wsRef = React.useRef<any>(null);

  // Fetch diagnostics
  const fetchDiagnostics = React.useCallback(async () => {
    if (!sessionId) return;
    try {
      const data = await api.getDiagnostics(sessionId);
      setDiagnostics(data);
    } catch (error) {
      console.error('Failed to fetch diagnostics:', error);
      message.error('Failed to load agent diagnostics');
    }
  }, [sessionId]);

  // Fetch orders
  const fetchOrders = React.useCallback(async () => {
    if (!sessionId) return;
    try {
      const data = await api.getOrders(sessionId);
      setOrders(data || []);
    } catch (error) {
      console.error('Failed to fetch orders:', error);
    }
  }, [sessionId]);

  // Fetch trades
  const fetchTrades = React.useCallback(async () => {
    if (!sessionId) return;
    try {
      const data = await api.getTrades(sessionId);
      setTrades(data || []);
    } catch (error) {
      console.error('Failed to fetch trades:', error);
    }
  }, [sessionId]);

  // Initial load
  React.useEffect(() => {
    const load = async () => {
      setLoading(true);
      await Promise.all([
        fetchDiagnostics(),
        fetchOrders(),
        fetchTrades()
      ]);
      setLoading(false);
    };
    load();
  }, [fetchDiagnostics, fetchOrders, fetchTrades]);

  // Setup WebSocket
  React.useEffect(() => {
    if (!sessionId) return;
    
    const ws = openWS({
      onOpen: () => {
        setWsConnected(true);
        wsSend(ws, { type: 'subscribe', sessionId });
      },
      onClose: () => setWsConnected(false),
      onMessage: (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          
          // Handle real-time updates
          if (msg.type === 'tick' && msg.sessionId === sessionId) {
            setDiagnostics(prev => prev ? { ...prev, market: msg.data } : null);
          }
          if (msg.type === 'order' && msg.sessionId === sessionId) {
            fetchOrders();
          }
          if (msg.type === 'trade' && msg.sessionId === sessionId) {
            fetchTrades();
          }
          if (msg.type === 'strategy' && msg.sessionId === sessionId) {
            setDiagnostics(prev => prev ? { ...prev, strategy: msg.data } : null);
          }
          
          // Activity feed
          if (msg.sessionId === sessionId) {
            setActivityFeed(prev => [
              { type: msg.type, data: msg.data, timestamp: Date.now() },
              ...prev.slice(0, 49) // Keep last 50
            ]);
          }
        } catch (e) {
          console.error('WS message error:', e);
        }
      }
    });
    
    wsRef.current = ws;
    return () => ws?.close();
  }, [sessionId, fetchOrders, fetchTrades]);

  // Refresh all data
  const handleRefresh = () => {
    fetchDiagnostics();
    fetchOrders();
    fetchTrades();
  };

  // Action handlers
  const handleExitOrder = async (orderId: string) => {
    try {
      await api.cancelOrder(sessionId!, orderId);
      message.success('Order cancelled');
      fetchOrders();
    } catch (error) {
      message.error('Failed to cancel order');
    }
  };

  const handleStopAgent = async () => {
    try {
      await api.stopSession(sessionId!);
      message.success('Agent stopped');
      navigate('/');
    } catch (error) {
      message.error('Failed to stop agent');
    }
  };

  const handleDeleteAgent = async () => {
    try {
      await api.deleteSession(sessionId!);
      message.success('Agent deleted');
      navigate('/');
    } catch (error) {
      message.error('Failed to delete agent');
    }
  };

  const agentActions = [
    { key: 'stop', label: 'Stop Agent', icon: <StopOutlined />, onClick: handleStopAgent, danger: true },
    { key: 'delete', label: 'Delete Agent', icon: <DeleteOutlined />, onClick: handleDeleteAgent, danger: true },
  ];

  if (!sessionId) {
    return <Alert message="No session ID provided" type="error" />;
  }

  if (loading) {
    return (
      <div style={{ padding: 24 }}>
        <Skeleton active />
      </div>
    );
  }

  if (!diagnostics) {
    return <Alert message="Failed to load agent data" type="error" />;
  }

  return (
    <div style={{ padding: '16px 24px', height: '100vh', overflow: 'auto' }}>
      {/* Header with actions */}
      <Row justify="space-between" align="middle" style={{ marginBottom: 16 }}>
        <Col>
          <Space>
            <Title level={4} style={{ margin: 0 }}>
              {diagnostics.symbol}
            </Title>
            <Tag color={wsConnected ? 'green' : 'red'}>
              {wsConnected ? 'Live' : 'Disconnected'}
            </Tag>
          </Space>
        </Col>
        <Col>
          <Space>
            <Button icon={<ReloadOutlined />} onClick={handleRefresh}>
              Refresh
            </Button>
            <Dropdown menu={{ items: agentActions }} trigger={['click']}>
              <Button icon={<MoreOutlined />}>Actions</Button>
            </Dropdown>
          </Space>
        </Col>
      </Row>

      {/* Chart (full width, priority #1) */}
      <Row style={{ marginBottom: 8 }}>
        <Col span={24}>
          <Card 
            bodyStyle={{ padding: 12 }}
            style={{ height: 400 }}
          >
            <PriceChart 
              symbol={diagnostics.symbol}
              height={376}
            />
          </Card>
        </Col>
      </Row>

      {/* Market Snapshot (compact bar) */}
      <Row style={{ marginBottom: 16 }}>
        <Col span={24}>
          <Card size="small" bodyStyle={{ padding: '8px 16px' }}>
            <Space split={<span style={{ color: '#d9d9d9' }}>|</span>}>
              <Text>
                <Text type="secondary">Price:</Text> ${diagnostics.market.last?.toFixed(4)}
              </Text>
              <Text>
                <Text type="secondary">24h:</Text>{' '}
                <Text type={diagnostics.market.change24h >= 0 ? 'success' : 'danger'}>
                  {diagnostics.market.change24h >= 0 ? '+' : ''}
                  {diagnostics.market.change24h?.toFixed(2)}%
                </Text>
              </Text>
              <Text>
                <Text type="secondary">Volume:</Text> $
                {(diagnostics.market.volume24h / 1e6)?.toFixed(2)}M
              </Text>
              <Text>
                <Text type="secondary">ATR:</Text> {(diagnostics.symbolProfile?.atrPct ?? 0).toFixed(2)}%
              </Text>
              <Text>
                <Text type="secondary">RSI:</Text> {diagnostics.symbolProfile?.rsi?.toFixed(1)}
              </Text>
              <Text>
                <Text type="secondary">ADX:</Text> {diagnostics.symbolProfile?.adx?.toFixed(1)}
              </Text>
            </Space>
          </Card>
        </Col>
      </Row>

      {/* Main content: 3 columns */}
      <Row gutter={[16, 16]}>
        {/* Left: Agent State + Strategy */}
        <Col xs={24} lg={8}>
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            {/* Agent State */}
            <Card 
              title="Agent State" 
              size="small"
              extra={<InfoCircleOutlined />}
            >
              <Space direction="vertical" style={{ width: '100%' }}>
                <div>
                  <Text type="secondary">Session ID:</Text>
                  <br />
                  <Text copyable style={{ fontSize: 12 }}>
                    {diagnostics.sessionId}
                  </Text>
                </div>
                <div>
                  <Text type="secondary">Direction Bias:</Text>
                  <br />
                  <Tag color={
                    diagnostics.symbolProfile?.directionBias === 'long' ? 'green' : 
                    diagnostics.symbolProfile?.directionBias === 'short' ? 'red' : 
                    'default'
                  }>
                    {diagnostics.symbolProfile?.directionBias?.toUpperCase() || 'NONE'}
                  </Tag>
                </div>
                <div>
                  <Text type="secondary">Volatility:</Text>
                  <br />
                  <Tag>{diagnostics.symbolProfile?.volatilityRegime}</Tag>
                </div>
                <div>
                  <Text type="secondary">Trend:</Text>
                  <br />
                  <Tag>{diagnostics.symbolProfile?.trendingRanging}</Tag>
                </div>
                <div>
                  <Text type="secondary">Volume:</Text>
                  <br />
                  <Tag>{diagnostics.symbolProfile?.volumeRegime}</Tag>
                </div>
              </Space>
            </Card>

            {/* Strategy */}
            {diagnostics.strategy && (
              <Card 
                title="Active Strategy" 
                size="small"
                extra={<BarChartOutlined />}
              >
                <Space direction="vertical" style={{ width: '100%' }}>
                  <div>
                    <Text strong>{diagnostics.strategy.label}</Text>
                    <br />
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {diagnostics.strategy.id}
                    </Text>
                  </div>
                  <div>
                    <Text type="secondary">Bias:</Text>{' '}
                    <Tag color={
                      diagnostics.strategy.bias === 'long' ? 'green' :
                      diagnostics.strategy.bias === 'short' ? 'red' :
                      'default'
                    }>
                      {diagnostics.strategy.bias?.toUpperCase()}
                    </Tag>
                  </div>
                  <div>
                    <Text type="secondary">Confidence:</Text>{' '}
                    <Text strong>{(diagnostics.strategy.confidence * 100).toFixed(1)}%</Text>
                  </div>
                  <div>
                    <Text type="secondary">Score:</Text>{' '}
                    <Text>{diagnostics.strategy.score?.toFixed(3)}</Text>
                  </div>
                </Space>
              </Card>
            )}
          </Space>
        </Col>

        {/* Middle: Predictor Analysis */}
        <Col xs={24} lg={8}>
          <Card 
            title="Predictor Analysis" 
            size="small"
            extra={
              diagnostics.predictor?.available ? (
                <Tag color="green">Active</Tag>
              ) : (
                <Tag color="red">Unavailable</Tag>
              )
            }
          >
            {diagnostics.predictor?.available ? (
              <Space direction="vertical" style={{ width: '100%' }}>
                <div>
                  <Text type="secondary">Decision:</Text>
                  <br />
                  <Tag 
                    color={
                      diagnostics.predictor.decision === 'long' ? 'green' :
                      diagnostics.predictor.decision === 'short' ? 'red' :
                      'default'
                    }
                    style={{ fontSize: 16, padding: '4px 12px' }}
                  >
                    {diagnostics.predictor.decision?.toUpperCase()}
                  </Tag>
                </div>
                <div>
                  <Text type="secondary">Confidence:</Text>
                  <br />
                  <Text strong style={{ fontSize: 18 }}>
                    {(diagnostics.predictor.confidence * 100).toFixed(1)}%
                  </Text>
                </div>
                <div style={{ marginTop: 12 }}>
                  <Text type="secondary">Probabilities:</Text>
                  <div style={{ marginTop: 8 }}>
                    <Space direction="vertical" style={{ width: '100%' }}>
                      <div>
                        <Text>Long: </Text>
                        <Text strong style={{ color: '#52c41a' }}>
                          {(diagnostics.predictor.probabilities.long * 100).toFixed(1)}%
                        </Text>
                      </div>
                      <div>
                        <Text>Short: </Text>
                        <Text strong style={{ color: '#ff4d4f' }}>
                          {(diagnostics.predictor.probabilities.short * 100).toFixed(1)}%
                        </Text>
                      </div>
                      <div>
                        <Text>None: </Text>
                        <Text strong>
                          {(diagnostics.predictor.probabilities.none * 100).toFixed(1)}%
                        </Text>
                      </div>
                    </Space>
                  </div>
                </div>
                <div style={{ marginTop: 12 }}>
                  <Text type="secondary">Edge:</Text>{' '}
                  <Text strong>{(diagnostics.predictor.edge * 100).toFixed(1)}%</Text>
                </div>
                <div>
                  <Text type="secondary">Source:</Text>{' '}
                  <Tag>{diagnostics.predictor.source}</Tag>
                </div>
              </Space>
            ) : (
              <Text type="secondary">Predictor not available</Text>
            )}
          </Card>
        </Col>

        {/* Right: Orders & Trades */}
        <Col xs={24} lg={8}>
          <Card 
            title="Orders & Trades" 
            size="small"
            bodyStyle={{ padding: 0 }}
          >
            <Tabs
              defaultActiveKey="orders"
              items={[
                {
                  key: 'orders',
                  label: `Orders (${orders.length})`,
                  children: (
                    <div style={{ maxHeight: 400, overflow: 'auto', padding: 16 }}>
                      {orders.length === 0 ? (
                        <Text type="secondary">No orders</Text>
                      ) : (
                        <Space direction="vertical" style={{ width: '100%' }} size="small">
                          {orders.map((order: any) => (
                            <Card 
                              key={order.id} 
                              size="small"
                              extra={
                                order.status === 'open' && (
                                  <Button 
                                    size="small" 
                                    danger
                                    icon={<LogoutOutlined />}
                                    onClick={() => handleExitOrder(order.id)}
                                  >
                                    Exit
                                  </Button>
                                )
                              }
                            >
                              <Space direction="vertical" style={{ width: '100%' }} size={2}>
                                <div>
                                  <Tag color={order.side === 'buy' ? 'green' : 'red'}>
                                    {order.side?.toUpperCase()}
                                  </Tag>
                                  <Tag>{order.type}</Tag>
                                  <Tag color={
                                    order.status === 'open' ? 'blue' :
                                    order.status === 'filled' ? 'green' :
                                    order.status === 'cancelled' ? 'default' :
                                    'red'
                                  }>
                                    {order.status}
                                  </Tag>
                                </div>
                                <Text style={{ fontSize: 12 }}>
                                  {order.qty} @ ${order.price?.toFixed(4)}
                                </Text>
                                <Text type="secondary" style={{ fontSize: 11 }}>
                                  {new Date(order.createdAt).toLocaleString()}
                                </Text>
                              </Space>
                            </Card>
                          ))}
                        </Space>
                      )}
                    </div>
                  )
                },
                {
                  key: 'trades',
                  label: `Trades (${trades.length})`,
                  children: (
                    <div style={{ maxHeight: 400, overflow: 'auto', padding: 16 }}>
                      {trades.length === 0 ? (
                        <Text type="secondary">No trades</Text>
                      ) : (
                        <Space direction="vertical" style={{ width: '100%' }} size="small">
                          {trades.map((trade: any) => (
                            <Card key={trade.id} size="small">
                              <Space direction="vertical" style={{ width: '100%' }} size={2}>
                                <div>
                                  <Tag color={trade.side === 'buy' ? 'green' : 'red'}>
                                    {trade.side?.toUpperCase()}
                                  </Tag>
                                  <Text strong>${trade.price?.toFixed(4)}</Text>
                                </div>
                                <Text style={{ fontSize: 12 }}>
                                  Qty: {trade.qty}
                                </Text>
                                {trade.pnl !== undefined && (
                                  <Text 
                                    type={trade.pnl >= 0 ? 'success' : 'danger'}
                                    style={{ fontSize: 12 }}
                                  >
                                    PnL: ${trade.pnl.toFixed(2)}
                                  </Text>
                                )}
                                <Text type="secondary" style={{ fontSize: 11 }}>
                                  {new Date(trade.timestamp).toLocaleString()}
                                </Text>
                              </Space>
                            </Card>
                          ))}
                        </Space>
                      )}
                    </div>
                  )
                }
              ]}
            />
          </Card>
        </Col>
      </Row>

      {/* Activity Feed (bottom, full width) */}
      <Row style={{ marginTop: 16 }}>
        <Col span={24}>
          <Card 
            title="Activity Feed" 
            size="small"
            bodyStyle={{ maxHeight: 300, overflow: 'auto' }}
          >
            {activityFeed.length === 0 ? (
              <Text type="secondary">No recent activity</Text>
            ) : (
              <Space direction="vertical" style={{ width: '100%' }} size="small">
                {activityFeed.map((item, idx) => (
                  <div key={idx} style={{ padding: '4px 0', borderBottom: '1px solid #f0f0f0' }}>
                    <Space>
                      <Tag>{item.type}</Tag>
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        {new Date(item.timestamp).toLocaleTimeString()}
                      </Text>
                    </Space>
                    <div style={{ fontSize: 12, marginTop: 4 }}>
                      <Text type="secondary">
                        {JSON.stringify(item.data).slice(0, 100)}...
                      </Text>
                    </div>
                  </div>
                ))}
              </Space>
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
}

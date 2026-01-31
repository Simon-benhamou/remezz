import React from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Divider,
  Form,
  Modal,
  Row,
  Select,
  Slider,
  Space,
  Spin,
  Statistic,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  RocketOutlined,
  ThunderboltOutlined,
  TrophyOutlined,
  FireOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import { api } from '../api';
import type { AppMode } from '../store';

const { Text } = Typography;

type CreationFormShape = {
  maxLeverage: number;
  mode: AppMode;
};

// ═══════════════════════════════════════════════════════════════════════════
// CRYPTOS V5.6 - Classées par ROI backtest 24 mois (Nov 2023 - Nov 2025)
// ═══════════════════════════════════════════════════════════════════════════

// ✅ RECOMMANDÉES V5.6 - Backtest ROI positif sur 24 mois
// Toutes ces cryptos ont un ROI positif avec la stratégie V5 (Momentum Simple)
const V5_RECOMMENDED_CRYPTOS = [
  { symbol: 'DOGE/USDT', name: 'Dogecoin', category: '🏆 TOP 1', icon: '🐕', roi: '+438%', badge: 'gold', recommended: true },
  { symbol: 'IMX/USDT', name: 'Immutable X', category: '🏆 TOP 2', icon: '🔷', roi: '+344%', badge: 'gold', recommended: true },
  { symbol: 'SEI/USDT', name: 'Sei', category: '🏆 TOP 3', icon: '🌊', roi: '+280%', badge: 'gold', recommended: true },
  { symbol: 'SUI/USDT', name: 'Sui', category: '🏆 TOP 4', icon: '💧', roi: '+266%', badge: 'gold', recommended: true },
  { symbol: 'XRP/USDT', name: 'Ripple', category: '✅ Excellent', icon: '✕', roi: '+185%', badge: 'green', recommended: true },
  { symbol: 'ETH/USDT', name: 'Ethereum', category: '✅ Excellent', icon: 'Ξ', roi: '+173%', badge: 'green', recommended: true },
  { symbol: 'ADA/USDT', name: 'Cardano', category: '✅ Excellent', icon: '₳', roi: '+173%', badge: 'green', recommended: true },
  { symbol: 'DOT/USDT', name: 'Polkadot', category: '✅ Excellent', icon: '⬤', roi: '+173%', badge: 'green', recommended: true },
  { symbol: 'LINK/USDT', name: 'Chainlink', category: '✅ Bon', icon: '🔗', roi: '+143%', badge: 'blue', recommended: true },
  { symbol: 'AVAX/USDT', name: 'Avalanche', category: '✅ Bon', icon: '🔺', roi: '+118%', badge: 'blue', recommended: true },
  { symbol: 'SOL/USDT', name: 'Solana', category: '✅ Bon', icon: '◎', roi: '+111%', badge: 'blue', recommended: true },
  { symbol: 'BTC/USDT', name: 'Bitcoin', category: '⚡ Stable', icon: '₿', roi: '+65%', badge: 'cyan', recommended: true },
];

// ⚠️ AUTRES CRYPTOS - Disponibles mais moins testées
const NON_RECOMMENDED_CRYPTOS = [
  { symbol: 'BNB/USDT', name: 'Binance Coin', category: '⚠️ Non testé', icon: '🔶', roi: 'N/A', badge: 'default', recommended: false },
  { symbol: 'ATOM/USDT', name: 'Cosmos', category: '⚠️ Non testé', icon: '⚛️', roi: 'N/A', badge: 'default', recommended: false },
  { symbol: 'UNI/USDT', name: 'Uniswap', category: '⚠️ Non testé', icon: '🦄', roi: 'N/A', badge: 'default', recommended: false },
  { symbol: 'LTC/USDT', name: 'Litecoin', category: '⚠️ Non testé', icon: 'Ł', roi: 'N/A', badge: 'default', recommended: false },
  { symbol: 'SONIC/USDT', name: 'Sonic', category: '⚠️ Non testé', icon: '🎵', roi: 'N/A', badge: 'default', recommended: false },
  { symbol: 'BCH/USDT', name: 'Bitcoin Cash', category: '⚠️ Non testé', icon: '💵', roi: 'N/A', badge: 'default', recommended: false },
  { symbol: 'APT/USDT', name: 'Aptos', category: '⚠️ Non testé', icon: '🅰️', roi: 'N/A', badge: 'default', recommended: false },
];

// Combiner les deux listes (recommandées d'abord)
const ALL_CRYPTOS = [...V5_RECOMMENDED_CRYPTOS, ...NON_RECOMMENDED_CRYPTOS];

interface RankedCrypto {
  symbol: string;
  rank: number;
  score: number;
  volumeUsd24h: number;
  change24h: number;
  technical: {
    rsi: number;
    adx: number;
    atrPct: number;
    trend: string;
  };
  opportunity: {
    type: string;
    direction: string;
    confidence: number;
  };
  aiReasoning: string[];
}

interface AgentCreationModalProps {
  visible: boolean;
  mode: AppMode;
  onClose: () => void;
  onSuccess: () => void;
}

export default function AgentCreationModal({
  visible,
  mode,
  onClose,
  onSuccess,
}: AgentCreationModalProps) {
  const [form] = Form.useForm<CreationFormShape>();
  const [activeTab, setActiveTab] = React.useState<'manual' | 'ai'>('manual');
  const [selectedSymbol, setSelectedSymbol] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [rankedCryptos, setRankedCryptos] = React.useState<RankedCrypto[]>([]);
  const [loadingRanking, setLoadingRanking] = React.useState(false);

  // Load crypto ranking when AI tab is opened
  React.useEffect(() => {
    if (visible && activeTab === 'ai' && rankedCryptos.length === 0) {
      loadCryptoRanking();
    }
  }, [visible, activeTab]);

  const loadCryptoRanking = async () => {
    setLoadingRanking(true);
    try {
      const ranking = await api.getCryptoRanking({ limit: 20 });
      setRankedCryptos(Array.isArray(ranking) ? ranking : []);
    } catch (error: any) {
      message.error(error?.response?.data?.error || 'Failed to load crypto ranking');
      setRankedCryptos([]);
    } finally {
      setLoadingRanking(false);
    }
  };

  const handleCreate = async () => {
    if (!selectedSymbol) {
      message.warning('Please select a crypto first');
      return;
    }

    try {
      const values = await form.validateFields();
      setCreating(true);

      const payload = {
        mode,
        symbol: selectedSymbol,
        maxLeverage: values.maxLeverage,
        strategyEngine: 'meta_adaptive',
      };

      const prepare = await api.prepareAgentCreation(payload);
      const creationId = prepare?.creationId;

      if (!creationId) {
        throw new Error('No creation ID returned');
      }

      await api.createAgentSession(creationId, selectedSymbol);
      await api.activateAgentCreation(creationId);

      message.success(`Agent created for ${selectedSymbol}`);
      onSuccess();
      handleClose();
    } catch (error: any) {
      const detail = error?.response?.data?.message || error?.message || error;
      message.error(typeof detail === 'string' ? detail : 'Failed to create agent');
    } finally {
      setCreating(false);
    }
  };

  const handleClose = () => {
    setSelectedSymbol(null);
    setActiveTab('manual');
    form.resetFields();
    onClose();
  };

  const aiColumns: ColumnsType<RankedCrypto> = [
    {
      title: 'Rank',
      dataIndex: 'rank',
      key: 'rank',
      width: 60,
      render: (rank: number) => (
        <Tag color={rank <= 3 ? 'gold' : rank <= 10 ? 'blue' : 'default'}>
          #{rank}
        </Tag>
      ),
    },
    {
      title: 'Symbol',
      dataIndex: 'symbol',
      key: 'symbol',
      render: (symbol: string) => (
        <Text strong style={{ color: 'var(--text-primary)' }}>
          {symbol}
        </Text>
      ),
    },
    {
      title: 'Score',
      dataIndex: 'score',
      key: 'score',
      render: (score: number) => (
        <Text style={{ color: '#4ade80', fontWeight: 600 }}>
          {(score * 100).toFixed(0)}%
        </Text>
      ),
    },
    {
      title: 'Volume 24h',
      dataIndex: 'volumeUsd24h',
      key: 'volume',
      render: (volume: number) => (
        <Text style={{ color: '#cbd5f5' }}>
          ${(volume / 1_000_000).toFixed(1)}M
        </Text>
      ),
    },
    {
      title: 'Change',
      dataIndex: 'change24h',
      key: 'change',
      render: (change: number) => (
        <Text style={{ color: change >= 0 ? '#4ade80' : '#f87171', fontWeight: 600 }}>
          {change >= 0 ? '+' : ''}{change.toFixed(2)}%
        </Text>
      ),
    },
    {
      title: 'Trend',
      key: 'trend',
      render: (_, record) => (
        <Tag color={
          record.technical.trend === 'bullish' ? 'green' :
          record.technical.trend === 'bearish' ? 'red' : 'default'
        }>
          {record.technical.trend}
        </Tag>
      ),
    },
    {
      title: 'Opportunity',
      key: 'opportunity',
      render: (_, record) => (
        <Space direction="vertical" size={2}>
          <Text style={{ fontSize: 12, color: 'var(--text-primary)' }}>
            {record.opportunity.type}
          </Text>
          <Tag
            color={record.opportunity.direction === 'long' ? 'green' : 'red'}
            style={{ fontSize: 11 }}
          >
            {record.opportunity.direction.toUpperCase()}
          </Tag>
        </Space>
      ),
    },
    {
      title: 'Confidence',
      dataIndex: ['opportunity', 'confidence'],
      key: 'confidence',
      render: (confidence: number) => (
        <Text style={{ color: confidence >= 0.7 ? '#4ade80' : confidence >= 0.5 ? '#fbbf24' : '#f87171' }}>
          {(confidence * 100).toFixed(0)}%
        </Text>
      ),
    },
    {
      title: 'Action',
      key: 'action',
      render: (_, record) => (
        <Button
          type={selectedSymbol === record.symbol ? 'primary' : 'default'}
          size="small"
          onClick={() => setSelectedSymbol(record.symbol)}
        >
          {selectedSymbol === record.symbol ? 'Selected' : 'Select'}
        </Button>
      ),
    },
  ];

  return (
    <Modal
      open={visible}
      onCancel={handleClose}
      onOk={handleCreate}
      okText={`Create Agent${selectedSymbol ? ` (${selectedSymbol})` : ''}`}
      okButtonProps={{ disabled: !selectedSymbol, loading: creating }}
      cancelButtonProps={{ disabled: creating }}
      title={
        <Space>
          <RocketOutlined style={{ color: '#3b82f6' }} />
          <span>Create AI Trading Agent</span>
        </Space>
      }
      width={activeTab === 'ai' ? 1200 : 800}
      destroyOnClose={false}
      maskClosable={false}
      styles={{
        body: {
          background: 'linear-gradient(155deg, rgba(15, 23, 42, 0.95) 0%, rgba(15, 23, 42, 0.85) 100%)',
          padding: 24,
          maxHeight: '70vh',
          overflowY: 'auto',
        },
        header: {
          background: 'rgba(15, 23, 42, 0.92)',
          borderBottom: '1px solid rgba(148, 163, 184, 0.18)',
        },
        footer: {
          background: 'rgba(15, 23, 42, 0.92)',
          borderTop: '1px solid rgba(148, 163, 184, 0.18)',
        },
      }}
    >
      <Tabs
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key as 'manual' | 'ai')}
        items={[
          {
            key: 'manual',
            label: (
              <Space>
                <CheckCircleOutlined />
                Manual Selection
              </Space>
            ),
            children: (
              <div>
                <Alert
                  type="success"
                  showIcon
                  icon={<TrophyOutlined />}
                  message="🎯 Cryptos Backtestées V5.6 (24 mois)"
                  description={
                    <span>
                      Toutes ces cryptos ont un <strong>ROI positif</strong> sur 24 mois (Nov 2023 - Nov 2025) 
                      avec la stratégie V5 (Momentum Simple). Win Rate moyen: 65-68%.
                    </span>
                  }
                  style={{
                    background: 'rgba(34, 197, 94, 0.12)',
                    border: '1px solid rgba(34, 197, 94, 0.35)',
                    borderRadius: 12,
                    marginBottom: 16,
                  }}
                />

                {/* V5 RECOMMENDED */}
                <Text style={{ color: '#4ade80', fontSize: 14, fontWeight: 600, display: 'block', marginBottom: 12 }}>
                  ✅ TOUTES RECOMMANDÉES - ROI Positif sur 24 mois
                </Text>
                <Row gutter={[12, 12]} style={{ marginBottom: 24 }}>
                  {V5_RECOMMENDED_CRYPTOS.map((crypto) => {
                    const isSelected = selectedSymbol === crypto.symbol;
                    return (
                      <Col xs={12} sm={8} md={6} key={crypto.symbol}>
                        <Card
                          hoverable
                          onClick={() => setSelectedSymbol(crypto.symbol)}
                          style={{
                            background: isSelected
                              ? 'linear-gradient(135deg, rgba(34, 197, 94, 0.3), rgba(22, 163, 74, 0.2))'
                              : 'linear-gradient(135deg, rgba(34, 197, 94, 0.08), rgba(30, 41, 59, 0.55))',
                            border: isSelected
                              ? '2px solid #22c55e'
                              : '1px solid rgba(34, 197, 94, 0.3)',
                            borderRadius: 12,
                            textAlign: 'center',
                            cursor: 'pointer',
                            transition: 'all 0.3s',
                          }}
                          bodyStyle={{ padding: 14 }}
                        >
                          <div style={{ fontSize: 28, marginBottom: 6 }}>{crypto.icon}</div>
                          <Text strong style={{ color: 'var(--text-primary)', display: 'block', marginBottom: 2 }}>
                            {crypto.symbol.replace('/USDT', '')}
                          </Text>
                          <Text style={{ color: 'var(--text-secondary)', fontSize: 11, display: 'block', marginBottom: 6 }}>
                            {crypto.name}
                          </Text>
                          <Tag
                            color={crypto.badge as any}
                            style={{
                              borderRadius: 6,
                              fontSize: 10,
                              marginBottom: 4,
                            }}
                          >
                            {crypto.category}
                          </Tag>
                          <div>
                            <Text style={{ 
                              color: crypto.roi.startsWith('+') ? '#4ade80' : '#f87171', 
                              fontSize: 13, 
                              fontWeight: 700 
                            }}>
                              {crypto.roi}
                            </Text>
                          </div>
                        </Card>
                      </Col>
                    );
                  })}
                </Row>

                {/* NON RECOMMENDED */}
                <Alert
                  type="info"
                  showIcon
                  icon={<InfoCircleOutlined />}
                  message="ℹ️ Autres Cryptos Disponibles"
                  description="Ces cryptos n'ont pas été testées sur 24 mois avec notre stratégie."
                  style={{
                    background: 'rgba(59, 130, 246, 0.08)',
                    border: '1px solid rgba(59, 130, 246, 0.24)',
                    borderRadius: 12,
                    marginBottom: 12,
                    marginTop: 16,
                  }}
                />
                <Row gutter={[12, 12]} style={{ marginBottom: 24 }}>
                  {NON_RECOMMENDED_CRYPTOS.map((crypto) => {
                    const isSelected = selectedSymbol === crypto.symbol;
                    return (
                      <Col xs={12} sm={8} md={6} key={crypto.symbol}>
                        <Card
                          hoverable
                          onClick={() => setSelectedSymbol(crypto.symbol)}
                          style={{
                            background: isSelected
                              ? 'linear-gradient(135deg, rgba(239, 68, 68, 0.25), rgba(185, 28, 28, 0.15))'
                              : 'rgba(30, 41, 59, 0.4)',
                            border: isSelected
                              ? '2px solid #ef4444'
                              : '1px solid rgba(71, 107, 176, 0.12)',
                            borderRadius: 12,
                            textAlign: 'center',
                            cursor: 'pointer',
                            transition: 'all 0.3s',
                            opacity: 0.7,
                          }}
                          bodyStyle={{ padding: 14 }}
                        >
                          <div style={{ fontSize: 28, marginBottom: 6 }}>{crypto.icon}</div>
                          <Text strong style={{ color: 'var(--text-secondary)', display: 'block', marginBottom: 2 }}>
                            {crypto.symbol.replace('/USDT', '')}
                          </Text>
                          <Text style={{ color: 'var(--text-secondary)', fontSize: 11, display: 'block', marginBottom: 6 }}>
                            {crypto.name}
                          </Text>
                          <Tag
                            color={crypto.badge as any}
                            style={{
                              borderRadius: 6,
                              fontSize: 10,
                              marginBottom: 4,
                            }}
                          >
                            {crypto.category}
                          </Tag>
                          <div>
                            <Text style={{ 
                              color: '#f87171', 
                              fontSize: 12, 
                              fontWeight: 600 
                            }}>
                              {crypto.roi}
                            </Text>
                          </div>
                        </Card>
                      </Col>
                    );
                  })}
                </Row>
              </div>
            ),
          },
          {
            key: 'ai',
            label: (
              <Space>
                <ThunderboltOutlined />
                AI Suggestions
                <Tag color="purple" style={{ marginLeft: 4 }}>NEW</Tag>
              </Space>
            ),
            children: (
              <div>
                <Alert
                  type="success"
                  showIcon
                  icon={<FireOutlined />}
                  message="AI-Ranked Opportunities"
                  description="These cryptos are identified by AI as having high potential based on technical analysis, volume, and market conditions. All suggestions have sufficient volume for safe trading."
                  style={{
                    background: 'rgba(34, 197, 94, 0.08)',
                    border: '1px solid rgba(34, 197, 94, 0.24)',
                    borderRadius: 12,
                    marginBottom: 16,
                  }}
                />

                {loadingRanking ? (
                  <div style={{ textAlign: 'center', padding: 48 }}>
                    <Spin size="large" />
                    <Text style={{ display: 'block', marginTop: 16, color: 'var(--text-secondary)' }}>
                      Analyzing market opportunities...
                    </Text>
                  </div>
                ) : rankedCryptos.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 48 }}>
                    <Text style={{ color: 'var(--text-secondary)' }}>No ranking data available</Text>
                    <br />
                    <Button
                      type="primary"
                      onClick={loadCryptoRanking}
                      style={{ marginTop: 16 }}
                    >
                      Load Ranking
                    </Button>
                  </div>
                ) : (
                  <>
                    <div style={{ marginBottom: 16 }}>
                      <Space>
                        <Statistic
                          title="Opportunities Found"
                          value={rankedCryptos.length}
                          prefix={<TrophyOutlined />}
                          valueStyle={{ fontSize: 18, color: '#4ade80' }}
                        />
                      </Space>
                    </div>
                    <Table
                      columns={aiColumns}
                      dataSource={rankedCryptos}
                      rowKey="symbol"
                      pagination={false}
                      size="small"
                      scroll={{ y: 400 }}
                      rowClassName={(record) =>
                        selectedSymbol === record.symbol ? 'ant-table-row-selected' : ''
                      }
                    />
                  </>
                )}
              </div>
            ),
          },
        ]}
      />

      <Divider style={{ margin: '24px 0' }} />

      {/* Configuration Form */}
      <Form<CreationFormShape>
        layout="vertical"
        form={form}
        initialValues={{
          maxLeverage: 4,
          mode,
        }}
      >
        <Row gutter={16}>
          <Col xs={24} md={24}>
            <Form.Item
              label={
                <Space>
                  <Text style={{ color: 'var(--text-primary)' }}>Max Leverage</Text>
                  <Tooltip title="Maximum leverage the agent can use for trades">
                    <InfoCircleOutlined style={{ color: 'var(--text-secondary)' }} />
                  </Tooltip>
                </Space>
              }
              name="maxLeverage"
            >
              <Slider
                min={1}
                max={10}
                marks={{
                  1: '1x',
                  5: '5x',
                  10: '10x',
                }}
                tooltip={{ formatter: (value) => `${value}x` }}
              />
            </Form.Item>
          </Col>
        </Row>

        <div
          style={{
            background: 'rgba(30, 41, 59, 0.65)',
            border: '1px solid rgba(148, 163, 184, 0.22)',
            borderRadius: 12,
            padding: 16,
            display: 'flex',
            gap: 24,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: 1 }}>
            <Text style={{ color: 'var(--text-secondary)', fontSize: 12, display: 'block', marginBottom: 4 }}>
              Position Size
            </Text>
            <Text style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: 18 }}>
              40%
            </Text>
          </div>
          <div style={{ flex: 1 }}>
            <Text style={{ color: 'var(--text-secondary)', fontSize: 12, display: 'block', marginBottom: 4 }}>
              Stop Loss
            </Text>
            <Text style={{ color: '#f87171', fontWeight: 600, fontSize: 18 }}>
              1.5%
            </Text>
            <Text style={{ color: 'var(--text-secondary)', fontSize: 10, display: 'block' }}>
              ≈7.5% avec 5x lev
            </Text>
          </div>
          <div style={{ flex: 1 }}>
            <Text style={{ color: 'var(--text-secondary)', fontSize: 12, display: 'block', marginBottom: 4 }}>
              Take Profit
            </Text>
            <Text style={{ color: '#4ade80', fontWeight: 600, fontSize: 18 }}>
              3.0%
            </Text>
            <Text style={{ color: 'var(--text-secondary)', fontSize: 10, display: 'block' }}>
              ≈15% avec 5x lev
            </Text>
          </div>
          <div style={{ flex: 1 }}>
            <Text style={{ color: 'var(--text-secondary)', fontSize: 12, display: 'block', marginBottom: 4 }}>
              Strategy
            </Text>
            <Text style={{ color: '#4ade80', fontWeight: 600, fontSize: 18 }}>
              V5 Momentum
            </Text>
          </div>
        </div>

        <Form.Item name="mode" hidden initialValue={mode}>
          <input type="hidden" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

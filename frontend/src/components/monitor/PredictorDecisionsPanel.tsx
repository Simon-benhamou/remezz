import { Card, Table, Tag, Statistic, Row, Col, Space, Tooltip } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  MinusCircleOutlined,
  ClockCircleOutlined,
  RiseOutlined,
  FallOutlined,
  TrophyOutlined,
} from '@ant-design/icons';
import { useState, useEffect } from 'react';
import { api } from '../../api';

interface PredictorDecision {
  id: string;
  symbol: string;
  decision: 'long' | 'short' | 'none';
  previousDecision: string | null;
  probabilityLong: number;
  probabilityShort: number;
  confidence: number;
  entryWeight: number | null;
  riskMultiplier: number | null;
  price: number;
  createdAt: Date;
  // Analysis fields
  outcome: 'good' | 'bad' | 'neutral' | 'pending' | 'not_applicable';
  priceChange: number | null;
  pnlEstimate: number | null;
  durationMinutes: number | null;
  exitPrice: number | null;
  exitTime: Date | null;
}

interface PredictorMetrics {
  totalDecisions: number;
  completedTrades: number;
  pendingTrades: number;
  notApplicableTrades: number;
  goodTrades: number;
  badTrades: number;
  neutralTrades: number;
  winRate: number;
  avgPnl: number;
  totalPnl: number;
  avgDurationMinutes: number;
}

interface PredictorDecisionsPanelProps {
  symbol: string;
}

export function PredictorDecisionsPanel({ symbol }: PredictorDecisionsPanelProps) {
  const [loading, setLoading] = useState(true);
  const [decisions, setDecisions] = useState<PredictorDecision[]>([]);
  const [metrics, setMetrics] = useState<PredictorMetrics | null>(null);

  const fetchDecisions = async () => {
    try {
      setLoading(true);
      const data = await api.getPredictorDecisions(symbol, { limit: 100 });
      setDecisions(data.decisions || []);
      setMetrics(data.metrics || null);
    } catch (error) {
      console.error('Error fetching predictor decisions:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDecisions();
    
    // Auto-refresh every 30 seconds
    const interval = setInterval(fetchDecisions, 30000);
    return () => clearInterval(interval);
  }, [symbol]);

  const getDecisionTag = (decision: string) => {
    switch (decision) {
      case 'long':
        return <Tag color="green" icon={<RiseOutlined />}>LONG</Tag>;
      case 'short':
        return <Tag color="red" icon={<FallOutlined />}>SHORT</Tag>;
      case 'none':
        return <Tag color="default" icon={<MinusCircleOutlined />}>NONE</Tag>;
      default:
        return <Tag>{decision}</Tag>;
    }
  };

  const getOutcomeTag = (outcome: string) => {
    switch (outcome) {
      case 'good':
        return <Tag color="success" icon={<CheckCircleOutlined />}>✓ Good</Tag>;
      case 'bad':
        return <Tag color="error" icon={<CloseCircleOutlined />}>✗ Bad</Tag>;
      case 'neutral':
        return <Tag color="warning" icon={<MinusCircleOutlined />}>~ Neutral</Tag>;
      case 'pending':
        return <Tag color="processing" icon={<ClockCircleOutlined />}>Pending</Tag>;
      case 'not_applicable':
        return <Tag icon={<MinusCircleOutlined />}>N/A</Tag>;
      default:
        return <Tag>{outcome}</Tag>;
    }
  };

  const columns = [
    {
      title: 'Time',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 160,
      render: (ts: string) => {
        const date = new Date(ts);
        return date.toLocaleString('en-US', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        });
      },
    },
    {
      title: 'Decision',
      dataIndex: 'decision',
      key: 'decision',
      width: 100,
      render: (decision: string) => getDecisionTag(decision),
    },
    {
      title: 'Change',
      key: 'change',
      width: 150,
      render: (_: any, record: PredictorDecision) => {
        if (!record.previousDecision || record.previousDecision === record.decision) {
          return <span style={{ color: '#8c8c8c' }}>-</span>;
        }
        return (
          <Space size="small">
            {getDecisionTag(record.previousDecision)}
            <span>→</span>
            {getDecisionTag(record.decision)}
          </Space>
        );
      },
    },
    {
      title: 'Confidence',
      dataIndex: 'confidence',
      key: 'confidence',
      width: 110,
      align: 'right' as const,
      render: (confidence: number) => {
        const color = confidence >= 0.5 ? '#52c41a' : confidence >= 0.3 ? '#faad14' : '#ff4d4f';
        return (
          <span style={{ color, fontWeight: 'bold' }}>
            {(confidence * 100).toFixed(1)}%
          </span>
        );
      },
    },
    {
      title: 'Probabilities',
      key: 'probabilities',
      width: 200,
      render: (_: any, record: PredictorDecision) => (
        <Space size="small" style={{ fontSize: '12px' }}>
          <Tooltip title="Long probability">
            <span style={{ color: '#52c41a' }}>
              L: {(record.probabilityLong * 100).toFixed(0)}%
            </span>
          </Tooltip>
          <span style={{ color: '#8c8c8c' }}>|</span>
          <Tooltip title="Short probability">
            <span style={{ color: '#ff4d4f' }}>
              S: {(record.probabilityShort * 100).toFixed(0)}%
            </span>
          </Tooltip>
        </Space>
      ),
    },
    {
      title: 'Entry Price',
      dataIndex: 'price',
      key: 'price',
      width: 110,
      align: 'right' as const,
      render: (price: number) => `$${price.toFixed(4)}`,
    },
    {
      title: 'Exit Price',
      dataIndex: 'exitPrice',
      key: 'exitPrice',
      width: 110,
      align: 'right' as const,
      render: (exitPrice: number | null) => 
        exitPrice ? `$${exitPrice.toFixed(4)}` : <span style={{ color: '#8c8c8c' }}>-</span>,
    },
    {
      title: 'Price Change',
      dataIndex: 'priceChange',
      key: 'priceChange',
      width: 110,
      align: 'right' as const,
      render: (priceChange: number | null, record: PredictorDecision) => {
        if (priceChange === null) {
          return <span style={{ color: '#8c8c8c' }}>-</span>;
        }
        const color = priceChange >= 0 ? '#52c41a' : '#ff4d4f';
        return (
          <Tooltip title={`Price ${priceChange >= 0 ? 'increased' : 'decreased'} by ${Math.abs(priceChange).toFixed(2)}%`}>
            <span style={{ color, fontWeight: 'bold' }}>
              {priceChange >= 0 ? '+' : ''}{priceChange.toFixed(2)}%
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: 'Estimated PnL',
      dataIndex: 'pnlEstimate',
      key: 'pnlEstimate',
      width: 120,
      align: 'right' as const,
      render: (pnl: number | null, record: PredictorDecision) => {
        if (pnl === null) {
          return <span style={{ color: '#8c8c8c' }}>-</span>;
        }
        const color = pnl >= 0 ? '#52c41a' : '#ff4d4f';
        return (
          <Tooltip title={`If traded with 1x leverage (${record.decision} position)`}>
            <span style={{ color, fontWeight: 'bold' }}>
              {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}%
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: 'Duration',
      dataIndex: 'durationMinutes',
      key: 'durationMinutes',
      width: 100,
      align: 'right' as const,
      render: (minutes: number | null) => {
        if (minutes === null) {
          return <span style={{ color: '#8c8c8c' }}>-</span>;
        }
        if (minutes < 60) {
          return `${minutes}m`;
        } else if (minutes < 1440) {
          return `${(minutes / 60).toFixed(1)}h`;
        } else {
          return `${(minutes / 1440).toFixed(1)}d`;
        }
      },
    },
    {
      title: 'Outcome',
      dataIndex: 'outcome',
      key: 'outcome',
      width: 110,
      render: (outcome: string) => getOutcomeTag(outcome),
    },
  ];

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {/* Performance Metrics */}
      {metrics && (
        <Card size="small" title={
          <Space>
            <TrophyOutlined />
            <span>Predictor Performance Analysis</span>
          </Space>
        }>
          <Row gutter={16}>
            <Col span={4}>
              <Statistic
                title="Win Rate"
                value={metrics.winRate}
                precision={1}
                suffix="%"
                valueStyle={{ 
                  color: metrics.winRate >= 50 ? '#52c41a' : '#ff4d4f',
                  fontSize: '24px',
                }}
              />
            </Col>
            <Col span={4}>
              <Statistic
                title="Total Trades"
                value={metrics.completedTrades}
                valueStyle={{ fontSize: '24px' }}
              />
            </Col>
            <Col span={4}>
              <Statistic
                title="Good Trades"
                value={metrics.goodTrades}
                valueStyle={{ color: '#52c41a', fontSize: '24px' }}
                prefix={<CheckCircleOutlined />}
              />
            </Col>
            <Col span={4}>
              <Statistic
                title="Bad Trades"
                value={metrics.badTrades}
                valueStyle={{ color: '#ff4d4f', fontSize: '24px' }}
                prefix={<CloseCircleOutlined />}
              />
            </Col>
            <Col span={4}>
              <Statistic
                title="Avg PnL"
                value={metrics.avgPnl}
                precision={2}
                suffix="%"
                valueStyle={{ 
                  color: metrics.avgPnl >= 0 ? '#52c41a' : '#ff4d4f',
                  fontSize: '24px',
                }}
                prefix={metrics.avgPnl >= 0 ? '+' : ''}
              />
            </Col>
            <Col span={4}>
              <Statistic
                title="Avg Duration"
                value={metrics.avgDurationMinutes < 60 
                  ? `${metrics.avgDurationMinutes.toFixed(0)}m`
                  : `${(metrics.avgDurationMinutes / 60).toFixed(1)}h`
                }
                valueStyle={{ fontSize: '24px' }}
              />
            </Col>
          </Row>
        </Card>
      )}

      {/* Decisions Table */}
      <Card
        title={
          <Space>
            <RiseOutlined />
            <span>Predictor Decision History</span>
            {decisions.length > 0 && (
              <Tag color="blue">{decisions.length}</Tag>
            )}
          </Space>
        }
        size="small"
      >
        <Table
          dataSource={decisions}
          columns={columns}
          rowKey="id"
          size="small"
          loading={loading}
          pagination={{ 
            pageSize: 20, 
            showSizeChanger: true,
            pageSizeOptions: ['10', '20', '50', '100'],
          }}
          scroll={{ x: 1600 }}
          locale={{ emptyText: 'No predictor decisions yet' }}
          rowClassName={(record) => {
            if (record.outcome === 'good') return 'predictor-row-good';
            if (record.outcome === 'bad') return 'predictor-row-bad';
            return '';
          }}
        />
      </Card>

      <style>{`
        .predictor-row-good {
          background-color: rgba(82, 196, 26, 0.05);
        }
        .predictor-row-bad {
          background-color: rgba(245, 34, 45, 0.05);
        }
      `}</style>
    </Space>
  );
}

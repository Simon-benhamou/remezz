import React from 'react';
import { Card, Table, Tag, Space, List, Typography, Tooltip, Button, Statistic } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';

const { Text } = Typography;

interface WeightRow {
  family: string;
  momentumWeight: number;
  volumeWeight: number;
  volatilityWeight: number;
  confidence: number;
  sampleSize: number;
  lastWinRate: number;
  updatedAt: string;
  createdAt: string;
}

interface DecisionRow {
  id: string;
  sessionId?: string | null;
  symbol: string;
  family: string;
  score?: number | null;
  confidence?: number | null;
  biasConfidence?: number | null;
  outcome?: string | null;
  realizedPnl?: number | null;
  createdAt: string;
  features?: any;
}

interface AdaptiveWeightsData {
  weights: WeightRow[];
  recentDecisions: DecisionRow[];
  familyStats?: any;
}

interface Props {
  data?: AdaptiveWeightsData | null;
  loading?: boolean;
  onRefresh?: () => void;
}

const weightColumns = [
  {
    title: 'Family',
    dataIndex: 'family',
    key: 'family',
    render: (value: string) => <Tag color="blue">{value.toUpperCase()}</Tag>,
  },
  {
    title: 'Momentum',
    dataIndex: 'momentumWeight',
    key: 'momentumWeight',
    render: (value: number) => <WeightValue value={value} baseline={1} />,
  },
  {
    title: 'Volume',
    dataIndex: 'volumeWeight',
    key: 'volumeWeight',
    render: (value: number) => <WeightValue value={value} baseline={1} />,
  },
  {
    title: 'Volatility',
    dataIndex: 'volatilityWeight',
    key: 'volatilityWeight',
    render: (value: number) => <WeightValue value={value} baseline={1} />,
  },
  {
    title: 'Win Rate',
    dataIndex: 'lastWinRate',
    key: 'lastWinRate',
    render: (value: number) => <Statistic value={value * 100} precision={1} suffix="%" valueStyle={{ fontSize: 14 }} />, 
  },
  {
    title: 'Samples',
    dataIndex: 'sampleSize',
    key: 'sampleSize',
    render: (value: number) => <Text>{value}</Text>,
  },
  {
    title: 'Confidence',
    dataIndex: 'confidence',
    key: 'confidence',
    render: (value: number) => <Statistic value={value * 100} precision={1} suffix="%" valueStyle={{ fontSize: 14 }} />, 
  },
  {
    title: 'Updated',
    dataIndex: 'updatedAt',
    key: 'updatedAt',
    render: (value: string) => new Date(value).toLocaleTimeString(),
  }
];

function WeightValue({ value, baseline }: { value: number; baseline: number }) {
  const diff = value - baseline;
  const color = diff > 0.05 ? '#52c41a' : diff < -0.05 ? '#ff4d4f' : '#d9d9d9';
  const label = diff > 0 ? `+${diff.toFixed(2)}` : diff.toFixed(2);
  return (
    <Space size={4}>
      <Text strong style={{ color }}>{value.toFixed(2)}</Text>
      {Math.abs(diff) >= 0.01 && (
        <Tag color={color} style={{ margin: 0 }}>{label}</Tag>
      )}
    </Space>
  );
}

const outcomeColor: Record<string, string> = {
  win: 'green',
  loss: 'red',
  breakeven: 'orange',
  cancelled: 'default',
};

const AdaptiveWeightsPanel: React.FC<Props> = ({ data, loading, onRefresh }) => {
  const weights = data?.weights || [];
  const decisions = data?.recentDecisions || [];

  return (
    <Card
      title={
        <Space>
          <Text strong>Adaptive Weights</Text>
          <Tag color="purple">Momentum / Volume / Volatility</Tag>
        </Space>
      }
      extra={
        <Space>
          <Tooltip title="Refresh">
            <Button size="small" icon={<ReloadOutlined />} onClick={onRefresh} loading={loading} />
          </Tooltip>
        </Space>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <Table
          size="small"
          pagination={false}
          loading={loading}
          columns={weightColumns}
          dataSource={weights.map((row) => ({ ...row, key: row.family }))}
        />

        <Card type="inner" title="Recent Decisions" bodyStyle={{ padding: 0 }}>
          <List
            loading={loading}
            dataSource={decisions}
            locale={{ emptyText: 'No recent decisions logged yet.' }}
            renderItem={(item) => {
              const features = (item.features || {}) as any;
              const outcome = item.outcome || 'pending';
              const color = outcomeColor[outcome] || 'default';
              return (
                <List.Item>
                  <Space direction="vertical" style={{ width: '100%' }} size={0}>
                    <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                      <Space>
                        <Tag color="blue">{item.family.toUpperCase()}</Tag>
                        <Text strong>{item.symbol}</Text>
                        <Tag color={color}>{outcome.toUpperCase()}</Tag>
                      </Space>
                      <Text type="secondary">{new Date(item.createdAt).toLocaleTimeString()}</Text>
                    </Space>
                    <Space size="large" wrap>
                      <Tooltip title="Signal score">
                        <Text>Score: {item.score?.toFixed(2) ?? '—'}</Text>
                      </Tooltip>
                      <Tooltip title="AI confidence">
                        <Text>Confidence: {item.confidence?.toFixed(1)}%</Text>
                      </Tooltip>
                      <Tooltip title="Bias confidence">
                        <Text>Bias: {item.biasConfidence?.toFixed(1)}%</Text>
                      </Tooltip>
                      <Tooltip title="Momentum feature">
                        <Text>Momentum: {features?.momentum?.toFixed?.(2) ?? features?.momentum ?? '—'}</Text>
                      </Tooltip>
                      <Tooltip title="Volume 24h feature">
                        <Text>Volume: {features?.volume24h ? `${(features.volume24h/1e6).toFixed(2)}M` : '—'}</Text>
                      </Tooltip>
                      <Tooltip title="Volatility feature">
                        <Text>Volatility: {features?.volatility?.toFixed?.(2) ?? features?.volatility ?? '—'}</Text>
                      </Tooltip>
                      {typeof item.realizedPnl === 'number' && (
                        <Tooltip title="Realized PnL">
                          <Text style={{ color: item.realizedPnl > 0 ? '#52c41a' : item.realizedPnl < 0 ? '#ff4d4f' : undefined }}>
                            PnL: {item.realizedPnl.toFixed(2)}
                          </Text>
                        </Tooltip>
                      )}
                    </Space>
                  </Space>
                </List.Item>
              );
            }}
          />
        </Card>
      </Space>
    </Card>
  );
};

export default AdaptiveWeightsPanel;

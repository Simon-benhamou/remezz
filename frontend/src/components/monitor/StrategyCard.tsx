import { Card, Row, Col, Statistic, Progress, Tag, Space, Tooltip } from 'antd';
import { ThunderboltOutlined, StarOutlined } from '@ant-design/icons';

interface StrategyCardProps {
  data: any;
}

export function StrategyCard({ data }: StrategyCardProps) {
  if (!data) return null;

  const getBiasColor = (bias: string) => {
    if (bias === 'long') return 'green';
    if (bias === 'short') return 'red';
    if (bias === 'both') return 'blue';
    return 'default';
  };

  const confidencePercent = Math.round((data.confidence || 0) * 100);
  const scorePercent = Math.round((data.score || 0) * 100);

  return (
    <Card
      title={
        <Space>
          <ThunderboltOutlined />
          <span>Active Strategy</span>
        </Space>
      }
      size="small"
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <div>
          <div style={{ marginBottom: 8 }}>
            <strong>{data.label || data.id}</strong>
            {data.family && data.family !== 'unknown' && (
              <Tag color="blue" style={{ marginLeft: 8 }}>
                {data.family}
              </Tag>
            )}
          </div>
          {data.id && (
            <div style={{ fontSize: '12px', color: '#8c8c8c', fontFamily: 'monospace' }}>
              ID: {data.id}
            </div>
          )}
        </div>

        <Row gutter={16}>
          <Col span={8}>
            <Statistic
              title="Bias"
              value={data.bias || 'none'}
              valueStyle={{ 
                fontSize: '14px', 
                textTransform: 'uppercase',
                color: data.bias === 'long' ? '#52c41a' : data.bias === 'short' ? '#f5222d' : '#1890ff'
              }}
            />
          </Col>
          
          <Col span={8}>
            <Tooltip title={`Confidence: ${confidencePercent}%`}>
              <div>
                <div style={{ fontSize: '12px', color: '#8c8c8c', marginBottom: 4 }}>
                  Confidence
                </div>
                <Progress
                  percent={confidencePercent}
                  size="small"
                  status={confidencePercent >= 70 ? 'success' : confidencePercent >= 40 ? 'normal' : 'exception'}
                  format={percent => `${percent}%`}
                />
              </div>
            </Tooltip>
          </Col>

          <Col span={8}>
            <Tooltip title={`Score: ${scorePercent}%`}>
              <div>
                <div style={{ fontSize: '12px', color: '#8c8c8c', marginBottom: 4 }}>
                  Score
                </div>
                <Progress
                  percent={scorePercent}
                  size="small"
                  strokeColor="#1890ff"
                  format={percent => `${percent}%`}
                />
              </div>
            </Tooltip>
          </Col>
        </Row>
      </Space>
    </Card>
  );
}

import { Card, Tag, Row, Col, Statistic, Space, Tooltip } from 'antd';
import {
  RobotOutlined,
  ThunderboltOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  MinusOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons';

interface AgentStateCardProps {
  data: any;
}

export function AgentStateCard({ data }: AgentStateCardProps) {
  if (!data) return null;

  const getStateColor = (state: string) => {
    const colors: Record<string, string> = {
      ACTIVE: 'green',
      WAITING: 'orange',
      WARMING: 'blue',
      ERROR: 'red',
      STOPPED: 'default',
    };
    return colors[state] || 'default';
  };

  const getBiasIcon = (bias: string) => {
    if (bias === 'long') return <ArrowUpOutlined style={{ color: 'var(--success)' }} />;
    if (bias === 'short') return <ArrowDownOutlined style={{ color: 'var(--error)' }} />;
    return <MinusOutlined style={{ color: 'var(--text-secondary)' }} />;
  };

  const getTradeableStatus = () => {
    if (!data.canTrade) {
      return {
        icon: <CloseCircleOutlined style={{ color: 'var(--error)' }} />,
        text: 'Cannot Trade',
        color: 'red',
        reason: data.reason || 'Unknown',
      };
    }
    return {
      icon: <CheckCircleOutlined style={{ color: 'var(--success)' }} />,
      text: 'Ready to Trade',
      color: 'green',
      reason: data.reason || 'All conditions met',
    };
  };

  const tradeableStatus = getTradeableStatus();

  return (
    <Card 
      title={
        <Space>
          <RobotOutlined />
          <span>Agent State</span>
          <Tag color={getStateColor(data.state)}>{data.state}</Tag>
        </Space>
      }
      size="small"
    >
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} md={6}>
          <Statistic
            title="Current Bias"
            value={data.bias || 'none'}
            prefix={getBiasIcon(data.bias)}
            valueStyle={{ fontSize: '16px', textTransform: 'uppercase' }}
          />
        </Col>
        
        <Col xs={24} sm={12} md={6}>
          <Tooltip title={tradeableStatus.reason}>
            <Statistic
              title="Trade Status"
              value={tradeableStatus.text}
              prefix={tradeableStatus.icon}
              valueStyle={{ fontSize: '14px', color: tradeableStatus.color === 'green' ? 'var(--success)' : 'var(--error)' }}
            />
          </Tooltip>
        </Col>

        <Col xs={24} sm={12} md={6}>
          <Statistic
            title="Session ID"
            value={data.sessionId?.slice(0, 8) || 'N/A'}
            valueStyle={{ fontSize: '14px', fontFamily: 'monospace' }}
          />
        </Col>

        <Col xs={24} sm={12} md={6}>
          <Statistic
            title="Strategy"
            value="Momentum Simple"
            valueStyle={{ fontSize: '14px', textTransform: 'capitalize' }}
          />
        </Col>
      </Row>

      {data.trigger && (
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid #f0f0f0' }}>
          <Space direction="vertical" style={{ width: '100%' }} size="small">
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              <strong>Entry Ready:</strong>{' '}
              {data.trigger.entryReady ? (
                <Tag color="green" icon={<CheckCircleOutlined />}>Yes</Tag>
              ) : (
                <Tag color="red" icon={<CloseCircleOutlined />}>No</Tag>
              )}
            </div>
            {data.trigger.phase && (
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                <strong>Phase:</strong> {data.trigger.phase}
              </div>
            )}
            {data.blockers && data.blockers.length > 0 && (
              <div style={{ fontSize: '12px', color: 'var(--error)' }}>
                <strong>Blockers:</strong> {data.blockers.join(', ')}
              </div>
            )}
          </Space>
        </div>
      )}
    </Card>
  );
}

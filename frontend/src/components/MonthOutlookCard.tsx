/**
 * Month Outlook Card Component
 * Displays macro analysis comparing current month to historical patterns
 */
import { useEffect, useState } from 'react';
import { Card, Row, Col, Statistic, Tag, Tooltip, Spin, Space } from 'antd';
import { 
  CalendarOutlined, 
  RiseOutlined, 
  FallOutlined, 
  MinusOutlined,
  BarChartOutlined,
  InfoCircleOutlined 
} from '@ant-design/icons';
import { api } from '../api';

type MonthOutlookData = Awaited<ReturnType<typeof api.getMonthOutlook>>;

export function MonthOutlookCard() {
  const [outlook, setOutlook] = useState<MonthOutlookData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchOutlook = async () => {
      try {
        const data = await api.getMonthOutlook();
        setOutlook(data);
        setError(null);
      } catch (err) {
        setError('Unable to load month outlook');
      } finally {
        setLoading(false);
      }
    };

    fetchOutlook();
    // Refresh every 6 hours
    const interval = setInterval(fetchOutlook, 6 * 60 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <Card size="small" style={{ background: '#141414', borderColor: '#303030' }}>
        <div style={{ textAlign: 'center', padding: '20px' }}>
          <Spin size="small" />
        </div>
      </Card>
    );
  }

  if (error || !outlook) {
    return null;
  }

  const { currentMonth, prediction, similarMonths, historicalBest, historicalWorst } = outlook;

  // Validate required data exists
  if (!prediction || !currentMonth || !similarMonths || !historicalBest || !historicalWorst) {
    return null;
  }

  const outlookConfig = {
    BULLISH: {
      icon: <RiseOutlined />,
      color: '#52c41a',
      tagColor: 'success',
      label: 'BULLISH',
    },
    BEARISH: {
      icon: <FallOutlined />,
      color: '#ff4d4f',
      tagColor: 'error',
      label: 'BEARISH',
    },
    NEUTRAL: {
      icon: <MinusOutlined />,
      color: '#faad14',
      tagColor: 'warning',
      label: 'NEUTRAL',
    },
  };

  const config = outlookConfig[prediction.outlook];

  // Helper to format year from yearMonth (2024-09 -> '24)
  const formatYear = (yearMonth: string) => yearMonth.slice(2, 4);

  return (
    <Card
      size="small"
      style={{ background: '#141414', borderColor: '#303030' }}
      title={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Space>
            <CalendarOutlined style={{ color: '#888' }} />
            <span style={{ color: '#fff', fontWeight: 500 }}>
              {currentMonth.monthName} Outlook
            </span>
            <span style={{ color: '#666', fontSize: 12 }}>(Day {outlook.dayOfMonth})</span>
          </Space>
          <Tag color={config.tagColor} icon={config.icon}>
            {config.label} {prediction.confidence.toFixed(0)}%
          </Tag>
        </div>
      }
    >
      {/* Current Month Stats */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Statistic
            title="Trades"
            value={currentMonth.trades}
            valueStyle={{ fontSize: 18, color: '#fff' }}
          />
        </Col>
        <Col span={6}>
          <Statistic
            title="Win Rate"
            value={currentMonth.winRate}
            precision={0}
            suffix="%"
            valueStyle={{ fontSize: 18, color: '#fff' }}
          />
        </Col>
        <Col span={6}>
          <Statistic
            title="PnL"
            value={currentMonth.totalPnl}
            precision={0}
            prefix="$"
            valueStyle={{ 
              fontSize: 18, 
              color: currentMonth.totalPnl >= 0 ? '#52c41a' : '#ff4d4f' 
            }}
          />
        </Col>
        <Col span={6}>
          <Statistic
            title="SL Rate"
            value={currentMonth.slRatio * 100}
            precision={0}
            suffix="%"
            valueStyle={{ fontSize: 18, color: '#fff' }}
          />
        </Col>
      </Row>

      {/* Similar Months */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ color: '#888', fontSize: 12, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
          <BarChartOutlined />
          Similar historical periods (first {outlook.dayOfMonth} days):
          <Tooltip title="Compares current month's first days to same period in past months to predict outcome">
            <InfoCircleOutlined style={{ cursor: 'help' }} />
          </Tooltip>
        </div>
        <Space wrap>
          {similarMonths.slice(0, 3).map((sim, idx) => {
            const outcomeColor = sim.finalOutcome === 'POSITIVE' 
              ? 'success'
              : sim.finalOutcome === 'NEGATIVE'
              ? 'error'
              : 'warning';
            
            const year = formatYear(sim.month.yearMonth);
            const pnlSign = sim.month.totalPnl >= 0 ? '+' : '';
            
            return (
              <Tooltip
                key={idx}
                title={
                  <div>
                    <div><strong>{sim.month.monthName} {sim.month.yearMonth.split('-')[0]}</strong></div>
                    <div>Similarity: {sim.similarity.toFixed(0)}%</div>
                    <div>Full month: {pnlSign}${sim.month.totalPnl.toFixed(0)} ({sim.month.winRate.toFixed(0)}% WR)</div>
                  </div>
                }
              >
                <Tag 
                  color={outcomeColor}
                  style={{ cursor: 'help' }}
                >
                  {sim.month.monthName} '{year} → {pnlSign}${sim.month.totalPnl.toFixed(0)}
                </Tag>
              </Tooltip>
            );
          })}
        </Space>
      </div>

      {/* Prediction */}
      <div style={{ 
        background: '#1a1a1a', 
        padding: '8px 12px', 
        borderRadius: 6, 
        marginBottom: 12,
        borderLeft: `3px solid ${config.color}`
      }}>
        <div style={{ color: '#888', fontSize: 11, marginBottom: 4 }}>PREDICTION</div>
        <div style={{ color: '#ccc', fontSize: 12, fontStyle: 'italic' }}>
          "{prediction.reasoning}"
        </div>
        <div style={{ marginTop: 8, display: 'flex', gap: 16 }}>
          <span style={{ fontSize: 12 }}>
            <span style={{ color: '#666' }}>Expected WR:</span>{' '}
            <span style={{ color: '#fff' }}>{prediction.expectedWinRate.toFixed(0)}%</span>
          </span>
          <span style={{ fontSize: 12 }}>
            <span style={{ color: '#666' }}>Expected PnL:</span>{' '}
            <span style={{ color: prediction.expectedPnl >= 0 ? '#52c41a' : '#ff4d4f' }}>
              ${prediction.expectedPnl.toFixed(0)}
            </span>
          </span>
        </div>
      </div>

      {/* Historical Context */}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#555' }}>
        <span>
          📈 Best: {historicalBest.monthName} '{formatYear(historicalBest.yearMonth)} (+${historicalBest.totalPnl.toFixed(0)})
        </span>
        <span>
          📉 Worst: {historicalWorst.monthName} '{formatYear(historicalWorst.yearMonth)} (${historicalWorst.totalPnl.toFixed(0)})
        </span>
      </div>
    </Card>
  );
}

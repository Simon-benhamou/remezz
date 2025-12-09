/**
 * Month Outlook Card Component
 * Shows where current month stands vs historical performance
 */
import { useEffect, useState } from 'react';
import { Card, Row, Col, Statistic, Tag, Tooltip, Spin, Progress, Space, Table } from 'antd';
import { 
  CalendarOutlined, 
  RiseOutlined, 
  FallOutlined, 
  TrophyOutlined,
  ThunderboltOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  MinusOutlined
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
    const interval = setInterval(fetchOutlook, 5 * 60 * 1000); // Refresh every 5 min
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

  const { currentMonth, dayOfMonth, daysInMonth, ranking, projection, allMonthsRanked, averageMonthlyPnl, bestMonth, worstMonth } = outlook;

  if (!ranking || !projection || !currentMonth) {
    return null;
  }

  // Status configuration
  const statusConfig = {
    TOP_TIER: { color: '#52c41a', tagColor: 'success', icon: <TrophyOutlined />, label: 'TOP TIER' },
    GOOD: { color: '#73d13d', tagColor: 'success', icon: <RiseOutlined />, label: 'GOOD' },
    AVERAGE: { color: '#faad14', tagColor: 'warning', icon: <MinusOutlined />, label: 'AVERAGE' },
    POOR: { color: '#ff7a45', tagColor: 'warning', icon: <FallOutlined />, label: 'POOR' },
    WORST: { color: '#ff4d4f', tagColor: 'error', icon: <FallOutlined />, label: 'WORST' },
  };

  const trendConfig = {
    IMPROVING: { color: '#52c41a', icon: <ArrowUpOutlined />, label: 'Improving' },
    STABLE: { color: '#faad14', icon: <MinusOutlined />, label: 'Stable' },
    DECLINING: { color: '#ff4d4f', icon: <ArrowDownOutlined />, label: 'Declining' },
  };

  const config = statusConfig[ranking.status];
  const trend = trendConfig[projection.trend];

  // Format year from yearMonth
  const formatYear = (ym: string) => ym.slice(2, 4);

  return (
    <Card
      size="small"
      style={{ background: '#141414', borderColor: '#303030' }}
      title={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Space>
            <CalendarOutlined style={{ color: '#888' }} />
            <span style={{ color: '#fff', fontWeight: 500 }}>
              {currentMonth.monthName} {currentMonth.yearMonth.split('-')[0]}
            </span>
            <span style={{ color: '#666', fontSize: 12 }}>
              Day {dayOfMonth}/{daysInMonth}
            </span>
          </Space>
          <Space>
            <Tag color={config.tagColor} icon={config.icon}>
              #{ranking.position}/{ranking.totalMonths} {config.label}
            </Tag>
          </Space>
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
            value={currentMonth.slRate}
            precision={0}
            suffix="%"
            valueStyle={{ fontSize: 18, color: currentMonth.slRate > 30 ? '#ff4d4f' : '#fff' }}
          />
        </Col>
      </Row>

      {/* Ranking Progress */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span style={{ color: '#888', fontSize: 12 }}>Ranking Percentile</span>
          <span style={{ color: '#fff', fontSize: 12 }}>{ranking.percentile}% (better than {ranking.percentile}% of months)</span>
        </div>
        <Progress 
          percent={ranking.percentile} 
          strokeColor={config.color}
          trailColor="#303030"
          showInfo={false}
          size="small"
        />
      </div>

      {/* Projection */}
      <div style={{ 
        background: '#1a1a1a', 
        padding: '10px 12px', 
        borderRadius: 6, 
        marginBottom: 12,
        borderLeft: `3px solid ${trend.color}`
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={{ color: '#888', fontSize: 11 }}>
            <ThunderboltOutlined /> PROJECTION (at current pace)
          </div>
          <Tag color={projection.trend === 'IMPROVING' ? 'success' : projection.trend === 'DECLINING' ? 'error' : 'warning'} style={{ margin: 0 }}>
            {trend.icon} {trend.label}
          </Tag>
        </div>
        <Row gutter={16}>
          <Col span={8}>
            <div style={{ color: '#666', fontSize: 11 }}>Projected Trades</div>
            <div style={{ color: '#fff', fontSize: 14, fontWeight: 500 }}>{projection.projectedTrades}</div>
          </Col>
          <Col span={8}>
            <div style={{ color: '#666', fontSize: 11 }}>Projected PnL</div>
            <div style={{ 
              color: projection.projectedPnl >= 0 ? '#52c41a' : '#ff4d4f', 
              fontSize: 14, 
              fontWeight: 500 
            }}>
              ${projection.projectedPnl.toFixed(0)}
            </div>
          </Col>
          <Col span={8}>
            <div style={{ color: '#666', fontSize: 11 }}>vs Avg Month</div>
            <div style={{ 
              color: projection.projectedPnl > averageMonthlyPnl ? '#52c41a' : '#ff4d4f', 
              fontSize: 14, 
              fontWeight: 500 
            }}>
              {projection.projectedPnl > averageMonthlyPnl ? '↑' : '↓'} {Math.abs(projection.projectedPnl - averageMonthlyPnl).toFixed(0)}$
            </div>
          </Col>
        </Row>
      </div>

      {/* Top/Bottom Months Mini Table */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ color: '#888', fontSize: 11, marginBottom: 6 }}>HISTORICAL RANKING (Best → Worst)</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {allMonthsRanked.slice(0, 6).map((m, idx) => {
            const isGood = m.totalPnl > 20;
            const isBad = m.totalPnl < -20;
            const bgColor = m.isCurrent 
              ? '#1890ff22' 
              : isGood ? '#52c41a15' : isBad ? '#ff4d4f15' : '#ffffff08';
            const borderColor = m.isCurrent ? '#1890ff' : 'transparent';
            
            return (
              <Tooltip 
                key={m.yearMonth}
                title={`${m.monthName} ${m.yearMonth.split('-')[0]}: ${m.winRate.toFixed(0)}% WR`}
              >
                <div style={{ 
                  padding: '4px 8px', 
                  background: bgColor, 
                  borderRadius: 4,
                  border: `1px solid ${borderColor}`,
                  fontSize: 11,
                  cursor: 'help'
                }}>
                  <span style={{ color: '#888' }}>#{idx + 1}</span>{' '}
                  <span style={{ color: m.isCurrent ? '#1890ff' : '#fff' }}>
                    {m.monthName} '{formatYear(m.yearMonth)}
                  </span>{' '}
                  <span style={{ color: m.totalPnl >= 0 ? '#52c41a' : '#ff4d4f' }}>
                    {m.totalPnl >= 0 ? '+' : ''}{m.totalPnl.toFixed(0)}$
                  </span>
                </div>
              </Tooltip>
            );
          })}
          {allMonthsRanked.length > 6 && (
            <div style={{ 
              padding: '4px 8px', 
              background: '#ffffff08', 
              borderRadius: 4,
              fontSize: 11,
              color: '#666'
            }}>
              +{allMonthsRanked.length - 6} more
            </div>
          )}
        </div>
      </div>

      {/* Footer Stats */}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#555', borderTop: '1px solid #303030', paddingTop: 8 }}>
        <span>
          📊 Avg month: {averageMonthlyPnl >= 0 ? '+' : ''}{averageMonthlyPnl.toFixed(0)}$
        </span>
        <span>
          🏆 Best: {bestMonth.monthName} '{formatYear(bestMonth.yearMonth)} (+{bestMonth.totalPnl.toFixed(0)}$)
        </span>
        <span>
          💀 Worst: {worstMonth.monthName} '{formatYear(worstMonth.yearMonth)} ({worstMonth.totalPnl.toFixed(0)}$)
        </span>
      </div>
    </Card>
  );
}

import React from 'react';
import { Card, Row, Col, Statistic, Progress, Space, Tag, Tooltip } from 'antd';
import { 
  ArrowUpOutlined, 
  ArrowDownOutlined, 
  FireOutlined,
  ThunderboltOutlined,
  EyeOutlined,
  BarChartOutlined 
} from '@ant-design/icons';

interface KeyMetric {
  key: string;
  label: string;
  value: number;
  unit?: string;
  threshold?: number;
  good?: 'above' | 'below';
  format?: 'decimal' | 'percentage';
  precision?: number;
}

interface TechnicalIndicators {
  atrPct?: number;
  adx?: number;
  rsi?: number;
  ema20?: number;
  ema50?: number;
  ema20Slope?: number;
  volume?: number;
  price?: number;
}

interface KeyMetricsCardProps {
  indicators: TechnicalIndicators;
  style?: React.CSSProperties;
}

export default function KeyMetricsCard({ indicators = {}, style }: KeyMetricsCardProps) {
  const {
    atrPct = 0,
    adx = 0,
    rsi = 50,
    ema20 = 0,
    ema50 = 0,
    ema20Slope = 0,
    volume = 0,
    price = 0
  } = indicators;

  // Safely convert to numbers and calculate derived metrics
  const safeAtrPct = Number(atrPct) || 0;
  const safeAdx = Number(adx) || 0;
  const safeRsi = Number(rsi) || 50;
  const safeEma20 = Number(ema20) || 0;
  const safeEma50 = Number(ema50) || 0;
  const safeEma20Slope = Number(ema20Slope) || 0;
  const safePrice = Number(price) || 0;
  
  const emaSpread = safeEma20 && safeEma50 ? ((safeEma20 - safeEma50) / safeEma50) * 100 : 0;
  const slopePercentage = safeEma20 ? (safeEma20Slope / safeEma20) * 100 : 0;
  const priceVsEma = safeEma20 ? ((safePrice - safeEma20) / safeEma20) * 100 : 0;

  const getMetricStatus = (value: number, threshold: number, good: 'above' | 'below' = 'above') => {
    const isGood = good === 'above' ? value >= threshold : value <= threshold;
    return {
      color: isGood ? '#10b981' : '#ef4444',
      status: isGood ? 'good' : 'poor',
      icon: isGood ? <ArrowUpOutlined /> : <ArrowDownOutlined />
    };
  };

  const getRSIStatus = (rsi: number) => {
    if (rsi > 70) return { color: '#ef4444', status: 'overbought', level: 'high' };
    if (rsi < 30) return { color: '#ef4444', status: 'oversold', level: 'low' };
    if (rsi > 60 || rsi < 40) return { color: '#f59e0b', status: 'caution', level: 'medium' };
    return { color: '#10b981', status: 'neutral', level: 'good' };
  };

  const getTrendStatus = () => {
    const slope = Math.abs(slopePercentage);
    if (slope >= 0.15) return { strength: 'strong', color: '#10b981', icon: <FireOutlined /> };
    if (slope >= 0.10) return { strength: 'medium', color: '#f59e0b', icon: <ThunderboltOutlined /> };
    return { strength: 'weak', color: '#ef4444', icon: <BarChartOutlined /> };
  };

  const atrStatus = getMetricStatus(safeAtrPct, 0.8);
  const adxStatus = getMetricStatus(safeAdx, 25);
  const rsiStatus = getRSIStatus(safeRsi);
  const trendStatus = getTrendStatus();

  return (
    <Card 
      title="📊 Key Metrics"
      size="small"
      style={style}
      extra={
        <Space>
          <Tooltip title="Momentum Gates Status">
            <Tag color={atrStatus.status === 'good' && adxStatus.status === 'good' ? 'success' : 'error'}>
              {atrStatus.status === 'good' && adxStatus.status === 'good' ? 'PASS' : 'FAIL'}
            </Tag>
          </Tooltip>
        </Space>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size="small">
        {/* Primary Metrics Row */}
        <Row gutter={[8, 8]}>
          <Col span={12}>
            <div style={{ 
              padding: '12px', 
              background: atrStatus.color === '#10b981' ? '#ecfdf5' : '#fef2f2',
              borderRadius: 8,
              border: `1px solid ${atrStatus.color}20`
            }}>
              <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase' }}>
                    ATR% (Volatility)
                  </div>
                  <div style={{ 
                    fontSize: 18, 
                    fontWeight: 700, 
                    color: atrStatus.color,
                    fontFamily: 'Monaco, monospace'
                  }}>
                    {safeAtrPct.toFixed(2)}%
                  </div>
                  <div style={{ fontSize: 9, color: '#9ca3af' }}>
                    Target: ≥0.8%
                  </div>
                </div>
                <div style={{ color: atrStatus.color, fontSize: 16 }}>
                  {atrStatus.icon}
                </div>
              </Space>
              <Progress 
                percent={Math.min((safeAtrPct / 1.5) * 100, 100)}
                strokeColor={atrStatus.color}
                showInfo={false}
                size="small"
                style={{ marginTop: 4 }}
              />
            </div>
          </Col>
          
          <Col span={12}>
            <div style={{ 
              padding: '12px', 
              background: adxStatus.color === '#10b981' ? '#ecfdf5' : '#fef2f2',
              borderRadius: 8,
              border: `1px solid ${adxStatus.color}20`
            }}>
              <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase' }}>
                    ADX (Trend Strength)
                  </div>
                  <div style={{ 
                    fontSize: 18, 
                    fontWeight: 700, 
                    color: adxStatus.color,
                    fontFamily: 'Monaco, monospace'
                  }}>
                    {safeAdx.toFixed(1)}
                  </div>
                  <div style={{ fontSize: 9, color: '#9ca3af' }}>
                    Target: ≥25
                  </div>
                </div>
                <div style={{ color: adxStatus.color, fontSize: 16 }}>
                  {adxStatus.icon}
                </div>
              </Space>
              <Progress 
                percent={Math.min((safeAdx / 50) * 100, 100)}
                strokeColor={adxStatus.color}
                showInfo={false}
                size="small"
                style={{ marginTop: 4 }}
              />
            </div>
          </Col>
        </Row>

        {/* Secondary Metrics Row */}
        <Row gutter={[8, 8]}>
          <Col span={8}>
            <div style={{ 
              padding: '8px', 
              background: '#f9fafb',
              borderRadius: 6,
              border: `1px solid ${rsiStatus.color}20`,
              textAlign: 'center'
            }}>
              <div style={{ fontSize: 9, color: '#6b7280', textTransform: 'uppercase' }}>
                RSI
              </div>
              <div style={{ 
                fontSize: 14, 
                fontWeight: 600, 
                color: rsiStatus.color,
                fontFamily: 'Monaco, monospace'
              }}>
                {safeRsi.toFixed(0)}
              </div>
              <Tag 
                color={rsiStatus.level === 'good' ? 'success' : rsiStatus.level === 'medium' ? 'warning' : 'error'}
                style={{ fontSize: 8, margin: 0, marginTop: 2 }}
              >
                {rsiStatus.status}
              </Tag>
            </div>
          </Col>
          
          <Col span={8}>
            <div style={{ 
              padding: '8px', 
              background: '#f9fafb',
              borderRadius: 6,
              border: `1px solid ${trendStatus.color}20`,
              textAlign: 'center'
            }}>
              <div style={{ fontSize: 9, color: '#6b7280', textTransform: 'uppercase' }}>
                Trend
              </div>
              <div style={{ 
                fontSize: 12, 
                fontWeight: 600, 
                color: trendStatus.color,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 4
              }}>
                {trendStatus.icon}
                <span>{Math.abs(slopePercentage).toFixed(2)}%</span>
              </div>
              <Tag 
                color={trendStatus.strength === 'strong' ? 'success' : trendStatus.strength === 'medium' ? 'warning' : 'error'}
                style={{ fontSize: 8, margin: 0, marginTop: 2 }}
              >
                {trendStatus.strength}
              </Tag>
            </div>
          </Col>
          
          <Col span={8}>
            <div style={{ 
              padding: '8px', 
              background: '#f9fafb',
              borderRadius: 6,
              textAlign: 'center'
            }}>
              <div style={{ fontSize: 9, color: '#6b7280', textTransform: 'uppercase' }}>
                Price vs EMA20
              </div>
              <div style={{ 
                fontSize: 14, 
                fontWeight: 600, 
                color: priceVsEma >= 0 ? '#10b981' : '#ef4444',
                fontFamily: 'Monaco, monospace'
              }}>
                {priceVsEma >= 0 ? '+' : ''}{priceVsEma.toFixed(2)}%
              </div>
              <div style={{ fontSize: 8, color: '#9ca3af', marginTop: 2 }}>
                {priceVsEma >= 0 ? 'Above' : 'Below'}
              </div>
            </div>
          </Col>
        </Row>

        {/* EMA Spread Indicator */}
        <div style={{ 
          padding: '8px 12px', 
          background: Math.abs(emaSpread) > 0.5 ? '#ecfdf5' : '#fef2f2',
          borderRadius: 6,
          border: `1px solid ${Math.abs(emaSpread) > 0.5 ? '#10b981' : '#ef4444'}20`
        }}>
          <Row justify="space-between" align="middle">
            <Col>
              <Space size={4}>
                <span style={{ fontSize: 11, color: '#374151', fontWeight: 500 }}>
                  EMA Spread
                </span>
                <span style={{ 
                  fontSize: 12, 
                  fontWeight: 600,
                  color: Math.abs(emaSpread) > 0.5 ? '#10b981' : '#ef4444',
                  fontFamily: 'Monaco, monospace'
                }}>
                  {emaSpread >= 0 ? '+' : ''}{emaSpread.toFixed(3)}%
                </span>
              </Space>
            </Col>
            <Col>
              <Tag 
                color={Math.abs(emaSpread) > 0.5 ? 'success' : 'error'}
                style={{ fontSize: 9, margin: 0 }}
              >
                {Math.abs(emaSpread) > 0.5 ? 'Trending' : 'Consolidating'}
              </Tag>
            </Col>
          </Row>
        </div>
      </Space>
    </Card>
  );
}
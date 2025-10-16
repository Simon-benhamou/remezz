import React from 'react';
import { Card, Row, Col, Space, Tag, Tooltip, Typography, Progress, Divider } from 'antd';
import { ArrowUpOutlined, ArrowDownOutlined, AimOutlined } from '../icons';

const { Text } = Typography;

type BiasDirection = 'bullish' | 'bearish' | 'neutral';

type ProjectionComponents = {
  adx?: number;
  slope?: number;
  spread?: number;
  sentiment?: number;
  bias?: number;
};

type ProjectionData = {
  rangePct: number;
  rangeUpPct: number;
  rangeDownPct: number;
  rangeUpPrice: number;
  rangeDownPrice: number;
  biasDirection: BiasDirection;
  biasScore: number;
  confidence: number;
  components?: ProjectionComponents;
};

interface RangeProjectionCardProps {
  projection?: ProjectionData | null;
  price?: number;
  symbol?: string;
}

const biasColorMap: Record<BiasDirection, string> = {
  bullish: '#16a34a',
  neutral: '#3b82f6',
  bearish: '#ef4444',
};

const biasLabelMap: Record<BiasDirection, string> = {
  bullish: 'Bullish Bias',
  neutral: 'Neutral Bias',
  bearish: 'Bearish Bias',
};

const prettyPrice = (price?: number) => {
  if (!Number.isFinite(price || NaN)) return '-';
  const value = Number(price);
  if (value >= 1000) return value.toFixed(2);
  if (value >= 10) return value.toFixed(3);
  if (value >= 1) return value.toFixed(4);
  return value.toFixed(6);
};

const formatPct = (pct?: number) => {
  if (!Number.isFinite(pct || NaN)) return '-';
  return `${Number(pct).toFixed(2)}%`;
};

export default function RangeProjectionCard({ projection, price, symbol }: RangeProjectionCardProps) {
  if (!projection) {
    return (
      <Card title="📈 24h Range Forecast" size="small">
        <Text type="secondary">Range forecast is unavailable for this symbol. Analysis will appear once the technical snapshot is ready.</Text>
      </Card>
    );
  }

  const biasDir: BiasDirection = projection.biasDirection || 'neutral';
  const biasColor = biasColorMap[biasDir];
  const confidencePercent = Math.round(Math.min(Math.max((projection.confidence || 0) * 100, 0), 100));
  const components = projection.components || {};

  const componentBreakdown = [
    { key: 'bias', label: 'Directional bias', value: components.bias },
    { key: 'adx', label: 'ADX / trend strength', value: components.adx },
    { key: 'slope', label: 'EMA slope', value: components.slope },
    { key: 'spread', label: 'EMA spread', value: components.spread },
    { key: 'sentiment', label: 'Sentiment conviction', value: components.sentiment },
  ].filter((item) => item.value != null);

  return (
    <Card
      title="📈 24h Range Forecast"
      size="small"
      extra={
        <Tag color={biasColor} style={{ fontWeight: 600, textTransform: 'uppercase' }}>
          {biasLabelMap[biasDir]}
        </Tag>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <Row gutter={[16, 16]} align="middle">
          <Col xs={24} sm={12}>
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Text type="secondary">Symbol</Text>
              <Text strong style={{ fontSize: 18 }}>{symbol || '—'}</Text>
              <Text type="secondary">Last price</Text>
              <Text style={{ fontSize: 16 }}>{prettyPrice(price ?? projection.rangeDownPrice)}</Text>
              <Tag color="#6366f1" icon={<AimOutlined />}>±{formatPct(projection.rangePct / 2)} envelope</Tag>
            </Space>
          </Col>
          <Col xs={24} sm={12}>
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <Tooltip
                title={
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>Confidence breakdown</div>
                    {componentBreakdown.length ? componentBreakdown.map((item) => (
                      <div key={item.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                        <span>{item.label}</span>
                        <span>{Math.round((item.value || 0) * 100)}%</span>
                      </div>
                    )) : 'No component data'}
                  </div>
                }
              >
                <Progress
                  type="dashboard"
                  percent={confidencePercent}
                  strokeColor={biasColor}
                  width={140}
                  format={(p) => `${p ?? 0}%`}
                />
              </Tooltip>
            </div>
            <Text style={{ display: 'block', textAlign: 'center' }}>
              Confidence in outlook
            </Text>
          </Col>
        </Row>

        <Divider style={{ margin: '8px 0' }} />

        <Row gutter={[16, 16]}>
          <Col xs={24} md={12}>
            <Card size="small" bordered style={{ background: '#f0fdf4', borderColor: '#bbf7d0' }}>
              <Space direction="vertical" size={2} style={{ width: '100%' }}>
                <Text type="secondary" style={{ fontSize: 12 }}>Upside potential (24h)</Text>
                <Text style={{ fontSize: 24, color: '#15803d', fontWeight: 700 }}>
                  <ArrowUpOutlined /> {formatPct(projection.rangeUpPct)}
                </Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Target price ≈ {prettyPrice(projection.rangeUpPrice)}
                </Text>
              </Space>
            </Card>
          </Col>
          <Col xs={24} md={12}>
            <Card size="small" bordered style={{ background: '#fef2f2', borderColor: '#fecaca' }}>
              <Space direction="vertical" size={2} style={{ width: '100%' }}>
                <Text type="secondary" style={{ fontSize: 12 }}>Downside potential (24h)</Text>
                <Text style={{ fontSize: 24, color: '#b91c1c', fontWeight: 700 }}>
                  <ArrowDownOutlined /> {formatPct(projection.rangeDownPct)}
                </Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Target price ≈ {prettyPrice(projection.rangeDownPrice)}
                </Text>
              </Space>
            </Card>
          </Col>
        </Row>

        <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.5 }}>
          <b>How to read:</b> The agent estimates a ±{formatPct(projection.rangePct / 2)} trading envelope over the next 24h based on volatility, trend, and sentiment. Upside/downside targets adapt to the current directional bias.
        </div>
      </Space>
    </Card>
  );
}

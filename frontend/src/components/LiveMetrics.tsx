import React from 'react';
import { Card, Row, Col, Statistic, Tag, Space, Alert } from 'antd';
import { ArrowUpOutlined, ArrowDownOutlined, LineChartOutlined } from '../icons';

type Props = {
  symbol?: string;
  price?: number;
  ticker?: any; // CCXT ticker data
  lastUpdate?: string;
  status?: 'loading' | 'live' | 'stale' | 'error';
  errorMessage?: string;
};

export default function LiveMetrics({ symbol, price, ticker, lastUpdate, status = 'loading', errorMessage }: Props) {
  if (status === 'loading') {
    return (
      <Card size="small" style={{ marginBottom: 16 }}>
        <div style={{ textAlign: 'center', color: '#666' }}>
          Loading market data...
        </div>
      </Card>
    );
  }

  if (status === 'error') {
    return (
      <Card size="small" style={{ marginBottom: 16 }}>
        <Alert
          type="error"
          showIcon
          message="Live ticker unavailable"
          description={errorMessage || 'Ticker feed returned invalid data. Retrying automatically…'}
        />
      </Card>
    );
  }

  // Extract data from ticker or use fallback values (Binance WS: percentage is already in %)
  const currentPrice = price || Number(ticker?.last || 0);
  const openPrice = Number(ticker?.open || 0);
  const computedChange = (currentPrice && openPrice) ? (currentPrice - openPrice) : 0;
  const change24h = Number(ticker?.change ?? computedChange ?? 0);
  const percentage24h = Number(ticker?.percentage ?? (openPrice ? ((currentPrice - openPrice) / openPrice) * 100 : 0));
  const high24h = Number(ticker?.high || 0);
  const low24h = Number(ticker?.low || 0);
  const volume24h = Number(ticker?.baseVolume || 0);
  const quoteVolume24h = Number(ticker?.quoteVolume || 0);
  const bid = Number(ticker?.bid || 0);
  const ask = Number(ticker?.ask || 0);
  const spread = bid && ask ? ((ask - bid) / ((ask + bid) / 2)) * 100 : 0;

  // Format large numbers
  const formatVolume = (vol: number) => {
    if (vol >= 1e9) return `${(vol / 1e9).toFixed(2)}B`;
    if (vol >= 1e6) return `${(vol / 1e6).toFixed(2)}M`;
    if (vol >= 1e3) return `${(vol / 1e3).toFixed(1)}K`;
    return vol.toFixed(0);
  };

  const formatPrice = (price: number) => {
    if (price >= 100) return price.toFixed(2);
    if (price >= 1) return price.toFixed(4);
    return price.toFixed(6);
  };

  const isPositive = percentage24h >= 0;
  const changeColor = isPositive ? '#3f8600' : '#cf1322';
  const changeIcon = isPositive ? <ArrowUpOutlined /> : <ArrowDownOutlined />;

  // If ticker is present but clearly a placeholder (WS warming), show a warm-up card instead of zeros
  const isWarming = ticker && (currentPrice === 0 || (volume24h === 0 && quoteVolume24h === 0));

  return (
    <Card size="small" style={{ marginBottom: 16 }}>
      <Row gutter={16}>
        {(status === 'stale') && (
          <Col span={24}>
            <Alert
              type="warning"
              showIcon
              message="Market data marked stale"
              description="Last live update exceeded freshness threshold. Waiting for reconnection…"
            />
          </Col>
        )}
        {isWarming && (
          <Col span={24}>
            <div style={{ textAlign: 'center', color: '#999', padding: 4 }}>
              Binance WebSocket warming up… live metrics will appear shortly.
            </div>
          </Col>
        )}
        {/* Symbol & Price */}
        <Col xs={12} sm={6} md={4}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 'bold', marginBottom: 4 }}>
              {symbol || 'Unknown'}
            </div>
            <div style={{ fontSize: 20, fontWeight: 'bold', color: '#1890ff' }}>
              ${formatPrice(currentPrice)}
            </div>
          </div>
        </Col>

        {/* 24h Change */}
        <Col xs={12} sm={6} md={4}>
          <Statistic
            title="24h Change"
            value={percentage24h}
            precision={2}
            suffix="%"
            valueStyle={{ color: changeColor, fontSize: 16 }}
            prefix={changeIcon}
          />
          <div style={{ color: changeColor, fontSize: 12, marginTop: 4 }}>
            {isPositive ? '+' : ''}{formatPrice(change24h)}
          </div>
        </Col>

        {/* 24h High/Low */}
        <Col xs={12} sm={6} md={4}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>24h Range</div>
            <div style={{ color: '#cf1322', fontSize: 14, fontWeight: 'bold' }}>
              H: ${formatPrice(high24h)}
            </div>
            <div style={{ color: '#3f8600', fontSize: 14, fontWeight: 'bold' }}>
              L: ${formatPrice(low24h)}
            </div>
          </div>
        </Col>

        {/* Volume */}
        <Col xs={12} sm={6} md={4}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>24h Volume</div>
            <div style={{ fontSize: 14, fontWeight: 'bold' }}>
              {formatVolume(volume24h)}
            </div>
            <div style={{ fontSize: 12, color: '#666' }}>
              ${formatVolume(quoteVolume24h)}
            </div>
          </div>
        </Col>

        {/* Bid/Ask & Spread */}
        <Col xs={12} sm={6} md={4}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>Bid/Ask</div>
            <div style={{ fontSize: 13 }}>
              <span style={{ color: '#3f8600' }}>{formatPrice(bid)}</span>
              {' / '}
              <span style={{ color: '#cf1322' }}>{formatPrice(ask)}</span>
            </div>
            <div style={{ fontSize: 11, color: '#666' }}>
              Spread: {spread.toFixed(3)}%
            </div>
          </div>
        </Col>

        {/* Market Status */}
        <Col xs={12} sm={6} md={4}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>Market</div>
            <Space direction="vertical" size="small">
              <Tag color={isPositive ? 'green' : 'red'} icon={<LineChartOutlined />}>
                {isPositive ? 'BULLISH' : 'BEARISH'}
              </Tag>
              {lastUpdate && (
                <div style={{ fontSize: 10, color: '#999' }}>
                  Updated: {new Date(lastUpdate).toLocaleTimeString()}
                </div>
              )}
            </Space>
          </div>
        </Col>
      </Row>
    </Card>
  );
}

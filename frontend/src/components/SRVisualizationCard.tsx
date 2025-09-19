import React from 'react';
import { Card, Row, Col, Space, Tag, Tooltip, Progress } from 'antd';
import { AimOutlined, LineChartOutlined } from '@ant-design/icons';

interface SRLevel {
  price: number;
  strength?: number;
  touches?: number;
  age?: number;
  type?: 'support' | 'resistance';
}

interface PivotLevels {
  P?: number;   // Pivot
  S1?: number;  // Support 1
  S2?: number;  // Support 2
  S3?: number;  // Support 3
  R1?: number;  // Resistance 1
  R2?: number;  // Resistance 2
  R3?: number;  // Resistance 3
}

interface SRVisualizationProps {
  currentPrice: number;
  support?: SRLevel;
  resistance?: SRLevel;
  pivots?: PivotLevels;
  symbol?: string;
  style?: React.CSSProperties;
}

export default function SRVisualizationCard({ 
  currentPrice = 0, 
  support, 
  resistance, 
  pivots = {}, 
  symbol = '',
  style 
}: SRVisualizationProps) {
  
  // Calculate visualization bounds
  const supportPrice = support?.price || 0;
  const resistancePrice = resistance?.price || 0;
  
  // Create range for visualization (use wider range if pivots available)
  const allLevels = [
    supportPrice,
    resistancePrice,
    currentPrice,
    ...Object.values(pivots).filter(p => p && p > 0)
  ].filter(p => p > 0);
  
  const minPrice = Math.min(...allLevels) * 0.999;
  const maxPrice = Math.max(...allLevels) * 1.001;
  const priceRange = maxPrice - minPrice;
  
  const getPositionPercent = (price: number) => {
    if (priceRange === 0) return 50;
    return ((price - minPrice) / priceRange) * 100;
  };

  const getDistancePercent = (from: number, to: number) => {
    return Math.abs(((to - from) / from) * 100);
  };

  const formatPrice = (price: number) => {
    return price.toFixed(4);
  };

  const supportDistance = supportPrice ? getDistancePercent(currentPrice, supportPrice) : 0;
  const resistanceDistance = resistancePrice ? getDistancePercent(currentPrice, resistancePrice) : 0;
  
  const isNearSupport = supportDistance < 0.5;
  const isNearResistance = resistanceDistance < 0.5;

  return (
    <Card 
      title={
        <Space>
          <AimOutlined />
          <span>🎯 Key Levels</span>
          {(isNearSupport || isNearResistance) && (
            <Tag color="warning" style={{ fontSize: 10 }}>
              Near Level
            </Tag>
          )}
        </Space>
      }
      size="small"
      style={style}
      extra={
        <Tooltip title={`Price action relative to support and resistance levels`}>
          <LineChartOutlined style={{ color: '#2563eb' }} />
        </Tooltip>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size="small">
        {/* Price Level Summary */}
        <Row gutter={[8, 8]}>
          <Col span={8}>
            <div style={{ 
              textAlign: 'center', 
              padding: '8px', 
              background: isNearResistance ? '#fef2f2' : '#f9fafb', 
              borderRadius: 6,
              border: isNearResistance ? '1px solid #fca5a5' : '1px solid #e5e7eb'
            }}>
              <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase' }}>
                Resistance
              </div>
              <div style={{ 
                fontSize: 12, 
                fontWeight: 600, 
                color: '#ef4444',
                fontFamily: 'Monaco, monospace'
              }}>
                {resistancePrice ? formatPrice(resistancePrice) : 'N/A'}
              </div>
              {resistancePrice && (
                <div style={{ fontSize: 9, color: '#9ca3af' }}>
                  +{resistanceDistance.toFixed(2)}%
                </div>
              )}
            </div>
          </Col>
          
          <Col span={8}>
            <div style={{ 
              textAlign: 'center', 
              padding: '8px', 
              background: 'linear-gradient(135deg, #2563eb, #1d4ed8)', 
              borderRadius: 6,
              color: 'white'
            }}>
              <div style={{ fontSize: 10, textTransform: 'uppercase', opacity: 0.9 }}>
                Current
              </div>
              <div style={{ 
                fontSize: 12, 
                fontWeight: 700,
                fontFamily: 'Monaco, monospace'
              }}>
                {formatPrice(currentPrice)}
              </div>
              <div style={{ fontSize: 9, opacity: 0.8 }}>
                Live Price
              </div>
            </div>
          </Col>
          
          <Col span={8}>
            <div style={{ 
              textAlign: 'center', 
              padding: '8px', 
              background: isNearSupport ? '#ecfdf5' : '#f9fafb', 
              borderRadius: 6,
              border: isNearSupport ? '1px solid #86efac' : '1px solid #e5e7eb'
            }}>
              <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase' }}>
                Support
              </div>
              <div style={{ 
                fontSize: 12, 
                fontWeight: 600, 
                color: '#10b981',
                fontFamily: 'Monaco, monospace'
              }}>
                {supportPrice ? formatPrice(supportPrice) : 'N/A'}
              </div>
              {supportPrice && (
                <div style={{ fontSize: 9, color: '#9ca3af' }}>
                  -{supportDistance.toFixed(2)}%
                </div>
              )}
            </div>
          </Col>
        </Row>

        {/* Visual Price Ladder */}
        {(supportPrice || resistancePrice) && (
          <div style={{ 
            position: 'relative', 
            height: 80, 
            background: 'linear-gradient(to bottom, #fef2f2 0%, #f9fafb 50%, #ecfdf5 100%)',
            borderRadius: 8,
            border: '1px solid #e5e7eb',
            overflow: 'hidden'
          }}>
            {/* Resistance Line */}
            {resistancePrice && (
              <div style={{
                position: 'absolute',
                top: `${100 - getPositionPercent(resistancePrice)}%`,
                left: 0,
                right: 0,
                height: 2,
                background: '#ef4444',
                zIndex: 2
              }}>
                <div style={{
                  position: 'absolute',
                  right: 4,
                  top: -10,
                  fontSize: 8,
                  color: '#ef4444',
                  fontWeight: 600,
                  background: 'white',
                  padding: '1px 4px',
                  borderRadius: 2
                }}>
                  R: {formatPrice(resistancePrice)}
                </div>
              </div>
            )}
            
            {/* Current Price Indicator */}
            <div style={{
              position: 'absolute',
              top: `${100 - getPositionPercent(currentPrice)}%`,
              left: 0,
              right: 0,
              height: 3,
              background: '#2563eb',
              zIndex: 3,
              boxShadow: '0 0 8px rgba(37, 99, 235, 0.6)'
            }}>
              <div style={{
                position: 'absolute',
                left: 4,
                top: -10,
                fontSize: 8,
                color: '#2563eb',
                fontWeight: 700,
                background: 'white',
                padding: '1px 4px',
                borderRadius: 2,
                border: '1px solid #2563eb'
              }}>
                {formatPrice(currentPrice)}
              </div>
            </div>
            
            {/* Support Line */}
            {supportPrice && (
              <div style={{
                position: 'absolute',
                top: `${100 - getPositionPercent(supportPrice)}%`,
                left: 0,
                right: 0,
                height: 2,
                background: '#10b981',
                zIndex: 2
              }}>
                <div style={{
                  position: 'absolute',
                  right: 4,
                  top: -10,
                  fontSize: 8,
                  color: '#10b981',
                  fontWeight: 600,
                  background: 'white',
                  padding: '1px 4px',
                  borderRadius: 2
                }}>
                  S: {formatPrice(supportPrice)}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Pivot Levels (if available) */}
        {Object.keys(pivots).length > 0 && (
          <details style={{ fontSize: 11 }}>
            <summary style={{ 
              color: '#6b7280', 
              cursor: 'pointer',
              userSelect: 'none',
              fontWeight: 500
            }}>
              Pivot Levels ({Object.keys(pivots).length})
            </summary>
            <div style={{ marginTop: 4 }}>
              <Row gutter={[4, 4]}>
                {Object.entries(pivots).map(([key, value]) => {
                  if (!value || value <= 0) return null;
                  const distance = getDistancePercent(currentPrice, value);
                  const isAbove = value > currentPrice;
                  
                  return (
                    <Col span={8} key={key}>
                      <div style={{
                        padding: '4px 6px',
                        background: '#f9fafb',
                        borderRadius: 4,
                        textAlign: 'center',
                        border: `1px solid ${isAbove ? '#fca5a5' : '#86efac'}`
                      }}>
                        <div style={{ 
                          fontSize: 9, 
                          color: isAbove ? '#ef4444' : '#10b981',
                          fontWeight: 600
                        }}>
                          {key.toUpperCase()}
                        </div>
                        <div style={{ 
                          fontSize: 9, 
                          fontFamily: 'Monaco, monospace',
                          color: '#374151'
                        }}>
                          {formatPrice(value)}
                        </div>
                        <div style={{ fontSize: 8, color: '#9ca3af' }}>
                          {isAbove ? '+' : '-'}{distance.toFixed(1)}%
                        </div>
                      </div>
                    </Col>
                  );
                })}
              </Row>
            </div>
          </details>
        )}

        {/* Level Strength Indicators */}
        {(support?.strength || resistance?.strength) && (
          <Row gutter={[8, 8]}>
            {support?.strength && (
              <Col span={12}>
                <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 2 }}>
                  Support Strength
                </div>
                <Progress 
                  percent={support.strength}
                  strokeColor="#10b981"
                  size="small"
                  format={() => `${support.strength}%`}
                />
              </Col>
            )}
            {resistance?.strength && (
              <Col span={12}>
                <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 2 }}>
                  Resistance Strength
                </div>
                <Progress 
                  percent={resistance.strength}
                  strokeColor="#ef4444"
                  size="small"
                  format={() => `${resistance.strength}%`}
                />
              </Col>
            )}
          </Row>
        )}
      </Space>
    </Card>
  );
}
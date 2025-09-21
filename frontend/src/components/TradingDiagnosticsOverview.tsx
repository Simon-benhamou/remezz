import React from 'react';
import { Card, Row, Col, Badge, Progress, Space, Tooltip, Button, Tag, Typography } from 'antd';
import { RiseOutlined, FallOutlined, ThunderboltOutlined, ExclamationCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { api } from '../api';

const { Text, Title } = Typography;

interface CryptoSignal {
  symbol: string;
  signal: 'bullish' | 'bearish' | 'strong_buy' | 'strong_sell' | 'neutral' | 'caution';
  strength: number; // 0-100
  triggers: string[];
  price: number;
  change24h: number;
  volume24h: number;
  atr: number;
  rsi: number;
  trend: number;
  lastUpdated: string;
}

interface TradingDiagnosticsOverviewProps {
  activeSessions?: any[];
}

export default function TradingDiagnosticsOverview({ activeSessions = [] }: TradingDiagnosticsOverviewProps) {
  const [signals, setSignals] = React.useState<CryptoSignal[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [lastRefresh, setLastRefresh] = React.useState<Date | null>(null);
  const [dailyCallsUsed, setDailyCallsUsed] = React.useState(0);
  const [cacheInfo, setCacheInfo] = React.useState<any>(null);

  // Liste des cryptos populaires à surveiller
  const watchList = [
    'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'ADA/USDT',
    'DOGE/USDT', 'AVAX/USDT', 'MATIC/USDT', 'DOT/USDT', 'BNB/USDT', 'LINK/USDT'
  ];

  const loadTradingSignals = React.useCallback(async (forceRefresh = false) => {
    setLoading(true);
    try {
      const newSignals: CryptoSignal[] = [];
      
      for (const symbol of watchList) {
        try {
          // Use the new cache endpoint
          const endpoint = forceRefresh 
            ? `/api/cache/trading-diagnostics/${symbol}/refresh`
            : `/api/cache/trading-diagnostics/${symbol}`;
          
          const method = forceRefresh ? 'POST' : 'GET';
          const response = await api.client[method.toLowerCase() as 'get' | 'post'](endpoint);
          
          const { data, cached, timestamp, dailyCallsUsed: calls } = response.data;
          
          if (calls !== undefined) {
            setDailyCallsUsed(calls);
          }
          
          if (data) {
            const signal: CryptoSignal = {
              symbol,
              signal: data.technical?.trend > 0.6 ? 'bullish' : 
                     data.technical?.trend < -0.6 ? 'bearish' : 'neutral',
              strength: Math.abs(data.technical?.trend || 0) * 100,
              triggers: [
                data.technical?.atrPct > 2 ? 'High volatility' : 'Normal volatility',
                data.technical?.rsi14 > 70 ? 'Overbought' : 
                data.technical?.rsi14 < 30 ? 'Oversold' : 'Neutral RSI',
                data.strategy ? 'AI Strategy available' : 'Market analysis'
              ].filter(Boolean),
              price: data.technical?.last || 0,
              change24h: ((data.technical?.last || 1) - (data.technical?.prevClose || 1)) / (data.technical?.prevClose || 1) * 100,
              volume24h: data.technical?.volume24h || 0,
              atr: data.technical?.atr14 || 0,
              rsi: data.technical?.rsi14 || 50,
              trend: data.technical?.trend || 0,
              lastUpdated: timestamp
            };
            
            newSignals.push(signal);
            
            if (!cached && timestamp) {
              setCacheInfo({ 
                lastFresh: timestamp, 
                cached, 
                dailyCallsUsed: calls 
              });
            }
          }
        } catch (error: any) {
          console.warn(`Failed to load diagnostics for ${symbol}:`, error.message);
          
          // If daily limit exceeded, show fallback
          if (error.response?.status === 429) {
            const fallbackSignal: CryptoSignal = {
              symbol,
              signal: 'neutral',
              strength: 0,
              triggers: ['Daily limit reached - showing cached data'],
              price: 0,
              change24h: 0,
              volume24h: 0,
              atr: 0,
              rsi: 50,
              trend: 0,
              lastUpdated: new Date().toISOString()
            };
            newSignals.push(fallbackSignal);
          }
        }
      }

      // Trier par force du signal (plus forts en premier)
      const sortedSignals = newSignals.sort((a, b) => b.strength - a.strength);
      setSignals(sortedSignals);
      setLastRefresh(new Date());
    } catch (error) {
      console.error('Failed to load trading signals:', error);
    } finally {
      setLoading(false);
    }
  }, [watchList]);

  React.useEffect(() => {
    loadTradingSignals(false); // Use cache on initial load
    // Refresh automatique toutes les 30 minutes (au lieu de 5)
    const interval = setInterval(() => loadTradingSignals(false), 30 * 60 * 1000);
    return () => clearInterval(interval);
  }, [loadTradingSignals]);

  const getSignalIcon = (signal: string) => {
    switch (signal) {
      case 'strong_buy':
      case 'bullish':
        return <RiseOutlined style={{ color: '#10b981' }} />;
      case 'strong_sell':
      case 'bearish':
        return <FallOutlined style={{ color: '#ef4444' }} />;
      case 'caution':
        return <ExclamationCircleOutlined style={{ color: '#f59e0b' }} />;
      default:
        return <ThunderboltOutlined style={{ color: '#64748b' }} />;
    }
  };

  const getSignalColor = (signal: string) => {
    switch (signal) {
      case 'strong_buy': return '#059669';
      case 'bullish': return '#10b981';
      case 'strong_sell': return '#dc2626';
      case 'bearish': return '#ef4444';
      case 'caution': return '#f59e0b';
      default: return '#64748b';
    }
  };

  const getStrengthColor = (strength: number) => {
    if (strength >= 80) return '#059669';
    if (strength >= 60) return '#10b981';
    if (strength >= 40) return '#f59e0b';
    if (strength >= 20) return '#ef4444';
    return '#64748b';
  };

  // Filtrer les signaux les plus intéressants
  const hotSignals = signals.filter(s => s.strength > 60 && s.signal !== 'neutral');
  const activeSymbols = new Set(activeSessions.map(s => s.symbol));

  return (
    <Card
      style={{
        borderRadius: '16px',
        border: '1px solid #e2e8f0',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.08)',
        background: 'white'
      }}
      title={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{
              fontSize: '20px',
              fontWeight: '700',
              background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif'
            }}>
              🎯 Trading Diagnostics Overview
            </span>
            {hotSignals.length > 0 && (
              <Badge 
                count={hotSignals.length} 
                style={{ 
                  background: 'linear-gradient(135deg, #ef4444, #dc2626)',
                  fontSize: '10px',
                  fontWeight: '600'
                }} 
                title={`${hotSignals.length} hot signals detected`}
              />
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {/* Cache and API calls status */}
            <Space size="small">
              <Text style={{ fontSize: '12px', color: '#64748b' }}>
                Daily calls: {dailyCallsUsed}/5
              </Text>
              {cacheInfo?.cached && (
                <Tag color="blue" style={{ fontSize: '10px' }}>
                  Cached
                </Tag>
              )}
            </Space>
            {lastRefresh && (
              <Text style={{ fontSize: '12px', color: '#64748b' }}>
                Last: {lastRefresh.toLocaleTimeString()}
              </Text>
            )}
            <Button 
              icon={<ReloadOutlined />}
              onClick={() => loadTradingSignals(true)}
              loading={loading}
              size="small"
              style={{
                borderRadius: '8px',
                border: '1px solid #e2e8f0'
              }}
            >
              Refresh
            </Button>
          </div>
        </div>
      }
    >
      {/* Top Signals Row */}
      <Row gutter={[16, 16]} style={{ marginBottom: '24px' }}>
        {hotSignals.slice(0, 4).map((signal) => (
          <Col xs={24} sm={12} lg={6} key={signal.symbol}>
            <div style={{
              background: activeSymbols.has(signal.symbol) 
                ? 'linear-gradient(135deg, #f0f9ff, #e0f2fe)'
                : 'linear-gradient(135deg, #f9fafb, #f3f4f6)',
              border: activeSymbols.has(signal.symbol)
                ? '2px solid #0ea5e9'
                : '1px solid #e2e8f0',
              borderRadius: '12px',
              padding: '16px',
              position: 'relative'
            }}>
              {activeSymbols.has(signal.symbol) && (
                <div style={{
                  position: 'absolute',
                  top: '8px',
                  right: '8px',
                  background: '#0ea5e9',
                  color: 'white',
                  padding: '2px 6px',
                  borderRadius: '4px',
                  fontSize: '10px',
                  fontWeight: '600'
                }}>
                  ACTIVE
                </div>
              )}
              
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <Text strong style={{ fontSize: '14px', fontFamily: 'Monaco, "SF Mono", monospace' }}>
                  {signal.symbol}
                </Text>
                {getSignalIcon(signal.signal)}
              </div>
              
              <div style={{ marginBottom: '8px' }}>
                <Tag 
                  style={{
                    background: `${getSignalColor(signal.signal)}20`,
                    border: `1px solid ${getSignalColor(signal.signal)}40`,
                    color: getSignalColor(signal.signal),
                    fontSize: '10px',
                    fontWeight: '600',
                    margin: 0
                  }}
                >
                  {signal.signal.replace('_', ' ').toUpperCase()}
                </Tag>
              </div>
              
              <div style={{ marginBottom: '8px' }}>
                <Text style={{ fontSize: '11px', color: '#64748b' }}>Strength:</Text>
                <Progress 
                  percent={signal.strength} 
                  size="small"
                  strokeColor={getStrengthColor(signal.strength)}
                  format={() => `${signal.strength.toFixed(0)}%`}
                  style={{ fontSize: '10px' }}
                />
              </div>
              
              <div>
                <Text style={{ fontSize: '10px', color: '#64748b' }}>Triggers:</Text>
                <div style={{ marginTop: '4px' }}>
                  {signal.triggers.slice(0, 2).map((trigger, idx) => (
                    <div key={idx} style={{ 
                      fontSize: '10px', 
                      color: '#374151',
                      marginBottom: '2px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px'
                    }}>
                      <div style={{ 
                        width: '4px', 
                        height: '4px', 
                        borderRadius: '50%', 
                        background: getSignalColor(signal.signal) 
                      }} />
                      {trigger}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </Col>
        ))}
      </Row>

      {/* All Signals Grid */}
      <div style={{
        background: 'linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%)',
        borderRadius: '12px',
        padding: '16px'
      }}>
        <Title level={5} style={{ margin: '0 0 16px 0', color: '#374151' }}>
          All Monitored Symbols
        </Title>
        <Row gutter={[12, 12]}>
          {signals.map((signal) => (
            <Col xs={24} sm={12} md={8} lg={6} key={signal.symbol}>
              <div style={{
                background: 'white',
                border: activeSymbols.has(signal.symbol) 
                  ? '2px solid #0ea5e9' 
                  : '1px solid #e2e8f0',
                borderRadius: '8px',
                padding: '12px',
                fontSize: '12px',
                position: 'relative'
              }}>
                {activeSymbols.has(signal.symbol) && (
                  <div style={{
                    position: 'absolute',
                    top: '-8px',
                    right: '8px',
                    background: '#0ea5e9',
                    color: 'white',
                    padding: '2px 6px',
                    borderRadius: '4px',
                    fontSize: '9px',
                    fontWeight: '600'
                  }}>
                    TRADING
                  </div>
                )}
                
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <Text strong style={{ fontSize: '12px' }}>{signal.symbol}</Text>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {getSignalIcon(signal.signal)}
                    <span style={{ 
                      fontSize: '10px', 
                      color: getSignalColor(signal.signal),
                      fontWeight: '600'
                    }}>
                      {signal.strength.toFixed(0)}%
                    </span>
                  </div>
                </div>
                
                {signal.change24h !== 0 && (
                  <div style={{ 
                    fontSize: '11px',
                    color: signal.change24h >= 0 ? '#059669' : '#dc2626',
                    fontFamily: 'Monaco, "SF Mono", monospace'
                  }}>
                    {signal.change24h >= 0 ? '+' : ''}{signal.change24h.toFixed(2)}%
                  </div>
                )}
              </div>
            </Col>
          ))}
        </Row>
      </div>
    </Card>
  );
}
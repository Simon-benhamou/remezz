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

  // Liste des cryptos populaires à surveiller
  const watchList = [
    'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'ADA/USDT',
    'DOGE/USDT', 'AVAX/USDT', 'MATIC/USDT', 'DOT/USDT', 'BNB/USDT', 'LINK/USDT'
  ];

  const loadTradingSignals = React.useCallback(async () => {
    setLoading(true);
    try {
      // Simuler des données pour le moment - à remplacer par de vraies API calls
      const mockSignals: CryptoSignal[] = await Promise.all(
        watchList.map(async (symbol) => {
          try {
            // Essayer de récupérer des données réelles via l'analyse
            const analysis = await api.analysis(symbol).catch(() => null);
            const ticker = await api.getTicker(symbol).catch(() => null);
            
            // Mock data avec quelques vraies données si disponibles
            const baseStrength = Math.random() * 100;
            const signals = ['bullish', 'bearish', 'strong_buy', 'strong_sell', 'neutral', 'caution'] as const;
            const randomSignal = signals[Math.floor(Math.random() * signals.length)];
            
            return {
              symbol,
              signal: analysis?.signal || randomSignal,
              strength: analysis?.strength || baseStrength,
              triggers: analysis?.triggers || [
                baseStrength > 70 ? 'Strong momentum' : 'Low volatility',
                baseStrength > 60 ? 'Volume surge' : 'Consolidation',
                'RSI oversold'
              ].slice(0, Math.floor(Math.random() * 3) + 1),
              price: ticker?.price || (50000 + Math.random() * 20000),
              change24h: analysis?.change24h || (Math.random() - 0.5) * 10,
              volume24h: ticker?.volume24h || Math.random() * 1000000,
              atr: analysis?.atr || Math.random() * 5,
              rsi: analysis?.rsi || Math.random() * 100,
              trend: analysis?.trend || (Math.random() - 0.5) * 2,
              lastUpdated: new Date().toISOString()
            };
          } catch {
            // Fallback avec données mock
            const baseStrength = Math.random() * 100;
            return {
              symbol,
              signal: 'neutral' as const,
              strength: baseStrength,
              triggers: ['No data available'],
              price: 0,
              change24h: 0,
              volume24h: 0,
              atr: 0,
              rsi: 50,
              trend: 0,
              lastUpdated: new Date().toISOString()
            };
          }
        })
      );

      // Trier par force du signal (plus forts en premier)
      const sortedSignals = mockSignals.sort((a, b) => b.strength - a.strength);
      setSignals(sortedSignals);
      setLastRefresh(new Date());
    } catch (error) {
      console.error('Failed to load trading signals:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadTradingSignals();
    // Refresh automatique toutes les 5 minutes
    const interval = setInterval(loadTradingSignals, 5 * 60 * 1000);
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
            {lastRefresh && (
              <Text style={{ fontSize: '12px', color: '#64748b' }}>
                Last: {lastRefresh.toLocaleTimeString()}
              </Text>
            )}
            <Button 
              icon={<ReloadOutlined />}
              onClick={loadTradingSignals}
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
import React from 'react';
import { Card, Row, Col, Badge, Button, Typography, Spin } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { api } from '../api';

const { Text, Title } = Typography;

interface CryptoSignal {
  symbol: string;
  signal: string;
  strength: number;
  triggers: string[];
  price: number;
  change24h: number;
  error?: string;
}

interface BatchResponse {
  success: boolean;
  data: CryptoSignal[];
  metadata: {
    totalSymbols: number;
    successCount: number;
    errorCount: number;
    apiCallsUsed: number;
    processingTimeMs: number;
  };
}

interface TradingDiagnosticsOverviewProps {
  activeSessions?: any[];
}

export default function TradingDiagnosticsOverview({ activeSessions = [] }: TradingDiagnosticsOverviewProps) {
  const [signals, setSignals] = React.useState<CryptoSignal[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [lastRefresh, setLastRefresh] = React.useState<Date | null>(null);
  const [metadata, setMetadata] = React.useState<BatchResponse['metadata'] | null>(null);

  const watchList = [
    'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'ADA/USDT', 'BNB/USDT',
    'DOGE/USDT', 'AVAX/USDT', 'MATIC/USDT', 'DOT/USDT', 'LINK/USDT'
  ];

  const loadTradingSignals = React.useCallback(async (forceRefresh = false) => {
    setLoading(true);
    try {
      console.log('🚀 Loading batch trading diagnostics...');
      
      const response = await api.client.post<BatchResponse>('/api/batch/trading-diagnostics', {
        symbols: watchList,
        includeStrategy: true,
        includeSentiment: false,
        includeNews: false,
        forceRefresh
      });

      if (response.data.success) {
        setSignals(response.data.data);
        setMetadata(response.data.metadata);
        setLastRefresh(new Date());
        
        console.log('✅ Batch analysis completed:', {
          symbols: response.data.metadata.totalSymbols,
          successful: response.data.metadata.successCount,
          apiCalls: response.data.metadata.apiCallsUsed,
          processingTime: response.data.metadata.processingTimeMs + 'ms'
        });
      }
    } catch (error: any) {
      console.error('❌ Failed to load batch trading signals:', error);
      
      const fallbackSignals: CryptoSignal[] = watchList.map(symbol => ({
        symbol,
        signal: 'neutral',
        strength: 0,
        triggers: ['Analysis unavailable'],
        price: 0,
        change24h: 0,
        error: error.message
      }));
      
      setSignals(fallbackSignals);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadTradingSignals(false);
    const interval = setInterval(() => loadTradingSignals(false), 30 * 60 * 1000);
    return () => clearInterval(interval);
  }, [loadTradingSignals]);

  const hotSignals = signals.filter(s => s.strength > 60 && s.signal !== 'neutral' && !s.error);

  return (
    <Card
      title={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span>🎯 Trading Diagnostics Overview</span>
            {hotSignals.length > 0 && <Badge count={hotSignals.length} />}
            {loading && <Spin size="small" />}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {lastRefresh && (
              <Text style={{ fontSize: '12px', color: '#64748b' }}>
                Last: {lastRefresh.toLocaleTimeString()}
              </Text>
            )}
            <Button
              icon={<ReloadOutlined />}
              onClick={() => loadTradingSignals(false)}
              loading={loading}
              size="small"
            >
              Refresh
            </Button>
          </div>
        </div>
      }
    >
      {metadata && (
        <div style={{ marginBottom: '16px', padding: '12px', background: '#f0f9ff', borderRadius: '8px' }}>
          <Row gutter={16}>
            <Col span={6}>
              <Text style={{ fontSize: '12px', color: '#0369a1' }}>Symbols</Text>
              <div style={{ fontSize: '18px', fontWeight: '700', color: '#0284c7' }}>
                {metadata.successCount}/{metadata.totalSymbols}
              </div>
            </Col>
            <Col span={6}>
              <Text style={{ fontSize: '12px', color: '#0369a1' }}>API Calls</Text>
              <div style={{ fontSize: '18px', fontWeight: '700', color: '#0284c7' }}>
                {metadata.apiCallsUsed}
              </div>
            </Col>
            <Col span={6}>
              <Text style={{ fontSize: '12px', color: '#0369a1' }}>Time</Text>
              <div style={{ fontSize: '18px', fontWeight: '700', color: '#0284c7' }}>
                {metadata.processingTimeMs}ms
              </div>
            </Col>
            <Col span={6}>
              <Text style={{ fontSize: '12px', color: '#0369a1' }}>Hot Signals</Text>
              <div style={{ fontSize: '18px', fontWeight: '700', color: '#ef4444' }}>
                {hotSignals.length}
              </div>
            </Col>
          </Row>
        </div>
      )}

      <div style={{ background: '#f8fafc', borderRadius: '12px', padding: '16px' }}>
        <Title level={5} style={{ margin: '0 0 16px 0', color: '#374151' }}>
          All Monitored Symbols ({signals.length})
        </Title>
        
        <Row gutter={[12, 12]}>
          {signals.map(signal => (
            <Col xs={24} sm={12} md={8} lg={6} key={signal.symbol}>
              <div style={{
                background: 'white',
                border: '1px solid #e2e8f0',
                borderRadius: '8px',
                padding: '12px',
                fontSize: '12px'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <Text strong style={{ fontSize: '12px' }}>{signal.symbol}</Text>
                  <span style={{ fontSize: '10px', fontWeight: '600' }}>
                    {signal.strength}%
                  </span>
                </div>
                
                {signal.change24h !== 0 && (
                  <div style={{
                    fontSize: '11px',
                    color: signal.change24h >= 0 ? '#059669' : '#dc2626',
                    fontFamily: 'Monaco, monospace'
                  }}>
                    {signal.change24h >= 0 ? '+' : ''}{signal.change24h.toFixed(2)}%
                  </div>
                )}

                {signal.price > 0 && (
                  <div style={{
                    fontSize: '11px',
                    color: '#374151',
                    fontFamily: 'Monaco, monospace'
                  }}>
                    ${signal.price.toFixed(signal.price > 100 ? 2 : 4)}
                  </div>
                )}

                {signal.error && (
                  <div style={{ fontSize: '9px', color: '#dc2626', marginTop: '4px' }}>
                    ⚠ {signal.error}
                  </div>
                )}
              </div>
            </Col>
          ))}
        </Row>

        <div style={{ 
          marginTop: '12px', 
          padding: '8px', 
          background: '#ecfdf5', 
          borderRadius: '6px',
          fontSize: '11px',
          color: '#059669',
          textAlign: 'center'
        }}>
          ✨ <strong>Single API call</strong> analyzed {watchList.length} symbols!
          {metadata && (
            <span> • Processed in {metadata.processingTimeMs}ms • Used {metadata.apiCallsUsed} API calls</span>
          )}
        </div>
      </div>
    </Card>
  );
}

import React from 'react';
import { Card, Button, Table, Tag, Progress, Space, Typography, Select, InputNumber, Switch, Badge, Tooltip } from 'antd';
import { ReloadOutlined, RocketOutlined, TrophyOutlined, FireOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { api } from '../api';

const { Text, Title } = Typography;
const { Option } = Select;

interface CryptoOpportunity {
  symbol: string;
  price: number;
  change24h: number;
  volume24h: number;
  momentum: number;
  volatility: number;
  trend: string;
  signals: string[];
  rank: number;
  analysis?: any;
}

interface ScannerResponse {
  success: boolean;
  data: {
    opportunities: CryptoOpportunity[];
    recommendation: {
      symbol: string;
      reason: string;
      alternatives: Array<{symbol: string; reason: string}>;
    } | null;
    metadata: {
      scannedSymbols: number;
      qualifiedOpportunities: number;
      criteria: any;
      scanTime: string;
    };
  };
}

interface SmartOpportunityScannerProps {
  onSymbolSelect?: (symbol: string) => void;
  onAutoTrade?: (symbol: string) => void;
}

export default function SmartOpportunityScanner({ onSymbolSelect, onAutoTrade }: SmartOpportunityScannerProps) {
  const [opportunities, setOpportunities] = React.useState<CryptoOpportunity[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [recommendation, setRecommendation] = React.useState<ScannerResponse['data']['recommendation']>(null);
  const [metadata, setMetadata] = React.useState<ScannerResponse['data']['metadata'] | null>(null);
  const [lastScan, setLastScan] = React.useState<Date | null>(null);
  
  // Options de scan
  const [timeframe, setTimeframe] = React.useState<'1h' | '4h' | '24h'>('24h');
  const [minVolume, setMinVolume] = React.useState(1000000);
  const [maxSymbols, setMaxSymbols] = React.useState(20);
  const [sortBy, setSortBy] = React.useState<'volume' | 'change' | 'momentum'>('momentum');
  const [autoRefresh, setAutoRefresh] = React.useState(false);

  const scanOpportunities = React.useCallback(async () => {
    setLoading(true);
    try {
      console.log('🔍 Scanning crypto opportunities...');
      
      const response = await api.client.post<ScannerResponse>('/api/scanner/opportunities', {
        timeframe,
        minVolume,
        maxSymbols,
        sortBy,
        includeAnalysis: true
      });

      if (response.data.success) {
        setOpportunities(response.data.data.opportunities);
        setRecommendation(response.data.data.recommendation);
        setMetadata(response.data.data.metadata);
        setLastScan(new Date());
        
        console.log('✅ Scan completed:', {
          found: response.data.data.opportunities.length,
          recommended: response.data.data.recommendation?.symbol,
          scanned: response.data.data.metadata.scannedSymbols
        });
      }
    } catch (error: any) {
      console.error('❌ Failed to scan opportunities:', error);
    } finally {
      setLoading(false);
    }
  }, [timeframe, minVolume, maxSymbols, sortBy]);

  React.useEffect(() => {
    scanOpportunities();
  }, [scanOpportunities]);

  React.useEffect(() => {
    if (!autoRefresh) return;
    
    const interval = setInterval(() => {
      scanOpportunities();
    }, 5 * 60 * 1000); // Refresh every 5 minutes
    
    return () => clearInterval(interval);
  }, [autoRefresh, scanOpportunities]);

  const getTrendIcon = (trend: string) => {
    switch (trend) {
      case 'bullish': return <FireOutlined style={{ color: '#10b981' }} />;
      case 'bearish': return <ThunderboltOutlined style={{ color: '#ef4444' }} />;
      default: return <ThunderboltOutlined style={{ color: '#64748b' }} />;
    }
  };

  const getTrendColor = (trend: string) => {
    switch (trend) {
      case 'bullish': return 'success';
      case 'bearish': return 'error';
      default: return 'default';
    }
  };

  const getMomentumColor = (momentum: number) => {
    if (momentum >= 8) return '#059669';
    if (momentum >= 6) return '#10b981';
    if (momentum >= 4) return '#f59e0b';
    if (momentum >= 2) return '#ef4444';
    return '#64748b';
  };

  const formatVolume = (volume: number) => {
    if (volume >= 1e9) return `${(volume / 1e9).toFixed(1)}B`;
    if (volume >= 1e6) return `${(volume / 1e6).toFixed(1)}M`;
    if (volume >= 1e3) return `${(volume / 1e3).toFixed(1)}K`;
    return volume.toFixed(0);
  };

  const columns = [
    {
      title: 'Rank',
      dataIndex: 'rank',
      width: 60,
      render: (rank: number) => (
        <div style={{ textAlign: 'center' }}>
          {rank <= 3 ? (
            <Badge count={rank} style={{ 
              backgroundColor: rank === 1 ? '#FFD700' : rank === 2 ? '#C0C0C0' : '#CD7F32',
              color: '#000',
              fontWeight: 'bold'
            }} />
          ) : (
            <span style={{ color: '#999', fontSize: '12px' }}>#{rank}</span>
          )}
        </div>
      )
    },
    {
      title: 'Symbol',
      dataIndex: 'symbol',
      width: 100,
      render: (symbol: string, record: CryptoOpportunity) => (
        <div>
          <Text strong style={{ fontSize: '14px' }}>{symbol}</Text>
          <div>{getTrendIcon(record.trend)}</div>
        </div>
      )
    },
    {
      title: 'Price',
      dataIndex: 'price',
      width: 120,
      render: (price: number) => (
        <Text style={{ fontFamily: 'Monaco, monospace', fontSize: '12px' }}>
          ${price > 100 ? price.toFixed(2) : price.toFixed(4)}
        </Text>
      )
    },
    {
      title: '24h Change',
      dataIndex: 'change24h',
      width: 100,
      render: (change: number) => (
        <Tag color={change >= 0 ? 'green' : 'red'} style={{ fontFamily: 'Monaco, monospace' }}>
          {change >= 0 ? '+' : ''}{change.toFixed(2)}%
        </Tag>
      )
    },
    {
      title: 'Volume 24h',
      dataIndex: 'volume24h',
      width: 100,
      render: (volume: number) => (
        <Text style={{ fontSize: '12px' }}>
          ${formatVolume(volume)}
        </Text>
      )
    },
    {
      title: 'Momentum',
      dataIndex: 'momentum',
      width: 120,
      render: (momentum: number) => (
        <div>
          <Progress
            percent={(momentum / 10) * 100}
            size="small"
            strokeColor={getMomentumColor(momentum)}
            format={() => momentum.toFixed(1)}
            style={{ width: '80px' }}
          />
        </div>
      )
    },
    {
      title: 'Signals',
      dataIndex: 'signals',
      render: (signals: string[]) => (
        <div>
          {signals.slice(0, 2).map((signal, index) => (
            <Tag key={index} style={{ fontSize: '10px', margin: '1px' }}>
              {signal}
            </Tag>
          ))}
          {signals.length > 2 && (
            <Tooltip title={signals.slice(2).join(', ')}>
              <Tag style={{ fontSize: '10px' }}>+{signals.length - 2}</Tag>
            </Tooltip>
          )}
        </div>
      )
    },
    {
      title: 'Action',
      width: 120,
      render: (_: any, record: CryptoOpportunity) => (
        <Space size="small">
          <Button 
            size="small" 
            onClick={() => onSymbolSelect?.(record.symbol)}
            icon={<RocketOutlined />}
          >
            Select
          </Button>
          {onAutoTrade && (
            <Button 
              size="small" 
              type="primary"
              onClick={() => onAutoTrade(record.symbol)}
              icon={<TrophyOutlined />}
            >
              Trade
            </Button>
          )}
        </Space>
      )
    }
  ];

  return (
    <Card
      title={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <RocketOutlined style={{ color: '#1890ff' }} />
            <span style={{ fontWeight: '700' }}>Smart Opportunity Scanner</span>
            {loading && <Badge status="processing" text="Scanning..." />}
          </div>
          <Space>
            {lastScan && (
              <Text style={{ fontSize: '12px', color: '#64748b' }}>
                Last scan: {lastScan.toLocaleTimeString()}
              </Text>
            )}
            <Button
              icon={<ReloadOutlined />}
              onClick={scanOpportunities}
              loading={loading}
              size="small"
            >
              Scan
            </Button>
          </Space>
        </div>
      }
    >
      {/* Recommendation Banner */}
      {recommendation && (
        <Card 
          size="small" 
          style={{ 
            marginBottom: '16px', 
            background: 'linear-gradient(135deg, #e6f7ff 0%, #f6ffed 100%)',
            border: '1px solid #91d5ff'
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <Title level={5} style={{ margin: 0, color: '#0050b3' }}>
                🎯 Top Recommendation: {recommendation.symbol}
              </Title>
              <Text style={{ fontSize: '12px', color: '#0050b3' }}>
                {recommendation.reason}
              </Text>
            </div>
            <Space>
              <Button 
                type="primary" 
                size="small"
                onClick={() => onSymbolSelect?.(recommendation.symbol)}
              >
                Select {recommendation.symbol}
              </Button>
              {onAutoTrade && (
                <Button 
                  type="primary" 
                  size="small"
                  style={{ background: '#52c41a', borderColor: '#52c41a' }}
                  onClick={() => onAutoTrade(recommendation.symbol)}
                >
                  Auto Trade
                </Button>
              )}
            </Space>
          </div>
        </Card>
      )}

      {/* Scan Controls */}
      <Card size="small" style={{ marginBottom: '16px', background: '#fafafa' }}>
        <Space wrap>
          <div>
            <Text style={{ fontSize: '12px', color: '#666' }}>Timeframe:</Text>
            <Select 
              value={timeframe} 
              onChange={setTimeframe} 
              size="small" 
              style={{ width: 80, marginLeft: 4 }}
            >
              <Option value="1h">1h</Option>
              <Option value="4h">4h</Option>
              <Option value="24h">24h</Option>
            </Select>
          </div>
          
          <div>
            <Text style={{ fontSize: '12px', color: '#666' }}>Min Volume:</Text>
            <InputNumber
              value={minVolume / 1000000}
              onChange={(val) => setMinVolume((val || 1) * 1000000)}
              size="small"
              style={{ width: 80, marginLeft: 4 }}
              min={0.1}
              step={0.5}
              suffix="M"
            />
          </div>
          
          <div>
            <Text style={{ fontSize: '12px', color: '#666' }}>Max Symbols:</Text>
            <InputNumber
              value={maxSymbols}
              onChange={(val) => setMaxSymbols(val || 20)}
              size="small"
              style={{ width: 80, marginLeft: 4 }}
              min={5}
              max={50}
            />
          </div>
          
          <div>
            <Text style={{ fontSize: '12px', color: '#666' }}>Sort by:</Text>
            <Select 
              value={sortBy} 
              onChange={setSortBy} 
              size="small" 
              style={{ width: 100, marginLeft: 4 }}
            >
              <Option value="momentum">Momentum</Option>
              <Option value="volume">Volume</Option>
              <Option value="change">Change</Option>
            </Select>
          </div>
          
          <div>
            <Text style={{ fontSize: '12px', color: '#666' }}>Auto Refresh:</Text>
            <Switch 
              checked={autoRefresh} 
              onChange={setAutoRefresh} 
              size="small"
              style={{ marginLeft: 4 }}
            />
          </div>
        </Space>
      </Card>

      {/* Scan Stats */}
      {metadata && (
        <div style={{ 
          marginBottom: '16px', 
          padding: '8px 12px', 
          background: '#f0f9ff', 
          borderRadius: '6px',
          fontSize: '12px',
          color: '#0369a1'
        }}>
          <Space split={<span style={{ color: '#bae6fd' }}>|</span>}>
            <span>📊 Scanned: <strong>{metadata.scannedSymbols}</strong> symbols</span>
            <span>✅ Qualified: <strong>{metadata.qualifiedOpportunities}</strong> opportunities</span>
            <span>⏱️ Scan time: <strong>{new Date(metadata.scanTime).toLocaleTimeString()}</strong></span>
          </Space>
        </div>
      )}

      {/* Opportunities Table */}
      <Table
        dataSource={opportunities}
        columns={columns}
        rowKey="symbol"
        size="small"
        pagination={{
          pageSize: 10,
          showSizeChanger: false,
          showQuickJumper: false,
          showTotal: (total) => `${total} opportunities`
        }}
        scroll={{ x: 800 }}
        loading={loading}
      />

      {/* Bottom Info */}
      <div style={{ 
        marginTop: '12px', 
        padding: '8px', 
        background: '#ecfdf5', 
        borderRadius: '6px',
        fontSize: '11px',
        color: '#059669',
        textAlign: 'center'
      }}>
        💡 <strong>Smart Scanner</strong> analyzes {maxSymbols} popular perpetuals with aggressive trading-focused scoring.
        <strong> Guaranteed to find tradable opportunities!</strong>
        {autoRefresh && <span> 🔄 Auto-refreshing every 5 minutes.</span>}
      </div>
    </Card>
  );
}
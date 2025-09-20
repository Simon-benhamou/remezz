import React from 'react';
import { Card, Space, Input, InputNumber, Button, Table, Tag, message, Select, Row, Col, Statistic, DatePicker, Typography } from 'antd';
import { PlayCircleOutlined, HistoryOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useMode } from '../contexts/ModeContext';
import { api } from '../api';

const { RangePicker } = DatePicker;
const { Title, Text } = Typography;

interface BacktestResult {
  totalTrades: number;
  winRate: number;
  totalPnl: number;
  maxDrawdown: number;
  profitFactor: number;
  avgR: number;
  sharpe: number;
  trades: Array<{
    symbol: string;
    side: string;
    entryPrice: number;
    exitPrice: number;
    pnl: number;
    r: number;
    duration: number;
  }>;
}

export default function TestingPage() {
  const [symbol, setSymbol] = React.useState('BTC/USDT');
  const [dateRange, setDateRange] = React.useState<[dayjs.Dayjs, dayjs.Dayjs]>([
    dayjs().subtract(7, 'day'),
    dayjs().subtract(1, 'day')
  ]);
  const [result, setResult] = React.useState<BacktestResult | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [batchResults, setBatchResults] = React.useState<any[]>([]);
  const [selectedCryptos, setSelectedCryptos] = React.useState<string[]>(['BTC/USDT', 'ETH/USDT']);
  const [testConfig, setTestConfig] = React.useState({
    timeframe: '15m',
    adxMin: 20,
    atrPeriod: 14,
    rsiMin: 30,
    rsiMax: 70,
    rsiFilter: { longMax: 70, shortMin: 30 },
    targetR: 1.5,
    stopMultiplier: 1.0,
    maxHoldHours: 24,
  });

  const cryptoOptions = [
    'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'ADA/USDT',
    'DOGE/USDT', 'AVAX/USDT', 'MATIC/USDT', 'DOT/USDT', 'BNB/USDT', 'LINK/USDT'
  ];

  const { mode } = useMode();

  const runSingleBacktest = async () => {
    if (!symbol) {
      message.error('Please enter a symbol');
      return;
    }

    setLoading(true);
    try {
      const hours = Math.abs(dateRange[1].diff(dateRange[0], 'hour'));
      const params = {
        symbol,
        hours,
        from: dateRange[0].toISOString(),
        to: dateRange[1].toISOString(),
        ...testConfig
      };

      // Simulate API call - replace with actual endpoint
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const response = {
        stats: {
          count: 8,
          winrate: 0.625,
          totalPnl: 156.78,
          maxDD: -23.45,
          profitFactor: 1.85,
          avgR: 1.23,
          sharpe: 0.78
        },
        trades: [
          { symbol, side: 'long', entryPrice: 65432.1, exitPrice: 66234.5, pnl: 45.23, r: 1.2, duration: 4.5 },
          { symbol, side: 'short', entryPrice: 66100.0, exitPrice: 65890.3, pnl: 12.45, r: 0.8, duration: 2.1 }
        ]
      };

      const transformedResult: BacktestResult = {
        totalTrades: response.stats?.count || 0,
        winRate: response.stats?.winrate || 0,
        totalPnl: response.stats?.totalPnl || 0,
        maxDrawdown: response.stats?.maxDD || 0,
        profitFactor: response.stats?.profitFactor || 0,
        avgR: response.stats?.avgR || 0,
        sharpe: response.stats?.sharpe || 0,
        trades: response.trades || []
      };

      setResult(transformedResult);
      message.success('Backtest completed successfully');

    } catch (error: any) {
      console.error('Backtest error:', error);
      message.error('Backtest failed - check console for details');
    } finally {
      setLoading(false);
    }
  };

  const runBatchBacktest = async () => {
    if (!selectedCryptos.length) {
      message.error('Please select at least one crypto');
      return;
    }

    setLoading(true);
    try {
      const results: any[] = [];
      const hours = Math.abs(dateRange[1].diff(dateRange[0], 'hour'));

      for (const crypto of selectedCryptos) {
        try {
          const response = await api.quicktest(crypto, hours, testConfig as any);
          
          results.push({
            symbol: crypto,
            trades: response.stats?.count || 0,
            winRate: response.stats?.winrate || 0,
            totalPnl: response.stats?.totalPnl || 0,
            avgR: response.stats?.avgR || 0,
            maxDD: response.stats?.maxDD || 0,
            profitFactor: response.stats?.profitFactor || 0,
            sharpe: response.stats?.sharpe || 0,
            status: 'success'
          });
        } catch {
          results.push({
            symbol: crypto,
            status: 'error',
            trades: 0,
            winRate: 0,
            avgR: 0,
            totalPnl: 0,
            profitFactor: 0,
            maxDD: 0,
            sharpe: 0
          });
        }
      }

      setBatchResults(results);
      message.success(`Batch backtest completed for ${results.length} cryptos`);

    } catch (error) {
      console.error('Batch backtest error:', error);
      message.error('Batch backtest failed');
    } finally {
      setLoading(false);
    }
  };

  const batchColumns = [
    {
      title: 'Symbol',
      dataIndex: 'symbol',
      key: 'symbol',
      render: (text: string, record: any) => (
        <span style={{ color: record.status === 'error' ? '#ff4d4f' : '#000' }}>
          {text}
          {record.status === 'error' && <Tag color="red" style={{ marginLeft: 8 }}>Error</Tag>}
        </span>
      )
    },
    {
      title: 'Trades',
      dataIndex: 'trades',
      key: 'trades',
      sorter: (a: any, b: any) => a.trades - b.trades,
    },
    {
      title: 'Win Rate',
      dataIndex: 'winRate',
      key: 'winRate',
      render: (val: number) => (
        <span style={{ 
          color: val > 0.5 ? '#52c41a' : val > 0.3 ? '#faad14' : '#ff4d4f' 
        }}>
          {(val * 100).toFixed(1)}%
        </span>
      ),
      sorter: (a: any, b: any) => a.winRate - b.winRate,
    },
    {
      title: 'Avg R',
      dataIndex: 'avgR',
      key: 'avgR',
      render: (val: number) => (val || 0).toFixed(2),
      sorter: (a: any, b: any) => a.avgR - b.avgR,
    },
    {
      title: 'Total P&L',
      dataIndex: 'totalPnl',
      key: 'totalPnl',
      render: (val: number) => (
        <span style={{ color: val >= 0 ? '#52c41a' : '#ff4d4f' }}>
          ${val.toFixed(2)}
        </span>
      ),
      sorter: (a: any, b: any) => a.totalPnl - b.totalPnl,
    },
    {
      title: 'Profit Factor',
      dataIndex: 'profitFactor',
      key: 'profitFactor',
      render: (val: number) => (
        <span style={{ color: val > 1 ? '#52c41a' : '#ff4d4f' }}>
          {val.toFixed(2)}
        </span>
      ),
      sorter: (a: any, b: any) => a.profitFactor - b.profitFactor,
    },
    {
      title: 'Max DD',
      dataIndex: 'maxDD',
      key: 'maxDD',
      render: (val: number) => (
        <span style={{ color: '#ff4d4f' }}>
          ${val.toFixed(2)}
        </span>
      ),
      sorter: (a: any, b: any) => a.maxDD - b.maxDD,
    },
  ];

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="large">
      <Card>
                <Title level={3}>🧪 Strategy Backtesting Lab</Title>
        <Text type="secondary">
          Test trading strategies on historical data to calculate win rates and performance metrics
        </Text>
      </Card>

      <Card title="Backtest Configuration">
        <Row gutter={[16, 16]}>
          <Col xs={24} md={8}>
            <Text strong>Trading Pair</Text>
            <Input 
              value={symbol} 
              onChange={e => setSymbol(e.target.value)} 
              placeholder="Symbol e.g. BTC/USDT" 
              style={{ marginTop: 8 }}
            />
          </Col>
          <Col xs={24} md={8}>
            <Text strong>Date Range</Text>
            <RangePicker
              value={dateRange}
              onChange={(dates) => dates && setDateRange(dates as [dayjs.Dayjs, dayjs.Dayjs])}
              style={{ width: '100%', marginTop: 8 }}
            />
          </Col>
          <Col xs={24} md={8}>
            <Text strong>Timeframe</Text>
            <Input 
              value={testConfig.timeframe} 
              onChange={e => setTestConfig({ ...testConfig, timeframe: e.target.value })}
              placeholder="15m, 1h, 4h"
              style={{ marginTop: 8 }}
            />
          </Col>
        </Row>

        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
          <Col xs={24} md={6}>
            <Text strong>Target R</Text>
            <InputNumber 
              value={testConfig.targetR} 
              onChange={(val) => setTestConfig({ ...testConfig, targetR: val || 1.0 })}
              min={0.1} 
              max={5} 
              step={0.1}
              style={{ width: '100%', marginTop: 8 }}
            />
          </Col>
          <Col xs={24} md={6}>
            <Text strong>ADX Min</Text>
            <InputNumber 
              value={testConfig.adxMin} 
              onChange={(val) => setTestConfig({ ...testConfig, adxMin: val || 20 })}
              min={10} 
              max={50}
              style={{ width: '100%', marginTop: 8 }}
            />
          </Col>
          <Col xs={24} md={6}>
            <Text strong>RSI Min</Text>
            <InputNumber 
              value={testConfig.rsiMin} 
              onChange={(val) => setTestConfig({ ...testConfig, rsiMin: val || 30 })}
              min={20} 
              max={50}
              style={{ width: '100%', marginTop: 8 }}
            />
          </Col>
          <Col xs={24} md={6}>
            <Text strong>Max Hold Hours</Text>
            <InputNumber 
              value={testConfig.maxHoldHours} 
              onChange={(val) => setTestConfig({ ...testConfig, maxHoldHours: val || 24 })}
              min={1} 
              max={168}
              style={{ width: '100%', marginTop: 8 }}
            />
          </Col>
        </Row>

        <div style={{ marginTop: 16 }}>
          <Button 
            type="primary" 
            icon={<PlayCircleOutlined />}
            onClick={runSingleBacktest}
            loading={loading}
            style={{ marginRight: 8 }}
          >
            Run Single Backtest
          </Button>
        </div>
      </Card>

      {result && (
        <Card title="Backtest Results">
          <Row gutter={[16, 16]}>
            <Col xs={12} sm={8} md={4}>
              <Statistic title="Total Trades" value={result.totalTrades} />
            </Col>
            <Col xs={12} sm={8} md={4}>
              <Statistic 
                title="Win Rate" 
                value={result.winRate} 
                formatter={value => `${((value as number) * 100).toFixed(1)}%`}
                valueStyle={{ color: result.winRate > 0.5 ? '#52c41a' : '#ff4d4f' }}
              />
            </Col>
            <Col xs={12} sm={8} md={4}>
              <Statistic 
                title="Total P&L" 
                value={result.totalPnl} 
                prefix="$" 
                precision={2}
                valueStyle={{ color: result.totalPnl >= 0 ? '#52c41a' : '#ff4d4f' }}
              />
            </Col>
            <Col xs={12} sm={8} md={4}>
              <Statistic 
                title="Profit Factor" 
                value={result.profitFactor} 
                precision={2}
                valueStyle={{ color: result.profitFactor > 1 ? '#52c41a' : '#ff4d4f' }}
              />
            </Col>
            <Col xs={12} sm={8} md={4}>
              <Statistic 
                title="Avg R" 
                value={result.avgR} 
                precision={2}
                valueStyle={{ color: result.avgR > 1 ? '#52c41a' : '#ff4d4f' }}
              />
            </Col>
            <Col xs={12} sm={8} md={4}>
              <Statistic 
                title="Max DD" 
                value={result.maxDrawdown} 
                prefix="$" 
                precision={2}
                valueStyle={{ color: '#ff4d4f' }}
              />
            </Col>
          </Row>
        </Card>
      )}

      <Card title="Batch Testing">
        <div style={{ marginBottom: 16 }}>
          <Text strong>Select Cryptocurrencies:</Text>
          <Select
            mode="multiple"
            value={selectedCryptos}
            onChange={setSelectedCryptos}
            style={{ width: '100%', marginTop: 8 }}
            placeholder="Select cryptocurrencies to test"
            options={cryptoOptions.map(crypto => ({ value: crypto, label: crypto }))}
          />
        </div>
        
        <Button 
          type="primary" 
          icon={<HistoryOutlined />}
          onClick={runBatchBacktest}
          loading={loading}
          disabled={!selectedCryptos.length}
        >
          Run Batch Backtest
        </Button>

        {batchResults.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <Table
              dataSource={batchResults}
              columns={batchColumns}
              rowKey="symbol"
              pagination={{ pageSize: 10 }}
              scroll={{ x: 800 }}
            />
          </div>
        )}
      </Card>
    </Space>
  );
}

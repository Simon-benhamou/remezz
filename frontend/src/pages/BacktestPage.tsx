import React, { useEffect, useMemo, useState } from 'react';
import {
  Card,
  Form,
  DatePicker,
  InputNumber,
  Select,
  Button,
  Typography,
  Spin,
  Table,
  Statistic,
  Row,
  Col,
  Tag,
  Tabs,
  Space,
  List,
  message,
  Progress,
  Tooltip,
  Empty,
  Alert,
} from 'antd';
import {
  LineChartOutlined,
  DollarOutlined,
  PercentageOutlined,
  ThunderboltOutlined,
  WarningOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  FilterOutlined,
  DownloadOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { ArrowUpRight, ArrowDownRight, TrendingUp, TrendingDown } from 'lucide-react';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import type { ColumnsType } from 'antd/es/table';
import { api } from '../api';

const { Title, Text, Paragraph } = Typography;
const { RangePicker } = DatePicker;

// ============================================================================
// TYPES
// ============================================================================

interface BacktestTrade {
  id: string;
  symbol: string;
  side: 'long' | 'short';
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  notionalUsd: number;
  marginUsd: number;
  leverage: number;
  holdMinutes: number;
  grossPnlPct: number;
  netPnlPct: number;
  netPnlUsd: number;
  feesUsd: number;
  exitReason: string;
  capitalBefore: number;
  capitalAfter: number;
  month: string;
  day: string;
  wasCapped: boolean;
  slippagePct: number;
}

interface MonthlyStats {
  month: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  pnlUsd: number;
  pnlPct: number;
  longTrades: number;
  shortTrades: number;
  avgTradeUsd: number;
  maxWinUsd: number;
  maxLossUsd: number;
  capitalStart: number;
  capitalEnd: number;
}

interface BacktestResult {
  runId?: string;
  cachedAt?: string;
  cacheHit?: boolean;
  params: {
    startDate: string;
    endDate: string;
    initialCapital: number;
    symbols: string[];
    leverage: number;
  };
  summary: {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnlUsd: number;
    totalPnlPct: number;
    maxDrawdownPct: number;
    avgTradeUsd: number;
    avgWinUsd: number;
    avgLossUsd: number;
    profitFactor: number;
    sharpeRatio: number;
    finalCapital: number;
    longTrades: number;
    shortTrades: number;
    avgHoldMinutes: number;
    totalFeesUsd: number;
  };
  trades: BacktestTrade[];
  monthlyStats: MonthlyStats[];
  equityCurve: { date: string; equity: number }[];
  drawdownCurve: { date: string; drawdown: number }[];
}

type BacktestRunListItem = {
  id: string;
  createdAt: string;
  params: BacktestResult['params'];
  summary: BacktestResult['summary'];
};

// ============================================================================
// HELPER COMPONENTS
// ============================================================================

const formatCurrency = (value: number) => {
  const sign = value >= 0 ? '+' : '';
  return `${sign}$${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const formatPercent = (value: number) => {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
};

const SideTag: React.FC<{ side: 'long' | 'short' }> = ({ side }) => (
  <Tag color={side === 'long' ? 'green' : 'red'} style={{ margin: 0 }}>
    {side === 'long' ? (
      <><ArrowUpRight size={12} style={{ marginRight: 2 }} />LONG</>
    ) : (
      <><ArrowDownRight size={12} style={{ marginRight: 2 }} />SHORT</>
    )}
  </Tag>
);

const ExitReasonTag: React.FC<{ reason: string }> = ({ reason }) => {
  const colorMap: Record<string, string> = {
    'SL': 'red',
    'TP': 'green',
    'TRAIL': 'blue',
    'TIME': 'orange',
    'END': 'default',
  };
  return <Tag color={colorMap[reason] || 'default'}>{reason}</Tag>;
};

const PnlText: React.FC<{ value: number; showCurrency?: boolean }> = ({ value, showCurrency = true }) => (
  <Text style={{ color: value >= 0 ? 'var(--success)' : 'var(--error)', fontWeight: 600 }}>
    {showCurrency ? formatCurrency(value) : formatPercent(value)}
  </Text>
);

// ============================================================================
// CHART COMPONENTS (Simple SVG)
// ============================================================================

const MiniEquityChart: React.FC<{ data: { date: string; equity: number }[] }> = ({ data }) => {
  if (!data || data.length < 2) return null;
  
  const width = 600;
  const height = 200;
  const padding = { top: 20, right: 20, bottom: 30, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  
  const values = data.map(d => d.equity);
  const minVal = Math.min(...values) * 0.95;
  const maxVal = Math.max(...values) * 1.05;
  
  const xScale = (i: number) => padding.left + (i / (data.length - 1)) * chartWidth;
  const yScale = (val: number) => padding.top + (1 - (val - minVal) / (maxVal - minVal)) * chartHeight;
  
  const pathD = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(d.equity)}`).join(' ');
  const areaD = pathD + ` L ${xScale(data.length - 1)} ${height - padding.bottom} L ${padding.left} ${height - padding.bottom} Z`;
  
  return (
    <svg width={width} height={height} style={{ background: 'var(--bg-primary)', borderRadius: 8 }}>
      {/* Grid lines */}
      {[0, 0.25, 0.5, 0.75, 1].map((pct, i) => (
        <g key={i}>
          <line
            x1={padding.left}
            x2={width - padding.right}
            y1={padding.top + pct * chartHeight}
            y2={padding.top + pct * chartHeight}
            stroke="var(--bg-elevated)"
            strokeDasharray="3,3"
          />
          <text
            x={padding.left - 5}
            y={padding.top + pct * chartHeight + 4}
            fill="var(--text-secondary)"
            fontSize={10}
            textAnchor="end"
          >
            ${((maxVal - minVal) * (1 - pct) + minVal).toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </text>
        </g>
      ))}
      
      {/* Area fill */}
      <defs>
        <linearGradient id="equityGradient" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--success)" stopOpacity="0.3" />
          <stop offset="100%" stopColor="var(--success)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaD} fill="url(#equityGradient)" />
      
      {/* Line */}
      <path d={pathD} fill="none" stroke="var(--success)" strokeWidth={2} />
      
      {/* Final value dot */}
      <circle
        cx={xScale(data.length - 1)}
        cy={yScale(data[data.length - 1].equity)}
        r={4}
        fill="var(--success)"
      />
    </svg>
  );
};

const MiniDrawdownChart: React.FC<{ data: { date: string; drawdown: number }[] }> = ({ data }) => {
  if (!data || data.length < 2) return null;
  
  const width = 600;
  const height = 150;
  const padding = { top: 10, right: 20, bottom: 30, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  
  const maxDD = Math.max(...data.map(d => d.drawdown), 5);
  
  const xScale = (i: number) => padding.left + (i / (data.length - 1)) * chartWidth;
  const yScale = (val: number) => padding.top + (val / maxDD) * chartHeight;
  
  const pathD = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(d.drawdown)}`).join(' ');
  const areaD = `M ${padding.left} ${padding.top} ` + pathD.substring(2) + ` L ${xScale(data.length - 1)} ${padding.top} Z`;
  
  return (
    <svg width={width} height={height} style={{ background: 'var(--bg-primary)', borderRadius: 8 }}>
      {/* Area fill */}
      <defs>
        <linearGradient id="ddGradient" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--error)" stopOpacity="0.4" />
          <stop offset="100%" stopColor="var(--error)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaD} fill="url(#ddGradient)" />
      
      {/* Line */}
      <path d={pathD} fill="none" stroke="var(--error)" strokeWidth={2} />
      
      {/* Max DD line */}
      <line
        x1={padding.left}
        x2={width - padding.right}
        y1={yScale(maxDD)}
        y2={yScale(maxDD)}
        stroke="var(--error)"
        strokeDasharray="5,5"
        opacity={0.5}
      />
      <text
        x={width - padding.right}
        y={yScale(maxDD) - 5}
        fill="var(--error)"
        fontSize={10}
        textAnchor="end"
      >
        Max DD: {maxDD.toFixed(1)}%
      </text>
    </svg>
  );
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export default function BacktestPage() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runs, setRuns] = useState<BacktestRunListItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<string | 'all'>('all');
  const [selectedSymbol, setSelectedSymbol] = useState<string | 'all'>('all');
  const [selectedSide, setSelectedSide] = useState<'all' | 'long' | 'short'>('all');

  const defaultSymbols = ['DOGE/USDT:USDT', 'IMX/USDT:USDT', 'SEI/USDT:USDT', 'SUI/USDT:USDT', 'XRP/USDT:USDT', 'ETH/USDT:USDT'];
  const symbolOptions = [
    { value: 'DOGE/USDT:USDT', label: 'DOGE/USDT (+438%)' },
    { value: 'IMX/USDT:USDT', label: 'IMX/USDT (+344%)' },
    { value: 'SEI/USDT:USDT', label: 'SEI/USDT (+280%)' },
    { value: 'SUI/USDT:USDT', label: 'SUI/USDT (+266%)' },
    { value: 'XRP/USDT:USDT', label: 'XRP/USDT (+185%)' },
    { value: 'ETH/USDT:USDT', label: 'ETH/USDT (+173%)' },
    { value: 'ADA/USDT:USDT', label: 'ADA/USDT (+173%)' },
    { value: 'DOT/USDT:USDT', label: 'DOT/USDT (+173%)' },
    { value: 'LINK/USDT:USDT', label: 'LINK/USDT (+143%)' },
    { value: 'AVAX/USDT:USDT', label: 'AVAX/USDT (+118%)' },
    { value: 'SOL/USDT:USDT', label: 'SOL/USDT (+111%)' },
    { value: 'BTC/USDT:USDT', label: 'BTC/USDT (+65%)' },
    { value: 'UNI/USDT:USDT', label: 'UNI/USDT' },
    { value: 'LTC/USDT:USDT', label: 'LTC/USDT' },
    { value: 'SONIC/USDT:USDT', label: 'SONIC/USDT' },
    { value: 'BCH/USDT:USDT', label: 'BCH/USDT' },
    { value: 'APT/USDT:USDT', label: 'APT/USDT' },
  ];

  const refreshRuns = async () => {
    setRunsLoading(true);
    try {
      const data = await api.backtest.listRuns(20);
      setRuns(data.runs);
    } catch (error: any) {
      message.error(error?.response?.data?.error || 'Failed to load backtest history');
    } finally {
      setRunsLoading(false);
    }
  };

  useEffect(() => {
    void refreshRuns();
  }, []);

  const handleLoadRun = async (id: string) => {
    setLoading(true);
    try {
      const data = await api.backtest.getRun(id);
      setResult(data);
      setSelectedRunId(id);
      message.success('Loaded cached backtest');
    } catch (error: any) {
      message.error(error?.response?.data?.error || 'Failed to load cached backtest');
    } finally {
      setLoading(false);
    }
  };

  const handleClearRuns = async () => {
    setRunsLoading(true);
    try {
      await api.backtest.clearRuns();
      setRuns([]);
      message.success('Backtest history cleared');
    } catch (error: any) {
      message.error(error?.response?.data?.error || 'Failed to clear history');
    } finally {
      setRunsLoading(false);
    }
  };

  const handleRunBacktest = async (values: any) => {
    setLoading(true);
    setResult(null);
    setSelectedRunId(null);
    
    try {
      const [startDate, endDate] = values.dateRange;
      const params = {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        initialCapital: values.initialCapital,
        symbols: values.symbols,
        leverage: values.leverage,
      };
      
      message.info('Starting backtest... This may take a few minutes.');
      const data = await api.backtest.run(params);
      setResult(data);
      message.success(`Backtest completed! ${data.trades.length} trades analyzed.`);
      void refreshRuns();
    } catch (error: any) {
      message.error(error?.response?.data?.error || 'Backtest failed');
    } finally {
      setLoading(false);
    }
  };

  // Filter trades
  const filteredTrades = useMemo(() => {
    if (!result) return [];
    return result.trades.filter(t => {
      if (selectedMonth !== 'all' && t.month !== selectedMonth) return false;
      if (selectedSymbol !== 'all' && t.symbol !== selectedSymbol) return false;
      if (selectedSide !== 'all' && t.side !== selectedSide) return false;
      return true;
    });
  }, [result, selectedMonth, selectedSymbol, selectedSide]);

  // Calculate filtered stats
  const filteredStats = useMemo(() => {
    if (filteredTrades.length === 0) return null;
    const wins = filteredTrades.filter(t => t.netPnlUsd > 0);
    const pnl = filteredTrades.reduce((sum, t) => sum + t.netPnlUsd, 0);
    return {
      trades: filteredTrades.length,
      wins: wins.length,
      losses: filteredTrades.length - wins.length,
      winRate: (wins.length / filteredTrades.length) * 100,
      pnlUsd: pnl,
    };
  }, [filteredTrades]);

  // Months for filter
  const months = useMemo(() => {
    if (!result) return [];
    return [...new Set(result.trades.map(t => t.month))].sort();
  }, [result]);

  // Table columns
  const tradeColumns: ColumnsType<BacktestTrade> = [
    {
      title: 'Date',
      dataIndex: 'entryTime',
      key: 'entryTime',
      width: 140,
      render: (v: string) => dayjs(v).format('DD/MM/YY HH:mm'),
    },
    {
      title: 'Symbol',
      dataIndex: 'symbol',
      key: 'symbol',
      width: 120,
      render: (v: string) => v.replace('/USDT:USDT', ''),
    },
    {
      title: 'Side',
      dataIndex: 'side',
      key: 'side',
      width: 80,
      render: (v: 'long' | 'short') => <SideTag side={v} />,
    },
    {
      title: 'Entry',
      dataIndex: 'entryPrice',
      key: 'entryPrice',
      width: 100,
      align: 'right',
      render: (v: number) => `$${v.toFixed(4)}`,
    },
    {
      title: 'Exit',
      dataIndex: 'exitPrice',
      key: 'exitPrice',
      width: 100,
      align: 'right',
      render: (v: number) => `$${v.toFixed(4)}`,
    },
    {
      title: 'Notional',
      dataIndex: 'notionalUsd',
      key: 'notionalUsd',
      width: 100,
      align: 'right',
      render: (v: number) => `$${v.toFixed(0)}`,
    },
    {
      title: 'Hold',
      dataIndex: 'holdMinutes',
      key: 'holdMinutes',
      width: 80,
      align: 'right',
      render: (v: number) => v >= 60 ? `${(v / 60).toFixed(1)}h` : `${v}m`,
    },
    {
      title: 'PnL $',
      dataIndex: 'netPnlUsd',
      key: 'netPnlUsd',
      width: 100,
      align: 'right',
      render: (v: number) => <PnlText value={v} />,
      sorter: (a, b) => a.netPnlUsd - b.netPnlUsd,
    },
    {
      title: 'PnL %',
      dataIndex: 'netPnlPct',
      key: 'netPnlPct',
      width: 80,
      align: 'right',
      render: (v: number) => <PnlText value={v} showCurrency={false} />,
    },
    {
      title: 'Exit',
      dataIndex: 'exitReason',
      key: 'exitReason',
      width: 70,
      render: (v: string) => <ExitReasonTag reason={v} />,
    },
    {
      title: 'Capital',
      key: 'capital',
      width: 100,
      align: 'right',
      render: (_, r: BacktestTrade) => (
        <Tooltip title={`Before: $${r.capitalBefore.toFixed(0)} → After: $${r.capitalAfter.toFixed(0)}`}>
          <span style={{ color: 'var(--text-secondary)' }}>${r.capitalAfter.toFixed(0)}</span>
        </Tooltip>
      ),
    },
  ];

  const monthlyColumns: ColumnsType<MonthlyStats> = [
    {
      title: 'Month',
      dataIndex: 'month',
      key: 'month',
      width: 100,
      render: (v: string) => dayjs(v).format('MMM YYYY'),
    },
    {
      title: 'Trades',
      dataIndex: 'trades',
      key: 'trades',
      width: 80,
      align: 'right',
    },
    {
      title: 'W/L',
      key: 'wl',
      width: 80,
      render: (_, r) => (
        <span>
          <Text style={{ color: 'var(--success)' }}>{r.wins}</Text>
          {' / '}
          <Text style={{ color: 'var(--error)' }}>{r.losses}</Text>
        </span>
      ),
    },
    {
      title: 'Win Rate',
      dataIndex: 'winRate',
      key: 'winRate',
      width: 90,
      align: 'right',
      render: (v: number) => (
        <Text style={{ color: v >= 50 ? 'var(--success)' : 'var(--error)' }}>
          {v.toFixed(1)}%
        </Text>
      ),
    },
    {
      title: 'PnL',
      dataIndex: 'pnlUsd',
      key: 'pnlUsd',
      width: 100,
      align: 'right',
      render: (v: number) => <PnlText value={v} />,
      sorter: (a, b) => a.pnlUsd - b.pnlUsd,
    },
    {
      title: 'ROI',
      dataIndex: 'pnlPct',
      key: 'pnlPct',
      width: 80,
      align: 'right',
      render: (v: number) => <PnlText value={v} showCurrency={false} />,
    },
    {
      title: 'Long/Short',
      key: 'ls',
      width: 100,
      render: (_, r) => `${r.longTrades}L / ${r.shortTrades}S`,
    },
    {
      title: 'Best',
      dataIndex: 'maxWinUsd',
      key: 'maxWinUsd',
      width: 90,
      align: 'right',
      render: (v: number) => <Text style={{ color: 'var(--success)' }}>${v.toFixed(0)}</Text>,
    },
    {
      title: 'Worst',
      dataIndex: 'maxLossUsd',
      key: 'maxLossUsd',
      width: 90,
      align: 'right',
      render: (v: number) => <Text style={{ color: 'var(--error)' }}>${Math.abs(v).toFixed(0)}</Text>,
    },
    {
      title: 'Capital End',
      dataIndex: 'capitalEnd',
      key: 'capitalEnd',
      width: 110,
      align: 'right',
      render: (v: number) => `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
    },
  ];

  return (
    <div style={{ padding: 24, maxWidth: 1600, margin: '0 auto' }}>
      <Title level={2} style={{ color: 'var(--text-primary)', marginBottom: 24 }}>
        <LineChartOutlined style={{ marginRight: 12 }} />
        Strategy Backtester
      </Title>

      {/* History */}
      <Card
        style={{ marginBottom: 24, background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }}
        bodyStyle={{ padding: 16 }}
        title={<Text style={{ color: 'var(--text-primary)' }}>Recent Backtests (cached)</Text>}
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => void refreshRuns()} loading={runsLoading}>
              Refresh
            </Button>
            <Button danger onClick={() => void handleClearRuns()} loading={runsLoading}>
              Clear
            </Button>
          </Space>
        }
      >
        {runs.length === 0 ? (
          <Empty description={<Text style={{ color: 'var(--text-secondary)' }}>No cached runs yet</Text>} />
        ) : (
          <List
            loading={runsLoading}
            dataSource={runs}
            renderItem={(r) => {
              const isSelected = selectedRunId === r.id;
              return (
                <List.Item
                  style={{
                    border: '1px solid var(--border-color)',
                    borderRadius: 8,
                    marginBottom: 8,
                    padding: 12,
                    background: isSelected ? 'var(--bg-primary)' : 'transparent',
                    cursor: 'pointer',
                  }}
                  onClick={() => void handleLoadRun(r.id)}
                >
                  <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                    <Space direction="vertical" size={0}>
                      <Text style={{ color: 'var(--text-primary)' }}>
                        {dayjs(r.createdAt).format('DD/MM/YY HH:mm')} · ${r.params.initialCapital.toLocaleString()} · {r.params.leverage}x
                      </Text>
                      <Text style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
                        {dayjs(r.params.startDate).format('YYYY-MM-DD')} → {dayjs(r.params.endDate).format('YYYY-MM-DD')} · {r.params.symbols.length} symbols
                      </Text>
                    </Space>
                    <Space direction="vertical" size={0} style={{ textAlign: 'right' }}>
                      <Text style={{ color: r.summary.totalPnlUsd >= 0 ? 'var(--success)' : 'var(--error)' }}>
                        {formatCurrency(r.summary.totalPnlUsd)} ({formatPercent(r.summary.totalPnlPct)})
                      </Text>
                      <Text style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
                        {r.summary.totalTrades} trades · WR {r.summary.winRate.toFixed(1)}% · DD {r.summary.maxDrawdownPct.toFixed(1)}%
                      </Text>
                    </Space>
                  </Space>
                </List.Item>
              );
            }}
          />
        )}
      </Card>
      
      {/* Form */}
      <Card 
        style={{ marginBottom: 24, background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }}
        bodyStyle={{ padding: 24 }}
      >
        <Form
          form={form}
          layout="inline"
          onFinish={handleRunBacktest}
          initialValues={{
            initialCapital: 2000,
            leverage: 4.5,
            symbols: defaultSymbols,
            // Data files cover 2024-01-01 to 2025-12-26
            dateRange: [dayjs('2024-01-01'), dayjs('2025-12-26')],
          }}
          style={{ gap: 16, flexWrap: 'wrap' }}
        >
          <Form.Item
            name="dateRange"
            label={<Text style={{ color: 'var(--text-secondary)' }}>Period</Text>}
            rules={[{ required: true }]}
          >
            <RangePicker 
              style={{ width: 280 }}
              disabledDate={(d) => d.isAfter(dayjs())}
            />
          </Form.Item>
          
          <Form.Item
            name="initialCapital"
            label={<Text style={{ color: 'var(--text-secondary)' }}>Capital ($)</Text>}
            rules={[{ required: true }]}
          >
            <InputNumber
              min={100}
              max={1000000}
              step={1000}
              style={{ width: 120 }}
              formatter={v => `${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
            />
          </Form.Item>
          
          <Form.Item
            name="leverage"
            label={<Text style={{ color: 'var(--text-secondary)' }}>Leverage</Text>}
            rules={[{ required: true }]}
          >
            <Select style={{ width: 80 }}>
              <Select.Option value={3}>3x</Select.Option>
              <Select.Option value={4}>4x</Select.Option>
              <Select.Option value={4.5}>4.5x</Select.Option>
              <Select.Option value={5}>5x</Select.Option>
            </Select>
          </Form.Item>
          
          <Form.Item
            name="symbols"
            label={<Text style={{ color: 'var(--text-secondary)' }}>Symbols</Text>}
            rules={[{ required: true }]}
          >
            <Select
              mode="multiple"
              style={{ minWidth: 300 }}
              options={symbolOptions}
              maxTagCount={2}
            />
          </Form.Item>
          
          <Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              loading={loading}
              icon={<ThunderboltOutlined />}
              size="large"
            >
              Run Backtest
            </Button>
          </Form.Item>
        </Form>
      </Card>
      
      {/* Loading */}
      {loading && (
        <Card style={{ marginBottom: 24, background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', textAlign: 'center', padding: 48 }}>
          <Spin size="large" />
          <Paragraph style={{ color: 'var(--text-secondary)', marginTop: 16 }}>
            Fetching market data and running simulation...
          </Paragraph>
          <Progress percent={30} status="active" style={{ maxWidth: 400, margin: '0 auto' }} />
        </Card>
      )}
      
      {/* Results */}
      {result && !loading && (
        <>
          {/* Summary Stats */}
          <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
            <Col xs={24} sm={12} md={6}>
              <Card style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }}>
                <Statistic
                  title={<Text style={{ color: 'var(--text-secondary)' }}>Total PnL</Text>}
                  value={result.summary.totalPnlUsd}
                  precision={2}
                  prefix="$"
                  valueStyle={{ color: result.summary.totalPnlUsd >= 0 ? 'var(--success)' : 'var(--error)' }}
                />
                <Text style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
                  {formatPercent(result.summary.totalPnlPct)} ROI
                </Text>
              </Card>
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Card style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }}>
                <Statistic
                  title={<Text style={{ color: 'var(--text-secondary)' }}>Win Rate</Text>}
                  value={result.summary.winRate}
                  precision={1}
                  suffix="%"
                  valueStyle={{ color: result.summary.winRate >= 50 ? 'var(--success)' : 'var(--error)' }}
                />
                <Text style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
                  {result.summary.wins}W / {result.summary.losses}L ({result.summary.totalTrades} total)
                </Text>
              </Card>
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Card style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }}>
                <Statistic
                  title={<Text style={{ color: 'var(--text-secondary)' }}>Max Drawdown</Text>}
                  value={result.summary.maxDrawdownPct}
                  precision={1}
                  suffix="%"
                  valueStyle={{ color: 'var(--error)' }}
                  prefix={<WarningOutlined />}
                />
                <Text style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
                  Profit Factor: {result.summary.profitFactor.toFixed(2)}
                </Text>
              </Card>
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Card style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }}>
                <Statistic
                  title={<Text style={{ color: 'var(--text-secondary)' }}>Final Capital</Text>}
                  value={result.summary.finalCapital}
                  precision={0}
                  prefix="$"
                  valueStyle={{ color: 'var(--accent)' }}
                />
                <Text style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
                  Started with ${result.params.initialCapital.toLocaleString()}
                </Text>
              </Card>
            </Col>
          </Row>
          
          {/* Additional Stats Row */}
          <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
            <Col xs={12} sm={6} md={4}>
              <Card size="small" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }}>
                <Statistic
                  title={<Text style={{ color: 'var(--text-secondary)', fontSize: 11 }}>Avg Win</Text>}
                  value={result.summary.avgWinUsd}
                  precision={2}
                  prefix="$"
                  valueStyle={{ color: 'var(--success)', fontSize: 18 }}
                />
              </Card>
            </Col>
            <Col xs={12} sm={6} md={4}>
              <Card size="small" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }}>
                <Statistic
                  title={<Text style={{ color: 'var(--text-secondary)', fontSize: 11 }}>Avg Loss</Text>}
                  value={result.summary.avgLossUsd}
                  precision={2}
                  prefix="$"
                  valueStyle={{ color: 'var(--error)', fontSize: 18 }}
                />
              </Card>
            </Col>
            <Col xs={12} sm={6} md={4}>
              <Card size="small" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }}>
                <Statistic
                  title={<Text style={{ color: 'var(--text-secondary)', fontSize: 11 }}>Long Trades</Text>}
                  value={result.summary.longTrades}
                  valueStyle={{ color: 'var(--accent)', fontSize: 18 }}
                />
              </Card>
            </Col>
            <Col xs={12} sm={6} md={4}>
              <Card size="small" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }}>
                <Statistic
                  title={<Text style={{ color: 'var(--text-secondary)', fontSize: 11 }}>Short Trades</Text>}
                  value={result.summary.shortTrades}
                  valueStyle={{ color: '#f472b6', fontSize: 18 }}
                />
              </Card>
            </Col>
            <Col xs={12} sm={6} md={4}>
              <Card size="small" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }}>
                <Statistic
                  title={<Text style={{ color: 'var(--text-secondary)', fontSize: 11 }}>Avg Hold</Text>}
                  value={(result.summary.avgHoldMinutes / 60).toFixed(1)}
                  suffix="h"
                  valueStyle={{ color: '#a78bfa', fontSize: 18 }}
                />
              </Card>
            </Col>
            <Col xs={12} sm={6} md={4}>
              <Card size="small" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }}>
                <Statistic
                  title={<Text style={{ color: 'var(--text-secondary)', fontSize: 11 }}>Total Fees</Text>}
                  value={result.summary.totalFeesUsd}
                  precision={0}
                  prefix="$"
                  valueStyle={{ color: '#fb923c', fontSize: 18 }}
                />
              </Card>
            </Col>
          </Row>
          
          {/* Charts */}
          <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
            <Col xs={24} lg={12}>
              <Card 
                title={<Text style={{ color: 'var(--text-primary)' }}>Equity Curve</Text>}
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }}
              >
                <MiniEquityChart data={result.equityCurve} />
              </Card>
            </Col>
            <Col xs={24} lg={12}>
              <Card 
                title={<Text style={{ color: 'var(--text-primary)' }}>Drawdown</Text>}
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }}
              >
                <MiniDrawdownChart data={result.drawdownCurve} />
              </Card>
            </Col>
          </Row>
          
          {/* Tabs for Monthly/Trades */}
          <Card style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }}>
            <Tabs
              defaultActiveKey="monthly"
              items={[
                {
                  key: 'monthly',
                  label: 'Monthly Breakdown',
                  children: (
                    <Table
                      dataSource={result.monthlyStats}
                      columns={monthlyColumns}
                      rowKey="month"
                      pagination={false}
                      size="small"
                      scroll={{ x: 900 }}
                      onRow={(record) => ({
                        onClick: () => setSelectedMonth(record.month),
                        style: { cursor: 'pointer' },
                      })}
                    />
                  ),
                },
                {
                  key: 'trades',
                  label: `Individual Trades (${filteredTrades.length})`,
                  children: (
                    <>
                      {/* Filters */}
                      <Space style={{ marginBottom: 16 }} wrap>
                        <Text style={{ color: 'var(--text-secondary)' }}><FilterOutlined /> Filters:</Text>
                        <Select
                          value={selectedMonth}
                          onChange={setSelectedMonth}
                          style={{ width: 140 }}
                          options={[
                            { value: 'all', label: 'All Months' },
                            ...months.map(m => ({ value: m, label: dayjs(m).format('MMM YYYY') })),
                          ]}
                        />
                        <Select
                          value={selectedSymbol}
                          onChange={setSelectedSymbol}
                          style={{ width: 140 }}
                          options={[
                            { value: 'all', label: 'All Symbols' },
                            ...result.params.symbols.map(s => ({ value: s, label: s.replace('/USDT:USDT', '') })),
                          ]}
                        />
                        <Select
                          value={selectedSide}
                          onChange={setSelectedSide}
                          style={{ width: 100 }}
                          options={[
                            { value: 'all', label: 'All Sides' },
                            { value: 'long', label: 'Long' },
                            { value: 'short', label: 'Short' },
                          ]}
                        />
                        {filteredStats && (
                          <Alert
                            message={
                              <span>
                                Filtered: {filteredStats.trades} trades | {filteredStats.wins}W/{filteredStats.losses}L | 
                                {' '}<PnlText value={filteredStats.pnlUsd} /> | WR: {filteredStats.winRate.toFixed(1)}%
                              </span>
                            }
                            type="info"
                            style={{ padding: '4px 12px', background: 'var(--bg-elevated)', border: '1px solid var(--accent-secondary)' }}
                          />
                        )}
                      </Space>
                      
                      <Table
                        dataSource={filteredTrades}
                        columns={tradeColumns}
                        rowKey="id"
                        pagination={{ pageSize: 50, showSizeChanger: true, showTotal: (t) => `${t} trades` }}
                        size="small"
                        scroll={{ x: 1200 }}
                        rowClassName={(r) => r.netPnlUsd >= 0 ? 'trade-row-win' : 'trade-row-loss'}
                      />
                    </>
                  ),
                },
              ]}
            />
          </Card>
        </>
      )}
      
      {/* Empty state */}
      {!result && !loading && (
        <Card style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', textAlign: 'center', padding: 48 }}>
          <Empty
            description={
              <Text style={{ color: 'var(--text-secondary)' }}>
                Configure backtest parameters and click "Run Backtest" to analyze historical performance
              </Text>
            }
          />
        </Card>
      )}
      
      {/* CSS */}
      <style>{`
        .trade-row-win { background: rgba(16, 185, 129, 0.05) !important; }
        .trade-row-loss { background: rgba(239, 68, 68, 0.05) !important; }
        .trade-row-win:hover { background: rgba(16, 185, 129, 0.1) !important; }
        .trade-row-loss:hover { background: rgba(239, 68, 68, 0.1) !important; }
      `}</style>
    </div>
  );
}

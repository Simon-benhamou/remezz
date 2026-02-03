import React from 'react';
import { Card, Table, Space, Button, DatePicker, Typography, Statistic, Row, Col, message, Tabs, Tag, InputNumber, Tooltip, Select, Badge, Divider, Progress, theme } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined, SyncOutlined, ReloadOutlined, FilterOutlined, ExclamationCircleOutlined, WarningOutlined, InfoCircleOutlined, DownOutlined, RightOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { api } from '../api';
import { useMode } from '../contexts/ModeContext';
import { useReportsCache } from '../hooks/useReportsCache';
import { AppMode } from '../store';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar, Legend } from 'recharts';

dayjs.extend(relativeTime);

const { Title, Text, Paragraph } = Typography;
const { RangePicker } = DatePicker;
const { TabPane } = Tabs;

// ============================================================================
// TYPES
// ============================================================================

type ParityCategory = 'MATCH' | 'EXIT_MISMATCH' | 'NO_SIGNAL' | 'PNL_VARIANCE' | 'DATA_ERROR';

interface ParityResult {
  id: string;
  tradeId: string;
  symbol: string;
  side: 'long' | 'short';
  liveEntryTs: string;
  liveExitTs: string;
  liveExitReason: string;
  livePnlPct: number;
  btEntryTs: string | null;
  btExitTs: string | null;
  btExitReason: string | null;
  btPnlPct: number | null;
  entryMatch: boolean;
  exitMatch: boolean;
  pnlMatch: boolean;
  overallMatch: boolean;
  mismatchDetails: string | null;
  verifiedAt: string;
  backtestDurationMs: number | null;
}

interface ParsedMismatchDetails {
  category: ParityCategory;
  details: string;
  signalCheck?: {
    wouldBacktestEnter: boolean;
    signalStrength: number | null;
    signalReason: string | null;
  };
}

// ============================================================================
// CATEGORY STYLING
// ============================================================================

const categoryConfig: Record<ParityCategory, { color: string; icon: React.ReactNode; label: string; description: string }> = {
  MATCH: {
    color: 'success',
    icon: <CheckCircleOutlined />,
    label: 'Match',
    description: 'Live and backtest behavior are identical'
  },
  EXIT_MISMATCH: {
    color: 'error',
    icon: <CloseCircleOutlined />,
    label: 'Exit Mismatch',
    description: 'Same entry, but different exit reason - needs investigation'
  },
  NO_SIGNAL: {
    color: 'warning',
    icon: <ExclamationCircleOutlined />,
    label: 'No Signal',
    description: 'Live entered but backtest would not have - potential regime bug'
  },
  PNL_VARIANCE: {
    color: 'processing',
    icon: <InfoCircleOutlined />,
    label: 'PnL Variance',
    description: 'Same exit reason but PnL differs - usually acceptable slippage'
  },
  DATA_ERROR: {
    color: 'default',
    icon: <WarningOutlined />,
    label: 'Data Error',
    description: 'Could not verify due to missing data'
  },
};

// ============================================================================
// PARITY VERIFICATION PANEL
// ============================================================================

function ParityVerificationPanel() {
  const [results, setResults] = React.useState<ParityResult[]>([]);
  const [filteredResults, setFilteredResults] = React.useState<ParityResult[]>([]);
  const [summary, setSummary] = React.useState<{
    total: number;
    matched: number;
    mismatched: number;
    matchRate: number;
  }>({ total: 0, matched: 0, mismatched: 0, matchRate: 0 });
  const [loading, setLoading] = React.useState(false);
  const [verifying, setVerifying] = React.useState(false);
  const [days, setDays] = React.useState(30);
  const [symbolFilter, setSymbolFilter] = React.useState<string[]>([]);
  const [categoryFilter, setCategoryFilter] = React.useState<ParityCategory[]>([]);
  const [sideFilter, setSideFilter] = React.useState<string[]>([]);
  const [expandedRowKeys, setExpandedRowKeys] = React.useState<string[]>([]);

  // Theme detection for dark mode compatibility
  const { token } = theme.useToken();
  const base = token.colorBgBase.toLowerCase();
  const isDarkTheme = base.startsWith('#0') || base === 'black' || base.includes('dark');

  React.useEffect(() => {
    loadResults();
  }, []);

  // Valid category keys for validation
  const validCategories: ParityCategory[] = ['MATCH', 'EXIT_MISMATCH', 'NO_SIGNAL', 'PNL_VARIANCE', 'DATA_ERROR'];

  // Parse mismatch details from V2 format
  const parseDetails = React.useCallback((record: ParityResult): ParsedMismatchDetails | null => {
    if (!record.mismatchDetails) {
      return record.overallMatch
        ? { category: 'MATCH', details: 'Fully matched' }
        : null;
    }
    try {
      const parsed = JSON.parse(record.mismatchDetails);
      // V2 format: { category, details, signalCheck }
      if (parsed.category) {
        // Validate category is a known value to prevent undefined config access
        const category = validCategories.includes(parsed.category)
          ? parsed.category
          : 'DATA_ERROR';
        return { ...parsed, category } as ParsedMismatchDetails;
      }
      // V1 format: array of strings
      if (Array.isArray(parsed)) {
        return {
          category: record.overallMatch ? 'MATCH' : 'EXIT_MISMATCH',
          details: parsed.join('; '),
        };
      }
      return null;
    } catch {
      return null;
    }
  }, []);

  // Get category for a result
  const getCategory = React.useCallback((record: ParityResult): ParityCategory => {
    if (record.overallMatch) return 'MATCH';
    const parsed = parseDetails(record);
    return parsed?.category || 'EXIT_MISMATCH';
  }, [parseDetails]);

  // Apply filters when results or filters change
  React.useEffect(() => {
    let filtered = [...results];

    // Symbol filter
    if (symbolFilter.length > 0) {
      filtered = filtered.filter(r => {
        const sym = r.symbol.replace('/USDT:USDT', '').toUpperCase();
        return symbolFilter.some(f => sym.includes(f.toUpperCase()));
      });
    }

    // Category filter
    if (categoryFilter.length > 0) {
      filtered = filtered.filter(r => categoryFilter.includes(getCategory(r)));
    }

    // Side filter
    if (sideFilter.length > 0) {
      filtered = filtered.filter(r => sideFilter.includes(r.side));
    }

    setFilteredResults(filtered);
  }, [results, symbolFilter, categoryFilter, sideFilter, getCategory]);

  // Get unique symbols from results
  const availableSymbols = React.useMemo(() => {
    const symbols = new Set(results.map(r => r.symbol.replace('/USDT:USDT', '')));
    return Array.from(symbols).sort();
  }, [results]);

  // Category statistics
  const categoryStats = React.useMemo(() => {
    const stats: Record<ParityCategory, number> = {
      MATCH: 0,
      EXIT_MISMATCH: 0,
      NO_SIGNAL: 0,
      PNL_VARIANCE: 0,
      DATA_ERROR: 0,
    };
    for (const r of results) {
      stats[getCategory(r)]++;
    }
    return stats;
  }, [results, getCategory]);

  const loadResults = async () => {
    setLoading(true);
    try {
      const data = await api.backtest.getParityResults({ limit: 200 });
      // Cast side to proper type since API returns string
      const typedResults = (data.results || []).map((r: any) => ({
        ...r,
        side: r.side as 'long' | 'short',
      })) as ParityResult[];
      setResults(typedResults);
      setSummary(data.summary || { total: 0, matched: 0, mismatched: 0, matchRate: 0 });
    } catch (error) {
      console.error('Failed to load parity results:', error);
      message.error('Failed to load parity results');
    } finally {
      setLoading(false);
    }
  };

  const refreshAll = async () => {
    setVerifying(true);
    try {
      message.info(`Starting verification for last ${days} days...`);
      const result = await api.backtest.verifyAll({ days });
      message.success(`Verified ${result.total} trades: ${result.matched} matched, ${result.mismatched} mismatched`);
      await loadResults();
    } catch (error) {
      console.error('Bulk verification failed:', error);
      message.error('Bulk verification failed');
    } finally {
      setVerifying(false);
    }
  };

  // Helper functions
  const getTimeDiffMinutes = (ts1: string | null, ts2: string | null): string => {
    if (!ts1 || !ts2) return 'N/A';
    const diff = Math.abs(dayjs(ts1).diff(dayjs(ts2), 'minute'));
    if (diff === 0) return 'Same';
    if (diff < 60) return `${diff}m`;
    return `${Math.floor(diff / 60)}h ${diff % 60}m`;
  };

  const isSameCandle = (ts1: string | null, ts2: string | null): boolean => {
    if (!ts1 || !ts2) return false;
    const CANDLE_MS = 15 * 60 * 1000;
    const c1 = Math.floor(dayjs(ts1).valueOf() / CANDLE_MS);
    const c2 = Math.floor(dayjs(ts2).valueOf() / CANDLE_MS);
    return c1 === c2;
  };


  const PNL_TOLERANCE = 0.5;

  // Table columns with sorting
  const columns: ColumnsType<ParityResult> = [
    {
      title: 'Symbol',
      dataIndex: 'symbol',
      key: 'symbol',
      width: 90,
      sorter: (a, b) => a.symbol.localeCompare(b.symbol),
      render: (symbol: string, record) => (
        <Space direction="vertical" size={0}>
          <Text strong style={{ fontSize: '13px' }}>{symbol.replace('/USDT:USDT', '')}</Text>
          <Tag color={record.side === 'long' ? 'green' : 'red'} style={{ fontSize: '10px', margin: 0 }}>
            {record.side.toUpperCase()}
          </Tag>
        </Space>
      ),
    },
    {
      title: 'Category',
      key: 'category',
      width: 130,
      filters: [
        { text: 'Match', value: 'MATCH' },
        { text: 'No Signal', value: 'NO_SIGNAL' },
        { text: 'Exit Mismatch', value: 'EXIT_MISMATCH' },
        { text: 'PnL Variance', value: 'PNL_VARIANCE' },
        { text: 'Data Error', value: 'DATA_ERROR' },
      ],
      onFilter: (value, record) => getCategory(record) === value,
      render: (_, record) => {
        const category = getCategory(record);
        const config = categoryConfig[category];
        return (
          <Tooltip title={config.description}>
            <Tag icon={config.icon} color={config.color} style={{ cursor: 'help' }}>
              {config.label}
            </Tag>
          </Tooltip>
        );
      },
    },
    {
      title: 'Entry',
      key: 'entry',
      width: 120,
      sorter: (a, b) => dayjs(a.liveEntryTs).valueOf() - dayjs(b.liveEntryTs).valueOf(),
      render: (_, record) => (
        <Tooltip title={dayjs(record.liveEntryTs).format('YYYY-MM-DD HH:mm:ss')}>
          <Text style={{ fontSize: '12px' }}>{dayjs(record.liveEntryTs).format('MM-DD HH:mm')}</Text>
        </Tooltip>
      ),
    },
    {
      title: 'Exit Reason',
      key: 'exitReason',
      width: 140,
      filters: [
        { text: 'TRAIL', value: 'TRAIL' },
        { text: 'SL', value: 'SL' },
        { text: 'TIME', value: 'TIME' },
        { text: 'REGIME_CHANGE', value: 'REGIME_CHANGE' },
        { text: 'STAGNANT', value: 'STAGNANT' },
      ],
      onFilter: (value, record) => record.liveExitReason?.includes(String(value)),
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Tag color="blue" style={{ fontSize: '10px' }}>{record.liveExitReason}</Tag>
          {record.btExitReason && record.btExitReason !== record.liveExitReason && (
            <Tag color="orange" style={{ fontSize: '10px' }}>BT: {record.btExitReason}</Tag>
          )}
        </Space>
      ),
    },
    {
      title: 'Live PnL',
      dataIndex: 'livePnlPct',
      key: 'livePnl',
      width: 90,
      sorter: (a, b) => (a.livePnlPct || 0) - (b.livePnlPct || 0),
      render: (pnl: number) => (
        <Text strong style={{ color: pnl >= 0 ? 'var(--success)' : 'var(--error)', fontSize: '13px' }}>
          {pnl >= 0 ? '+' : ''}{pnl?.toFixed(2)}%
        </Text>
      ),
    },
    {
      title: 'BT PnL',
      dataIndex: 'btPnlPct',
      key: 'btPnl',
      width: 90,
      sorter: (a, b) => (a.btPnlPct || 0) - (b.btPnlPct || 0),
      render: (pnl: number | null) => (
        pnl != null ? (
          <Text style={{ color: pnl >= 0 ? 'var(--success)' : 'var(--error)', fontSize: '12px' }}>
            {pnl >= 0 ? '+' : ''}{pnl?.toFixed(2)}%
          </Text>
        ) : <Text type="secondary">-</Text>
      ),
    },
    {
      title: 'Δ PnL',
      key: 'pnlDiff',
      width: 80,
      sorter: (a, b) => {
        const diffA = a.btPnlPct != null ? Math.abs((a.livePnlPct || 0) - a.btPnlPct) : 0;
        const diffB = b.btPnlPct != null ? Math.abs((b.livePnlPct || 0) - b.btPnlPct) : 0;
        return diffA - diffB;
      },
      render: (_, record) => {
        if (record.btPnlPct == null) return <Text type="secondary">-</Text>;
        const diff = Math.abs((record.livePnlPct || 0) - record.btPnlPct);
        const ok = diff <= PNL_TOLERANCE;
        return (
          <Tag color={ok ? 'green' : 'orange'} style={{ fontSize: '10px' }}>
            {diff.toFixed(2)}%
          </Tag>
        );
      },
    },
    {
      title: 'Verified',
      dataIndex: 'verifiedAt',
      key: 'verifiedAt',
      width: 90,
      sorter: (a, b) => dayjs(a.verifiedAt).valueOf() - dayjs(b.verifiedAt).valueOf(),
      defaultSortOrder: 'descend',
      render: (ts: string) => (
        <Tooltip title={dayjs(ts).format('YYYY-MM-DD HH:mm:ss')}>
          <Text type="secondary" style={{ fontSize: '11px' }}>{dayjs(ts).fromNow()}</Text>
        </Tooltip>
      ),
    },
  ];

  // Render expanded row details
  const renderExpandedRow = (record: ParityResult) => {
    const livePnl = record.livePnlPct ?? 0;
    const btPnl = record.btPnlPct;
    const pnlDiff = btPnl != null ? (livePnl - btPnl) : null;
    const holdTimeLive = record.liveExitTs && record.liveEntryTs
      ? Math.round(dayjs(record.liveExitTs).diff(dayjs(record.liveEntryTs), 'minute'))
      : null;
    const holdTimeBt = record.btExitTs && record.btEntryTs
      ? Math.round(dayjs(record.btExitTs).diff(dayjs(record.btEntryTs), 'minute'))
      : null;
    const parsed = parseDetails(record);
    const category = getCategory(record);
    const config = categoryConfig[category];

    // Theme-aware colors for expanded row
    const containerBg = isDarkTheme
      ? 'linear-gradient(135deg, rgba(15, 23, 42, 0.95) 0%, rgba(15, 23, 42, 0.85) 100%)'
      : 'linear-gradient(135deg, #fafafa 0%, #f5f5f5 100%)';
    const headerBg = isDarkTheme ? 'rgba(30, 41, 59, 0.8)' : '#fff';
    const tableBorder = isDarkTheme ? 'rgba(255, 255, 255, 0.1)' : '#f0f0f0';
    const labelColor = isDarkTheme ? 'rgba(255, 255, 255, 0.65)' : '#8c8c8c';

    return (
      <div style={{ padding: '16px', background: containerBg, borderRadius: 8 }}>
        {/* Category Header */}
        <div style={{ marginBottom: 16, padding: '12px 16px', background: headerBg, borderRadius: 8, borderLeft: `4px solid ${category === 'MATCH' ? 'var(--success)' : category === 'NO_SIGNAL' ? '#faad14' : 'var(--error)'}` }}>
          <Space>
            <Tag icon={config.icon} color={config.color} style={{ fontSize: '13px', padding: '4px 12px' }}>
              {config.label}
            </Tag>
            <Text type="secondary">{config.description}</Text>
          </Space>
          {parsed?.signalCheck && !parsed.signalCheck.wouldBacktestEnter && (
            <div style={{ marginTop: 8 }}>
              <Text type="danger" strong>Signal Rejection Reason: </Text>
              <Text code>{parsed.signalCheck.signalReason}</Text>
            </div>
          )}
        </div>

        <Row gutter={[16, 16]}>
          {/* Time Comparison */}
          <Col xs={24} lg={12}>
            <Card size="small" title={<><Text strong>Time Comparison</Text></>} styles={{ body: { padding: '12px' } }}>
              <table style={{ width: '100%', fontSize: '12px' }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${tableBorder}` }}>
                    <th style={{ textAlign: 'left', padding: '8px 0' }}></th>
                    <th style={{ textAlign: 'left', padding: '8px 0' }}>LIVE</th>
                    <th style={{ textAlign: 'left', padding: '8px 0' }}>BACKTEST</th>
                    <th style={{ textAlign: 'left', padding: '8px 0' }}>Δ</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={{ padding: '6px 0', color: labelColor }}>Entry</td>
                    <td>{dayjs(record.liveEntryTs).format('MM-DD HH:mm:ss')}</td>
                    <td>{record.btEntryTs ? dayjs(record.btEntryTs).format('MM-DD HH:mm:ss') : '-'}</td>
                    <td>
                      <Tag color={isSameCandle(record.liveEntryTs, record.btEntryTs) ? 'green' : 'orange'} style={{ margin: 0, fontSize: '10px' }}>
                        {getTimeDiffMinutes(record.liveEntryTs, record.btEntryTs)}
                      </Tag>
                    </td>
                  </tr>
                  <tr>
                    <td style={{ padding: '6px 0', color: labelColor }}>Exit</td>
                    <td>{dayjs(record.liveExitTs).format('MM-DD HH:mm:ss')}</td>
                    <td>{record.btExitTs ? dayjs(record.btExitTs).format('MM-DD HH:mm:ss') : '-'}</td>
                    <td>
                      <Tag color={isSameCandle(record.liveExitTs, record.btExitTs) ? 'green' : 'orange'} style={{ margin: 0, fontSize: '10px' }}>
                        {getTimeDiffMinutes(record.liveExitTs, record.btExitTs)}
                      </Tag>
                    </td>
                  </tr>
                  <tr>
                    <td style={{ padding: '6px 0', color: labelColor }}>Hold</td>
                    <td>{holdTimeLive != null ? `${holdTimeLive}m (${(holdTimeLive/15).toFixed(1)} candles)` : '-'}</td>
                    <td>{holdTimeBt != null ? `${holdTimeBt}m (${(holdTimeBt/15).toFixed(1)} candles)` : '-'}</td>
                    <td>
                      {holdTimeLive != null && holdTimeBt != null && (
                        <Tag color={Math.abs(holdTimeLive - holdTimeBt) <= 15 ? 'green' : 'orange'} style={{ margin: 0, fontSize: '10px' }}>
                          {Math.abs(holdTimeLive - holdTimeBt)}m
                        </Tag>
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>
            </Card>
          </Col>

          {/* PnL Comparison */}
          <Col xs={24} lg={12}>
            <Card size="small" title={<><Text strong>PnL Comparison</Text></>} styles={{ body: { padding: '12px' } }}>
              <Row gutter={16}>
                <Col span={8}>
                  <div style={{ textAlign: 'center' }}>
                    <Text type="secondary" style={{ fontSize: '11px' }}>Live PnL</Text>
                    <div style={{ fontSize: '18px', fontWeight: 600, color: livePnl >= 0 ? 'var(--success)' : 'var(--error)' }}>
                      {livePnl >= 0 ? '+' : ''}{livePnl.toFixed(2)}%
                    </div>
                  </div>
                </Col>
                <Col span={8}>
                  <div style={{ textAlign: 'center' }}>
                    <Text type="secondary" style={{ fontSize: '11px' }}>Backtest PnL</Text>
                    <div style={{ fontSize: '18px', fontWeight: 600, color: (btPnl ?? 0) >= 0 ? 'var(--success)' : 'var(--error)' }}>
                      {btPnl != null ? `${btPnl >= 0 ? '+' : ''}${btPnl.toFixed(2)}%` : '-'}
                    </div>
                  </div>
                </Col>
                <Col span={8}>
                  <div style={{ textAlign: 'center' }}>
                    <Text type="secondary" style={{ fontSize: '11px' }}>Difference</Text>
                    <div style={{ fontSize: '18px', fontWeight: 600, color: pnlDiff != null && Math.abs(pnlDiff) <= PNL_TOLERANCE ? 'var(--success)' : 'var(--error)' }}>
                      {pnlDiff != null ? `${Math.abs(pnlDiff).toFixed(2)}%` : '-'}
                    </div>
                  </div>
                </Col>
              </Row>
              <Divider style={{ margin: '12px 0 8px' }} />
              <Space>
                <Tag color={record.entryMatch ? 'green' : 'red'}>Entry {record.entryMatch ? '✓' : '✗'}</Tag>
                <Tag color={record.exitMatch ? 'green' : 'red'}>Exit {record.exitMatch ? '✓' : '✗'}</Tag>
                <Tag color={record.pnlMatch ? 'green' : 'red'}>PnL {record.pnlMatch ? '✓' : '✗'}</Tag>
              </Space>
            </Card>
          </Col>
        </Row>

        {/* Details Section */}
        {parsed?.details && category !== 'MATCH' && (
          <Card size="small" style={{
            marginTop: 16,
            background: isDarkTheme ? 'rgba(250, 173, 20, 0.1)' : '#fffbe6',
            border: isDarkTheme ? '1px solid rgba(250, 173, 20, 0.3)' : '1px solid #ffe58f'
          }}
                title={<><WarningOutlined style={{ color: '#faad14', marginRight: 8 }} /><Text strong>Details</Text></>}>
            <Paragraph style={{ margin: 0 }}>{parsed.details}</Paragraph>
          </Card>
        )}

        {/* Footer */}
        <div style={{ marginTop: 12, textAlign: 'right' }}>
          <Text type="secondary" style={{ fontSize: '11px' }}>
            Verified {dayjs(record.verifiedAt).fromNow()} • Duration: {record.backtestDurationMs ? `${record.backtestDurationMs}ms` : 'N/A'}
          </Text>
        </div>
      </div>
    );
  };

  // Chart data for category distribution
  const chartData = React.useMemo(() => {
    return Object.entries(categoryStats).map(([key, value]) => ({
      name: categoryConfig[key as ParityCategory].label,
      value,
      color: key === 'MATCH' ? 'var(--success)' : key === 'NO_SIGNAL' ? '#faad14' : key === 'PNL_VARIANCE' ? '#1890ff' : 'var(--error)',
    })).filter(d => d.value > 0);
  }, [categoryStats]);

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {/* Header */}
      <Card styles={{ body: { padding: '16px 24px' } }}>
        <Row justify="space-between" align="middle">
          <Col>
            <Title level={4} style={{ margin: 0 }}>Parity Verification</Title>
            <Text type="secondary">Compare live trades against backtest simulation</Text>
          </Col>
          <Col>
            <Space>
              <Text type="secondary">Last</Text>
              <InputNumber min={1} max={365} value={days} onChange={(v) => setDays(v || 30)} style={{ width: 70 }} />
              <Text type="secondary">days</Text>
              <Button
                type="primary"
                icon={verifying ? <SyncOutlined spin /> : <ReloadOutlined />}
                onClick={refreshAll}
                loading={verifying}
              >
                Verify All
              </Button>
              <Button onClick={loadResults} loading={loading}>Refresh</Button>
            </Space>
          </Col>
        </Row>
      </Card>

      {/* Statistics Row */}
      <Row gutter={[16, 16]}>
        <Col xs={24} md={16}>
          <Card styles={{ body: { padding: '16px' } }}>
            <Row gutter={16}>
              <Col span={4}>
                <Statistic title="Total" value={summary.total} valueStyle={{ color: '#1890ff', fontSize: '24px' }} />
              </Col>
              <Col span={4}>
                <Statistic title="Match" value={categoryStats.MATCH} valueStyle={{ color: 'var(--success)', fontSize: '24px' }} prefix={<CheckCircleOutlined />} />
              </Col>
              <Col span={4}>
                <Tooltip title="Live entered but backtest wouldn't">
                  <Statistic title="No Signal" value={categoryStats.NO_SIGNAL} valueStyle={{ color: '#faad14', fontSize: '24px' }} prefix={<ExclamationCircleOutlined />} />
                </Tooltip>
              </Col>
              <Col span={4}>
                <Tooltip title="Same entry, different exit">
                  <Statistic title="Exit Δ" value={categoryStats.EXIT_MISMATCH} valueStyle={{ color: 'var(--error)', fontSize: '24px' }} prefix={<CloseCircleOutlined />} />
                </Tooltip>
              </Col>
              <Col span={4}>
                <Tooltip title="Same exit, PnL differs">
                  <Statistic title="PnL Δ" value={categoryStats.PNL_VARIANCE} valueStyle={{ color: '#1890ff', fontSize: '24px' }} prefix={<InfoCircleOutlined />} />
                </Tooltip>
              </Col>
              <Col span={4}>
                <Statistic
                  title="Match Rate"
                  value={summary.matchRate}
                  precision={1}
                  suffix="%"
                  valueStyle={{ color: summary.matchRate >= 90 ? 'var(--success)' : summary.matchRate >= 70 ? '#faad14' : 'var(--error)', fontSize: '24px' }}
                />
              </Col>
            </Row>
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card styles={{ body: { padding: '8px 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' } }}>
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={80}>
                <PieChart>
                  <Pie data={chartData} dataKey="value" cx="50%" cy="50%" innerRadius={25} outerRadius={35} paddingAngle={2}>
                    {chartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Legend layout="vertical" align="right" verticalAlign="middle" iconSize={8}
                          formatter={(value) => <span style={{ fontSize: '11px' }}>{value}</span>} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <Text type="secondary">No data</Text>
            )}
          </Card>
        </Col>
      </Row>

      {/* Table */}
      <Card
        title={
          <Space>
            <Text strong>Verification Results</Text>
            {(symbolFilter.length > 0 || categoryFilter.length > 0 || sideFilter.length > 0) && (
              <Tag color="blue">{filteredResults.length} / {results.length}</Tag>
            )}
          </Space>
        }
        extra={
          <Space wrap>
            <Select
              mode="multiple"
              placeholder="Symbol"
              value={symbolFilter}
              onChange={setSymbolFilter}
              style={{ minWidth: 120 }}
              allowClear
              options={availableSymbols.map(s => ({ label: s, value: s }))}
              maxTagCount={1}
            />
            <Select
              mode="multiple"
              placeholder="Category"
              value={categoryFilter}
              onChange={setCategoryFilter}
              style={{ minWidth: 120 }}
              allowClear
              options={[
                { label: 'Match', value: 'MATCH' },
                { label: 'No Signal', value: 'NO_SIGNAL' },
                { label: 'Exit Mismatch', value: 'EXIT_MISMATCH' },
                { label: 'PnL Variance', value: 'PNL_VARIANCE' },
              ]}
              maxTagCount={1}
            />
            <Select
              mode="multiple"
              placeholder="Side"
              value={sideFilter}
              onChange={setSideFilter}
              style={{ minWidth: 80 }}
              allowClear
              options={[
                { label: 'Long', value: 'long' },
                { label: 'Short', value: 'short' },
              ]}
              maxTagCount={1}
            />
          </Space>
        }
        loading={loading}
        styles={{ body: { padding: 0 } }}
      >
        <Table
          dataSource={filteredResults}
          columns={columns}
          rowKey="id"
          pagination={{ pageSize: 15, showSizeChanger: true, pageSizeOptions: ['10', '15', '25', '50'] }}
          size="small"
          expandable={{
            expandedRowRender: renderExpandedRow,
            expandedRowKeys,
            onExpand: (expanded, record) => {
              setExpandedRowKeys(expanded ? [record.id] : []);
            },
            rowExpandable: () => true,
          }}
          scroll={{ x: 900 }}
          locale={{ emptyText: results.length === 0
            ? 'No verification results yet. Click "Verify All" to compare trades against backtest.'
            : 'No trades match the current filters.'
          }}
        />
      </Card>
    </Space>
  );
}

function pct(val?: number | null, digits = 2) {
  if (val == null || Number.isNaN(Number(val))) return '-';
  return `${(Number(val) * 100).toFixed(digits)}%`;
}

export default function ReportsPage() {
  const { mode } = useMode();
  const {
    reports,
    sessions,
    isRefreshing,
    isInitialLoad,
    error,
    loadReports,
    setupAutoRefresh
  } = useReportsCache();

  // Initial load and mode change
  React.useEffect(() => {
    loadReports(mode as AppMode).catch(console.error);
  }, [mode, loadReports]);

  // Setup auto-refresh (every 60s)
  React.useEffect(() => {
    return setupAutoRefresh(mode as AppMode);
  }, [mode, setupAutoRefresh]);

  // Manual refresh handler
  const handleRefresh = React.useCallback(() => {
    loadReports(mode as AppMode, true).catch(console.error);
  }, [mode, loadReports]);

  // Show error toast only once
  React.useEffect(() => {
    if (error) {
      message.error(error);
    }
  }, [error]);

  const globalStats = React.useMemo(() => {
    const totalTrades = reports.reduce((sum, r) => sum + r.totalTrades, 0);
    const avgWinRate = reports.length > 0 ? 
      reports.reduce((sum, r) => sum + r.winRate, 0) / reports.length : 0;
    const totalPnl = reports.reduce((sum, r) => sum + r.totalPnl, 0);
    const maxDrawdown = Math.min(...reports.map(r => r.maxDrawdown), 0);

    return { totalTrades, avgWinRate, totalPnl, maxDrawdown };
  }, [reports]);

  const columns = React.useMemo(() => [
    {
      title: 'Date',
      dataIndex: 'date',
      key: 'date',
      render: (date: string) => dayjs(date).format('MMM DD, YYYY')
    },
    {
      title: 'Sessions',
      dataIndex: 'sessionsCount',
      key: 'sessionsCount',
      render: (count: number) => <span style={{ color: '#1890ff' }}>{count}</span>
    },
    {
      title: 'Trades',
      dataIndex: 'totalTrades',
      key: 'totalTrades',
    },
    {
      title: 'Win Rate',
      dataIndex: 'winRate',
      key: 'winRate',
      render: (rate: number) => (
        <span style={{ color: rate > 0.5 ? 'var(--success)' : rate > 0.3 ? '#faad14' : 'var(--error)' }}>
          {pct(rate)}
        </span>
      ),
    },
    {
      title: 'Expectancy',
      dataIndex: 'expectancy',
      key: 'expectancy',
      render: (exp: number) => (
        <span style={{ color: exp > 0 ? 'var(--success)' : 'var(--error)' }}>
          {exp.toFixed(2)}%
        </span>
      ),
    },
    {
      title: 'PnL',
      dataIndex: 'totalPnl',
      key: 'totalPnl',
      render: (pnl: number) => (
        <span style={{ color: pnl >= 0 ? 'var(--success)' : 'var(--error)' }}>
          ${pnl.toFixed(2)}
        </span>
      ),
    },
    {
      title: 'Profit Factor',
      dataIndex: 'profitFactor',
      key: 'profitFactor',
      render: (pf: number) => (
        <span style={{ color: pf > 1 ? 'var(--success)' : 'var(--error)' }}>
          {pf.toFixed(2)}
        </span>
      ),
    }
  ], []);

  return (
    <Tabs defaultActiveKey="daily" style={{ padding: '20px' }}>
      <TabPane tab="📊 Daily Reports" key="daily">
        <Space direction="vertical" style={{ width: '100%' }} size="large">
          <Card>
            <Title level={3}>📊 Global Trading Reports</Title>
            <Text type="secondary">
              Comprehensive dashboard with performance metrics across all agents
            </Text>
          </Card>

          <Row gutter={[16, 16]}>
            <Col xs={24} sm={12} md={6}>
              <Card>
                <Statistic
                  title="Total Trades"
                  value={globalStats.totalTrades}
                  valueStyle={{ color: '#1890ff' }}
                />
              </Card>
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Card>
                <Statistic
                  title="Average Win Rate"
                  value={globalStats.avgWinRate}
                  formatter={(value) => pct(value as number)}
                  valueStyle={{ color: globalStats.avgWinRate > 0.5 ? 'var(--success)' : 'var(--error)' }}
                />
              </Card>
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Card>
                <Statistic
                  title="Total P&L"
                  value={globalStats.totalPnl}
                  prefix="$"
                  precision={2}
                  valueStyle={{ color: globalStats.totalPnl >= 0 ? 'var(--success)' : 'var(--error)' }}
                />
              </Card>
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Card>
                <Statistic
                  title="Max Drawdown"
                  value={globalStats.maxDrawdown}
                  prefix="$"
                  precision={2}
                  valueStyle={{ color: 'var(--error)' }}
                />
              </Card>
            </Col>
          </Row>

          <Card
            title={
              <Space>
                <span>📊 Daily Reports</span>
                {isRefreshing && !isInitialLoad && (
                  <Tag color="processing" icon={<SyncOutlined spin />}>
                    Updating...
                  </Tag>
                )}
              </Space>
            }
            loading={isInitialLoad}
            extra={
              <Button onClick={handleRefresh} loading={isRefreshing}>
                Refresh Reports
              </Button>
            }
          >
            {reports.length === 0 && !isInitialLoad ? (
              <div style={{ textAlign: 'center', padding: '40px' }}>
                <Text type="secondary">
                  {sessions.length === 0 ? 'No trading sessions found' : 'No daily reports available yet'}
                </Text>
              </div>
            ) : reports.length > 0 ? (
              <Table
                dataSource={reports}
                columns={columns}
                rowKey="date"
                pagination={{ pageSize: 10 }}
                expandable={{
                  expandedRowRender: (record) => (
                    <div style={{ margin: 0 }}>
                      <Text strong>Sessions for {dayjs(record.date).format('MMM DD, YYYY')}:</Text>
                      <Row gutter={[16, 8]} style={{ marginTop: 8 }}>
                        {record.sessions?.map((session: any, index: number) => (
                          <Col xs={24} sm={12} md={8} key={index}>
                            <Card size="small" style={{ marginBottom: 8 }}>
                              <Text strong>{session.symbol}</Text>
                              <br />
                              <Text type="secondary">Trades: {session.totalTrades}</Text>
                              <br />
                              <Text type="secondary">WR: {pct(session.winRate)}</Text>
                              <br />
                              <Text type="secondary">PnL: ${session.totalPnl.toFixed(2)}</Text>
                              {session.llmSummary && (
                                <>
                                  <br />
                                  <Text type="secondary" style={{ fontSize: '11px' }}>
                                    {session.llmSummary.substring(0, 100)}
                                    {session.llmSummary.length > 100 ? '...' : ''}
                                  </Text>
                                </>
                              )}
                            </Card>
                          </Col>
                        ))}
                      </Row>
                    </div>
                  ),
                  rowExpandable: (record) => record.sessions && record.sessions.length > 0,
                }}
              />
            ) : null}
          </Card>

          <Card title="Active Sessions" size="small">
            <Row gutter={[16, 16]}>
              {sessions.filter((s: any) => !s.stoppedAt).map((session: any) => (
                <Col xs={24} sm={12} md={8} key={session.id}>
                  <Card size="small">
                    <Text strong>{session.symbol}</Text>
                    <br />
                    <Text type="secondary">
                      Mode: {session.mode?.toUpperCase()}
                    </Text>
                    <br />
                    <Text type="secondary">
                      Started: {dayjs(session.startedAt).format('MM-DD HH:mm')}
                    </Text>
                  </Card>
                </Col>
              ))}
            </Row>
          </Card>
        </Space>
      </TabPane>

      <TabPane tab="🔬 Backtest Parity" key="parity">
        <ParityVerificationPanel />
      </TabPane>
    </Tabs>
  );
}

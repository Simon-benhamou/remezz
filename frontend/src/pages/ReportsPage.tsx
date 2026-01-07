import React from 'react';
import { Card, Table, Space, Button, DatePicker, Typography, Statistic, Row, Col, message, Tabs, Tag, InputNumber, Tooltip, Select } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined, SyncOutlined, ReloadOutlined, FilterOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { api } from '../api';
import { useMode } from '../contexts/ModeContext';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';

dayjs.extend(relativeTime);

const { Title, Text } = Typography;
const { RangePicker } = DatePicker;
const { TabPane } = Tabs;

// ============================================================================
// PARITY VERIFICATION PANEL
// ============================================================================

function ParityVerificationPanel() {
  const [results, setResults] = React.useState<any[]>([]);
  const [filteredResults, setFilteredResults] = React.useState<any[]>([]);
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

  React.useEffect(() => {
    loadResults();
  }, []);

  // Apply filters when results or symbolFilter changes
  React.useEffect(() => {
    if (symbolFilter.length === 0) {
      setFilteredResults(results);
    } else {
      const filtered = results.filter(r => {
        const sym = r.symbol.replace('/USDT:USDT', '').toUpperCase();
        return symbolFilter.some(f => sym.includes(f.toUpperCase()));
      });
      setFilteredResults(filtered);
    }
  }, [results, symbolFilter]);

  // Get unique symbols from results
  const availableSymbols = React.useMemo(() => {
    const symbols = new Set(results.map(r => r.symbol.replace('/USDT:USDT', '')));
    return Array.from(symbols).sort();
  }, [results]);

  const loadResults = async () => {
    setLoading(true);
    try {
      const data = await api.backtest.getParityResults({ limit: 100 });
      setResults(data.results || []);
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

  // Helper to calculate time difference in minutes
  const getTimeDiffMinutes = (ts1: string | null, ts2: string | null): string => {
    if (!ts1 || !ts2) return 'N/A';
    const diff = Math.abs(dayjs(ts1).diff(dayjs(ts2), 'minute'));
    if (diff === 0) return 'Same candle';
    if (diff < 60) return `${diff}m`;
    return `${Math.floor(diff / 60)}h ${diff % 60}m`;
  };

  // Helper to check if times are in same 15m candle
  const isSameCandle = (ts1: string | null, ts2: string | null): boolean => {
    if (!ts1 || !ts2) return false;
    const CANDLE_MS = 15 * 60 * 1000;
    const c1 = Math.floor(dayjs(ts1).valueOf() / CANDLE_MS);
    const c2 = Math.floor(dayjs(ts2).valueOf() / CANDLE_MS);
    return c1 === c2;
  };

  // Helper to check if times are within ±1 candle (15 minutes)
  // This is the acceptable tolerance because:
  // - Backtest enters at candle CLOSE (e.g., 14:15:00)
  // - Live enters when order executes (e.g., 14:30:14) - on the NEXT candle
  // So a 1-candle difference is expected and normal
  const isWithinOneCandle = (ts1: string | null, ts2: string | null): boolean => {
    if (!ts1 || !ts2) return false;
    const CANDLE_MS = 15 * 60 * 1000;
    const c1 = Math.floor(dayjs(ts1).valueOf() / CANDLE_MS);
    const c2 = Math.floor(dayjs(ts2).valueOf() / CANDLE_MS);
    return Math.abs(c1 - c2) <= 1;
  };

  const PNL_TOLERANCE = 0.5; // 0.5% tolerance

  const columns = [
    {
      title: 'Trade',
      dataIndex: 'symbol',
      key: 'symbol',
      width: 100,
      render: (symbol: string, record: any) => (
        <Space direction="vertical" size={0}>
          <Text strong>{symbol.replace('/USDT:USDT', '')}</Text>
          <Text type="secondary" style={{ fontSize: '11px' }}>
            {record.side.toUpperCase()}
          </Text>
        </Space>
      ),
    },
    {
      title: 'Entry Time',
      key: 'entryTime',
      width: 180,
      render: (record: any) => {
        const withinOneCandle = isWithinOneCandle(record.liveEntryTs, record.btEntryTs);
        const sameCandle = isSameCandle(record.liveEntryTs, record.btEntryTs);
        const diff = getTimeDiffMinutes(record.liveEntryTs, record.btEntryTs);
        return (
          <Space direction="vertical" size={0}>
            <Tooltip title={`Live: ${dayjs(record.liveEntryTs).format('YYYY-MM-DD HH:mm:ss')}`}>
              <Text>Live: {dayjs(record.liveEntryTs).format('MM-DD HH:mm')}</Text>
            </Tooltip>
            <Tooltip title={record.btEntryTs ? `BT: ${dayjs(record.btEntryTs).format('YYYY-MM-DD HH:mm:ss')}` : 'No BT trade'}>
              <Text type="secondary" style={{ fontSize: '11px' }}>
                BT: {record.btEntryTs ? dayjs(record.btEntryTs).format('MM-DD HH:mm') : 'N/A'}
              </Text>
            </Tooltip>
            <Space size={4}>
              {sameCandle ? (
                <Tag color="green" style={{ fontSize: '10px' }}>Same candle</Tag>
              ) : withinOneCandle ? (
                <Tag color="green" style={{ fontSize: '10px' }}>Δ {diff} ✓</Tag>
              ) : record.btEntryTs ? (
                <Tag color="orange" style={{ fontSize: '10px' }}>Δ {diff}</Tag>
              ) : (
                <Tag color="red" style={{ fontSize: '10px' }}>No match</Tag>
              )}
            </Space>
          </Space>
        );
      },
    },
    {
      title: 'Exit Time',
      key: 'exitTime',
      width: 180,
      render: (record: any) => {
        const withinOneCandle = isWithinOneCandle(record.liveExitTs, record.btExitTs);
        const sameCandle = isSameCandle(record.liveExitTs, record.btExitTs);
        const diff = getTimeDiffMinutes(record.liveExitTs, record.btExitTs);
        return (
          <Space direction="vertical" size={0}>
            <Tooltip title={`Live: ${dayjs(record.liveExitTs).format('YYYY-MM-DD HH:mm:ss')}`}>
              <Text>Live: {dayjs(record.liveExitTs).format('MM-DD HH:mm')}</Text>
            </Tooltip>
            <Tooltip title={record.btExitTs ? `BT: ${dayjs(record.btExitTs).format('YYYY-MM-DD HH:mm:ss')}` : 'No BT trade'}>
              <Text type="secondary" style={{ fontSize: '11px' }}>
                BT: {record.btExitTs ? dayjs(record.btExitTs).format('MM-DD HH:mm') : 'N/A'}
              </Text>
            </Tooltip>
            <Space size={4}>
              {sameCandle ? (
                <Tag color="green" style={{ fontSize: '10px' }}>Same candle</Tag>
              ) : withinOneCandle ? (
                <Tag color="green" style={{ fontSize: '10px' }}>Δ {diff} ✓</Tag>
              ) : record.btExitTs ? (
                <Tag color="orange" style={{ fontSize: '10px' }}>Δ {diff}</Tag>
              ) : (
                <Tag color="red" style={{ fontSize: '10px' }}>N/A</Tag>
              )}
            </Space>
          </Space>
        );
      },
    },
    {
      title: 'Exit Reason',
      key: 'exitReason',
      width: 120,
      render: (record: any) => (
        <Space direction="vertical" size={0}>
          <Text>Live: {record.liveExitReason}</Text>
          <Text type="secondary" style={{ fontSize: '11px' }}>
            BT: {record.btExitReason || 'N/A'}
          </Text>
          {record.exitMatch ? (
            <Tag color="green" style={{ fontSize: '10px' }}>MATCH</Tag>
          ) : (
            <Tag color="red" style={{ fontSize: '10px' }}>MISMATCH</Tag>
          )}
        </Space>
      ),
    },
    {
      title: 'PnL (±0.5% tol)',
      key: 'pnl',
      width: 150,
      render: (record: any) => {
        const livePnl = record.livePnlPct ?? 0;
        const btPnl = record.btPnlPct;
        const pnlDiff = btPnl != null ? Math.abs(livePnl - btPnl) : null;
        const withinTolerance = pnlDiff != null && pnlDiff <= PNL_TOLERANCE;
        
        return (
          <Space direction="vertical" size={0}>
            <Text style={{ color: livePnl >= 0 ? '#52c41a' : '#ff4d4f' }}>
              Live: {livePnl.toFixed(2)}%
            </Text>
            <Text type="secondary" style={{ fontSize: '11px' }}>
              BT: {btPnl != null ? `${btPnl.toFixed(2)}%` : 'N/A'}
            </Text>
            {pnlDiff != null && (
              <Tooltip title={`Difference: ${pnlDiff.toFixed(3)}% (Tolerance: ±${PNL_TOLERANCE}%)`}>
                <Tag color={withinTolerance ? 'green' : 'red'} style={{ fontSize: '10px' }}>
                  Δ {pnlDiff.toFixed(2)}% {withinTolerance ? '✓' : '✗'}
                </Tag>
              </Tooltip>
            )}
          </Space>
        );
      },
    },
    {
      title: 'Status',
      key: 'status',
      width: 140,
      render: (record: any) => {
        // Check for new mismatchCategory field (if available from updated backend)
        const category = record.mismatchCategory;
        
        if (record.overallMatch || category === 'NONE') {
          return <Tag icon={<CheckCircleOutlined />} color="success">MATCH</Tag>;
        }
        
        if (category === 'EXPECTED_VARIANCE') {
          return (
            <Tooltip title="Difference explained by live execution slippage - not a real issue">
              <Tag color="warning" style={{ cursor: 'help' }}>⚠️ EXPECTED</Tag>
            </Tooltip>
          );
        }
        
        // Real mismatch or old data without category
        return (
          <Tooltip title="Real mismatch - needs investigation">
            <Tag icon={<CloseCircleOutlined />} color="error">🔍 INVESTIGATE</Tag>
          </Tooltip>
        );
      },
    },
    {
      title: 'Entry Slippage',
      key: 'slippage',
      width: 100,
      render: (record: any) => {
        // Try to extract slippage from mismatchDetails if entryPriceDiffPct not directly available
        let slippage: number | null = null;
        
        if (record.entryPriceDiffPct != null) {
          slippage = record.entryPriceDiffPct;
        } else if (record.mismatchDetails) {
          try {
            const details = JSON.parse(record.mismatchDetails);
            const slippageDetail = details.find((d: string) => d.includes('Entry Price Slippage'));
            if (slippageDetail) {
              const match = slippageDetail.match(/(\d+\.?\d*)%/);
              if (match) slippage = parseFloat(match[1]);
            }
          } catch {}
        }
        
        if (slippage == null) {
          return <Text type="secondary" style={{ fontSize: '11px' }}>N/A</Text>;
        }
        
        const isHigh = slippage > 1.5;
        return (
          <Tooltip title={`Entry price difference between live and backtest: ${slippage.toFixed(3)}%`}>
            <Tag color={isHigh ? 'orange' : 'green'} style={{ fontSize: '10px' }}>
              {slippage.toFixed(2)}%
            </Tag>
          </Tooltip>
        );
      },
    },
    {
      title: 'Verified',
      dataIndex: 'verifiedAt',
      key: 'verifiedAt',
      width: 100,
      render: (ts: string) => (
        <Tooltip title={dayjs(ts).format('YYYY-MM-DD HH:mm:ss')}>
          <Text type="secondary" style={{ fontSize: '11px' }}>
            {dayjs(ts).fromNow()}
          </Text>
        </Tooltip>
      ),
    },
  ];

  // Calculate categorized stats from results
  const categoryStats = React.useMemo(() => {
    let expectedVariance = 0;
    let realMismatch = 0;
    
    for (const r of results) {
      if (!r.overallMatch) {
        if (r.mismatchCategory === 'EXPECTED_VARIANCE') {
          expectedVariance++;
        } else {
          realMismatch++;
        }
      }
    }
    
    return { expectedVariance, realMismatch };
  }, [results]);

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="large">
      <Card>
        <Title level={3}>🔬 Backtest Parity Verification</Title>
        <Text type="secondary">
          Compare live/paper trades against backtest to ensure identical behavior
        </Text>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} md={4}>
          <Card>
            <Statistic
              title="Total Verified"
              value={summary.total}
              valueStyle={{ color: '#1890ff' }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={4}>
          <Card>
            <Statistic
              title="Matched"
              value={summary.matched}
              valueStyle={{ color: '#52c41a' }}
              suffix={<CheckCircleOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={4}>
          <Card>
            <Tooltip title="Differences explained by live execution slippage - not bugs">
              <Statistic
                title="⚠️ Expected Variance"
                value={categoryStats.expectedVariance}
                valueStyle={{ color: '#faad14' }}
              />
            </Tooltip>
          </Card>
        </Col>
        <Col xs={24} sm={12} md={4}>
          <Card>
            <Tooltip title="Real mismatches that need investigation">
              <Statistic
                title="🔍 Real Mismatch"
                value={categoryStats.realMismatch}
                valueStyle={{ color: categoryStats.realMismatch > 0 ? '#ff4d4f' : '#52c41a' }}
                suffix={categoryStats.realMismatch > 0 ? <CloseCircleOutlined /> : <CheckCircleOutlined />}
              />
            </Tooltip>
          </Card>
        </Col>
        <Col xs={24} sm={12} md={4}>
          <Card>
            <Statistic
              title="Match Rate"
              value={summary.matchRate}
              precision={1}
              suffix="%"
              valueStyle={{ color: summary.matchRate >= 95 ? '#52c41a' : summary.matchRate >= 80 ? '#faad14' : '#ff4d4f' }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={4}>
          <Card>
            <Tooltip title="Matched + Expected Variance (no real bugs)">
              <Statistic
                title="✅ Effective Parity"
                value={summary.total > 0 ? ((summary.matched + categoryStats.expectedVariance) / summary.total * 100) : 0}
                precision={1}
                suffix="%"
                valueStyle={{ color: '#52c41a' }}
              />
            </Tooltip>
          </Card>
        </Col>
      </Row>

      <Card
        title={
          <Space>
            <span>Verification Results</span>
            {symbolFilter.length > 0 && (
              <Tag color="blue">{filteredResults.length} / {results.length} trades</Tag>
            )}
          </Space>
        }
        loading={loading}
        extra={
          <Space wrap>
            <FilterOutlined />
            <Select
              mode="multiple"
              placeholder="Filter by symbol"
              value={symbolFilter}
              onChange={setSymbolFilter}
              style={{ minWidth: 200 }}
              allowClear
              options={availableSymbols.map(s => ({ label: s, value: s }))}
            />
            <Text type="secondary">|</Text>
            <Text type="secondary">Last</Text>
            <InputNumber
              min={1}
              max={365}
              value={days}
              onChange={(v) => setDays(v || 30)}
              style={{ width: 70 }}
            />
            <Text type="secondary">days</Text>
            <Button
              type="primary"
              icon={verifying ? <SyncOutlined spin /> : <ReloadOutlined />}
              onClick={refreshAll}
              loading={verifying}
            >
              Verify All
            </Button>
            <Button onClick={loadResults} loading={loading}>
              Refresh
            </Button>
          </Space>
        }
      >
        {filteredResults.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px' }}>
            <Text type="secondary">
              {results.length === 0 
                ? "No verification results yet. Click \"Verify All\" to compare trades against backtest."
                : "No trades match the current filter."}
            </Text>
          </div>
        ) : (
          <Table
            dataSource={filteredResults}
            columns={columns}
            rowKey="id"
            pagination={{ pageSize: 20 }}
            size="small"
            expandable={{
              expandedRowRender: (record) => {
                const livePnl = record.livePnlPct ?? 0;
                const btPnl = record.btPnlPct;
                const pnlDiff = btPnl != null ? (livePnl - btPnl) : null;
                const entryDiff = getTimeDiffMinutes(record.liveEntryTs, record.btEntryTs);
                const exitDiff = getTimeDiffMinutes(record.liveExitTs, record.btExitTs);
                const holdTimeLive = record.liveExitTs && record.liveEntryTs 
                  ? Math.round(dayjs(record.liveExitTs).diff(dayjs(record.liveEntryTs), 'minute'))
                  : null;
                const holdTimeBt = record.btExitTs && record.btEntryTs
                  ? Math.round(dayjs(record.btExitTs).diff(dayjs(record.btEntryTs), 'minute'))
                  : null;

                return (
                  <div style={{ margin: 0, padding: '12px', background: '#fafafa', borderRadius: 8 }}>
                    <Row gutter={[24, 16]}>
                      {/* Detailed Time Comparison */}
                      <Col span={12}>
                        <Card size="small" title="⏱️ Time Comparison" style={{ marginBottom: 0 }}>
                          <Row gutter={8}>
                            <Col span={12}>
                              <Text strong>LIVE</Text>
                              <div style={{ marginTop: 4 }}>
                                <Text type="secondary">Entry: </Text>
                                <Text>{dayjs(record.liveEntryTs).format('YYYY-MM-DD HH:mm:ss')}</Text>
                              </div>
                              <div>
                                <Text type="secondary">Exit: </Text>
                                <Text>{dayjs(record.liveExitTs).format('YYYY-MM-DD HH:mm:ss')}</Text>
                              </div>
                              <div>
                                <Text type="secondary">Hold Time: </Text>
                                <Text>{holdTimeLive != null ? `${holdTimeLive}m (${(holdTimeLive/15).toFixed(1)} candles)` : 'N/A'}</Text>
                              </div>
                            </Col>
                            <Col span={12}>
                              <Text strong>BACKTEST</Text>
                              <div style={{ marginTop: 4 }}>
                                <Text type="secondary">Entry: </Text>
                                <Text>{record.btEntryTs ? dayjs(record.btEntryTs).format('YYYY-MM-DD HH:mm:ss') : 'N/A'}</Text>
                              </div>
                              <div>
                                <Text type="secondary">Exit: </Text>
                                <Text>{record.btExitTs ? dayjs(record.btExitTs).format('YYYY-MM-DD HH:mm:ss') : 'N/A'}</Text>
                              </div>
                              <div>
                                <Text type="secondary">Hold Time: </Text>
                                <Text>{holdTimeBt != null ? `${holdTimeBt}m (${(holdTimeBt/15).toFixed(1)} candles)` : 'N/A'}</Text>
                              </div>
                            </Col>
                          </Row>
                          <div style={{ marginTop: 8, borderTop: '1px solid #f0f0f0', paddingTop: 8 }}>
                            <Space>
                              <Tag color={isWithinOneCandle(record.liveEntryTs, record.btEntryTs) ? 'green' : 'orange'}>
                                Entry Δ: {entryDiff}
                              </Tag>
                              <Tag color={isWithinOneCandle(record.liveExitTs, record.btExitTs) ? 'green' : 'orange'}>
                                Exit Δ: {exitDiff}
                              </Tag>
                            </Space>
                          </div>
                        </Card>
                      </Col>

                      {/* PnL Comparison */}
                      <Col span={12}>
                        <Card size="small" title="💰 PnL Comparison" style={{ marginBottom: 0 }}>
                          <Row gutter={16}>
                            <Col span={8}>
                              <Statistic 
                                title="Live PnL" 
                                value={livePnl} 
                                precision={3} 
                                suffix="%" 
                                valueStyle={{ color: livePnl >= 0 ? '#52c41a' : '#ff4d4f', fontSize: 16 }}
                              />
                            </Col>
                            <Col span={8}>
                              <Statistic 
                                title="Backtest PnL" 
                                value={btPnl ?? 0} 
                                precision={3} 
                                suffix="%" 
                                valueStyle={{ color: (btPnl ?? 0) >= 0 ? '#52c41a' : '#ff4d4f', fontSize: 16 }}
                              />
                            </Col>
                            <Col span={8}>
                              <Statistic 
                                title="Difference" 
                                value={pnlDiff ?? 0} 
                                precision={3} 
                                suffix="%" 
                                prefix={pnlDiff != null && pnlDiff > 0 ? '+' : ''}
                                valueStyle={{ 
                                  color: pnlDiff != null && Math.abs(pnlDiff) <= PNL_TOLERANCE ? '#52c41a' : '#ff4d4f',
                                  fontSize: 16
                                }}
                              />
                            </Col>
                          </Row>
                          <div style={{ marginTop: 8 }}>
                            <Text type="secondary">Tolerance: ±{PNL_TOLERANCE}% </Text>
                            {pnlDiff != null && Math.abs(pnlDiff) <= PNL_TOLERANCE ? (
                              <Tag color="green">Within tolerance ✓</Tag>
                            ) : (
                              <Tag color="red">Outside tolerance ✗</Tag>
                            )}
                          </div>
                        </Card>
                      </Col>
                    </Row>

                    {/* Match Summary */}
                    <Row style={{ marginTop: 12 }}>
                      <Col span={24}>
                        <Space wrap>
                          <Text strong>Match Status:</Text>
                          <Tag color={record.entryMatch ? 'green' : 'red'}>
                            Entry: {record.entryMatch ? '✓ MATCH' : '✗ MISMATCH'}
                          </Tag>
                          <Tag color={record.exitMatch ? 'green' : 'red'}>
                            Exit Reason: {record.exitMatch ? '✓ MATCH' : '✗ MISMATCH'}
                          </Tag>
                          <Tag color={record.pnlMatch ? 'green' : 'red'}>
                            PnL: {record.pnlMatch ? '✓ MATCH' : '✗ MISMATCH'}
                          </Tag>
                          <Text type="secondary">|</Text>
                          <Text type="secondary">Backtest Duration: {record.backtestDurationMs ? `${record.backtestDurationMs}ms` : 'N/A'}</Text>
                        </Space>
                      </Col>
                    </Row>

                    {/* Mismatch Details */}
                    {record.mismatchDetails && (
                      <Row style={{ marginTop: 12 }}>
                        <Col span={24}>
                          <Card size="small" title="⚠️ Mismatch Details" style={{ background: '#fff2f0', border: '1px solid #ffccc7' }}>
                            <Space direction="vertical" size={0}>
                              {JSON.parse(record.mismatchDetails).map((detail: string, i: number) => (
                                <Text key={i} style={{ color: '#cf1322' }}>• {detail}</Text>
                              ))}
                            </Space>
                          </Card>
                        </Col>
                      </Row>
                    )}
                  </div>
                );
              },
              rowExpandable: () => true,
            }}
          />
        )}
      </Card>
    </Space>
  );
}

function pct(val?: number | null, digits = 2) {
  if (val == null || Number.isNaN(Number(val))) return '-';
  return `${(Number(val) * 100).toFixed(digits)}%`;
}

export default function ReportsPage() {
  const [sessions, setSessions] = React.useState<any[]>([]);
  const [reports, setReports] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(false);
  const { mode } = useMode();

  React.useEffect(() => {
    loadSessions();
  }, [mode]);

  React.useEffect(() => {
    if (sessions.length > 0) {
      loadReports();
    }
  }, [sessions]);

  const loadSessions = async () => {
    try {
      const data = await api.listSessions(mode);
      setSessions(data);
    } catch (error) {
      console.error('Failed to load sessions:', error);
    }
  };

  const loadReports = async () => {
    setLoading(true);
    try {
      // Récupérer les rapports quotidiens pour toutes les sessions actives
      const allReports: any[] = [];
      
      for (const session of sessions) {
        try {
          const sessionReports = await api.listDailyReports(session.id, 30);
          // Transformer les données pour correspondre au format attendu
          const transformedReports = sessionReports.map((report: any) => ({
            date: report.day,
            sessionId: report.sessionId,
            symbol: session.symbol,
            totalTrades: report.stats?.trades || 0,
            winRate: report.stats?.winRate || 0,
            totalPnl: report.stats?.pnlUsd || 0,
            avgWin: report.stats?.avgWin || 0,
            avgLoss: report.stats?.avgLoss || 0,
            expectancy: report.stats?.expectancy || 0,
            roiPct: report.stats?.roiPct || 0,
            maxDrawdown: -(Math.abs(report.stats?.pnlUsd || 0) * 0.15), // Estimation du drawdown
            profitFactor: report.stats?.expectancy ? Math.max(1 + (report.stats.expectancy / 100), 0.1) : 1,
            llmSummary: report.llm?.summary,
            createdAt: report.createdAt
          }));
          allReports.push(...transformedReports);
        } catch (error) {
          console.warn(`Failed to load reports for session ${session.id}:`, error);
        }
      }
      
      // Trier par date (plus récent en premier) et grouper par jour
      const groupedByDay = allReports.reduce((acc, report) => {
        const date = report.date;
        if (!acc[date]) {
          acc[date] = {
            date,
            totalTrades: 0,
            totalPnl: 0,
            sessions: [],
            winRates: [],
            expectancies: []
          };
        }
        
        acc[date].totalTrades += report.totalTrades;
        acc[date].totalPnl += report.totalPnl;
        acc[date].sessions.push(report);
        if (report.totalTrades > 0) {
          acc[date].winRates.push(report.winRate);
          acc[date].expectancies.push(report.expectancy);
        }
        
        return acc;
      }, {} as Record<string, any>);
      
      // Convertir en array et calculer les moyennes
      const finalReports = Object.values(groupedByDay).map((dayData: any) => ({
        date: dayData.date,
        totalTrades: dayData.totalTrades,
        winRate: dayData.winRates.length > 0 ? 
          dayData.winRates.reduce((sum: number, wr: number) => sum + wr, 0) / dayData.winRates.length : 0,
        totalPnl: dayData.totalPnl,
        expectancy: dayData.expectancies.length > 0 ?
          dayData.expectancies.reduce((sum: number, exp: number) => sum + exp, 0) / dayData.expectancies.length : 0,
        maxDrawdown: Math.min(...dayData.sessions.map((s: any) => s.maxDrawdown), 0),
        profitFactor: dayData.expectancies.length > 0 ? 
          Math.max(1 + (dayData.expectancies.reduce((sum: number, exp: number) => sum + exp, 0) / dayData.expectancies.length / 100), 0.1) : 1,
        sessionsCount: dayData.sessions.length,
        sessions: dayData.sessions
      })).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      
      setReports(finalReports);
    } catch (error) {
      console.error('Failed to load reports:', error);
      message.error('Failed to load reports');
    } finally {
      setLoading(false);
    }
  };

  const globalStats = React.useMemo(() => {
    const totalTrades = reports.reduce((sum, r) => sum + r.totalTrades, 0);
    const avgWinRate = reports.length > 0 ? 
      reports.reduce((sum, r) => sum + r.winRate, 0) / reports.length : 0;
    const totalPnl = reports.reduce((sum, r) => sum + r.totalPnl, 0);
    const maxDrawdown = Math.min(...reports.map(r => r.maxDrawdown), 0);

    return { totalTrades, avgWinRate, totalPnl, maxDrawdown };
  }, [reports]);

  const columns = [
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
        <span style={{ color: rate > 0.5 ? '#52c41a' : rate > 0.3 ? '#faad14' : '#ff4d4f' }}>
          {pct(rate)}
        </span>
      ),
    },
    {
      title: 'Expectancy',
      dataIndex: 'expectancy',
      key: 'expectancy',
      render: (exp: number) => (
        <span style={{ color: exp > 0 ? '#52c41a' : '#ff4d4f' }}>
          {exp.toFixed(2)}%
        </span>
      ),
    },
    {
      title: 'PnL',
      dataIndex: 'totalPnl',
      key: 'totalPnl',
      render: (pnl: number) => (
        <span style={{ color: pnl >= 0 ? '#52c41a' : '#ff4d4f' }}>
          ${pnl.toFixed(2)}
        </span>
      ),
    },
    {
      title: 'Profit Factor',
      dataIndex: 'profitFactor',
      key: 'profitFactor',
      render: (pf: number) => (
        <span style={{ color: pf > 1 ? '#52c41a' : '#ff4d4f' }}>
          {pf.toFixed(2)}
        </span>
      ),
    }
  ];

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
                  valueStyle={{ color: globalStats.avgWinRate > 0.5 ? '#52c41a' : '#ff4d4f' }}
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
                  valueStyle={{ color: globalStats.totalPnl >= 0 ? '#52c41a' : '#ff4d4f' }}
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
                  valueStyle={{ color: '#ff4d4f' }}
                />
              </Card>
            </Col>
          </Row>

          <Card title="📊 Daily Reports" loading={loading} extra={
            <Button onClick={loadReports} loading={loading}>
              Refresh Reports
            </Button>
          }>
            {reports.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px' }}>
                <Text type="secondary">
                  {sessions.length === 0 ? 'No trading sessions found' : 'No daily reports available yet'}
                </Text>
              </div>
            ) : (
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
            )}
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

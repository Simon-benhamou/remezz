import React from 'react';
import { Card, Table, Select, Space, Button, DatePicker, Drawer, Typography, Statistic, List, Descriptions, Tag, message, Tooltip } from 'antd';
import dayjs, { Dayjs } from 'dayjs';
import { api } from '../api';

const { Title, Paragraph, Text } = Typography;

function pct(val?: number | null, digits = 2) {
  if (val == null || Number.isNaN(Number(val))) return '-';
  return `${(Number(val) * 100).toFixed(digits)}%`;
}

export default function ReportsPage() {
  const [sessions, setSessions] = React.useState<any[]>([]);
  const [sessionId, setSessionId] = React.useState<string>('');
  const [reports, setReports] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [detail, setDetail] = React.useState<any>(null);
  const [detailDay, setDetailDay] = React.useState<string>('');
  const [detailOpen, setDetailOpen] = React.useState(false);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [customDate, setCustomDate] = React.useState<Dayjs | null>(dayjs());

  React.useEffect(() => {
    (async () => {
      try {
        const rows = await api.listSessions();
        setSessions(rows);
        const active = rows.find((r: any) => !r.stoppedAt);
        const first = active || rows[0];
        if (first?.id) setSessionId(first.id);
      } catch {}
    })();
  }, []);

  const loadReports = React.useCallback(async (sid: string) => {
    if (!sid) return;
    setLoading(true);
    try {
      const list = await api.listDailyReports(sid, 45);
      setReports(list);
    } catch {}
    setLoading(false);
  }, []);

  React.useEffect(() => {
    if (sessionId) loadReports(sessionId);
  }, [sessionId, loadReports]);

  const openDetail = React.useCallback(async (day: string, refresh = false) => {
    if (!sessionId) return;
    setDetailLoading(true);
    try {
      const data = await api.getDailyReport(sessionId, day, refresh ? { refresh: true } : undefined);
      setDetail(data);
      setDetailDay(day);
      setDetailOpen(true);
      if (refresh) await loadReports(sessionId);
    } catch (e: any) {
      message.error(String(e?.response?.data?.error || e?.message || 'Failed to load report'));
    } finally {
      setDetailLoading(false);
    }
  }, [sessionId, loadReports]);

  const saveDetail = React.useCallback(async () => {
    if (!sessionId || !detailDay || !detail) return;
    try {
      await api.saveDailyReport(sessionId, detailDay, detail);
      message.success('Report saved');
      await loadReports(sessionId);
    } catch (e: any) {
      message.error(String(e?.response?.data?.error || e?.message || 'Save failed'));
    }
  }, [sessionId, detailDay, detail, loadReports]);

  const generateCustom = React.useCallback(async (refreshAndSave = false) => {
    if (!sessionId || !customDate) return;
    const day = customDate.format('YYYY-MM-DD');
    setDetailLoading(true);
    try {
      const data = await api.getDailyReport(sessionId, day, { refresh: true });
      setDetail(data);
      setDetailDay(day);
      setDetailOpen(true);
      if (refreshAndSave) {
        await api.saveDailyReport(sessionId, day, data);
        message.success('Report generated and saved');
      } else {
        message.success('Report generated');
      }
      await loadReports(sessionId);
    } catch (e: any) {
      message.error(String(e?.response?.data?.error || e?.message || 'Generation failed'));
    } finally {
      setDetailLoading(false);
    }
  }, [sessionId, customDate, loadReports]);

  const columns = React.useMemo(() => ([
    {
      title: 'Date',
      dataIndex: 'day',
      width: 140,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD'),
    },
    {
      title: 'Trades',
      dataIndex: ['stats', 'trades'],
      width: 90,
    },
    {
      title: 'Win rate',
      dataIndex: ['stats', 'winRate'],
      render: (v: number) => pct(v, 1),
      width: 110,
    },
    {
      title: 'Expectancy',
      dataIndex: ['stats', 'expectancy'],
      render: (v: number) => `${(Number(v || 0)).toFixed(2)}%`,
      width: 130,
    },
    {
      title: 'ROI',
      dataIndex: ['stats', 'roiPct'],
      render: (v: number | undefined) => {
        if (v == null || Number.isNaN(Number(v))) return '—';
        const val = Number(v);
        const color = val >= 0 ? '#15803d' : '#b91c1c';
        return (
          <Tooltip title='Portfolio-return style ROI based on daily realized PnL vs start balance'>
            <span style={{ color }}>{val.toFixed(2)}%</span>
          </Tooltip>
        );
      },
      width: 110,
    },
    {
      title: 'PnL (USD)',
      dataIndex: ['stats', 'pnlUsd'],
      render: (v: number) => `$${Number(v || 0).toFixed(2)}`,
      width: 120,
    },
    {
      title: 'Summary',
      dataIndex: ['llm', 'summary'],
      ellipsis: true,
    },
    {
      title: 'Updated',
      dataIndex: 'createdAt',
      width: 160,
      render: (v: string) => v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '—',
    },
    {
      title: '',
      key: 'actions',
      width: 220,
      render: (_: any, row: any) => (
        <Space>
          <Button size='small' onClick={() => openDetail(row.day)}>View</Button>
          <Button size='small' onClick={() => openDetail(row.day, true)}>Refresh</Button>
        </Space>
      ),
    },
  ]), [openDetail]);

  const summary = React.useMemo(() => {
    if (!reports.length) return null;
    const totals = reports.reduce((acc, r) => {
      const stats = r?.stats || {};
      acc.trades += Number(stats.trades || 0);
      acc.pnl += Number(stats.pnlUsd || 0);
      acc.winTrades += Number(stats.trades || 0) * Number(stats.winRate || 0);
      if (stats.roiPct != null && !Number.isNaN(Number(stats.roiPct))) {
        acc.roiSum += Number(stats.roiPct);
        acc.roiCount += 1;
      }
      return acc;
    }, { trades: 0, pnl: 0, winTrades: 0, roiSum: 0, roiCount: 0 });
    const winRate = totals.trades ? (totals.winTrades / totals.trades) : 0;
    const avgRoi = totals.roiCount ? (totals.roiSum / totals.roiCount) : null;
    return { trades: totals.trades, pnl: totals.pnl, winRate, avgRoi };
  }, [reports]);

  const sessionOptions = sessions.map((s: any) => ({
    value: s.id,
    label: `${s.symbol} · ${s.mode?.toUpperCase?.() || ''}${!s.stoppedAt ? ' (active)' : ''}`,
  }));

  return (
    <Space direction='vertical' size='large' style={{ width: '100%' }}>
      <Card>
        <Space wrap align='center'>
          <Select
            placeholder='Session'
            style={{ minWidth: 240 }}
            value={sessionId || undefined}
            options={sessionOptions}
            onChange={(v) => setSessionId(v)}
          />
          <DatePicker value={customDate} onChange={(v) => setCustomDate(v)} />
          <Space>
            <Button onClick={() => generateCustom(false)} disabled={!customDate || !sessionId}>Generate</Button>
            <Button type='primary' onClick={() => generateCustom(true)} disabled={!customDate || !sessionId}>Generate & Save</Button>
          </Space>
          <Button onClick={() => { if (sessionId) loadReports(sessionId); }}>Reload list</Button>
          {summary && (
            <Space size='large'>
              <Statistic title='Trades' value={summary.trades} />
              <Statistic title='PnL (USD)' value={summary.pnl} precision={2} valueStyle={{ color: summary.pnl >= 0 ? '#15803d' : '#b91c1c' }} />
              <Statistic title='Win rate' value={summary.winRate * 100} suffix='%' precision={1} />
              <Statistic
                title='Avg ROI %'
                value={summary.avgRoi != null ? summary.avgRoi : 0}
                precision={2}
                valueStyle={{ color: (summary.avgRoi ?? 0) >= 0 ? '#15803d' : '#b91c1c' }}
              />
            </Space>
          )}
        </Space>
      </Card>

      <Card title='Daily Reports'>
        <Table
          rowKey={(row) => row.day}
          loading={loading}
          dataSource={reports}
          columns={columns}
          pagination={{ pageSize: 10 }}
        />
      </Card>

      <Drawer
        width={520}
        title={`Report · ${detailDay || ''}`}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        extra={detailDay ? <Button onClick={saveDetail} type='primary'>Save</Button> : null}
      >
        {detailLoading && <Paragraph>Loading…</Paragraph>}
        {!detailLoading && detail && (
          <Space direction='vertical' size='middle' style={{ width: '100%' }}>
            <Title level={4}>Stats</Title>
            <Space size='large' wrap>
              <Statistic title='Trades' value={detail?.stats?.trades || 0} />
              <Statistic title='Win rate' value={(detail?.stats?.winRate || 0) * 100} precision={1} suffix='%' />
              <Statistic title='Expectancy %' value={detail?.stats?.expectancy || 0} precision={2} />
              <Statistic title='PnL (USD)' value={detail?.stats?.pnlUsd || 0} precision={2} valueStyle={{ color: (detail?.stats?.pnlUsd || 0) >= 0 ? '#15803d' : '#b91c1c' }} />
              <Statistic title='Avg Win %' value={detail?.stats?.avgWin || 0} precision={2} />
              <Statistic title='Avg Loss %' value={detail?.stats?.avgLoss || 0} precision={2} />
            </Space>
            <Descriptions bordered size='small' column={1}>
              <Descriptions.Item label='Summary'>{detail?.llm?.summary || '-'}</Descriptions.Item>
            </Descriptions>
            <Space align='start' style={{ width: '100%' }}>
              <Card size='small' title='What went well' style={{ flex: 1 }}>
                <List size='small' dataSource={detail?.llm?.what_went_well || []} renderItem={(item: any) => <List.Item>{item}</List.Item>} />
              </Card>
              <Card size='small' title='Issues' style={{ flex: 1 }}>
                <List size='small' dataSource={detail?.llm?.issues || []} renderItem={(item: any) => <List.Item>{item}</List.Item>} />
              </Card>
              <Card size='small' title='Suggestions' style={{ flex: 1 }}>
                <List size='small' dataSource={detail?.llm?.suggestions || []} renderItem={(item: any) => <List.Item>{item}</List.Item>} />
              </Card>
            </Space>
            {Array.isArray(detail?.alerts?.recent) && detail.alerts.recent.length > 0 && (
              <Card size='small' title='Recent alerts'>
                <List
                  size='small'
                  dataSource={detail.alerts.recent}
                  renderItem={(item: any) => (
                    <List.Item>
                      <Space>
                        <Tag color={item.severity === 'high' ? 'red' : item.severity === 'med' ? 'orange' : 'blue'}>{item.kind}</Tag>
                        <Text>{dayjs(item.ts).format('HH:mm')} – {item.details?.note || ''}</Text>
                      </Space>
                    </List.Item>
                  )}
                />
              </Card>
            )}
          </Space>
        )}
        {!detailLoading && !detail && <Paragraph type='secondary'>Select a report to inspect details.</Paragraph>}
      </Drawer>
    </Space>
  );
}

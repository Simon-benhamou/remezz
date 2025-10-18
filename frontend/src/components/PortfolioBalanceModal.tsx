import React from 'react';
import { Button, Divider, InputNumber, Modal, Space, Statistic, Table, Typography, message } from 'antd';
import { api } from '../api';
import { ThunderboltOutlined } from '../icons';

type PortfolioBalanceModalProps = {
  open: boolean;
  mode: 'live' | 'paper';
  onClose: () => void;
  onUpdated?: () => void;
};

type PortfolioAllocation = {
  sessionId: string;
  symbol: string;
  capitalUsd: number;
  weightPct: number;
  winRate: number;
  roiPct: number;
  expectancy: number;
  drawdownPct: number;
  budgetFraction: number;
  performanceScore: number;
};

type PortfolioSnapshot = {
  mode: 'paper' | 'live';
  balanceUsd: number;
  allocatedUsd: number;
  freeUsd: number;
  maxExposureUsd: number;
  exposureUtilizationPct: number;
  maxExposureMultiplier: number;
  lastRebalancedAt?: string;
  allocations: PortfolioAllocation[];
};

const formatUsd = (value?: number | null, digits = 0) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
};

const formatPercent = (value?: number | null, digits = 1) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
};

const formatDecimal = (value?: number | null, digits = 2) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
};

const safeNumber = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const getTrendColor = (value?: number | null, neutral = 0) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value > neutral) return '#16a34a';
  if (value < neutral) return '#dc2626';
  return '#334155';
};

const formatSessionLabel = (sessionId: string) => {
  if (!sessionId) return '—';
  if (sessionId.length <= 12) return sessionId;
  return `${sessionId.slice(0, 6)}…${sessionId.slice(-4)}`;
};

const PortfolioBalanceModal: React.FC<PortfolioBalanceModalProps> = ({ open, mode, onClose, onUpdated }) => {
  const [loading, setLoading] = React.useState(false);
  const [paperSnapshot, setPaperSnapshot] = React.useState<PortfolioSnapshot | null>(null);
  const [liveSnapshot, setLiveSnapshot] = React.useState<PortfolioSnapshot | null>(null);
  const [paperBalance, setPaperBalance] = React.useState<number | null>(null);
  const [rebalancing, setRebalancing] = React.useState(false);

  const loadSnapshots = React.useCallback(async () => {
    try {
      setLoading(true);
      const [paper, live] = await Promise.all([
        api.getPortfolio('paper').catch(() => null),
        api.getPortfolio('live').catch(() => null),
      ]);
      setPaperSnapshot(paper);
      setLiveSnapshot(live);
      if (paper?.balanceUsd != null) {
        setPaperBalance(Number(paper.balanceUsd));
      }
    } catch (error) {
      console.error('Unable to load portfolio snapshots', error);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (open) {
      void loadSnapshots();
    }
  }, [open, mode, loadSnapshots]);

  const handleSave = async () => {
    if (mode !== 'paper') {
      onClose();
      return;
    }

    if (!Number.isFinite(paperBalance)) {
      message.error('Enter a valid paper balance');
      return;
    }

    try {
      setLoading(true);
      await api.setPortfolioBalance('paper', Number(paperBalance));
      message.success('Paper balance updated');
      onUpdated?.();
      onClose();
    } catch (error) {
      console.error('Failed to update paper balance', error);
      message.error('Unable to update paper balance');
    } finally {
      setLoading(false);
    }
  };

  const paperMetrics:any = paperSnapshot ?? {};
  const liveMetrics:any = liveSnapshot ?? {};
  const activeSnapshot = mode === 'paper' ? paperSnapshot : liveSnapshot;
  const allocationRows = React.useMemo(() => {
    const list = activeSnapshot?.allocations ?? [];
    return list.map((allocation) => ({
      key: allocation.sessionId,
      ...allocation,
      capitalUsd: safeNumber(allocation.capitalUsd),
      weightPct: safeNumber(allocation.weightPct, Number.NaN),
      winRate: safeNumber(allocation.winRate, Number.NaN),
      roiPct: safeNumber(allocation.roiPct, Number.NaN),
      expectancy: safeNumber(allocation.expectancy, Number.NaN),
      drawdownPct: safeNumber(allocation.drawdownPct, Number.NaN),
      budgetFraction: safeNumber(allocation.budgetFraction, Number.NaN),
      performanceScore: safeNumber(allocation.performanceScore, Number.NaN),
    }));
  }, [activeSnapshot]);
  const allocationColumns = React.useMemo(
    () => [
      {
        title: 'Agent',
        dataIndex: 'symbol',
        key: 'agent',
        render: (_: string, record: PortfolioAllocation) => (
          <Space direction='vertical' size={0}>
            <Typography.Text strong>{record.symbol || '—'}</Typography.Text>
            <Typography.Text type='secondary' style={{ fontSize: 12 }}>
              {formatSessionLabel(record.sessionId)}
            </Typography.Text>
          </Space>
        ),
      },
      {
        title: 'Capital',
        dataIndex: 'capitalUsd',
        key: 'capitalUsd',
        align: 'right' as const,
        render: (value: number) => <Typography.Text>{formatUsd(value, 0)}</Typography.Text>,
      },
      {
        title: 'Weight',
        dataIndex: 'weightPct',
        key: 'weightPct',
        align: 'right' as const,
        render: (value: number) => <Typography.Text>{formatPercent(value, 1)}</Typography.Text>,
      },
      {
        title: 'Win rate',
        dataIndex: 'winRate',
        key: 'winRate',
        align: 'right' as const,
        render: (value: number) => (
          <Typography.Text style={{ color: getTrendColor(value, 50) }}>
            {formatPercent(value, 1)}
          </Typography.Text>
        ),
      },
      {
        title: 'ROI',
        dataIndex: 'roiPct',
        key: 'roiPct',
        align: 'right' as const,
        render: (value: number) => (
          <Typography.Text style={{ color: getTrendColor(value, 0) }}>
            {formatPercent(value, 1)}
          </Typography.Text>
        ),
      },
      {
        title: 'Expectancy',
        dataIndex: 'expectancy',
        key: 'expectancy',
        align: 'right' as const,
        render: (value: number) => <Typography.Text>{formatDecimal(value, 2)}</Typography.Text>,
      },
      {
        title: 'Drawdown',
        dataIndex: 'drawdownPct',
        key: 'drawdownPct',
        align: 'right' as const,
        render: (value: number) => (
          <Typography.Text style={{ color: getTrendColor(-value, 0) }}>
            {formatPercent(value, 1)}
          </Typography.Text>
        ),
      },
      {
        title: 'Budget',
        dataIndex: 'budgetFraction',
        key: 'budgetFraction',
        align: 'right' as const,
        render: (value: number) => <Typography.Text>{formatPercent((value ?? 0) * 100, 1)}</Typography.Text>,
      },
      {
        title: 'Score',
        dataIndex: 'performanceScore',
        key: 'performanceScore',
        align: 'right' as const,
        render: (value: number) => <Typography.Text>{formatDecimal(value, 2)}</Typography.Text>,
      },
    ],
    [],
  );
  const lastRebalancedLabel = React.useMemo(() => {
    if (!activeSnapshot?.lastRebalancedAt) return 'Never';
    const date = new Date(activeSnapshot.lastRebalancedAt);
    if (Number.isNaN(date.getTime())) return activeSnapshot.lastRebalancedAt;
    return date.toLocaleString();
  }, [activeSnapshot?.lastRebalancedAt]);
  const handleRebalance = React.useCallback(async () => {
    try {
      setRebalancing(true);
      const response = await api.rebalancePortfolio(mode);
      const snapshot = (response?.snapshot ?? response) as PortfolioSnapshot | undefined;
      if (snapshot?.mode === 'paper') {
        setPaperSnapshot(snapshot);
        if (Number.isFinite(Number(snapshot.balanceUsd))) {
          setPaperBalance(Number(snapshot.balanceUsd));
        }
      } else if (snapshot?.mode === 'live') {
        setLiveSnapshot(snapshot);
      }
      message.success('Portfolio rebalanced using agent win rates');
      onUpdated?.();
    } catch (error) {
      console.error('Failed to rebalance portfolio', error);
      message.error('Unable to rebalance portfolio');
    } finally {
      setRebalancing(false);
    }
  }, [loadSnapshots, mode, onUpdated]);

  return (
    <Modal
      open={open}
      title='Manage portfolio balance'
      onCancel={onClose}
      onOk={handleSave}
      okText={mode === 'paper' ? 'Save balance' : 'Close'}
      cancelButtonProps={{ style: mode === 'paper' ? undefined : { display: 'none' } }}
      confirmLoading={loading}
    >
      <Space direction='vertical' size='large' style={{ width: '100%' }}>
        <Typography.Paragraph type='secondary'>
          Adjust your paper capital allocation or review live exchange balances. Paper balance updates do not impact live funds.
        </Typography.Paragraph>

        <Space size='large' wrap>
          <Statistic
            title='Paper balance'
            prefix='$'
            value={Number(paperMetrics.balanceUsd ?? 0)}
            precision={0}
          />
          <Statistic
            title='Allocated'
            prefix='$'
            value={Number(paperMetrics.allocatedUsd ?? 0)}
            precision={0}
          />
          <Statistic
            title='Free capital'
            prefix='$'
            value={Number(paperMetrics.freeUsd ?? 0)}
            precision={0}
          />
        </Space>

        <InputNumber
          min={0}
          value={paperBalance ?? undefined}
          onChange={(val) => setPaperBalance(typeof val === 'number' ? val : null)}
          style={{ width: '100%' }}
          disabled={mode !== 'paper'}
          addonBefore='Paper balance (USD)'
        />

        <Divider style={{ margin: '12px 0' }} />

        <Space size='large' wrap>
          <Statistic
            title='Live equity'
            prefix='$'
            value={Number(liveMetrics.totalUsd ?? 0)}
            precision={0}
          />
          <Statistic
            title='Free balance'
            prefix='$'
            value={Number(liveMetrics.freeUsd ?? 0)}
            precision={0}
          />
        </Space>

        <Divider style={{ margin: '12px 0' }} />

        <Space
          align='center'
          style={{ width: '100%', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}
        >
          <Space direction='vertical' size={0} style={{ flex: 1, minWidth: 220 }}>
            <Typography.Title level={5} style={{ margin: 0 }}>
              {mode === 'paper' ? 'Paper agent allocations' : 'Live agent allocations'}
            </Typography.Title>
            <Typography.Text type='secondary'>
              Last rebalance: {lastRebalancedLabel}
            </Typography.Text>
          </Space>
          <Button
            type='primary'
            icon={<ThunderboltOutlined />}
            onClick={handleRebalance}
            loading={rebalancing}
            disabled={!allocationRows.length || loading}
          >
            Rebalance by win rate
          </Button>
        </Space>

        <Table
          size='small'
          rowKey='sessionId'
          dataSource={allocationRows}
          columns={allocationColumns}
          pagination={false}
          scroll={{ x: true }}
          loading={loading || rebalancing}
          locale={{ emptyText: loading || rebalancing ? 'Loading allocations…' : 'No active agents found' }}
        />
      </Space>
    </Modal>
  );
};

export default PortfolioBalanceModal;

import React from 'react';
import { Modal, Typography, Statistic, Row, Col, Space, InputNumber, Button, Divider, message, Tag, Tooltip, Table } from 'antd';
import { api } from '../api';

const formatUsd = (value?: number | null) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
};

const formatLeverage = (value?: number | null) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '1x';
  return `${value.toFixed(1)}x`;
};

type Snapshot = {
  totalUSD: number;
  freeUSD: number;
  reservedUSD: number;
  inPositionsUSD: number;
  ts: number;
};

type Reservation = {
  id: string;
  agentId: string;
  symbol: string;
  requestedUSD: number;
  grantedUSD: number;
  leverage?: number;
  expiresAt: number;
  state: 'reserved' | 'committed' | 'released';
};

type PortfolioBalanceModalProps = {
  open: boolean;
  mode: 'live' | 'paper';
  onClose: () => void;
  onUpdated?: () => void;
};

export default function PortfolioBalanceModal({ open, mode, onClose, onUpdated }: PortfolioBalanceModalProps) {
  const [paperSnapshot, setPaperSnapshot] = React.useState<Snapshot | null>(null);
  const [liveSnapshot, setLiveSnapshot] = React.useState<Snapshot | null>(null);
  const [paperReservations, setPaperReservations] = React.useState<Reservation[]>([]);
  const [liveReservations, setLiveReservations] = React.useState<Reservation[]>([]);
  const [paperBalance, setPaperBalance] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(false);

  const loadSnapshots = React.useCallback(async () => {
    try {
      setLoading(true);
      const [paper, live, reservations] = await Promise.all([
        api.getCapitalSnapshot('paper').catch(() => null),
        api.getCapitalSnapshot('live').catch(() => null),
        api.getCapitalReservations().catch(() => ({ paper: [], live: [] })),
      ]);
      setPaperSnapshot(paper);
      setLiveSnapshot(live);
      setPaperReservations(reservations.paper.filter(r => r.state === 'reserved'));
      setLiveReservations(reservations.live.filter(r => r.state === 'reserved'));
      if (paper?.totalUSD != null) {
        setPaperBalance(Number(paper.totalUSD));
      }
    } catch (error) {
      console.error('Failed to load capital snapshots', error);
      message.error('Unable to load capital snapshots');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (open) {
      void loadSnapshots();
    }
  }, [open, loadSnapshots]);

  const handleSave = async () => {
    if (mode !== 'paper') {
      onClose();
      return;
    }
    if (!Number.isFinite(paperBalance) || paperBalance == null || paperBalance <= 0) {
      message.error('Enter a valid initial balance');
      return;
    }
    try {
      setLoading(true);
      await api.setPaperCapitalBalance(Number(paperBalance));
      message.success('Paper balance updated');
      await loadSnapshots();
      onUpdated?.();
      onClose();
    } catch (error) {
      console.error('Failed to update paper balance', error);
      message.error('Unable to update paper balance');
    } finally {
      setLoading(false);
    }
  };

  const currentSnapshot = mode === 'paper' ? paperSnapshot : liveSnapshot;
  const currentReservations = mode === 'paper' ? paperReservations : liveReservations;
  
  const renderSnapshot = (snapshot: Snapshot | null, label: string) => (
    <Row gutter={[16, 16]} style={{ width: '100%' }}>
      <Col span={12}>
        <Statistic title={`${label} Total`} value={formatUsd(snapshot?.totalUSD)} />
      </Col>
      <Col span={12}>
        <Statistic title='Free' value={formatUsd(snapshot?.freeUSD)} />
      </Col>
      <Col span={12}>
        <Tooltip title="Margin reserved by agents (with leverage applied)">
          <Statistic title='Reserved (Margin)' value={formatUsd(snapshot?.reservedUSD)} />
        </Tooltip>
      </Col>
      <Col span={12}>
        <Tooltip title="Margin locked in open positions (with leverage applied)">
          <Statistic title='In Positions (Margin)' value={formatUsd(snapshot?.inPositionsUSD)} />
        </Tooltip>
      </Col>
    </Row>
  );

  const reservationColumns = [
    {
      title: 'Symbol',
      dataIndex: 'symbol',
      key: 'symbol',
      width: 100,
    },
    {
      title: 'Agent',
      dataIndex: 'agentId',
      key: 'agentId',
      width: 100,
      render: (id: string) => id.slice(0, 8) + '...',
    },
    {
      title: 'Notional',
      dataIndex: 'requestedUSD',
      key: 'requestedUSD',
      width: 100,
      render: (value: number) => formatUsd(value),
    },
    {
      title: 'Leverage',
      dataIndex: 'leverage',
      key: 'leverage',
      width: 80,
      render: (value?: number) => (
        <Tag color={!value || value === 1 ? 'default' : value >= 5 ? 'orange' : 'blue'}>
          {formatLeverage(value)}
        </Tag>
      ),
    },
    {
      title: 'Margin',
      dataIndex: 'grantedUSD',
      key: 'grantedUSD',
      width: 100,
      render: (value: number, record: Reservation) => (
        <Tooltip title={`${formatUsd(record.requestedUSD)} / ${formatLeverage(record.leverage)} = ${formatUsd(value)}`}>
          <strong>{formatUsd(value)}</strong>
        </Tooltip>
      ),
    },
  ];

  const footer = mode === 'paper'
    ? [
        <Button key='cancel' onClick={onClose} disabled={loading}>
          Cancel
        </Button>,
        <Button key='save' type='primary' loading={loading} onClick={handleSave}>
          Save
        </Button>,
      ]
    : [
        <Button key='close' type='primary' onClick={onClose}>
          Close
        </Button>,
      ];

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={
        <Space align='center'>
          <Typography.Text strong style={{ fontSize: 18 }}>
            Capital Pool Snapshot
          </Typography.Text>
          <Tag color={mode === 'live' ? 'cyan' : 'blue'}>{mode.toUpperCase()}</Tag>
        </Space>
      }
      footer={footer}
      maskClosable={!loading}
      centered
      width={currentReservations.length > 0 ? 800 : 600}
    >
      <Space direction='vertical' size={24} style={{ width: '100%' }}>
        <Typography.Paragraph type='secondary'>
          View the shared capital pool for {mode === 'live' ? 'live trading' : 'paper simulation'}. {mode === 'paper'
            ? 'You can adjust the initial paper balance below.'
            : 'Live balances are read-only and sourced from the exchange.'}
        </Typography.Paragraph>

        {renderSnapshot(currentSnapshot, mode === 'paper' ? 'Paper' : 'Live')}

        {currentReservations.length > 0 && (
          <>
            <Divider />
            <Space direction='vertical' size={8} style={{ width: '100%' }}>
              <Typography.Text strong>Active Reservations with Leverage</Typography.Text>
              <Typography.Paragraph type='secondary' style={{ marginBottom: 8 }}>
                Agents reserve margin (not full notional) when using leverage. The "Margin" column shows the actual capital locked from the pool.
              </Typography.Paragraph>
              <Table
                columns={reservationColumns}
                dataSource={currentReservations}
                rowKey='id'
                size='small'
                pagination={false}
                scroll={{ x: 'max-content' }}
              />
            </Space>
          </>
        )}

        {mode === 'paper' && (
          <>
            <Divider />
            <Space direction='vertical' size={8} style={{ width: '100%' }}>
              <Typography.Text strong>Initial Cash (USD)</Typography.Text>
              <InputNumber
                style={{ width: '100%' }}
                min={0}
                step={100}
                value={paperBalance ?? undefined}
                onChange={(value) => setPaperBalance(typeof value === 'number' ? value : null)}
              />
              <Typography.Paragraph type='secondary' style={{ marginBottom: 0 }}>
                Updating this value resets the paper ledger and applies instantly to all paper agents.
              </Typography.Paragraph>
            </Space>
          </>
        )}

        <Divider />
        <Space direction='vertical' size={12} style={{ width: '100%' }}>
          <Typography.Text type='secondary'>
            Live Snapshot
          </Typography.Text>
          {renderSnapshot(liveSnapshot, 'Live')}
        </Space>
      </Space>
    </Modal>
  );
}

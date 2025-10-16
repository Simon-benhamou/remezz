import React from 'react';
import { Divider, InputNumber, Modal, Space, Statistic, Typography, message } from 'antd';
import { api } from '../api';

type PortfolioBalanceModalProps = {
  open: boolean;
  mode: 'live' | 'paper';
  onClose: () => void;
  onUpdated?: () => void;
};

const PortfolioBalanceModal: React.FC<PortfolioBalanceModalProps> = ({ open, mode, onClose, onUpdated }) => {
  const [loading, setLoading] = React.useState(false);
  const [paperSnapshot, setPaperSnapshot] = React.useState<any | null>(null);
  const [liveSnapshot, setLiveSnapshot] = React.useState<any | null>(null);
  const [paperBalance, setPaperBalance] = React.useState<number | null>(null);

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

  const paperMetrics = paperSnapshot ?? {};
  const liveMetrics = liveSnapshot ?? {};

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
      </Space>
    </Modal>
  );
};

export default PortfolioBalanceModal;

import React from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Divider,
  Empty,
  Progress,
  Row,
  Space,
  Statistic,
  Tag,
  Typography,
  theme,
} from 'antd';
import { Activity, Brain, RefreshCcw, TrendingDown, TrendingUp } from 'lucide-react';
import { useSelectorInsights } from '../hooks/useSelectorInsights';
import type { SelectorDecision } from '../types/selector';
import { formatDisplaySymbol } from '../utils/symbols';

const { Title, Text } = Typography;

function formatRelativeTime(ts?: number | null) {
  if (!ts) return 'never';
  const delta = Date.now() - ts;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) {
    return `${Math.round(delta / 60_000)} min ago`;
  }
  if (delta < 86_400_000) {
    return `${Math.round(delta / 3_600_000)}h ago`;
  }
  return `${Math.round(delta / 86_400_000)}d ago`;
}

function formatUsd(value: number, digits = 0) {
  if (!Number.isFinite(value)) return '$0';
  const sign = value >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: digits })}`;
}

function formatPercent(value: number, digits = 1) {
  if (!Number.isFinite(value)) return '0%';
  return `${value.toFixed(digits)}%`;
}

type DecisionPanelProps = {
  title: string;
  accent: string;
  decisions: SelectorDecision[];
  emptyLabel: string;
  variant?: 'promote' | 'demote' | 'neutral';
};

const DecisionPanel: React.FC<DecisionPanelProps> = ({ title, accent, decisions, emptyLabel, variant = 'neutral' }) => {
  const { token } = theme.useToken();
  return (
    <Card
      title={<span style={{ color: '#e2e8f0' }}>{title}</span>}
      extra={<Tag color={accent} style={{ borderRadius: 8 }}>{decisions.length}</Tag>}
      style={{ borderRadius: 18, border: `1px solid ${token.colorBorderSecondary}` }}
      bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 16 }}
    >
      {decisions.length === 0 ? (
        <Empty description={emptyLabel} style={{ color: 'rgba(148,163,184,0.7)' }} />
      ) : (
        decisions.slice(0, 6).map((decision) => (
          <DecisionRow key={`${decision.sessionId}-${decision.symbol}`} decision={decision} accent={accent} variant={variant} />
        ))
      )}
    </Card>
  );
};

type DecisionRowProps = {
  decision: SelectorDecision;
  accent: string;
  variant?: 'promote' | 'demote' | 'neutral';
};

const DecisionRow: React.FC<DecisionRowProps> = ({ decision, accent, variant = 'neutral' }) => {
  const { token } = theme.useToken();
  const winRatePct = decision.winRate * 100;
  const normalizedScore = decision.normalizedScore;
  const scorePct = Math.round((normalizedScore + 1) * 50);
  const scoreTone = variant === 'promote' ? '#34d399' : variant === 'demote' ? '#f87171' : '#60a5fa';
  return (
    <div
      style={{
        borderRadius: 16,
        border: `1px solid ${token.colorBorderSecondary}`,
        padding: 16,
        background: 'rgba(15, 23, 42, 0.72)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <Space size={10} wrap>
          <Tag color={accent} style={{ borderRadius: 10, fontWeight: 600 }}>
            {formatDisplaySymbol(decision.symbol)}
          </Tag>
          <Text style={{ color: '#e2e8f0', fontWeight: 600 }}>{decision.agentName}</Text>
          {decision.agentFamily && <Tag color='geekblue'>{decision.agentFamily}</Tag>}
          {decision.regime && <Tag color='purple'>{decision.regime}</Tag>}
          <Tag color='default'>{decision.mode}</Tag>
          <Tag color='default'>Trades {decision.totalTrades}</Tag>
        </Space>
        <Space size={8} align='center'>
          <Text style={{ color: scoreTone, fontWeight: 600 }}>Score {normalizedScore.toFixed(2)}</Text>
          {variant === 'promote' && <TrendingUp size={16} color={scoreTone} />}
          {variant === 'demote' && <TrendingDown size={16} color={scoreTone} />}
        </Space>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
        <Statistic title='Net PnL' value={formatUsd(decision.netPnlUsd)} valueStyle={{ color: decision.netPnlUsd >= 0 ? '#34d399' : '#f87171', fontSize: 18 }} />
        <Statistic title='Win rate' value={formatPercent(winRatePct)} valueStyle={{ color: winRatePct >= 50 ? '#34d399' : '#fbbf24', fontSize: 18 }} />
        <Statistic title='Avg latency' value={decision.avgLatencyMs ? `${Math.round(decision.avgLatencyMs)} ms` : '—'} valueStyle={{ color: '#e2e8f0', fontSize: 18 }} />
        <Statistic title='Slippage' value={decision.avgSlippageBps ? `${decision.avgSlippageBps.toFixed(1)} bps` : '—'} valueStyle={{ color: '#e2e8f0', fontSize: 18 }} />
      </div>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Progress
            percent={scorePct}
            showInfo={false}
            strokeColor={scoreTone}
            trailColor='rgba(148,163,184,0.25)'
          />
          <Text style={{ color: 'rgba(148,163,184,0.85)' }}>{decision.reason || 'Score rationale unavailable'}</Text>
        </div>
        {decision.sampleWindows.length > 0 && (
          <Text style={{ color: 'rgba(148,163,184,0.75)', fontSize: 12 }}>
            Windows: {decision.sampleWindows.map((minutes) => `${minutes}m`).join(', ')}
          </Text>
        )}
      </div>
    </div>
  );
};

const LearningInsightsPage: React.FC = () => {
  const { snapshot, loading, error, lastUpdated, lastReason, refresh } = useSelectorInsights({
    refreshIntervalMs: 60_000,
    enableLive: true,
  });
  const { token } = theme.useToken();

  const stats = snapshot?.stats;
  const lookbackLabel = stats
    ? stats.lookbackMinutes >= 60
      ? `${(stats.lookbackMinutes / 60).toFixed(1)}h rolling ledger`
      : `${stats.lookbackMinutes}m rolling ledger`
    : 'Waiting for ledger refresh';

  const summaryCards = [
    {
      key: 'combos',
      title: 'Combos evaluated',
      value: snapshot?.combosEvaluated ?? 0,
      helper: lookbackLabel,
      accent: '#60a5fa',
    },
    {
      key: 'promotions',
      title: 'Promotion-ready',
      value: snapshot?.promotions.length ?? 0,
      helper: `Score >= ${(stats?.promoteThreshold ?? 0).toFixed(2)}`,
      accent: '#34d399',
    },
    {
      key: 'demotions',
      title: 'Demotions flagged',
      value: snapshot?.demotions.length ?? 0,
      helper: `Score <= ${(stats?.demoteThreshold ?? 0).toFixed(2)}`,
      accent: '#f87171',
    },
    {
      key: 'watchlist',
      title: 'Watchlist',
      value: snapshot?.watchlist.length ?? 0,
      helper: 'Hold & monitor',
      accent: '#fbbf24',
    },
    {
      key: 'insufficient',
      title: 'Insufficient data',
      value: snapshot?.suppressed.length ?? 0,
      helper: `Min trades ${stats?.minTrades ?? 0}+`,
      accent: '#94a3b8',
    },
  ];

  return (
    <Space direction='vertical' size={24} style={{ width: '100%' }}>
      <Card
        style={{
          borderRadius: 20,
          border: `1px solid ${token.colorBorderSecondary}`,
          background: 'linear-gradient(135deg, rgba(15,23,42,0.95), rgba(30,64,175,0.65))',
        }}
        bodyStyle={{ padding: 28 }}
      >
        <Row gutter={[24, 24]} align='middle'>
          <Col xs={24} md={16}>
            <Space direction='vertical' size={10}>
              <Tag color='geekblue' icon={<Brain size={14} />} style={{ alignSelf: 'flex-start', borderRadius: 999 }}>
                Learning Insights
              </Tag>
              <Title level={2} style={{ margin: 0, color: '#e2e8f0' }}>
                Selector intelligence & self-learning telemetry
              </Title>
              <Text style={{ color: 'rgba(226,232,240,0.78)', maxWidth: 540 }}>
                Track how the agent selector evaluates each session-symbol combo, what it plans to promote or demote,
                and which markets still need more evidence before automation reacts.
              </Text>
              <Space size={12} wrap>
                <Tag color='green' style={{ borderRadius: 10 }}>Live websocket feed</Tag>
                <Tag color='blue' style={{ borderRadius: 10 }}>{lookbackLabel}</Tag>
                {lastUpdated && (
                  <Tag color='default' style={{ borderRadius: 10 }}>
                    Updated {formatRelativeTime(lastUpdated)}{lastReason ? ` · ${lastReason}` : ''}
                  </Tag>
                )}
              </Space>
            </Space>
          </Col>
          <Col xs={24} md={8}>
            <Space direction='vertical' size={12} style={{ width: '100%' }}>
              <Button
                type='primary'
                icon={<RefreshCcw size={16} />}
                onClick={() => void refresh({ force: true })}
                loading={loading}
                style={{ width: '100%', borderRadius: 12 }}
              >
                Force recompute
              </Button>
              <Card
                size='small'
                style={{
                  borderRadius: 16,
                  border: `1px solid ${token.colorBorderSecondary}`,
                  background: 'rgba(8,15,35,0.8)',
                }}
                bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 8 }}
              >
                <Space size={8} align='center'>
                  <Activity size={18} color='#60a5fa' />
                  <Text style={{ color: '#e2e8f0', fontWeight: 600 }}>Latest snapshot</Text>
                </Space>
                <Text style={{ color: 'rgba(148,163,184,0.78)' }}>
                  {snapshot?.generatedAt ? `Generated ${formatRelativeTime(snapshot.generatedAt)}` : 'Awaiting telemetry'}
                </Text>
                <Divider style={{ margin: '8px 0', borderColor: 'rgba(148,163,184,0.2)' }} />
                <Text style={{ color: 'rgba(148,163,184,0.78)', fontSize: 12 }}>
                  Combos scanned: {snapshot?.combosEvaluated ?? '—'}
                </Text>
              </Card>
            </Space>
          </Col>
        </Row>
      </Card>

      {error && (
        <Alert
          type='error'
          message='Failed to load learning insights'
          description={error}
          showIcon
        />
      )}

      <Row gutter={[24, 24]}>
        {summaryCards.map((card) => (
          <Col xs={24} sm={12} lg={8} xl={6} key={card.key}>
            <Card
              style={{ borderRadius: 18, border: `1px solid ${token.colorBorderSecondary}`, height: '100%' }}
              bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 10 }}
            >
              <Text style={{ color: 'rgba(148,163,184,0.78)', fontSize: 12 }}>{card.title}</Text>
              <Title level={3} style={{ margin: 0, color: card.accent }}>{card.value}</Title>
              <Text style={{ color: 'rgba(148,163,184,0.72)', fontSize: 12 }}>{card.helper}</Text>
            </Card>
          </Col>
        ))}
      </Row>

      <Row gutter={[24, 24]}>
        <Col xs={24} xl={12}>
          <DecisionPanel
            title='Promotion queue'
            accent='#34d399'
            decisions={snapshot?.promotions ?? []}
            emptyLabel='No promotion candidates yet.'
            variant='promote'
          />
        </Col>
        <Col xs={24} xl={12}>
          <DecisionPanel
            title='Demotion watchlist'
            accent='#f87171'
            decisions={snapshot?.demotions ?? []}
            emptyLabel='No demotion candidates yet.'
            variant='demote'
          />
        </Col>
      </Row>

      <Row gutter={[24, 24]}>
        <Col xs={24} xl={12}>
          <DecisionPanel
            title='Stable but monitored'
            accent='#fbbf24'
            decisions={snapshot?.watchlist ?? []}
            emptyLabel='Watchlist empty.'
          />
        </Col>
        <Col xs={24} xl={12}>
          <DecisionPanel
            title='Needs more evidence'
            accent='#94a3b8'
            decisions={snapshot?.suppressed ?? []}
            emptyLabel='No low-sample combos.'
          />
        </Col>
      </Row>
    </Space>
  );
};

export default LearningInsightsPage;

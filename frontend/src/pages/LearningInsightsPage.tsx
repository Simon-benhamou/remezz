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
import { Activity, Brain, Cpu, Globe, MessageCircle, RefreshCcw, Shield, TrendingDown, TrendingUp, Zap } from 'lucide-react';
import { useSelectorInsights, useSubagentLearningInsights } from '../hooks/useSelectorInsights';
import type { SelectorDecision } from '../types/selector';
import type { SubagentLearningRecord } from '../types/subagentLearning';
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

function formatLatency(value: number | null | undefined) {
  if (!Number.isFinite(value ?? Number.NaN)) return '—';
  return `${Math.round(value ?? 0)} ms`;
}

function formatBps(value: number | null | undefined) {
  if (!Number.isFinite(value ?? Number.NaN)) return '—';
  return `${(value ?? 0).toFixed(1)} bps`;
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

type GenericSubagentRecord = SubagentLearningRecord;

type SubagentPanelProps = {
  title: string;
  accent: string;
  icon?: React.ReactNode;
  records: GenericSubagentRecord[];
  emptyLabel: string;
  renderTuning: (record: GenericSubagentRecord) => React.ReactNode;
};

const SubagentPanel: React.FC<SubagentPanelProps> = ({ title, accent, icon, records, emptyLabel, renderTuning }) => {
  const { token } = theme.useToken();
  const topRecords = records
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  return (
    <Card
      style={{ borderRadius: 18, border: `1px solid ${token.colorBorderSecondary}`, height: '100%' }}
      bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      title={(
        <Space size={8} align='center'>
          {icon}
          <span style={{ color: '#e2e8f0', fontWeight: 600 }}>{title}</span>
        </Space>
      )}
      extra={<Tag color={accent} style={{ borderRadius: 12 }}>{records.length}</Tag>}
    >
      {records.length === 0 ? (
        <Empty description={emptyLabel} style={{ color: 'rgba(148,163,184,0.7)' }} />
      ) : (
        topRecords.map((record) => (
          <div
            key={`${record.subagent}-${record.symbol}-${record.mode}`}
            style={{
              borderRadius: 14,
              border: `1px solid ${token.colorBorderSecondary}`,
              padding: 14,
              background: 'rgba(15,23,42,0.6)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <Space size={8} wrap>
              <Tag color={accent} style={{ borderRadius: 10 }}>{formatDisplaySymbol(record.symbol)}</Tag>
              <Tag color='default'>{record.mode}</Tag>
              <Tag color='purple'>{record.regime}</Tag>
              <Tag color='default'>Trades {record.metrics.tradeCount}</Tag>
              <Tag color='default'>Score {record.score.toFixed(2)}</Tag>
            </Space>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
              <Statistic
                title='Net PnL'
                value={formatUsd(record.metrics.netPnlUsd)}
                valueStyle={{ color: record.metrics.netPnlUsd >= 0 ? '#34d399' : '#f87171', fontSize: 16 }}
              />
              <Statistic
                title='Win rate'
                value={formatPercent(record.metrics.winRate * 100)}
                valueStyle={{ color: record.metrics.winRate >= 0.5 ? '#34d399' : '#fbbf24', fontSize: 16 }}
              />
              <Statistic title='Latency' value={formatLatency(record.metrics.avgLatencyMs)} valueStyle={{ color: '#e2e8f0', fontSize: 16 }} />
              <Statistic title='Slippage' value={formatBps(record.metrics.avgSlippageBps)} valueStyle={{ color: '#e2e8f0', fontSize: 16 }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Space size={6} wrap>
                {renderTuning(record)}
              </Space>
              {record.reason && (
                <Text style={{ color: 'rgba(148,163,184,0.8)', fontSize: 12 }}>Reason: {record.reason}</Text>
              )}
            </div>
          </div>
        ))
      )}
    </Card>
  );
};

function renderRiskTuning(record: SubagentLearningRecord<'risk_governor'>) {
  const tuning = record.tuning;
  return (
    <>
      <Tag color='red' style={{ borderRadius: 10 }}>Max lev {tuning.recommendedMaxLeverage.toFixed(2)}x</Tag>
      <Tag color='red' style={{ borderRadius: 10 }}>Pos {(tuning.recommendedMaxPositionPct * 100).toFixed(1)}%</Tag>
      <Tag color='geekblue' style={{ borderRadius: 10 }}>Hedge {(tuning.hedgingTension * 100).toFixed(0)}%</Tag>
      <Tag color='default' style={{ borderRadius: 10 }}>Confidence {(tuning.confidence * 100).toFixed(0)}%</Tag>
    </>
  );
}

function renderExecutionTuning(record: SubagentLearningRecord<'execution'>) {
  const tuning = record.tuning;
  return (
    <>
      {tuning.preferredMode && <Tag color='cyan' style={{ borderRadius: 10 }}>{tuning.preferredMode.toUpperCase()} mode</Tag>}
      <Tag color='cyan' style={{ borderRadius: 10 }}>Passive {(tuning.passiveBias ?? 0).toFixed(2)}</Tag>
      {tuning.fallbackMs && <Tag color='cyan' style={{ borderRadius: 10 }}>Fallback {Math.round(tuning.fallbackMs)} ms</Tag>}
      <Tag color='cyan' style={{ borderRadius: 10 }}>TWAP x{(tuning.twapSliceMultiplier ?? 1).toFixed(2)}</Tag>
      <Tag color='default' style={{ borderRadius: 10 }}>Confidence {(tuning.confidence * 100).toFixed(0)}%</Tag>
    </>
  );
}

function renderSentimentTuning(record: SubagentLearningRecord<'sentiment'>) {
  const tuning = record.tuning;
  return (
    <>
      <Tag color='purple' style={{ borderRadius: 10 }}>Weight {(tuning.signalWeight * 100).toFixed(0)}%</Tag>
      <Tag color='purple' style={{ borderRadius: 10 }}>Cooldown {Math.round(tuning.cooldownMs / 1000)}s</Tag>
      <Tag color='purple' style={{ borderRadius: 10 }}>News {(tuning.newsHeatWeight * 100).toFixed(0)}%</Tag>
      <Tag color='default' style={{ borderRadius: 10 }}>Confidence {(tuning.confidence * 100).toFixed(0)}%</Tag>
    </>
  );
}

function renderMarketQualityTuning(record: SubagentLearningRecord<'market_quality'>) {
  const tuning = record.tuning;
  return (
    <>
      <Tag color='blue' style={{ borderRadius: 10 }}>Score ≥ {tuning.minScore.toFixed(2)}</Tag>
      <Tag color='blue' style={{ borderRadius: 10 }}>Liquidity ≥ ${tuning.liquidityFloorUsd.toLocaleString()}</Tag>
      <Tag color='blue' style={{ borderRadius: 10 }}>Spread ≤ {tuning.spreadCeilBps} bps</Tag>
      <Tag color='default' style={{ borderRadius: 10 }}>Confidence {(tuning.confidence * 100).toFixed(0)}%</Tag>
    </>
  );
}

const LearningInsightsPage: React.FC = () => {
  const { snapshot, loading, error, lastUpdated, lastReason, refresh } = useSelectorInsights({
    refreshIntervalMs: 60_000,
    enableLive: true,
  });
  const {
    snapshot: subagentSnapshot,
    loading: subagentLoading,
    error: subagentError,
    lastUpdated: subagentUpdated,
    lastReason: subagentReason,
    refresh: refreshSubagents,
  } = useSubagentLearningInsights({
    refreshIntervalMs: 120_000,
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

  const riskRecords = subagentSnapshot?.data.risk ?? [];
  const executionRecords = subagentSnapshot?.data.execution ?? [];
  const sentimentRecords = subagentSnapshot?.data.sentiment ?? [];
  const marketRecords = subagentSnapshot?.data.marketQuality ?? [];
  const totalLearningCombos = riskRecords.length + executionRecords.length + sentimentRecords.length + marketRecords.length;
  const riskTightenings = riskRecords.filter((record) => record.tuning.recommendedMaxLeverage <= 2.5).length;
  const executionModeShifts = executionRecords.filter((record) => record.tuning.preferredMode && record.tuning.preferredMode !== 'market').length;
  const subagentLookbackLabel = subagentSnapshot
    ? subagentSnapshot.lookbackMinutes >= 60
      ? `${(subagentSnapshot.lookbackMinutes / 60).toFixed(1)}h rolling ledger`
      : `${subagentSnapshot.lookbackMinutes}m rolling ledger`
    : 'Awaiting learning pulse';

  const subagentSummaryCards = [
    {
      key: 'learningCombos',
      title: 'Subagent combos evaluated',
      value: subagentSnapshot?.combosEvaluated ?? totalLearningCombos ?? '—',
      helper: subagentLookbackLabel,
      accent: '#60a5fa',
    },
    {
      key: 'riskTighten',
      title: 'Risk tightenings',
      value: riskTightenings,
      helper: 'Leverage capped ≤ 2.5x',
      accent: '#f97316',
    },
    {
      key: 'executionShift',
      title: 'Execution mode shifts',
      value: executionModeShifts,
      helper: 'Prefers sweep/iceberg/twap',
      accent: '#22d3ee',
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
                <Button
                  icon={<Zap size={16} />}
                  onClick={() => void refreshSubagents({ force: true })}
                  loading={subagentLoading}
                  style={{ width: '100%', borderRadius: 12 }}
                >
                  Refresh subagent tunings
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
                <Text style={{ color: 'rgba(148,163,184,0.78)', fontSize: 12 }}>
                  Subagents pulse: {subagentSnapshot?.generatedAt ? formatRelativeTime(subagentSnapshot.generatedAt) : 'pending'}
                  {subagentReason ? ` · ${subagentReason}` : ''}
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

      {subagentError && (
        <Alert
          type='error'
          message='Failed to load subagent telemetry'
          description={subagentError}
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

      <Divider style={{ borderColor: 'rgba(148,163,184,0.2)' }} />
      <Space direction='vertical' size={12} style={{ width: '100%' }}>
        <Space align='center' size={10} wrap>
          <Tag color='purple' icon={<Cpu size={14} />} style={{ borderRadius: 999 }}>Subagent telemetry</Tag>
          <Text style={{ color: 'rgba(226,232,240,0.78)' }}>
            Learnings pushed by risk, execution, sentiment, and market-quality subagents to self-tune operations.
          </Text>
          {subagentUpdated && (
            <Tag color='default' style={{ borderRadius: 10 }}>
              Updated {formatRelativeTime(subagentUpdated)}
            </Tag>
          )}
        </Space>
        <Row gutter={[24, 24]}>
          {subagentSummaryCards.map((card) => (
            <Col xs={24} sm={12} lg={6} key={card.key}>
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
          <Col xs={24} md={12}>
            <SubagentPanel
              title='Risk governor'
              accent='#f97316'
              icon={<Shield size={16} color='#f97316' />}
              records={riskRecords as GenericSubagentRecord[]}
              emptyLabel='No risk deltas captured yet.'
              renderTuning={(record) => renderRiskTuning(record as SubagentLearningRecord<'risk_governor'>)}
            />
          </Col>
          <Col xs={24} md={12}>
            <SubagentPanel
              title='Execution router'
              accent='#22d3ee'
              icon={<Zap size={16} color='#22d3ee' />}
              records={executionRecords as GenericSubagentRecord[]}
              emptyLabel='Execution layer stable.'
              renderTuning={(record) => renderExecutionTuning(record as SubagentLearningRecord<'execution'>)}
            />
          </Col>
          <Col xs={24} md={12}>
            <SubagentPanel
              title='Sentiment sentinel'
              accent='#c084fc'
              icon={<MessageCircle size={16} color='#c084fc' />}
              records={sentimentRecords as GenericSubagentRecord[]}
              emptyLabel='No sentiment adjustments pending.'
              renderTuning={(record) => renderSentimentTuning(record as SubagentLearningRecord<'sentiment'>)}
            />
          </Col>
          <Col xs={24}>
            <SubagentPanel
              title='Market quality gate'
              accent='#38bdf8'
              icon={<Globe size={16} color='#38bdf8' />}
              records={marketRecords as GenericSubagentRecord[]}
              emptyLabel='No market quality overrides.'
              renderTuning={(record) => renderMarketQualityTuning(record as SubagentLearningRecord<'market_quality'>)}
            />
          </Col>
        </Row>
      </Space>

      {subagentSnapshot?.data && totalLearningCombos === 0 && (
        <Alert
          type='info'
          message='Subagent learning service active'
          description='Awaiting the first completed ledger sweep to populate subagent tunings. This typically appears within ~5 minutes.'
          showIcon
        />
      )}
    </Space>
  );
};

export default LearningInsightsPage;

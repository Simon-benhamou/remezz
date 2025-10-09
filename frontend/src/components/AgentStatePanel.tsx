import React from 'react';
import {
  Card,
  Descriptions,
  Tag,
  Space,
  Button,
  message,
  Segmented,
  Tooltip,
  Progress,
  Divider,
} from 'antd';
import { Typography } from 'antd';
import {
  ThunderboltOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import { api } from '../api';

type Props = {
  agent: any;
  symbol: string;
  lastPrice?: number;
  onPlan?: (plan: any) => void;
  sessionId?: string;
};

const { Text } = Typography;

const STATUS_PALETTE: Record<
  string,
  { color: string; background: string; icon: React.ReactNode }
> = {
  PASS: {
    color: '#15803d',
    background: 'rgba(22, 163, 74, 0.12)',
    icon: <CheckCircleOutlined style={{ color: '#15803d' }} />,
  },
  FAIL: {
    color: '#dc2626',
    background: 'rgba(220, 38, 38, 0.12)',
    icon: <CloseCircleOutlined style={{ color: '#dc2626' }} />,
  },
  REJECT: {
    color: '#ea580c',
    background: 'rgba(234, 88, 12, 0.12)',
    icon: <ExclamationCircleOutlined style={{ color: '#ea580c' }} />,
  },
  PARTIAL: {
    color: '#0891b2',
    background: 'rgba(8, 145, 178, 0.12)',
    icon: <InfoCircleOutlined style={{ color: '#0891b2' }} />,
  },
  UNKNOWN: {
    color: '#64748b',
    background: 'rgba(148, 163, 184, 0.18)',
    icon: <InfoCircleOutlined style={{ color: '#64748b' }} />,
  },
};

const formatPrice = (value: any) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `$${num.toFixed(4)}`;
};

const formatPct = (value: any, precision = 2) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `${num.toFixed(precision)}%`;
};

const formatLeverage = (value: any) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `${num.toFixed(1)}x`;
};

const formatUsd = (value: any) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `$${num.toFixed(2)}`;
};

const stateColors: Record<string, string> = {
  MANAGE: '#16a34a',
  ARMED: '#2563eb',
  COOLDOWN: '#f97316',
  HALT: '#dc2626',
};

export default function AgentStatePanel({ agent, symbol, lastPrice, onPlan, sessionId }: Props) {
  const [llmPlan, setLlmPlan] = React.useState<any>(null);
  const [forcingArm, setForcingArm] = React.useState(false);
  const balance = agent?.balance;
  const [agg, setAgg] = React.useState<string>(agent?.profile?.aggressiveness || 'conservative');

  React.useEffect(() => {
    const next = agent?.profile?.aggressiveness || 'conservative';
    setAgg(next);
  }, [agent?.profile?.aggressiveness]);

  const propose = async () => {
    const p = await api.proposePlan(symbol, { sessionId, fresh: true });
    setLlmPlan(p);
    onPlan?.(p);
  };

  const arm = async () => {
    if (!llmPlan) return message.error('No plan to arm');
    if (!sessionId) return message.error('No active session');
    await api.proposeAgentPlan(sessionId, llmPlan);
    message.success('Plan validated & armed (if risk gates pass)');
  };

  const runtimePlan = agent?.plan;
  const rawPlan = runtimePlan?.plan;
  const bias = runtimePlan?.bias || rawPlan?.bias || 'none';
  const zoneFrom = Number(runtimePlan?.zone?.from);
  const zoneTo = Number(runtimePlan?.zone?.to);
  const zoneMid = Number(runtimePlan?.zone?.mid);
  const stopDistance = Number(runtimePlan?.stopDistance);
  const stopPrice =
    Number.isFinite(zoneMid) && Number.isFinite(stopDistance)
      ? runtimePlan?.bias === 'long'
        ? zoneMid - stopDistance
        : zoneMid + stopDistance
      : null;
  const tp1 = Number(runtimePlan?.rPrices?.[0]?.price ?? NaN);
  const r1 = Number(runtimePlan?.rPrices?.[0]?.r ?? NaN);
  const atrAbs = Number(runtimePlan?.atr ?? NaN);
  const atrPct = Number(runtimePlan?.atrPct ?? NaN);

  const onChangeAgg = async (val: any) => {
    try {
      if (!sessionId) {
        message.error('No active session');
        return;
      }
      setAgg(val);
      await api.setAggressiveness(sessionId, val);
      message.success('Aggressiveness updated');
    } catch {
      message.error('Failed to update aggressiveness');
    }
  };

  const canForceArm = Boolean(sessionId && (rawPlan || llmPlan));

  const forceRearm = async () => {
    if (!sessionId) return message.error('No active session');
    const planPayload = rawPlan || llmPlan;
    if (!planPayload) {
      message.error('No plan available to arm');
      return;
    }
    try {
      setForcingArm(true);
      await api.proposeAgentPlan(sessionId, planPayload);
      onPlan?.(planPayload);
      message.success('Agent armed with current plan');
    } catch (err: any) {
      const detail =
        err?.response?.data?.error || err?.response?.data?.message || err?.message || String(err);
      message.error(detail);
    } finally {
      setForcingArm(false);
    }
  };

  const ai = agent?.aiMetrics || {};
  const aiByModel = ai?.byModel || {};

  const diagnostics = agent?.diagnostics;
  const diagChecks = diagnostics?.checks || {};
  const qualityScore = diagChecks.qualityScore;
  const qualityCurrent = Number(qualityScore?.current ?? 0);
  const qualityRequired = Number(qualityScore?.required ?? 1);
  const qualityPct =
    qualityScore && Number.isFinite(qualityRequired) && qualityRequired > 0
      ? Math.min(100, Math.max(0, (qualityCurrent / qualityRequired) * 100))
      : null;
  const qualityStatusRaw =
    qualityScore && qualityCurrent >= qualityRequired
      ? 'PASS'
      : String(qualityScore?.status || 'UNKNOWN').toUpperCase();

  const baseChecks = [
    { key: 'hasPosition', label: 'Flat / No position', check: diagChecks.hasPosition },
    { key: 'isArmed', label: 'Agent armed', check: diagChecks.isArmed },
    { key: 'isEntering', label: 'Not entering', check: diagChecks.isEntering },
    { key: 'dailyTradeLimit', label: 'Daily trade limit', check: diagChecks.dailyTradeLimit },
    {
      key: 'consecutiveStopsLimit',
      label: 'Consecutive stops',
      check: diagChecks.consecutiveStopsLimit,
    },
    { key: 'inEntryZone', label: 'In entry zone', check: diagChecks.inEntryZone },
    { key: 'momentumGates', label: 'Momentum gates', check: diagChecks.momentumGates },
  ];

  const qualityChecks = diagChecks.qualityFilters
    ? [
        { key: 'trendAlignment', label: 'Trend alignment', check: diagChecks.qualityFilters.trendAlignment },
        { key: 'momentum', label: 'ADX momentum', check: diagChecks.qualityFilters.momentum },
        { key: 'rsiPosition', label: 'RSI position', check: diagChecks.qualityFilters.rsiPosition },
        { key: 'volatility', label: 'Volatility (ATR)', check: diagChecks.qualityFilters.volatility },
        { key: 'volume', label: 'Volume confirmation', check: diagChecks.qualityFilters.volume },
      ].filter((item) => item.check)
    : [];

  const trigger = diagnostics?.trigger;

  const renderChecklist = (items: { key: string; label: string; check: any }[]) =>
    (
      <Space wrap size={8}>
        {items
          .filter((item) => item.check)
          .map((item) => {
            const statusRaw = String(item.check?.status || 'UNKNOWN').toUpperCase();
            const palette = STATUS_PALETTE[statusRaw] || STATUS_PALETTE.UNKNOWN;
            return (
              <Tooltip
                key={item.key}
                title={
                  <div style={{ maxWidth: 260 }}>
                    <div>{item.check?.reason}</div>
                    {item.check?.details && (
                      <div style={{ marginTop: 6, fontSize: 11, opacity: 0.8 }}>
                        {JSON.stringify(item.check.details, null, 2)}
                      </div>
                    )}
                  </div>
                }
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '6px 12px',
                    borderRadius: 999,
                    background: palette.background,
                    color: palette.color,
                    border: `1px solid ${palette.color}33`,
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  {palette.icon}
                  <span>{item.label}</span>
                </div>
              </Tooltip>
            );
          })}
      </Space>
    );

  const stateTagColor = stateColors[agent?.state || ''] || '#6366f1';

  const leverageMeta = (agent?.profile?.leverageCap as any) || null;
  const resolvedLeverage = Number.isFinite(Number(leverageMeta?.resolved))
    ? Number(leverageMeta.resolved)
    : (Number.isFinite(Number(agent?.profile?.maxLeverage)) ? Number(agent.profile.maxLeverage) : undefined);
  const requestedLeverage = Number.isFinite(Number(leverageMeta?.requested))
    ? Number(leverageMeta.requested)
    : (Number.isFinite(Number(agent?.profile?.requestedMaxLeverage))
        ? Number(agent.profile.requestedMaxLeverage)
        : resolvedLeverage);
  const leverageTrimmed = Boolean(
    leverageMeta?.trimmed ?? (
      resolvedLeverage != null && requestedLeverage != null && resolvedLeverage + 1e-9 < requestedLeverage
    )
  );
  const leverageTooltipParts = [] as string[];
  if (leverageMeta?.modeCap != null) leverageTooltipParts.push(`Mode cap ${formatLeverage(leverageMeta.modeCap)}`);
  if (leverageMeta?.categoryCap != null) leverageTooltipParts.push(`Category cap ${formatLeverage(leverageMeta.categoryCap)}`);
  if (leverageMeta?.constraintCap != null) leverageTooltipParts.push(`Constraint cap ${formatLeverage(leverageMeta.constraintCap)}`);
  if (leverageMeta?.constraintSource) leverageTooltipParts.push(`Source: ${leverageMeta.constraintSource}`);
  const leverageTooltip = leverageTooltipParts.length ? leverageTooltipParts.join(' · ') : undefined;
  const leverageBadges: React.ReactNode[] = [];
  if (leverageTooltip) {
    leverageBadges.push(
      <Tooltip key="cap" title={leverageTooltip}>
        <InfoCircleOutlined style={{ color: '#2563eb' }} />
      </Tooltip>
    );
  }
  if (leverageTrimmed) {
    const trimTooltip = `Requested ${formatLeverage(requestedLeverage)} trimmed to ${formatLeverage(resolvedLeverage)}`;
    leverageBadges.push(
      <Tooltip key="trimmed" title={trimTooltip}>
        <Tag color="orange">Trimmed</Tag>
      </Tooltip>
    );
  }

  const riskMetrics: { label: string; value: React.ReactNode; badge?: React.ReactNode }[] = [
    {
      label: 'Risk / trade',
      value: formatPct(agent?.profile?.riskPerTradePct),
    },
    {
      label: 'Daily loss cap',
      value: formatPct(agent?.profile?.dailyLossLimitPct),
    },
    {
      label: 'Max leverage',
      value: formatLeverage(resolvedLeverage),
      badge: leverageBadges.length ? (
        <Space size={4}>
          {leverageBadges.map((badge, idx) => (
            <React.Fragment key={idx}>{badge}</React.Fragment>
          ))}
        </Space>
      ) : undefined,
    },
  ];

  const balanceMetrics = [
    { label: 'Equity', value: formatUsd(balance?.equityUsd) },
    { label: 'Free', value: formatUsd(balance?.freeUsd) },
    { label: 'Committed', value: formatUsd(balance?.committedUsd) },
  ].filter((metric) => metric.value !== '—');

  const planMetrics = [
    {
      label: 'Entry zone',
      value:
        Number.isFinite(zoneFrom) && Number.isFinite(zoneTo)
          ? `${formatPrice(zoneFrom)} → ${formatPrice(zoneTo)}`
          : '—',
    },
    {
      label: 'Stop',
      value: formatPrice(stopPrice),
    },
    {
      label: 'TP1',
      value: formatPrice(tp1),
    },
    {
      label: 'TP1 (R)',
      value: Number.isFinite(r1) ? `${r1.toFixed(2)}R` : '—',
    },
    {
      label: 'ATR (abs)',
      value: formatPrice(atrAbs),
    },
    {
      label: 'ATR %',
      value: formatPct(atrPct),
    },
  ];

  const triggerMetrics = trigger
    ? [
        {
          label: 'Phase',
          value: trigger.phase || '—',
        },
        {
          label: 'Entry ready',
          value: trigger.entryReady ? '✅ Ready' : '⏳ Waiting',
        },
        {
          label: 'Distance to zone',
          value:
            typeof trigger.distancePctToZone === 'number'
              ? formatPct(trigger.distancePctToZone)
              : '—',
        },
        {
          label: 'Momentum',
          value: trigger.momentumOk ? 'OK' : 'Hold',
        },
        {
          label: 'Quality',
          value: trigger.qualityOk ? 'OK' : 'Hold',
        },
        {
          label: 'Cooldown',
          value: trigger.cooldown?.active
            ? `${trigger.cooldown.remainingSec}s`
            : 'None',
        },
      ]
    : [];

  const blueprintPlan = rawPlan || llmPlan;

  return (
    <Card
      title={
        <Space>
          <span>QuantAI Agent</span>
          {agent?.state && <Tag color={stateTagColor}>{agent.state}</Tag>}
        </Space>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <Text style={{ fontSize: 18, fontWeight: 600 }}>
              {agent?.profile?.symbol || symbol}
            </Text>
            <div style={{ color: '#64748b', fontSize: 12, marginTop: 4 }}>
              Mode {agent?.profile?.mode || '—'} · Last price{' '}
              {lastPrice != null ? formatPrice(lastPrice) : '—'}
            </div>
          </div>
          <Space wrap>
            <Tooltip title="Proposer un plan frais via LLM (vision stratégique)">
              <Button onClick={propose}>Propose plan (LLM)</Button>
            </Tooltip>
            <Tooltip title="Valider & armer le dernier plan LLM proposé">
              <Button type="primary" onClick={arm} disabled={!llmPlan}>
                Arm
              </Button>
            </Tooltip>
            <Tooltip title="Forcer l'armement avec le plan courant côté agent">
              <Button
                icon={<ThunderboltOutlined />}
                onClick={forceRearm}
                disabled={!canForceArm}
                loading={forcingArm}
              >
                Force re-arm
              </Button>
            </Tooltip>
          </Space>
        </div>

        {bias && bias !== 'none' && (
          <div
            style={{
              background:
                bias === 'long'
                  ? 'linear-gradient(135deg, #f6ffed 0%, #bbf7d0 100%)'
                  : 'linear-gradient(135deg, #fff2e8 0%, #fecdd3 100%)',
              border: `1px solid ${bias === 'long' ? '#4ade80' : '#fb7185'}`,
              borderRadius: 12,
              padding: '12px 16px',
              display: 'flex',
              justifyContent: 'space-between',
              gap: 16,
              flexWrap: 'wrap',
            }}
          >
            <Space direction="vertical" size={4}>
              <Text style={{ fontWeight: 700, color: bias === 'long' ? '#15803d' : '#b91c1c' }}>
                🎯 Agent bias: {bias.toUpperCase()}
              </Text>
              <Text style={{ fontSize: 12, color: '#1f2937' }}>
                {bias === 'long'
                  ? 'Recherche des rebonds sur support & breakouts haussiers.'
                  : 'Recherche des rejets de résistance & breakouts baissiers.'}
              </Text>
            </Space>
            {trigger?.biasConfidence != null && (
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 12, color: '#334155' }}>Bias confidence</div>
                <div style={{ fontWeight: 700, fontSize: 18, color: '#0f172a' }}>
                  {(Number(trigger.biasConfidence) * 100).toFixed(0)}%
                </div>
              </div>
            )}
          </div>
        )}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: 12,
          }}
        >
          {planMetrics.map((metric) => (
            <div
              key={metric.label}
              style={{
                background: '#f8fafc',
                borderRadius: 10,
                padding: '12px 14px',
                border: '1px solid #e2e8f0',
              }}
            >
              <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase' }}>
                {metric.label}
              </div>
              <div style={{ fontWeight: 600, fontSize: 14, color: '#0f172a' }}>{metric.value}</div>
            </div>
          ))}
        </div>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 24,
            alignItems: 'flex-start',
          }}
        >
          <div style={{ minWidth: 220, flex: '1 1 220px' }}>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>
              Risk controls
            </Text>
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              {riskMetrics.map((metric) => (
                <div
                  key={metric.label}
                  style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}
                >
                  <span style={{ color: '#64748b' }}>{metric.label}</span>
                  <span style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>{metric.value}</span>
                    {metric.badge}
                  </span>
                </div>
              ))}
            </Space>
          </div>
          <div style={{ minWidth: 220, flex: '1 1 220px' }}>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>
              Aggressiveness
            </Text>
            <Segmented
              value={agg}
              onChange={onChangeAgg}
              options={[
                { label: 'Conservative', value: 'conservative' },
                { label: 'Reactive', value: 'reactive' },
                { label: 'Aggressive', value: 'aggressive' },
              ]}
            />
          </div>
          {balanceMetrics.length > 0 && (
            <div style={{ minWidth: 220, flex: '1 1 220px' }}>
              <Text strong style={{ display: 'block', marginBottom: 8 }}>
                Account snapshot
              </Text>
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {balanceMetrics.map((metric) => (
                  <div
                    key={metric.label}
                    style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}
                  >
                    <span style={{ color: '#64748b' }}>{metric.label}</span>
                    <span style={{ fontWeight: 600 }}>{metric.value}</span>
                  </div>
                ))}
              </Space>
            </div>
          )}
        </div>

        {diagnostics && (
          <div
            style={{
              padding: '16px 18px',
              borderRadius: 12,
              border: '1px solid #e2e8f0',
              background: '#f8fafc',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 12,
                alignItems: 'center',
              }}
            >
              <Space size={12}>
                <Tag color={diagnostics.canTrade ? 'green' : 'red'}>
                  {diagnostics.canTrade ? 'READY TO TRADE' : 'BLOCKED'}
                </Tag>
                <Text strong>{diagnostics.reason || 'No diagnostics reason provided'}</Text>
              </Space>
              {diagnostics.summary && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {diagnostics.summary.passed}/{diagnostics.summary.totalChecks} checks passed
                  {diagnostics.summary.failed ? ` • ${diagnostics.summary.failed} failed` : ''}
                </Text>
              )}
            </div>

            {qualityPct != null && (
              <div style={{ marginTop: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Space>
                    {(STATUS_PALETTE[qualityStatusRaw] || STATUS_PALETTE.UNKNOWN).icon}
                    <Text strong>Quality score</Text>
                  </Space>
                  <Tag
                    color={(STATUS_PALETTE[qualityStatusRaw] || STATUS_PALETTE.UNKNOWN).color}
                    style={{ background: (STATUS_PALETTE[qualityStatusRaw] || STATUS_PALETTE.UNKNOWN).background }}
                  >
                    {qualityCurrent}/{qualityRequired}
                  </Tag>
                </div>
                <Progress
                  percent={Math.round(qualityPct)}
                  size="small"
                  strokeColor={(STATUS_PALETTE[qualityStatusRaw] || STATUS_PALETTE.UNKNOWN).color}
                  status={qualityStatusRaw === 'PASS' ? 'success' : 'active'}
                />
                {qualityScore?.reason && (
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {qualityScore.reason}
                  </Text>
                )}
              </div>
            )}

            <Divider style={{ margin: '16px 0' }} />

            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              <div>
                <Text strong style={{ marginBottom: 6, display: 'block' }}>
                  Entry checklist
                </Text>
                {renderChecklist(baseChecks)}
              </div>
              {qualityChecks.length > 0 && (
                <div>
                  <Text strong style={{ marginBottom: 6, display: 'block' }}>
                    Quality filters
                  </Text>
                  {renderChecklist(qualityChecks)}
                </div>
              )}
              {trigger && (
                <div>
                  <Text strong style={{ marginBottom: 6, display: 'block' }}>
                    Trigger telemetry
                  </Text>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                      gap: 12,
                    }}
                  >
                    {triggerMetrics.map((metric) => (
                      <div
                        key={metric.label}
                        style={{
                          background: '#fff',
                          border: '1px solid #e2e8f0',
                          borderRadius: 10,
                          padding: '10px 12px',
                        }}
                      >
                        <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase' }}>
                          {metric.label}
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>
                          {metric.value}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Space>
          </div>
        )}

        {typeof ai?.total === 'number' && (
          <div
            style={{
              background: '#f1f5f9',
              borderRadius: 12,
              padding: '12px 16px',
              border: '1px solid #e2e8f0',
            }}
          >
            <Text strong style={{ display: 'block', marginBottom: 6 }}>
              LLM usage
            </Text>
            <div style={{ fontSize: 12, color: '#475569' }}>
              Total: <b>{ai?.total ?? 0}</b> · calls/h:{' '}
              <b>{Number(ai?.callsPerHour ?? 0).toFixed(2)}</b> · cost:{' '}
              <b>${Number(ai?.costUsd ?? 0).toFixed(4)}</b>
            </div>
            {Object.keys(aiByModel).length > 0 && (
              <div style={{ marginTop: 6, fontSize: 12, color: '#475569' }}>
                {Object.entries(aiByModel).map(([model, count]: any) => (
                  <Tag key={model} color="blue" style={{ marginRight: 8 }}>
                    {model}: {count}
                  </Tag>
                ))}
              </div>
            )}
          </div>
        )}

        {blueprintPlan && (
          <Descriptions size="small" column={1} bordered title="Plan blueprint">
            <Descriptions.Item label="Name">{blueprintPlan.name}</Descriptions.Item>
            <Descriptions.Item label="Bias">{blueprintPlan.bias}</Descriptions.Item>
            <Descriptions.Item label="Timeframe">{blueprintPlan.timeframe}</Descriptions.Item>
            <Descriptions.Item label="Zone">
              {blueprintPlan.zone?.type} • {blueprintPlan.zone?.from}
            </Descriptions.Item>
            <Descriptions.Item label="Entry rule">
              {blueprintPlan.entry_rule?.type} · confirm close:{' '}
              {String(blueprintPlan.entry_rule?.confirm_close)}
            </Descriptions.Item>
            <Descriptions.Item label="Stop">
              {blueprintPlan.risk?.stop?.type} × {blueprintPlan.risk?.stop?.mult}
            </Descriptions.Item>
            <Descriptions.Item label="Take profits (R)">
              {(blueprintPlan.risk?.tp || []).map((tp: any) => tp.value).join(', ')}
            </Descriptions.Item>
            <Descriptions.Item label="Max hold (h)">
              {blueprintPlan.risk?.max_hold_hours}
            </Descriptions.Item>
            <Descriptions.Item label="Risk fraction">
              {blueprintPlan.position?.risk_fraction}
            </Descriptions.Item>
            <Descriptions.Item label="Max leverage">
              {blueprintPlan.position?.max_leverage}
            </Descriptions.Item>
            {blueprintPlan.notes && (
              <Descriptions.Item label="Notes">{blueprintPlan.notes}</Descriptions.Item>
            )}
          </Descriptions>
        )}
      </Space>
    </Card>
  );
}


import React from 'react';
import { Tag, Button, message } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined, ExclamationCircleOutlined, InfoCircleOutlined } from '../icons';
import { api } from '../api';

type DiagnosticsCheck = {
  status?: string;
  reason?: string;
  details?: Record<string, unknown>;
};

type Props = {
  agent: any;
  symbol: string;
  lastPrice?: number;
  sessionId?: string;
  margin?: any;
  marginHistory?: any[];
};

const formatUsd = (value: any, digits = 2) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `$${num.toFixed(digits)}`;
};

const formatPercent = (value: any, digits = 1) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `${num >= 0 ? '+' : ''}${num.toFixed(digits)}%`;
};

const formatLeverage = (value: any) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `${num.toFixed(1)}x`;
};

const checkPalette = (status?: string) => {
  const normalized = String(status || 'unknown').toUpperCase();
  switch (normalized) {
    case 'PASS':
      return { className: 'agent-diagnostics__chip agent-diagnostics__chip--pass', icon: <CheckCircleOutlined /> };
    case 'FAIL':
      return { className: 'agent-diagnostics__chip agent-diagnostics__chip--fail', icon: <CloseCircleOutlined /> };
    case 'REJECT':
    case 'PARTIAL':
      return { className: 'agent-diagnostics__chip agent-diagnostics__chip--warn', icon: <ExclamationCircleOutlined /> };
    default:
      return { className: 'agent-diagnostics__chip agent-diagnostics__chip--neutral', icon: <InfoCircleOutlined /> };
  }
};

const asList = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string') return value.split('\n').map((row) => row.trim()).filter(Boolean);
  return [];
};

export default function AgentStatePanel({ agent, symbol, lastPrice, margin, sessionId }: Props) {
  const [clearingCooldown, setClearingCooldown] = React.useState(false);

  if (!agent) {
    return <div className='agent-diagnostics agent-diagnostics--empty'>No live diagnostics available.</div>;
  }

  const diagnostics = agent.diagnostics || {};
  const checks = diagnostics.checks || {};
  const trigger = diagnostics.trigger || {};
  const balance = agent.balance || {};

  const primaryChecks = [
    { key: 'armed', label: 'Agent armed', check: checks.isArmed },
    { key: 'position', label: 'Flat / clear position', check: checks.hasPosition },
    { key: 'entry', label: 'Entry zone', check: checks.inEntryZone },
    { key: 'momentum', label: 'Momentum gates', check: checks.momentumGates },
    { key: 'quality', label: 'Quality score', check: checks.qualityScore },
    { key: 'dailyLimit', label: 'Daily trade limit', check: checks.dailyTradeLimit },
    { key: 'circuitBreaker', label: 'Circuit breaker', check: checks.circuitBreaker },
  ].filter((item) => item.check);

  const handleClearCooldown = async () => {
    if (!sessionId) {
      message.error('Session ID not available');
      return;
    }
    
    setClearingCooldown(true);
    try {
      await api.clearCooldown(sessionId);
      message.success('Circuit breaker cooldown cleared');
      // Refresh the page or trigger a reload
      window.location.reload();
    } catch (error: any) {
      const errorMsg = error?.response?.data?.message || 'Failed to clear cooldown';
      message.error(errorMsg);
    } finally {
      setClearingCooldown(false);
    }
  };

  const isCircuitBreakerBlocked = checks.circuitBreaker?.status === 'FAIL' || 
                                   checks.circuitBreaker?.reason?.toLowerCase().includes('cooldown');

  const qualityChecks = checks.qualityFilters
    ? Object.entries(checks.qualityFilters).map(([key, value]) => ({
        key,
        label: key.replace(/([A-Z])/g, ' $1').replace(/^\w/, (c) => c.toUpperCase()),
        check: value as DiagnosticsCheck,
      }))
    : [];

  const riskProfile = [
    { label: 'Risk / trade', value: formatPercent(agent?.profile?.riskPerTradePct) },
    { label: 'Daily loss cap', value: formatPercent(agent?.profile?.dailyLossLimitPct) },
    { label: 'Max leverage', value: formatLeverage(agent?.profile?.maxLeverage ?? agent?.profile?.leverageCap?.resolved) },
    { label: 'Equity', value: formatUsd(balance?.equityUsd) },
    { label: 'Free balance', value: formatUsd(balance?.freeUsd) },
    { label: 'Committed', value: formatUsd(balance?.committedUsd) },
  ].filter((item) => item.value !== '—');

  const plan = agent.plan || {};
  const planMetrics = [
    {
      label: 'Entry',
      value:
        plan.zone && Number.isFinite(Number(plan.zone.from)) && Number.isFinite(Number(plan.zone.to))
          ? `${formatUsd(plan.zone.from)} → ${formatUsd(plan.zone.to)}`
          : plan.zone?.mid
            ? formatUsd(plan.zone.mid)
            : '—',
    },
    { label: 'Stop', value: plan.stopPrice ? formatUsd(plan.stopPrice) : '—' },
    { label: 'TP1', value: plan.rPrices?.[0]?.price ? formatUsd(plan.rPrices[0].price) : '—' },
    { label: 'ATR', value: plan.atr ? formatUsd(plan.atr, 4) : '—' },
    { label: 'ATR %', value: plan.atrPct ? formatPercent(plan.atrPct) : '—' },
  ];

  const triggerNotes = [
    trigger.phase ? `Phase: ${trigger.phase}` : null,
    typeof trigger.distancePctToZone === 'number' ? `Distance: ${formatPercent(trigger.distancePctToZone)}` : null,
    trigger.entryReady ? 'Entry ready ✅' : 'Entry waiting',
    trigger.momentumOk === false ? 'Momentum hold' : null,
    trigger.cooldown?.active ? `Cooldown ${trigger.cooldown.remainingSec}s` : null,
  ].filter(Boolean);

  const marginStatus = (() => {
    const state = String(margin?.status || '').toLowerCase();
    if (state === 'critical') return { label: 'Critical', tone: 'error' as const };
    if (state === 'warn') return { label: 'Warning', tone: 'warning' as const };
    return { label: 'Healthy', tone: 'success' as const };
  })();

  const marginInsights = [
    margin?.utilisationPct != null ? `Utilisation ${formatPercent(margin.utilisationPct)}` : null,
    margin?.worstLiquidationDistancePct != null ? `Worst Liq. Dist ${formatPercent(margin.worstLiquidationDistancePct)}` : null,
    ...asList(margin?.actions?.map((action: any) => action?.rationale || action?.message)),
  ].filter(Boolean);

  return (
    <div className='agent-diagnostics'>
      <div className='agent-diagnostics__header'>
        <div>
          <div className='agent-diagnostics__title'>Operational status</div>
          <div className='agent-diagnostics__subtitle'>
            {symbol} · Last price {lastPrice != null ? formatUsd(lastPrice, 4) : '—'}
          </div>
        </div>
        {agent.state && (
          <Tag className='agent-diagnostics__state' color={
            agent.state === 'ARMED' ? 'green' :
            agent.state === 'MANAGE' ? 'blue' :
            agent.state === 'COOLDOWN' ? 'orange' : 'red'
          }>
            {agent.state}
          </Tag>
        )}
      </div>

      {triggerNotes.length > 0 && (
        <div className='agent-diagnostics__highlight'>
          {triggerNotes.map((note, index) => (
            <span key={index}>{note}</span>
          ))}
        </div>
      )}

      <section className='agent-diagnostics__section'>
        <div className='agent-diagnostics__section-title' style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Entry conditions</span>
          {isCircuitBreakerBlocked && sessionId && (
            <Button 
              size="small" 
              type="primary" 
              danger
              loading={clearingCooldown}
              onClick={handleClearCooldown}
              style={{ marginLeft: 'auto' }}
            >
              Clear Cooldown
            </Button>
          )}
        </div>
        <div className='agent-diagnostics__chips'>
          {primaryChecks.length === 0 && <span className='agent-diagnostics__empty'>No diagnostic signals available.</span>}
          {primaryChecks.map(({ key, label, check }) => {
            const palette = checkPalette(check?.status);
            return (
              <div key={key} className={palette.className} title={check?.reason || ''}>
                {palette.icon}
                <span>{label}</span>
              </div>
            );
          })}
        </div>
      </section>

      {qualityChecks.length > 0 && (
        <section className='agent-diagnostics__section'>
          <div className='agent-diagnostics__section-title'>Quality filters</div>
          <div className='agent-diagnostics__chips'>
            {qualityChecks.map(({ key, label, check }) => {
              const palette = checkPalette(check?.status);
              return (
                <div key={key} className={palette.className} title={check?.reason || ''}>
                  {palette.icon}
                  <span>{label}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className='agent-diagnostics__section agent-diagnostics__grid'>
        <div>
          <div className='agent-diagnostics__section-title'>Risk & balance</div>
          <ul className='agent-diagnostics__list'>
            {riskProfile.map((metric) => (
              <li key={metric.label}>
                <span>{metric.label}</span>
                <strong>{metric.value}</strong>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className='agent-diagnostics__section-title'>Plan targets</div>
          <ul className='agent-diagnostics__list'>
            {planMetrics.map((metric) => (
              <li key={metric.label}>
                <span>{metric.label}</span>
                <strong>{metric.value}</strong>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {margin && (
        <section className='agent-diagnostics__section'>
          <div className='agent-diagnostics__section-title'>Margin health</div>
          <div className={`agent-diagnostics__margin agent-diagnostics__margin--${marginStatus.tone}`}>
            <div className='agent-diagnostics__margin-header'>
              <strong>{marginStatus.label}</strong>
              <span>{new Date(margin?.createdAt || margin?.timestamp || Date.now()).toLocaleString()}</span>
            </div>
            {marginInsights.length > 0 && (
              <ul>
                {marginInsights.map((item, idx) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

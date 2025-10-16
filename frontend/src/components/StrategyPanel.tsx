import React from 'react';
import { Empty, Tag } from 'antd';

const formatNumber = (value: any, opts: Intl.NumberFormatOptions = { minimumFractionDigits: 2, maximumFractionDigits: 2 }) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return num.toLocaleString(undefined, opts);
};

const formatPercent = (value: any) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `${num >= 0 ? '+' : ''}${num.toFixed(1)}%`;
};

const resolveConfidence = (confidence?: number) => {
  if (confidence == null) return '—';
  return confidence > 1 ? `${confidence.toFixed(0)}%` : `${(confidence * 100).toFixed(0)}%`;
};

const biasMeta = (bias?: string) => {
  const normalized = String(bias || '').toLowerCase();
  if (normalized === 'long' || normalized === 'bullish') {
    return { label: 'Bullish', tone: 'success', emoji: '📈' };
  }
  if (normalized === 'short' || normalized === 'bearish') {
    return { label: 'Bearish', tone: 'error', emoji: '📉' };
  }
  return { label: 'Neutral', tone: 'default', emoji: '⚖️' };
};

type StrategyPanelProps = {
  strategy?: any;
};

export default function StrategyPanel({ strategy }: StrategyPanelProps) {
  if (!strategy) {
    return (
      <div className='strategy-panel strategy-panel--empty'>
        <Empty description="No active strategy plan" />
      </div>
    );
  }

  const bias = biasMeta(strategy.bias);
  const entryMin = Number(strategy.entry?.zone?.min);
  const entryMax = Number(strategy.entry?.zone?.max);
  const entryMid = Number.isFinite(Number(strategy.entry?.price))
    ? Number(strategy.entry.price)
    : Number.isFinite(entryMin) && Number.isFinite(entryMax)
      ? (entryMin + entryMax) / 2
      : null;

  const strategyInfo = [
    { label: 'Bias', value: bias.label },
    { label: 'Confidence', value: resolveConfidence(strategy.confidence) },
    { label: 'Score', value: strategy.score != null ? strategy.score.toFixed(1) : '—' },
    { label: 'Target R', value: strategy.targetR != null ? strategy.targetR.toFixed(1) : '—' },
    { label: 'Valid from', value: strategy.validity?.from ? new Date(strategy.validity.from).toLocaleString() : '—' },
    { label: 'Valid to', value: strategy.validity?.to ? new Date(strategy.validity.to).toLocaleString() : '—' },
  ];

  const riskInfo = [
    {
      label: 'Entry zone',
      value:
        Number.isFinite(entryMin) && Number.isFinite(entryMax)
          ? `$${formatNumber(entryMin)} → $${formatNumber(entryMax)}`
          : entryMid != null
            ? `$${formatNumber(entryMid)}`
            : '—',
    },
    {
      label: 'Stop loss',
      value:
        strategy.risk?.stop?.value != null
          ? strategy.risk?.stop?.type === 'percent'
            ? formatPercent(strategy.risk.stop.value)
            : `$${formatNumber(strategy.risk.stop.value)}`
          : '—',
    },
    {
      label: 'Take profit',
      value:
        strategy.risk?.target?.value != null
          ? strategy.risk?.target?.type === 'percent'
            ? formatPercent(strategy.risk.target.value)
            : `$${formatNumber(strategy.risk.target.value)}`
          : '—',
    },
    {
      label: 'Risk / reward',
      value:
        strategy.opportunity?.riskReward != null
          ? `${strategy.opportunity.riskReward.toFixed(2)}`
          : strategy.risk?.rewardMultiple
            ? strategy.risk.rewardMultiple.toFixed(2)
            : '—',
    },
  ];

  const signals: string[] =
    (Array.isArray(strategy.signals) && strategy.signals) ||
    (Array.isArray(strategy.reasons) && strategy.reasons) ||
    (Array.isArray(strategy.reasoning?.signals) && strategy.reasoning.signals) ||
    (typeof strategy.rationale === 'string' ? [strategy.rationale] : []);

  return (
    <div className='strategy-panel'>
      <div className='strategy-panel__header'>
        <div className='strategy-panel__title'>
          <span className='strategy-panel__icon'>{bias.emoji}</span>
          <div>
            <div className='strategy-panel__name'>{strategy?.name || strategy?.label || 'Strategy insights'}</div>
            <div className='strategy-panel__subtitle'>
              {strategy?.symbol || '—'} · {(strategy?.type || strategy?.category || 'Momentum').toString()}
            </div>
          </div>
        </div>
        <Tag color={bias.tone === 'success' ? 'green' : bias.tone === 'error' ? 'red' : 'default'} className='strategy-panel__bias'>
          {bias.label.toUpperCase()}
        </Tag>
      </div>

      <div className='strategy-panel__section'>
        <div className='strategy-panel__section-title'>Plan overview</div>
        <div className='strategy-panel__grid'>
          {strategyInfo.map((item) => (
            <div key={item.label} className='strategy-panel__metric'>
              <span className='strategy-panel__metric-label'>{item.label}</span>
              <span className='strategy-panel__metric-value'>{item.value}</span>
            </div>
          ))}
        </div>
      </div>

      <div className='strategy-panel__section'>
        <div className='strategy-panel__section-title'>Risk controls</div>
        <div className='strategy-panel__grid'>
          {riskInfo.map((item) => (
            <div key={item.label} className='strategy-panel__metric'>
              <span className='strategy-panel__metric-label'>{item.label}</span>
              <span className='strategy-panel__metric-value'>{item.value}</span>
            </div>
          ))}
        </div>
      </div>

      {signals.length > 0 && (
        <div className='strategy-panel__section'>
          <div className='strategy-panel__section-title'>Active signals</div>
          <ul className='strategy-panel__signals'>
            {signals.map((signal, index) => (
              <li key={`${signal}-${index}`}>{signal}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

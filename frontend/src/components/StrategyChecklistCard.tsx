import React from 'react';
import { Space, Tag, Typography } from 'antd';
import type { StrategySnapshot } from '../types/strategies';
import { STRATEGY_META } from '../utils/strategies';

const { Text } = Typography;

const STATUS_COLORS: Record<string, string> = {
  PASS: 'green',
  FAIL: 'red',
  REJECT: 'orange',
  PARTIAL: 'blue',
  UNKNOWN: 'default',
};

const BIAS_META: Record<'long' | 'short' | 'both', { label: string; color: string; background: string }> = {
  long: { label: 'LONG', color: 'var(--success)', background: 'rgba(34, 197, 94, 0.12)' },
  short: { label: 'SHORT', color: '#f97316', background: 'rgba(249, 115, 22, 0.16)' },
  both: { label: 'BI-DIRECTIONAL', color: '#38bdf8', background: 'rgba(14, 165, 233, 0.16)' },
};

type Props = {
  strategy?: StrategySnapshot | null;
};

const formatPercent = (value?: number | null, digits = 0) => {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return `${(value * 100).toFixed(digits)}%`;
};

const statusTagColor = (status: string) => {
  const normalized = status?.toUpperCase?.() ?? 'UNKNOWN';
  return STATUS_COLORS[normalized] || STATUS_COLORS.UNKNOWN;
};

export default function StrategyChecklistCard({ strategy }: Props) {
  if (!strategy) {
    return <Text type="secondary">Strategy telemetry not available.</Text>;
  }

  const engineMeta = strategy.engine ? STRATEGY_META[strategy.engine] : null;
  const primary = strategy.primary;
  const biasMeta = primary?.bias ? BIAS_META[primary.bias] : null;
  const confidenceText = formatPercent(primary?.confidence ?? null);
  const scoreText = formatPercent(primary?.score ?? null, 1);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space align="center" size={8} wrap>
        <Text strong style={{ fontSize: 16 }}>
          {primary?.label || 'Active strategy'}
        </Text>
        {engineMeta && (
          <Tag
            style={{
              borderRadius: 12,
              border: 'none',
              background: `${engineMeta.color}20`,
              color: engineMeta.color,
            }}
          >
            {engineMeta.label}
          </Tag>
        )}
        {biasMeta && (
          <Tag
            style={{
              borderRadius: 12,
              border: 'none',
              background: biasMeta.background,
              color: biasMeta.color,
            }}
          >
            {biasMeta.label}
          </Tag>
        )}
        {primary?.guardrail && (
          <Tag
            style={{
              borderRadius: 12,
              border: 'none',
              background: 'rgba(251, 191, 36, 0.16)',
              color: 'var(--warning)',
            }}
          >
            Guardrail active
          </Tag>
        )}
      </Space>

      <Space size={16} wrap>
        {confidenceText && (
          <Text type="secondary">Confidence {confidenceText}</Text>
        )}
        {scoreText && (
          <Text type="secondary">Score {scoreText}</Text>
        )}
        {strategy.context?.regime && (
          <Text type="secondary">Regime {strategy.context.regime}</Text>
        )}
        {strategy.context?.effectivePlaybook && (
          <Text type="secondary">Playbook {strategy.context.effectivePlaybook}</Text>
        )}
      </Space>

      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Text strong>Pre-trade checklist</Text>
        {strategy.checklist.length === 0 ? (
          <Text type="secondary">Checklist not available yet.</Text>
        ) : (
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            {strategy.checklist.map((item) => (
              <div
                key={item.key}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                <Space size={8} align="start">
                  <Tag color={statusTagColor(item.status)}>{item.status}</Tag>
                  <span style={{ color: 'var(--text-primary)' }}>{item.label}</span>
                </Space>
                {item.reason && (
                  <Text type="secondary" style={{ fontSize: 12, textAlign: 'right', maxWidth: '55%' }}>
                    {item.reason}
                  </Text>
                )}
              </div>
            ))}
          </Space>
        )}
      </Space>

      {strategy.context?.notes?.length ? (
        <Space direction="vertical" size={4}>
          <Text strong>Context notes</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {strategy.context.notes.join(' • ')}
          </Text>
        </Space>
      ) : null}

      {strategy.recognized.length > 1 && (
        <Space direction="vertical" size={4}>
          <Text strong>Other candidates</Text>
          <Space size={6} wrap>
            {strategy.recognized.slice(1).map((signal) => (
              <Tag key={signal.id} color={signal.active ? 'cyan' : 'default'}>
                {signal.label} ({formatPercent(signal.confidence) ?? 'n/a'})
              </Tag>
            ))}
          </Space>
        </Space>
      )}
    </Space>
  );
}

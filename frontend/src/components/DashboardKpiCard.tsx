import React from 'react';
import { ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons';
import { Typography } from 'antd';

const { Title, Text } = Typography;

type DashboardKpiCardProps = {
  title: string;
  value: React.ReactNode;
  icon?: React.ReactNode;
  hint?: string;
  trendLabel?: string;
  delta?: {
    value: string;
    positive?: boolean;
  };
  accent?: string;
};

const gradientPresets: Record<string, { from: string; to: string }> = {
  blue: { from: '#0ea5e9', to: '#3b82f6' },
  purple: { from: '#8b5cf6', to: '#6366f1' },
  indigo: { from: '#3730a3', to: '#4c1d95' },
  emerald: { from: '#10b981', to: '#059669' },
  amber: { from: '#f59e0b', to: '#d97706' },
  rose: { from: '#f43f5e', to: '#e11d48' },
};

function resolveGradient(accent?: string) {
  if (!accent) return gradientPresets.blue;
  if (gradientPresets[accent]) return gradientPresets[accent];
  return gradientPresets.blue;
}

const DashboardKpiCard: React.FC<DashboardKpiCardProps> = ({
  title,
  value,
  icon,
  hint,
  trendLabel,
  delta,
  accent,
}) => {
  const gradient = resolveGradient(accent);
  const deltaPositive = delta?.positive ?? (delta ? !delta.value.startsWith('-') : false);

  return (
    <div
      style={{
        position: 'relative',
        overflow: 'hidden',
        borderRadius: 18,
        padding: 20,
        background: '#0f172a',
        color: '#f8fafc',
        minHeight: 160,
        boxShadow: '0 20px 45px -20px rgba(15, 23, 42, 0.6)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: `linear-gradient(135deg, ${gradient.from}, ${gradient.to})`,
          opacity: 0.92,
        }}
      />
      <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {icon && (
              <div
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: '50%',
                  background: 'rgba(15, 23, 42, 0.25)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 18,
                  color: '#e0f2fe',
                }}
              >
                {icon}
              </div>
            )}
            <div>
              <Text style={{ color: 'rgba(241, 245, 249, 0.78)', fontSize: 13, letterSpacing: 0.6 }}>{title}</Text>
              {hint && (
                <div style={{ color: 'rgba(226, 232, 240, 0.66)', fontSize: 12, marginTop: 2 }}>{hint}</div>
              )}
            </div>
          </div>
          {trendLabel && (
            <Text style={{ color: 'rgba(226, 232, 240, 0.6)', fontSize: 12 }}>{trendLabel}</Text>
          )}
        </div>
        <Title level={2} style={{ color: '#f8fafc', margin: 0 }}>
          {value}
        </Title>
        {delta && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'rgba(226, 232, 240, 0.86)' }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                color: deltaPositive ? '#bbf7d0' : '#fecdd3',
                fontWeight: 600,
              }}
            >
              {deltaPositive ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
              {delta.value}
            </span>
            {trendLabel && <span style={{ opacity: 0.7 }}>{trendLabel}</span>}
          </div>
        )}
      </div>
    </div>
  );
};

export default DashboardKpiCard;

import React from "react";
import { Card, Statistic, Space, Empty, Tooltip } from "antd";
export default function PerfPanel({ kpi, session }: any) {
  if (!session)
    return (
      <Card title="Performance">
        <Empty description="No active session" />
      </Card>
    );
  const roi = kpi?.roiPct ?? 0;
  const color = roi >= 0 ? '#1f8f1f' : '#c0392b';
  const stats = (kpi?.stats || {}) as any;
  const expectancy = typeof kpi?.expectancy === 'number' ? kpi.expectancy : 0;
  const stdPct = typeof stats?.stdPct === 'number' ? stats.stdPct : null;
  const partialWinRate = typeof stats?.partialWinRate === 'number' ? stats.partialWinRate : null;
  const medianHold = typeof stats?.medianHoldMin === 'number' ? stats.medianHoldMin : null;
  const p75Hold = typeof stats?.p75HoldMin === 'number' ? stats.p75HoldMin : null;
  const avgHold = typeof kpi?.avgHoldingMin === 'number' ? kpi.avgHoldingMin : 0;
  return (
    <Card
      title={`Performance — since ${new Date(
        session.startedAt
      ).toLocaleString()}`}
    >
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Space size="large" wrap>
          <Statistic
            title={<Tooltip title="Closed profit/loss since session start">Realized PnL (USD)</Tooltip>}
            value={kpi?.realizedPnlUsd ?? 0}
            precision={2}
          />
          <Statistic
            title={<Tooltip title="Open profit/loss on current positions">Unrealized PnL (USD)</Tooltip>}
            value={kpi?.unrealizedPnlUsd ?? 0}
            precision={2}
          />
          <Statistic title={<Tooltip title="Return on investment since activation">ROI (%)</Tooltip>} value={roi} precision={2} valueStyle={{ color }} />
          <Statistic
            title={<Tooltip title="Winning trades / total trades">Win rate (%)</Tooltip>}
            value={kpi?.winRate ?? 0}
            precision={1}
          />
          <Statistic
            title={<Tooltip title="Largest peak-to-trough drop during the session">Max Drawdown (%)</Tooltip>}
            value={kpi?.maxDrawdownPct ?? 0}
            precision={1}
          />
        </Space>
        <Space size="large" wrap>
          <Statistic
            title={<Tooltip title="Average return per trade">Expectancy (% per trade)</Tooltip>}
            value={expectancy}
            precision={2}
          />
          <Statistic
            title={<Tooltip title="Standard deviation of trade returns">Return Std Dev (%)</Tooltip>}
            value={stdPct ?? 0}
            precision={2}
          />
          <Statistic
            title={<Tooltip title="Average holding duration across exits">Avg Hold (min)</Tooltip>}
            value={avgHold}
            precision={1}
          />
          {medianHold != null && (
            <Statistic
              title={<Tooltip title="Median holding duration">Median Hold (min)</Tooltip>}
              value={medianHold}
              precision={1}
            />
          )}
          {p75Hold != null && (
            <Statistic
              title={<Tooltip title="75th percentile holding duration">P75 Hold (min)</Tooltip>}
              value={p75Hold}
              precision={1}
            />
          )}
          {partialWinRate != null && (
            <Statistic
              title={<Tooltip title="Percent of partial exits that locked gains">Partial Effectiveness (%)</Tooltip>}
              value={partialWinRate}
              precision={1}
            />
          )}
        </Space>
      </Space>
    </Card>
  );
}

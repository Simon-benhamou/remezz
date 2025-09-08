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
  return (
    <Card
      title={`Performance — since ${new Date(
        session.startedAt
      ).toLocaleString()}`}
    >
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
    </Card>
  );
}

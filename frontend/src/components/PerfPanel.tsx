import React from "react";
import { Card, Statistic, Space, Empty } from "antd";
export default function PerfPanel({ kpi, session }: any) {
  if (!session)
    return (
      <Card title="Performance">
        <Empty description="No active session" />
      </Card>
    );
  return (
    <Card
      title={`Performance — since ${new Date(
        session.startedAt
      ).toLocaleString()}`}
    >
      <Space size="large" wrap>
        <Statistic
          title="Realized PnL (USD)"
          value={kpi?.realizedPnlUsd ?? 0}
          precision={2}
        />
        <Statistic
          title="Unrealized PnL (USD)"
          value={kpi?.unrealizedPnlUsd ?? 0}
          precision={2}
        />
        <Statistic title="ROI (%)" value={kpi?.roiPct ?? 0} precision={2} />
        <Statistic
          title="Win rate (%)"
          value={kpi?.winRate ?? 0}
          precision={1}
        />
        <Statistic
          title="Max Drawdown (%)"
          value={kpi?.maxDrawdownPct ?? 0}
          precision={1}
        />
      </Space>
    </Card>
  );
}

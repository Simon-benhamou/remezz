import React from "react";
import { Card, Statistic, Space } from "antd";
export default function IndicatorsPanel({ indicators }: any) {
  return (
    <Card title="Indicateurs (1h)">
      <Space size="large" wrap>
        <Statistic title="EMA20" value={indicators?.ema20} precision={2} />
        <Statistic title="EMA50" value={indicators?.ema50} precision={2} />
        <Statistic title="RSI14" value={indicators?.rsi14} precision={1} />
        <Statistic title="ATR14" value={indicators?.atr14} precision={2} />
      </Space>
    </Card>
  );
}

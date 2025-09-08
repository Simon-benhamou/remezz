import React from "react";
import { Card, Descriptions, Empty } from "antd";
export default function StrategyPanel({ strategy }: any) {
  if (!strategy)
    return (
      <Card title="Strategy (classic)">
        <Empty description="No strategy" />
      </Card>
    );
  const s = strategy;
  return (
    <Card title="Strategy (active)">
      <Descriptions column={1} size="small" bordered>
        <Descriptions.Item label="ID">{s.id || s.strategyId}</Descriptions.Item>
        <Descriptions.Item label="Symbol">{s.symbol}</Descriptions.Item>
        <Descriptions.Item label="Bias">{s.bias}</Descriptions.Item>
        <Descriptions.Item label="Confidence">
          {s.confidence ?? "-"}
        </Descriptions.Item>
        <Descriptions.Item label="Entry">
          {s.entry?.price ??
            `${s.entry?.zone?.min ?? "-"} → ${s.entry?.zone?.max ?? "-"}`}
        </Descriptions.Item>
        <Descriptions.Item label="SL">
          {s.risk?.stop?.value}
          {s.risk?.stop?.type === "percent" ? "%" : ""}
        </Descriptions.Item>
        <Descriptions.Item label="TP">
          {s.risk?.target?.value}
          {s.risk?.target?.type === "percent" ? "%" : ""}
        </Descriptions.Item>
        <Descriptions.Item label="Max leverage">
          {s.risk?.max_leverage}
        </Descriptions.Item>
        <Descriptions.Item label="Validity">
          {s.validity?.from || "-"} → {s.validity?.to || "-"}
        </Descriptions.Item>
        <Descriptions.Item label="Trigger">
          {s.trigger || "-"}
        </Descriptions.Item>
      </Descriptions>
      {strategy?.levels && (
        <div style={{ marginTop: 8 }}>
          <b>Targets:</b>&nbsp; Entry mid:{" "}
          {strategy.entry?.price ??
            (
              (strategy.entry?.zone?.min ||
                0 + strategy.entry?.zone?.max ||
                0) / 2
            ).toFixed?.(2)}{" "}
          &nbsp;|&nbsp; SL: {strategy.levels?.stopPrice?.toFixed?.(2)}{" "}
          &nbsp;|&nbsp; TP: {strategy.levels?.takeProfitPrice?.toFixed?.(2)}
        </div>
      )}
    </Card>
  );
}

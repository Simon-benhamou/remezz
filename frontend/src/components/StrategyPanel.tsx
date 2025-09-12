import React from "react";
import { Card, Descriptions, Empty, Tooltip } from "antd";
export default function StrategyPanel({ strategy }: any) {
  if (!strategy)
    return (
      <Card title="Strategy">
        <Empty description="No strategy" />
      </Card>
    );
  const s = strategy;
  const bias = String(s.bias || '').toLowerCase();
  const color = bias==='long'? 'green' : bias==='short'? 'red' : 'default';
  return (
    <Card title={<span>Strategy (active) &nbsp; <span style={{ display:'inline-block', padding:'2px 8px', borderRadius:12, background: color==='green'? '#e6ffed' : color==='red'? '#ffeaea' : '#f0f0f0', color: color==='green'? '#1f8f1f' : color==='red'? '#c0392b' : '#555' }}>{(s.bias || '-').toUpperCase()}</span></span>}>
      <Descriptions column={1} size="small" bordered>
        <Descriptions.Item label={<Tooltip title="Strategy identifier">ID</Tooltip>}>{s.id || s.strategyId}</Descriptions.Item>
        <Descriptions.Item label={<Tooltip title="Trading pair">Symbol</Tooltip>}>{s.symbol}</Descriptions.Item>
        <Descriptions.Item label={<Tooltip title="Direction: long = buy pullback/rebound, short = sell rejection">Bias</Tooltip>}>{s.bias}</Descriptions.Item>
        <Descriptions.Item label={<Tooltip title="How confident the model is (0–1)">Confidence</Tooltip>}>
          {s.confidence ?? "-"}
        </Descriptions.Item>
        <Descriptions.Item label={<Tooltip title="Planned entry price or zone bounds">Entry</Tooltip>}>
          {s.entry?.price ??
            `${s.entry?.zone?.min ?? "-"} → ${s.entry?.zone?.max ?? "-"}`}
        </Descriptions.Item>
        <Descriptions.Item label={<Tooltip title="Stop loss level or %">SL</Tooltip>}>
          {s.risk?.stop?.value}
          {s.risk?.stop?.type === "percent" ? "%" : ""}
        </Descriptions.Item>
        <Descriptions.Item label={<Tooltip title="Take profit level or %">TP</Tooltip>}>
          {s.risk?.target?.value}
          {s.risk?.target?.type === "percent" ? "%" : ""}
        </Descriptions.Item>
        <Descriptions.Item label={<Tooltip title="Maximum leverage allowed for this plan">Max leverage</Tooltip>}>
          {s.risk?.max_leverage}
        </Descriptions.Item>
        <Descriptions.Item label={<Tooltip title="Time window when the plan is valid">Validity</Tooltip>}>
          {s.validity?.from || "-"} → {s.validity?.to || "-"}
        </Descriptions.Item>
        <Descriptions.Item label="Trigger">
          {s.trigger || "-"}
        </Descriptions.Item>
        {s.rationale && (
          <Descriptions.Item label={<Tooltip title="Why the strategy chose this setup">Rationale</Tooltip>}>
            {s.rationale}
          </Descriptions.Item>
        )}
      </Descriptions>
      {strategy?.levels && (
        <div style={{ marginTop: 8 }}>
          <b>Targets:</b>&nbsp; Entry mid:{" "}
          {strategy.entry?.price ?? (
            (() => {
              const mn = Number(strategy.entry?.zone?.min ?? 0);
              const mx = Number(strategy.entry?.zone?.max ?? 0);
              const mid = (mn + mx) / 2;
              return isFinite(mid) && mid > 0 ? mid.toFixed(4) : '-';
            })()
          )}{" "}
          &nbsp;|&nbsp; SL: {strategy.levels?.stopPrice?.toFixed?.(4)}{" "}
          &nbsp;|&nbsp; TP: {strategy.levels?.takeProfitPrice?.toFixed?.(4)}
        </div>
      )}
    </Card>
  );
}

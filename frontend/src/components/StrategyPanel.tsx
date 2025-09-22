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
    <Card title={
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <span>Strategy (active)</span>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '6px 12px',
          borderRadius: '8px',
          background: color === 'green' 
            ? 'linear-gradient(135deg, #f6ffed 0%, #d9f7be 100%)' 
            : color === 'red' 
              ? 'linear-gradient(135deg, #fff2e8 0%, #ffbb96 100%)'
              : '#f0f0f0',
          border: `2px solid ${color === 'green' ? '#52c41a' : color === 'red' ? '#ff7875' : '#d9d9d9'}`,
          fontSize: '14px',
          fontWeight: 'bold'
        }}>
          <span style={{
            fontSize: '16px'
          }}>
            {bias === 'long' ? '📈' : bias === 'short' ? '📉' : '⚖️'}
          </span>
          <span style={{
            color: color === 'green' ? '#389e0d' : color === 'red' ? '#cf1322' : '#666'
          }}>
            {(s.bias || 'NEUTRAL').toUpperCase()}
          </span>
        </div>
      </div>
    }>
      
      {/* Strategy Bias Explanation */}
      {s.bias && (
        <div style={{
          background: color === 'green' 
            ? 'rgba(82, 196, 26, 0.1)' 
            : color === 'red' 
              ? 'rgba(255, 77, 79, 0.1)'
              : 'rgba(0,0,0,0.05)',
          padding: '8px 12px',
          borderRadius: '6px',
          marginBottom: '16px',
          fontSize: '12px',
          fontStyle: 'italic',
          color: '#666'
        }}>
          {bias === 'long' 
            ? '🎯 Agent recherche des opportunités d\'ACHAT (rebonds sur support, breakouts haussiers)'
            : bias === 'short'
              ? '🎯 Agent recherche des opportunités de VENTE (rejections sur résistance, breakouts baissiers)'
              : '🎯 Agent en attente de signal directionnel clair'
          }
        </div>
      )}
      
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

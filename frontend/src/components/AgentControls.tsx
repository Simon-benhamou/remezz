import React from "react";
import { Card, Space, Button, Segmented, InputNumber, message, Modal, Switch } from "antd";
import { api } from "../api";
export default function AgentControls({ session, symbol, onChange, showStart = false }: any) {
  const [mode, setMode] = React.useState<"paper" | "live">("paper");
  const [startBal, setStartBal] = React.useState<number | undefined>(undefined);
  const [riskPct, setRiskPct] = React.useState<number>(1.5);
  const [maxLev, setMaxLev] = React.useState<number>(4);
  const [dailyLoss, setDailyLoss] = React.useState<number>(3.5);
  const start = async () => {
    await api.client.post('/api/agent/start', { symbol: symbol || 'BTCUSDT', mode, startBalanceUsd: startBal, riskPerTradePct: riskPct, maxLeverage: maxLev, dailyLossLimitPct: dailyLoss });
    message.success("Session started");
    onChange?.();
  };
  const stop = async () => {
    let closePos = true;
    Modal.confirm({
      title: 'Stop session',
      content: (
        <div>
          Close any open position now?
          <div style={{ marginTop: 8 }}>
            <Switch checked={closePos} onChange={(v)=> (closePos = v)} />
            <span style={{ marginLeft: 8 }}>{closePos ? 'Close position on stop' : 'Leave position open'}</span>
          </div>
        </div>
      ),
      okText: 'Stop',
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          await api.stopSession(closePos);
          message.info(closePos ? "Session stopped and position closed" : "Session stopped (position left open)");
          onChange?.();
        } catch {}
      }
    });
  };
  return (
    <Card title="Agent Controls">
      <Space direction="vertical" style={{ width: "100%" }}>
        <div>
          Mode:{" "}
          <Segmented
            options={["paper", "live"]}
            value={mode}
            onChange={(v) => setMode(v as any)}
          />
        </div>
        <div>
          Start balance USD (optional):{" "}
          <InputNumber
            value={startBal}
            onChange={setStartBal as any}
            style={{ width: 160 }}
          />
        </div>
        <div>
          Risk %/trade: <InputNumber min={1} max={2} step={0.1} value={riskPct} onChange={setRiskPct as any} style={{ width: 100 }} />
          &nbsp; Max Lev: <InputNumber min={1} max={5} step={1} value={maxLev} onChange={setMaxLev as any} style={{ width: 80 }} />
          &nbsp; Daily loss %: <InputNumber min={3} max={4} step={0.1} value={dailyLoss} onChange={setDailyLoss as any} style={{ width: 120 }} />
        </div>
        <Space>
          {showStart && (
            <Button type="primary" onClick={start} disabled={!!session}>
              Start
            </Button>
          )}
          <Button danger onClick={stop} disabled={!session}>
            Stop
          </Button>
        </Space>
        <div style={{ fontSize: 12, color: "#888" }}>
          The session measures performance since activation.
        </div>
      </Space>
    </Card>
  );
}

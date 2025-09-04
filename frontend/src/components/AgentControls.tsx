import React from "react";
import { Card, Space, Button, Segmented, InputNumber, message } from "antd";
import { api } from "../api";
export default function AgentControls({ session, symbol, onChange }: any) {
  const [mode, setMode] = React.useState<"paper" | "live">("paper");
  const [startBal, setStartBal] = React.useState<number | undefined>(undefined);
  const start = async () => {
    await api.startSession(symbol || "BTCUSDT", mode, startBal);
    message.success("Session démarrée");
    onChange?.();
  };
  const stop = async () => {
    await api.stopSession();
    message.info("Session arrêtée");
    onChange?.();
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
          Start balance USD (optionnel):{" "}
          <InputNumber
            value={startBal}
            onChange={setStartBal as any}
            style={{ width: 160 }}
          />
        </div>
        <Space>
          <Button type="primary" onClick={start} disabled={!!session}>
            Start
          </Button>
          <Button danger onClick={stop} disabled={!session}>
            Stop
          </Button>
        </Space>
        <div style={{ fontSize: 12, color: "#888" }}>
          La session mesure la performance depuis l'activation.
        </div>
      </Space>
    </Card>
  );
}

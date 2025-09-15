import React from "react";
import { Card, Space, Button, Segmented, InputNumber, message, Modal, Switch, Tooltip, Tag } from "antd";
import { api } from "../api";
export default function AgentControls({ session, symbol, onChange, showStart = false }: any) {
  const [mode, setMode] = React.useState<"paper" | "live">("paper");
  const [startBal, setStartBal] = React.useState<number | undefined>(undefined);
  const [riskPct, setRiskPct] = React.useState<number>(1.5);
  const [maxLev, setMaxLev] = React.useState<number>(4);
  const [dailyLoss, setDailyLoss] = React.useState<number>(3.5);
  const [budgetPct, setBudgetPct] = React.useState<number>(100);
  const [exBal, setExBal] = React.useState<{ totalUsd?: number; freeUsd?: number } | null>(null);

  React.useEffect(()=>{
    let t:any; const pull = async ()=>{ try { const o = await api.overview(); setExBal(o?.exchangeBalance || null); } catch{} };
    pull(); t = setInterval(pull, 15000); return ()=> clearInterval(t);
  }, []);
  const start = async () => {
    const payload: any = { symbol: symbol || 'BTCUSDT', mode, startBalanceUsd: startBal, riskPerTradePct: riskPct, maxLeverage: maxLev, dailyLossLimitPct: dailyLoss, budgetPct };
    if (mode === 'live' && exBal?.totalUsd != null && payload.startBalanceUsd != null) {
      payload.startBalanceUsd = Math.min(Number(payload.startBalanceUsd||0), Number(exBal.totalUsd||0));
    }
    await api.client.post('/api/agent/start', payload);
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
          await api.stopSession(session?.id, closePos);
          message.info(closePos ? "Session stopped and position closed" : "Session stopped (position left open)");
          onChange?.();
        } catch {}
      }
    });
  };
  return (
    <Card title="QuantAI Controls">
      <Space direction="vertical" style={{ width: "100%" }}>
        <div>
          Mode:{" "}
          <Segmented
            options={["paper", "live"]}
            value={mode}
            onChange={(v) => setMode(v as any)}
          />
        </div>
        {mode !== 'live' && (
          <div>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <span>Start balance USD (optional):</span>
              <Tooltip title={exBal? `Exchange: Free $${Number(exBal.freeUsd||0).toFixed(2)} • Equity $${Number(exBal.totalUsd||0).toFixed(2)}`: undefined}>
                <InputNumber
                  value={startBal}
                  onChange={setStartBal as any}
                  style={{ width: 200 }}
                  min={0}
                />
              </Tooltip>
            </div>
          </div>
        )}
        <div>
          Risk %/trade: <InputNumber min={1} max={2} step={0.1} value={riskPct} onChange={setRiskPct as any} style={{ width: 100 }} />
          &nbsp; Max Lev: <InputNumber min={1} max={5} step={1} value={maxLev} onChange={setMaxLev as any} style={{ width: 80 }} />
          &nbsp; Daily loss %: <InputNumber min={3} max={4} step={0.1} value={dailyLoss} onChange={setDailyLoss as any} style={{ width: 120 }} />
        </div>
        <div>
          Budget % of balance:&nbsp;
          <InputNumber min={10} max={100} step={5} value={budgetPct} onChange={setBudgetPct as any} style={{ width: 120 }} />
          {mode==='live' && exBal && (
            <span style={{ marginLeft:8, fontSize:12, color:'#666' }}>
              <Tag color='cyan'>Free ${Number(exBal.freeUsd||0).toFixed(2)}</Tag>
              <Tag color='geekblue'>Equity ${Number(exBal.totalUsd||0).toFixed(2)}</Tag>
            </span>
          )}
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

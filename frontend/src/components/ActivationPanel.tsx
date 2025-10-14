import React from 'react';
import { Card, Space, Segmented, InputNumber, Button, Select, Typography, message } from 'antd';
import { Link } from 'react-router-dom';
import { api } from '../api';

type Props = {
  defaultSymbol?: string;
  onStarted?: ()=>void;
};

export default function ActivationPanel({ defaultSymbol = 'BTC/USDT', onStarted }: Props){
  const [symbol, setSymbol] = React.useState(defaultSymbol);
  const [mode, setMode] = React.useState<'paper'|'live'>('paper');
  const [startBal, setStartBal] = React.useState<number | undefined>(1000);
  const [riskPct, setRiskPct] = React.useState<number>(1.5);
  const [maxLev, setMaxLev] = React.useState<number>(4);
  const [dailyLoss, setDailyLoss] = React.useState<number>(3.5);
  const [budgetPct, setBudgetPct] = React.useState<number>(100);
  const [aggressiveness, setAggressiveness] = React.useState<'conservative'|'reactive'|'aggressive'>('conservative');
  const [loading, setLoading] = React.useState(false);
  const start = async () => {
    setLoading(true);
    try {
      const payload: any = { symbol, mode, riskPerTradePct: riskPct, maxLeverage: maxLev, dailyLossLimitPct: dailyLoss, budgetPct, aggressiveness };
      if (mode === 'paper') {
        payload.startBalanceUsd = startBal;
        payload.portfolioBalanceUsd = startBal;
      }
      await api.client.post('/api/agent/start', payload);
      message.success('QuantAI agent activated');
      onStarted?.();
    } catch (e:any) {
      message.error(String(e?.message || e));
    } finally { setLoading(false); }
  };
  return (
    <Card title="Activate QuantAI Agent" style={{ maxWidth: 800, margin: '0 auto' }}>
      <Space direction='vertical' size='large' style={{ width:'100%' }}>
        <Typography.Paragraph>
          Choose mode and symbol. In paper mode, you may set a starting balance. Risk per trade, max leverage and daily loss guardrails are enforced by the agent.
        </Typography.Paragraph>
        <Space wrap>
          <div>
            <div style={{ fontSize:12, color:'#888' }}>Mode</div>
            <Segmented options={[{label:'Paper', value:'paper'},{label:'Live', value:'live'}]} value={mode} onChange={(v)=> setMode(v as any)} />
          </div>
          <div>
            <div style={{ fontSize:12, color:'#888' }}>Symbol</div>
            <Select style={{ width: 200 }} value={symbol} onChange={setSymbol}
              options={[{value:'BTC/USDT'},{value:'ETH/USDT'},{value:'SOL/USDT'},{value:'XRP/USDT'},{value:'AVAX/USDT'}]} />
          </div>
          {mode==='paper' && (
            <div>
              <div style={{ fontSize:12, color:'#888' }}>Paper portfolio balance (USD)</div>
              <InputNumber min={100} step={100} value={startBal} onChange={setStartBal as any} />
            </div>
          )}
          <div>
            <div style={{ fontSize:12, color:'#888' }}>Risk % / trade</div>
            <InputNumber min={1} max={2} step={0.1} value={riskPct} onChange={setRiskPct as any} />
          </div>
          <div>
            <div style={{ fontSize:12, color:'#888' }}>Max leverage</div>
            <InputNumber min={1} max={5} step={1} value={maxLev} onChange={setMaxLev as any} />
          </div>
          <div>
            <div style={{ fontSize:12, color:'#888' }}>Daily loss %</div>
            <InputNumber min={3} max={4} step={0.1} value={dailyLoss} onChange={setDailyLoss as any} />
          </div>
          <div>
            <div style={{ fontSize:12, color:'#888' }}>Agent budget (% of free)</div>
            <InputNumber min={10} max={100} step={5} value={budgetPct} onChange={setBudgetPct as any} />
          </div>
          <div>
            <div style={{ fontSize:12, color:'#888' }}>Aggressiveness</div>
            <Segmented
              options={[
                { label: 'Conservative', value: 'conservative' },
                { label: 'Reactive', value: 'reactive' },
                { label: 'Aggressive', value: 'aggressive' },
              ]}
              value={aggressiveness}
              onChange={(v)=> setAggressiveness(v as any)}
            />
          </div>
        </Space>
        <Space>
          <Button type='primary' onClick={start} loading={loading} disabled={loading}>Activate</Button>
          <Link to='/test'>Go to Testing</Link>
        </Space>
      </Space>
    </Card>
  );
}

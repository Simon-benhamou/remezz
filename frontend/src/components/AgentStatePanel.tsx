import React from 'react';
import { Card, Descriptions, Tag, Space, Button, message, Statistic, Tooltip } from 'antd';
import { api } from '../api';

type Props = {
  agent: any; // includes validated plan when ARMED/MANAGE
  symbol: string;
  lastPrice?: number;
  onPlan?: (plan:any)=>void; // emits LLM plan JSON
  sessionId?: string;
};

export default function AgentStatePanel({ agent, symbol, lastPrice, onPlan, sessionId }: Props){
  const [llmPlan, setLlmPlan] = React.useState<any>(null);
  const balance = agent?.balance;

  const propose = async () => {
    const p = await api.proposePlan(symbol);
    setLlmPlan(p);
    onPlan?.(p);
  };
  const arm = async () => {
    if (!llmPlan) return message.error('No plan');
    if (!sessionId) return message.error('No active session');
    await api.proposeAgentPlan(sessionId, llmPlan);
    message.success('Plan validated/ARMED (if risk checks pass)');
  };

  const vp = agent?.plan; // validated plan from backend with numeric zone
  const inZone = !!(vp && lastPrice && vp.zone && lastPrice >= Math.min(vp.zone.from || 0, vp.zone.to || 0) && lastPrice <= Math.max(vp.zone.from || 0, vp.zone.to || 0));
  const pos = agent?.pos;
  const dir = pos?.side === 'buy' ? 1 : -1;
  const rNow = (pos && vp && lastPrice) ? (dir * (lastPrice - pos.entry)) / (vp.stopDistance || 1) : 0;
  const pnlPct = (pos && lastPrice) ? (dir * (lastPrice - pos.entry) / pos.entry) * 100 : 0;
  const pnlColor = (pnlPct >= 0) ? '#1f8f1f' : '#c0392b';

  const check = (ok:boolean) => <span style={{ color: ok ? '#1f8f1f' : '#c0392b' }}>{ok ? '✓' : '✗'}</span>;
  const z = agent?.plan?.zone;
  const inZoneNow = !!(z && lastPrice!=null && lastPrice >= Math.min(z.from, z.to) && lastPrice <= Math.max(z.from, z.to));
  const confirmNeeded = !!agent?.plan?.plan?.entry_rule?.confirm_close;
  const confirmNow = !!(agent?.plan?.bias === 'long' ? (lastPrice! > (z?.mid ?? Infinity)) : (lastPrice! < (z?.mid ?? -Infinity)));
  const spreadOk = agent?.plan?.guards?.spreadOk ?? true;
  const levOk = agent?.plan?.guards?.leverageOk ?? true;
  const ai = agent?.aiMetrics || {};
  const aiByModel = ai?.byModel || {};

  return (
    <Card title={<span>Agent State {agent?.state && <Tag color={agent.state==='MANAGE'?'green':agent.state==='ARMED'?'blue':agent.state==='HALT'?'red':'default'}>{agent.state}</Tag>}</span>}>
      <Space direction='vertical' style={{ width:'100%' }}>
        <Descriptions column={1} size='small' bordered>
          <Descriptions.Item label='Symbol'>{agent?.profile?.symbol || symbol}</Descriptions.Item>
          <Descriptions.Item label='Mode'>{agent?.profile?.mode}</Descriptions.Item>
          <Descriptions.Item label='Risk/Trade %'>{agent?.profile?.riskPerTradePct}</Descriptions.Item>
          <Descriptions.Item label='Max Lev'>{agent?.profile?.maxLeverage}</Descriptions.Item>
          <Descriptions.Item label='Daily Loss %'>{agent?.profile?.dailyLossLimitPct}</Descriptions.Item>
          {balance && (
            <>
              <Descriptions.Item label='Equity (USD)'>{Number(balance?.equityUsd||0).toFixed(2)}</Descriptions.Item>
              <Descriptions.Item label='Free (USD)'>{Number(balance?.freeUsd||0).toFixed(2)}</Descriptions.Item>
              <Descriptions.Item label='Committed (USD)'>{Number(balance?.committedUsd||0).toFixed(2)}</Descriptions.Item>
            </>
          )}
        </Descriptions>

        <Space>
          <Button onClick={propose}>Propose plan (LLM)</Button>
          <Button type='primary' onClick={arm} disabled={!llmPlan}>Arm</Button>
        </Space>

        {pos && (
          <Space size='large' wrap>
            <Statistic title={<Tooltip title="Open profit/loss in percent relative to entry">Unrealized PnL %</Tooltip>} value={pnlPct} precision={2} valueStyle={{ color: pnlColor }} />
            <Statistic title={<Tooltip title="Distance from entry measured in units of stop size (1R means price moved one stop distance in favor)">R multiple</Tooltip>} value={rNow} precision={2} />
          </Space>
        )}

        <Card size='small' title={<span>Readiness &nbsp; {typeof agent?.aiCalls==='number' && (<span style={{ fontSize:12, color:'#888' }}>AI calls: {agent.aiCalls}</span>)}</span>} style={{ marginTop: 8 }}>
          <Space direction='vertical'>
            <div>{check(inZoneNow)} In entry zone</div>
            <div>{check(!confirmNeeded || confirmNow)} Confirmation {confirmNeeded ? '(close beyond mid)' : '(not required)'}</div>
            <div>{check(spreadOk)} Spread OK</div>
            <div>{check(levOk)} Leverage OK (≤ configured max)</div>
            <div>Status: <Tag color={agent?.state==='ARMED'?'blue': agent?.state==='MANAGE'?'green': agent?.state==='HALT'?'red':'default'}>{agent?.state || 'IDLE'}</Tag></div>
            <div style={{ fontSize:12, color:'#666' }}>
              LLM usage — total: <b>{ai?.total ?? 0}</b>, calls/h: <b>{(ai?.callsPerHour ?? 0).toFixed?.(2)}</b>, cost: <b>${(ai?.costUsd ?? 0).toFixed?.(4)}</b>
              {Object.keys(aiByModel).length>0 && (
                <>
                  <br />by model: {Object.entries(aiByModel).map(([m,c]:any)=> (<span key={m} style={{ marginRight:8 }}><Tag>{m}</Tag>×{c}</span>))}
                </>
              )}
            </div>
          </Space>
        </Card>

        {llmPlan && (
          <Descriptions column={1} size='small' bordered title='Plan (LLM)'>
            <Descriptions.Item label='Name'>{llmPlan.name}</Descriptions.Item>
            <Descriptions.Item label='Bias'>{llmPlan.bias}</Descriptions.Item>
            <Descriptions.Item label='Timeframe'>{llmPlan.timeframe}</Descriptions.Item>
            <Descriptions.Item label='Zone'>{llmPlan.zone?.type} • from auto_detect</Descriptions.Item>
            <Descriptions.Item label='Entry rule'>{llmPlan.entry_rule?.type} • confirm_close: {String(llmPlan.entry_rule?.confirm_close)}</Descriptions.Item>
            <Descriptions.Item label='Stop'>{llmPlan.risk?.stop?.type} × {llmPlan.risk?.stop?.mult}</Descriptions.Item>
            <Descriptions.Item label='TP R'>{(llmPlan.risk?.tp||[]).map((x:any)=>x.value).join(', ')}</Descriptions.Item>
            <Descriptions.Item label='MaxHoldH'>{llmPlan.risk?.max_hold_hours}</Descriptions.Item>
            <Descriptions.Item label='Risk fraction'>{llmPlan.position?.risk_fraction}</Descriptions.Item>
            <Descriptions.Item label='Leverage max'>{llmPlan.position?.max_leverage}</Descriptions.Item>
          </Descriptions>
        )}
      </Space>
    </Card>
  );
}

import React from 'react';
import { Card, Descriptions, Tag, Space, Button, message } from 'antd';
import { api } from '../api';

type Props = {
  agent: any; // includes validated plan when ARMED/MANAGE
  symbol: string;
  lastPrice?: number;
  onPlan?: (plan:any)=>void; // emits LLM plan JSON
};

export default function AgentStatePanel({ agent, symbol, lastPrice, onPlan }: Props){
  const [llmPlan, setLlmPlan] = React.useState<any>(null);

  const propose = async () => {
    const p = await api.proposePlan(symbol);
    setLlmPlan(p);
    onPlan?.(p);
  };
  const arm = async () => {
    if (!llmPlan) return message.error('No plan');
    await api.proposeAgentPlan(llmPlan);
    message.success('Plan validated/ARMED (if risk checks pass)');
  };

  const vp = agent?.plan; // validated plan from backend with numeric zone
  const inZone = !!(vp && lastPrice && vp.zone && lastPrice >= Math.min(vp.zone.from || 0, vp.zone.to || 0) && lastPrice <= Math.max(vp.zone.from || 0, vp.zone.to || 0));

  return (
    <Card title={<span>Agent State {agent?.state && <Tag color={agent.state==='MANAGE'?'green':agent.state==='ARMED'?'blue':agent.state==='HALT'?'red':'default'}>{agent.state}</Tag>}</span>}>
      <Space direction='vertical' style={{ width:'100%' }}>
        <Descriptions column={1} size='small' bordered>
          <Descriptions.Item label='Symbol'>{agent?.profile?.symbol || symbol}</Descriptions.Item>
          <Descriptions.Item label='Mode'>{agent?.profile?.mode}</Descriptions.Item>
          <Descriptions.Item label='Risk/Trade %'>{agent?.profile?.riskPerTradePct}</Descriptions.Item>
          <Descriptions.Item label='Max Lev'>{agent?.profile?.maxLeverage}</Descriptions.Item>
          <Descriptions.Item label='Daily Loss %'>{agent?.profile?.dailyLossLimitPct}</Descriptions.Item>
        </Descriptions>

        <Space>
          <Button onClick={propose}>Propose plan (LLM)</Button>
          <Button type='primary' onClick={arm} disabled={!llmPlan}>Arm</Button>
        </Space>

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

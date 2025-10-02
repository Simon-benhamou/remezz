import React from 'react';
import { Card, Descriptions, Tag, Space, Button, message, Segmented } from 'antd';
import { api } from '../api';
import TradingDiagnostics from './TradingDiagnostics';

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
  const [agg, setAgg] = React.useState<string>(agent?.profile?.aggressiveness || 'conservative');

  React.useEffect(()=>{
    const next = agent?.profile?.aggressiveness || 'conservative';
    setAgg(next);
  }, [agent?.profile?.aggressiveness]);

  const propose = async () => {
    const p = await api.proposePlan(symbol, { sessionId, fresh: true });
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
  const onChangeAgg = async (val: any) => {
    try {
      if (!sessionId) { message.error('No active session'); return; }
      setAgg(val);
      await api.setAggressiveness(sessionId, val);
      message.success('Aggressiveness updated');
    } catch {
      message.error('Failed to update aggressiveness');
    }
  };

  const z = agent?.plan?.zone;
  const ai = agent?.aiMetrics || {};
  const aiByModel = ai?.byModel || {};
  
  // ✅ Extraire diagnostics depuis agent (ajoutés par MonitorPage)
  const diagnostics = agent?.diagnostics;

  return (
    <Card title={<span>QuantAI Agent {agent?.state && <Tag color={agent.state==='MANAGE'?'green':agent.state==='ARMED'?'blue':agent.state==='HALT'?'red':'default'}>{agent.state}</Tag>}</span>}>
      <Space direction='vertical' style={{ width:'100%' }}>
        
        {/* ✅ FIX: DIAGNOSTICS EN PREMIER - Pourquoi je ne trade pas ? */}
        {!agent?.pos && diagnostics && (
          <TradingDiagnostics sessionId={sessionId} refreshTrigger={agent?.state} />
        )}
        
        {/* Agent Bias Display - Prominent placement */}
        {agent?.plan?.bias && (
          <div style={{
            background: agent.plan.bias === 'long' 
              ? 'linear-gradient(135deg, #f6ffed 0%, #d9f7be 100%)' 
              : 'linear-gradient(135deg, #fff2e8 0%, #ffbb96 100%)',
            border: `2px solid ${agent.plan.bias === 'long' ? '#52c41a' : '#ff7875'}`,
            borderRadius: '8px',
            padding: '12px',
            textAlign: 'center',
            marginBottom: '16px'
          }}>
            <div style={{
              fontSize: '16px',
              fontWeight: 'bold',
              color: agent.plan.bias === 'long' ? '#389e0d' : '#cf1322',
              marginBottom: '4px'
            }}>
              🎯 AGENT BIAS: {agent.plan.bias.toUpperCase()}
            </div>
            <div style={{
              fontSize: '12px',
              color: agent.plan.bias === 'long' ? '#52c41a' : '#ff4d4f'
            }}>
              {agent.plan.bias === 'long' 
                ? '📈 Cherche opportunities ACHAT (rebond/breakout up)'
                : '📉 Cherche opportunities VENTE (rejection/breakout down)'
              }
            </div>
            {agent.state === 'ARMED' && (
              <div style={{
                fontSize: '11px',
                color: '#666',
                marginTop: '4px'
              }}>
                ⚡ Entry zone: ${z?.from?.toFixed(4)} - ${z?.to?.toFixed(4)}
              </div>
            )}
          </div>
        )}
        
        <Descriptions column={1} size='small' bordered>
          <Descriptions.Item label='Symbol'>{agent?.profile?.symbol || symbol}</Descriptions.Item>
          <Descriptions.Item label='Mode'>{agent?.profile?.mode}</Descriptions.Item>
          <Descriptions.Item label='Risk/Trade %'>{agent?.profile?.riskPerTradePct}</Descriptions.Item>
          <Descriptions.Item label='Max Lev'>{agent?.profile?.maxLeverage}</Descriptions.Item>
          <Descriptions.Item label='Daily Loss %'>{agent?.profile?.dailyLossLimitPct}</Descriptions.Item>
          <Descriptions.Item label='Aggressiveness'>
            <Segmented
              value={agg}
              onChange={onChangeAgg}
              options={[
                { label:'Conservative', value:'conservative' },
                { label:'Reactive', value:'reactive' },
                { label:'Aggressive', value:'aggressive' },
              ]}
            />
          </Descriptions.Item>
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

        {/* LLM Usage Info */}
        {typeof ai?.total === 'number' && (
          <Card size="small" title="LLM Usage" style={{ marginTop: 8 }}>
            <div style={{ fontSize: 12, color: '#666' }}>
              Total: <b>{ai?.total ?? 0}</b>, calls/h: <b>{(ai?.callsPerHour ?? 0).toFixed?.(2)}</b>, cost: <b>${(ai?.costUsd ?? 0).toFixed?.(4)}</b>
              {Object.keys(aiByModel).length > 0 && (
                <>
                  <br />by model: {Object.entries(aiByModel).map(([m, c]: any) => (
                    <span key={m} style={{ marginRight: 8 }}><Tag>{m}</Tag>×{c}</span>
                  ))}
                </>
              )}
            </div>
          </Card>
        )}

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
 

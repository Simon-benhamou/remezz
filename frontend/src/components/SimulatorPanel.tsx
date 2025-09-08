import React from 'react';
import { Card, Space, InputNumber, Button, Table, Statistic, Divider, Switch, message, Descriptions, Typography, Input } from 'antd';
import { api } from '../api';

export default function SimulatorPanel({ symbol }: { symbol: string }){
  const [hours, setHours] = React.useState(72);
  const [useLLMPlan, setUseLLMPlan] = React.useState(true);
  const [loading, setLoading] = React.useState(false);
  const [data, setData] = React.useState<any>(null);
  const [plan, setPlan] = React.useState<any>(null);
  const [planText, setPlanText] = React.useState<string>('');
  const [confirmMode, setConfirmMode] = React.useState<'close'|'wick+close'>('wick+close');
  const [targetR, setTargetR] = React.useState<number>(1.0);
  const [useRsiFilter, setUseRsiFilter] = React.useState<boolean>(true);
  const [rsiLongMax, setRsiLongMax] = React.useState<number>(65);
  const [rsiShortMin, setRsiShortMin] = React.useState<number>(35);
  const [adxMin, setAdxMin] = React.useState<number>(20);

  const run = async () => {
    setLoading(true);
    try {
      let p = null as any;
      if (useLLMPlan) p = await api.proposePlan(symbol);
      else if (planText?.trim()) { try { p = JSON.parse(planText); } catch { message.error('Invalid plan JSON'); }
      }
      setPlan(p);
      const out = await api.client.post('/api/sim/quicktest', { symbol, hours, plan: p || undefined, opts: { confirmMode, targetR, adxMin, rsiFilter: useRsiFilter ? { longMax: rsiLongMax, shortMin: rsiShortMin } : undefined } });
      
      setData(out.data);
      setData(out);
    } catch (e: any) {
      message.error(String(e?.message || e));
    } finally { setLoading(false); }
  };

  const cols: any = [
    { title: 'Entry', dataIndex: 'entryTime', render: (v:any)=> new Date(v).toLocaleString() },
    { title: 'Side', dataIndex: 'side' },
    { title: 'Entry Px', dataIndex: 'entryPrice', render: (v:number)=> v?.toFixed?.(2) },
    { title: 'Exit', dataIndex: 'exitTime', render: (v:any)=> v ? new Date(v).toLocaleString() : '-' },
    { title: 'Exit Px', dataIndex: 'exitPrice', render: (v:number)=> v?.toFixed?.(2) },
    { title: 'Reason', dataIndex: 'reason' },
    { title: 'R', dataIndex: 'rMultiple', render: (v:number)=> (v??0).toFixed(2) },
  ];

  return (
    <Card title="Quick Test (15m, last N hours)">
      <Space direction='vertical' style={{ width:'100%' }}>
        <Typography.Paragraph>
          Runs a fast in-sample simulation on recent 15m bars using the current logic: zone entry with confirmation, ATR-based stop, 1R target, trailing after {'>'}1R, and max_hold rules. Use this to sanity-check the plan and trigger behavior even when live signals are absent.
        </Typography.Paragraph>
        <Space>
          <div>Hours:</div>
          <InputNumber min={24} max={240} value={hours} onChange={v=> setHours(v as number)} />
          <div>Use LLM Plan:</div>
          <Switch checked={useLLMPlan} onChange={setUseLLMPlan} />
          <div>Confirm</div>
          <SelectLike value={confirmMode} onChange={setConfirmMode} options={[{label:'Close only', value:'close'}, {label:'Wick + Close', value:'wick+close'}]} />
          <div>Target R</div>
          <InputNumber min={0.5} max={3} step={0.5} value={targetR} onChange={v=> setTargetR(v as number)} />
          <Button type='primary' loading={loading} onClick={run}>Run</Button>
        </Space>
        <Space>
          <div>RSI filters</div>
          <Switch checked={useRsiFilter} onChange={setUseRsiFilter} />
          {useRsiFilter && (
            <>
              <div>Long max</div>
              <InputNumber min={40} max={80} step={1} value={rsiLongMax} onChange={v=> setRsiLongMax(v as number)} />
              <div>Short min</div>
              <InputNumber min={20} max={60} step={1} value={rsiShortMin} onChange={v=> setRsiShortMin(v as number)} />
            </>
          )}
          <div>ADX min</div>
          <InputNumber min={0} max={50} step={1} value={adxMin} onChange={v=> setAdxMin(v as number)} />
        </Space>
        {!useLLMPlan && (
          <Input.TextArea placeholder='Paste PlanZ JSON here (optional)' value={planText} onChange={(e)=> setPlanText(e.target.value)} rows={6} />
        )}
        {plan && (
          <Descriptions size='small' column={2} bordered title='Plan used'>
            <Descriptions.Item label='Name'>{plan?.name}</Descriptions.Item>
            <Descriptions.Item label='Bias'>{plan?.bias}</Descriptions.Item>
            <Descriptions.Item label='Zone'>{plan?.zone?.type} (auto_detect)</Descriptions.Item>
            <Descriptions.Item label='Entry rule'>{plan?.entry_rule?.type}, confirm_close: {String(plan?.entry_rule?.confirm_close)}</Descriptions.Item>
            <Descriptions.Item label='Stop'>{plan?.risk?.stop?.type} × {plan?.risk?.stop?.mult}</Descriptions.Item>
            <Descriptions.Item label='TP (R)'>{(plan?.risk?.tp||[]).map((x:any)=>x.value).join(', ')}</Descriptions.Item>
          </Descriptions>
        )}
        {data && (
          <>
            <Divider />
            <Space size='large' wrap>
              <Statistic title='Trades' value={data.stats?.count || 0} />
              <Statistic title='Winrate %' value={data.stats?.winrate || 0} precision={1} />
              <Statistic title='Avg R' value={data.stats?.avgR || 0} precision={2} />
            </Space>
            <Table rowKey={(r:any)=> String(r.entryTime)} dataSource={data.trades || []} columns={cols} size='small' pagination={{ pageSize: 5 }} />
          </>
        )}
      </Space>
    </Card>
  );
}

function SelectLike({ value, onChange, options }:{ value:any; onChange:(v:any)=>void; options:{label:string; value:any}[] }){
  return (
    <select value={value} onChange={(e)=> onChange((e.target as HTMLSelectElement).value)} style={{ padding:4 }}>
      {options.map((o)=> <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

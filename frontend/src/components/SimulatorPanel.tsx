import React from 'react';
import { Card, Space, InputNumber, Button, Table, Statistic, Divider, Switch, message, Descriptions, Typography, Input, Select, Tag, Tooltip } from 'antd';
import { api } from '../api';

export default function SimulatorPanel({ symbol }: { symbol: string }){
  const [symbolSel, setSymbolSel] = React.useState<string>(symbol || 'BTC/USDT');
  const [hours, setHours] = React.useState(72);
  const [useLLMPlan, setUseLLMPlan] = React.useState(true);
  const [loading, setLoading] = React.useState(false);
  const [data, setData] = React.useState<any>(null);
  const [plan, setPlan] = React.useState<any>(null);
  const [planText, setPlanText] = React.useState<string>('');
  const [confirmMode, setConfirmMode] = React.useState<'close'|'wick+close'>('close');
  const [tf, setTf] = React.useState<'5m'|'15m'|'1h'>('15m');
  const [targetMode, setTargetMode] = React.useState<'R'|'percent'>('percent');
  const [targetR, setTargetR] = React.useState<number>(1.0);
  const [targetPercent, setTargetPercent] = React.useState<number>(3);
  const [trailingATRmult, setTrailingATRmult] = React.useState<number>(1.0);
  const [exitPolicy, setExitPolicy] = React.useState<'time'|'trend'|'none'>('trend');
  const [maxHoldHours, setMaxHoldHours] = React.useState<number>(36);
  const [useRsiFilter, setUseRsiFilter] = React.useState<boolean>(false);
  const [rsiLongMax, setRsiLongMax] = React.useState<number>(65);
  const [rsiShortMin, setRsiShortMin] = React.useState<number>(35);
  const [adxMin, setAdxMin] = React.useState<number>(0);

  const run = async () => {
    setLoading(true);
    try {
      let p = null as any;
      if (useLLMPlan) p = await api.proposePlan(symbolSel, { fresh: true });
      else if (planText?.trim()) { try { p = JSON.parse(planText); } catch { message.error('Invalid plan JSON'); }
      }
      setPlan(p);
      const out = await api.client.post('/api/sim/quicktest', { symbol: symbolSel, hours, plan: p || undefined, opts: { tf, confirmMode, targetMode, targetR, targetPercent, trailingATRmult, exitPolicy, maxHoldHours, adxMin, rsiFilter: useRsiFilter ? { longMax: rsiLongMax, shortMin: rsiShortMin } : undefined } });
      setData(out.data);
    } catch (e: any) {
      message.error(String(e?.message || e));
    } finally { setLoading(false); }
  };

  const cols: any = [
    { title: 'Entry', dataIndex: 'entryTime', render: (v:any)=> new Date(v).toLocaleString() },
    { title: 'Side', dataIndex: 'side' },
    { title: 'Entry Px', dataIndex: 'entryPrice', render: (v:number)=> v?.toFixed?.(4) },
    { title: 'Exit', dataIndex: 'exitTime', render: (v:any)=> v ? new Date(v).toLocaleString() : '-' },
    { title: 'Exit Px', dataIndex: 'exitPrice', render: (v:number)=> v?.toFixed?.(4) },
    { title: 'PnL %', render: (_:any, r:any)=> {
        const dir = r.side==='long'? 1 : -1;
        const val = r.exitPrice && r.entryPrice ? (dir * (r.exitPrice - r.entryPrice) / r.entryPrice) * 100 : 0;
        const color = val>=0 ? '#1f8f1f' : '#c0392b';
        return <span style={{ color }}>{val.toFixed(2)}%</span>;
      }
    },
    { title: 'Reason', dataIndex: 'reason' },
    { title: 'R', dataIndex: 'rMultiple', render: (v:number)=> (v??0).toFixed(2) },
    { title: 'Outcome', render: (_:any, r:any)=> <Tag color={(r.rMultiple??0)>0? 'green':'red'}>{(r.rMultiple??0)>0? 'Win':'Loss'}</Tag> },
    { title: 'Hold (h)', render: (_:any, r:any)=> r.exitTime && r.entryTime ? (((r.exitTime - r.entryTime)/3600000).toFixed(2)) : '-' },
  ];

  return (
    <Card title="Quick Test (15m, last N hours)">
      <Space direction='vertical' style={{ width:'100%' }}>
        <Typography.Paragraph>
          Simulates the strategy on recent 15m bars. It waits for price to reach the entry zone and confirm, uses an ATR-based stop and R target, trails after {'>'}1R, and applies max_hold rules. Use filters to calibrate signal quality.
        </Typography.Paragraph>
        <Space>
          <div>Symbol:</div>
          <Select style={{ width: 180 }} value={symbolSel} onChange={setSymbolSel}
            options={[{value:'BTC/USDT'},{value:'ETH/USDT'},{value:'SOL/USDT'},{value:'XRP/USDT'},{value:'AVAX/USDT'}]} />
          <div>Hours:</div>
          <InputNumber min={24} max={240} value={hours} onChange={v=> setHours(v as number)} />
          <div>Use LLM Plan:</div>
          <Switch checked={useLLMPlan} onChange={setUseLLMPlan} />
          <div>Timeframe:</div>
          <Select style={{ width: 100 }} value={tf} onChange={setTf as any} options={[{value:'5m', label:'5m'},{value:'15m', label:'15m'},{value:'1h', label:'1h'}]} />
          <div>Confirm</div>
          <SelectLike value={confirmMode} onChange={setConfirmMode} options={[{label:'Close only', value:'close'}, {label:'Wick + Close', value:'wick+close'}]} />
          <div>Target</div>
          <Select style={{ width: 110 }} value={targetMode} onChange={setTargetMode as any} options={[{value:'percent', label:'Percent'},{value:'R', label:'R multiple'}]} />
          {targetMode==='percent' ? (
            <><InputNumber min={0.5} max={10} step={0.5} value={targetPercent} onChange={v=> setTargetPercent(v as number)} /><span>%</span></>
          ) : (
            <InputNumber min={0.5} max={5} step={0.5} value={targetR} onChange={v=> setTargetR(v as number)} />
          )}
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
          <div>Trail ATR×</div>
          <InputNumber min={0.5} max={3} step={0.1} value={trailingATRmult} onChange={v=> setTrailingATRmult(v as number)} />
          <div>Exit</div>
          <Select style={{ width: 120 }} value={exitPolicy} onChange={setExitPolicy as any} options={[{value:'trend', label:'Trend only'},{value:'time', label:'Time'},{value:'none', label:'None'}]} />
          {exitPolicy==='time' && (<><div>Max hold (h)</div><InputNumber min={1} max={72} step={1} value={maxHoldHours} onChange={v=> setMaxHoldHours(v as number)} /></>)}
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
              <Statistic title={<Tooltip title="Number of simulated trades">Trades</Tooltip>} value={data.stats?.count || 0} />
              <Statistic title={<Tooltip title="Winning trades as percent of total">Winrate %</Tooltip>} value={data.stats?.winrate || 0} precision={1} />
              <Statistic title={<Tooltip title="Average R across all trades">Avg R</Tooltip>} value={data.stats?.avgR || 0} precision={2} />
            </Space>
            <Table rowKey={(r:any)=> String(r.entryTime)} dataSource={data.trades || []} columns={cols} size='small' pagination={{ pageSize: 5 }} />
            {(!data.trades || data.trades.length===0) && (
              <Typography.Paragraph type='secondary'>No trades found. Try "Close only" confirmation, set ADX min to 0, and disable RSI filters; then tighten filters once signals appear.</Typography.Paragraph>
            )}
          </>
        )}
        {!data && (
          <Typography.Paragraph type='secondary'>Tip: if zero trades, try "Close only" confirmation, ADX min = 0, and turn off RSI filters to see more entries. Then tighten filters.</Typography.Paragraph>
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

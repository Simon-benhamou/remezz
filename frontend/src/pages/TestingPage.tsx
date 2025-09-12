import React from 'react';
import { Card, Space, Alert, Input, InputNumber, Button, Table, Tag, message } from 'antd';
import { api } from '../api';

export default function TestingPage(){
  const [rows, setRows] = React.useState<any[]>([]);
  const [symbol, setSymbol] = React.useState('BTC/USDT');
  const [hours, setHours] = React.useState<number>(24);
  const [result, setResult] = React.useState<any>(null);
  const [opts, setOpts] = React.useState<any>({ tf:'15m', confirmMode:'close', adxMin: undefined, rsiFilter: undefined, targetR: 1.0, targetMode:'R', targetPercent: 3, trailingATRmult: 1.0, exitPolicy:'time', maxHoldHours: 36 });
  const [batch, setBatch] = React.useState<any[]>([]);

  const load = async ()=>{ try { setRows(await api.listSessions()); } catch {} };
  React.useEffect(()=>{ load(); }, []);

  // Logic checks adapted for multi-agent
  const coherence = React.useMemo(()=>{
    const issues: string[] = [];
    for (const r of rows as any[]) {
      if (r.stoppedAt && (r.openPositions || 0) > 0) issues.push(`Stopped session ${r.id} still shows open positions`);
    }
    return issues;
  }, [rows]);

  const run = async ()=>{
    try { setResult(await api.quicktest(symbol, hours, undefined as any)); } catch { message.error('Test failed'); }
  };
  const runWithOpts = async ()=>{
    try { setResult(await (api as any).client.post('/api/sim/quicktest', { symbol, hours, opts }).then((r:any)=> r.data)); } catch { message.error('Test failed'); }
  };

  const presets = [
    { key:'trend_up', label:'Trend Up', apply:()=> setOpts({ ...opts, tf:'15m', adxMin:20, rsiFilter:{ longMax: undefined, shortMin: undefined }, exitPolicy:'trend', targetR:1.5 }) },
    { key:'range', label:'Range', apply:()=> setOpts({ ...opts, tf:'5m', adxMin:10, exitPolicy:'time', trailingATRmult:0.8, targetR:1.0 }) },
    { key:'high_vol', label:'High Vol', apply:()=> setOpts({ ...opts, tf:'5m', adxMin: undefined, trailingATRmult:1.2, targetMode:'percent', targetPercent:4 }) },
  ];

  const runBatch = async ()=>{
    const scenarios = presets;
    const out: any[] = [];
    for (const sc of scenarios as any[]) {
      try {
        const res = await (api as any).client.post('/api/sim/quicktest', { symbol, hours, opts: (sc.apply(), opts) }).then((r:any)=> r.data);
        out.push({ key: sc.key, label: sc.label, stats: res?.stats });
      } catch { out.push({ key: sc.key, label: sc.label, error: true }); }
    }
    setBatch(out);
  };

  return (
    <Space direction='vertical' style={{ width:'100%' }}>
      <Card title='Coherence checks'>
        {coherence.length === 0 ? <Alert type='success' message='No issues detected' /> : coherence.map((m,i)=> <Alert key={i} type='warning' message={m} style={{ marginBottom: 8 }} />)}
      </Card>
      <Card title='Quick Backtest'>
        <Space wrap>
          <Input value={symbol} onChange={e=> setSymbol(e.target.value)} placeholder='Symbol e.g. BTC/USDT' style={{ width: 180 }} />
          <InputNumber value={hours} onChange={(v:any)=> setHours(v)} min={6} max={240} step={6} />
          <Button onClick={run}>Run (default)</Button>
        </Space>
        <div style={{ marginTop: 12 }}>
          <Space wrap>
            <Input placeholder='TF (5m/15m/1h)' value={opts.tf} onChange={e=> setOpts({ ...opts, tf:e.target.value })} style={{ width:120 }} />
            <Input placeholder='confirmMode (close|wick+close)' value={opts.confirmMode} onChange={e=> setOpts({ ...opts, confirmMode:e.target.value })} style={{ width:180 }} />
            <InputNumber placeholder='ADX min' value={opts.adxMin} onChange={(v:any)=> setOpts({ ...opts, adxMin:v })} style={{ width:120 }} />
            <InputNumber placeholder='Target R' value={opts.targetR} onChange={(v:any)=> setOpts({ ...opts, targetR:v })} style={{ width:120 }} />
            <Input placeholder='TargetMode (R|percent)' value={opts.targetMode} onChange={e=> setOpts({ ...opts, targetMode:e.target.value })} style={{ width:160 }} />
            <InputNumber placeholder='Target %' value={opts.targetPercent} onChange={(v:any)=> setOpts({ ...opts, targetPercent:v })} style={{ width:120 }} />
            <InputNumber placeholder='ATR trail mult' value={opts.trailingATRmult} onChange={(v:any)=> setOpts({ ...opts, trailingATRmult:v })} style={{ width:160 }} />
            <Input placeholder='Exit policy (time|trend|none)' value={opts.exitPolicy} onChange={e=> setOpts({ ...opts, exitPolicy:e.target.value })} style={{ width:200 }} />
            <InputNumber placeholder='Max hold hours' value={opts.maxHoldHours} onChange={(v:any)=> setOpts({ ...opts, maxHoldHours:v })} style={{ width:160 }} />
            <Button type='primary' onClick={runWithOpts}>Run with options</Button>
            {presets.map(p=> <Button key={p.key} onClick={p.apply}>{p.label}</Button>)}
            <Button onClick={runBatch}>Run presets batch</Button>
          </Space>
        </div>
        {result && (
          <div style={{ marginTop: 12 }}>
            <pre style={{ whiteSpace:'pre-wrap' }}>{JSON.stringify(result, null, 2)}</pre>
          </div>
        )}
        {batch.length>0 && (
          <div style={{ marginTop: 12 }}>
            <b>Batch summary:</b>
            <pre style={{ whiteSpace:'pre-wrap' }}>{JSON.stringify(batch, null, 2)}</pre>
          </div>
        )}
      </Card>
      <Card title='Active sessions'>
        <Table rowKey='id' dataSource={rows.filter((r:any)=> !r.stoppedAt)} pagination={false}
          columns={[
            { title:'Symbol', dataIndex:'symbol' },
            { title:'Mode', dataIndex:'mode', render:(m)=> <Tag color={m==='live'?'gold':'blue'}>{String(m).toUpperCase()}</Tag> },
            { title:'Started', dataIndex:'startedAt', render:(v)=> new Date(v).toLocaleString() },
            { title:'Open pos', dataIndex:'openPositions' },
          ]}
        />
      </Card>
    </Space>
  );
}

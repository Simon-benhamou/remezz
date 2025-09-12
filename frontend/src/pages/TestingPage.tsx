import React from 'react';
import { Card, Space, Alert, Input, InputNumber, Button, Table, Tag, message } from 'antd';
import { api } from '../api';

export default function TestingPage(){
  const [rows, setRows] = React.useState<any[]>([]);
  const [symbol, setSymbol] = React.useState('BTC/USDT');
  const [hours, setHours] = React.useState<number>(24);
  const [result, setResult] = React.useState<any>(null);
  const load = async ()=>{ try { setRows(await api.listSessions()); } catch {} };
  React.useEffect(()=>{ load(); }, []);
  const coherence = React.useMemo(()=>{
    const active = rows.filter(r=> !r.stoppedAt);
    const issues: string[] = [];
    if (active.length > 1) issues.push(`Multiple active sessions (${active.length})`);
    for (const r of rows) {
      if (r.stoppedAt && (r.openPositions || 0) > 0) issues.push(`Stopped session ${r.id} still shows open positions`);
    }
    return issues;
  }, [rows]);
  const run = async ()=>{
    try { setResult(await api.quicktest(symbol, hours)); } catch { message.error('Test failed'); }
  };
  return (
    <Space direction='vertical' style={{ width:'100%' }}>
      <Card title='Coherence checks'>
        {coherence.length === 0 ? <Alert type='success' message='No issues detected' /> : coherence.map((m,i)=> <Alert key={i} type='warning' message={m} style={{ marginBottom: 8 }} />)}
      </Card>
      <Card title='Global backtest (quick)'>
        <Space>
          <Input value={symbol} onChange={e=> setSymbol(e.target.value)} placeholder='Symbol e.g. BTC/USDT' style={{ width: 180 }} />
          <InputNumber value={hours} onChange={(v:any)=> setHours(v)} min={6} max={240} step={6} />
          <Button type='primary' onClick={run}>Run</Button>
        </Space>
        {result && (
          <div style={{ marginTop: 12 }}>
            <pre style={{ whiteSpace:'pre-wrap' }}>{JSON.stringify(result, null, 2)}</pre>
          </div>
        )}
      </Card>
      <Card title='Active sessions'>
        <Table rowKey='id' dataSource={rows.filter(r=> !r.stoppedAt)} pagination={false}
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


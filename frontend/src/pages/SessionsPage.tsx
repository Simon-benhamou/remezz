import React from 'react';
import { Card, Table, Tag, Button, Space, message, Modal, Form, Input, Segmented, InputNumber, Typography, Select } from 'antd';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

export default function SessionsPage(){
  const [rows, setRows] = React.useState<any[]>([]);
  const [open, setOpen] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [form] = Form.useForm();
  const navigate = useNavigate();
  const [exBal, setExBal] = React.useState<{ totalUsd?: number; freeUsd?: number } | null>(null);
  const modeVal = Form.useWatch?.('mode', form);
  const commonSymbols = ['BTC/USDT','ETH/USDT','SOL/USDT','XRP/USDT','BNB/USDT','ADA/USDT','AVAX/USDT','DOGE/USDT','TON/USDT','LINK/USDT','MATIC/USDT','DOT/USDT'];
  const load = async ()=>{ try { setRows(await api.listSessions()); } catch {} };
  React.useEffect(()=>{ load(); }, []);
  React.useEffect(()=>{
    let t:any; const pull = async ()=>{ try { const o = await api.overview(); setExBal(o?.exchangeBalance || null); } catch{} };
    pull(); t = setInterval(pull, 15000); return ()=> clearInterval(t);
  }, []);
  const stop = async (id:string)=>{
    Modal.confirm({
      title: 'Stop session?',
      content: 'This will stop the agent. Close any open position now?',
      okText: 'Stop', cancelText: 'Cancel', okButtonProps:{ danger:true },
      onOk: async ()=>{
        try {
          await api.stopSession(id, true);
          message.success('Session stopped');
          await load();
        } catch { message.error('Stop failed'); }
      }
    });
  };
  const relaunch = async (r:any)=>{
    const p = r.profile || {};
    form.setFieldsValue({
      symbol: r.symbol,
      mode: r.mode,
      startBalanceUsd: r.startBalanceUsd,
      riskPerTradePct: p.riskPerTradePct ?? 1.5,
      maxLeverage: p.maxLeverage ?? 4,
      dailyLossLimitPct: p.dailyLossLimitPct ?? 3.5,
      budgetPct: p.budgetPct ?? 100,
    });
    setOpen(true);
  };
  return (
    <Space direction='vertical' style={{ width:'100%' }}>
      <Card title={
        <Space>
          Active sessions
          <Button type='primary' onClick={()=>{ form.setFieldsValue({ symbol:'BTC/USDT', mode:'paper', riskPerTradePct:1.5, maxLeverage:4, dailyLossLimitPct:3.5, budgetPct:100 }); setOpen(true); }}>+ New Agent</Button>
        </Space>
      }>
        <Table rowKey="id" dataSource={rows.filter(r=> !r.stoppedAt)} pagination={false}
          onRow={(r)=> ({ onClick: async ()=> { navigate(`/monitor/${r.id}`); } })}
          columns={[
            { title:'Symbol', dataIndex:'symbol' },
            { title:'Mode', dataIndex:'mode', render:(m)=> <Tag color={m==='live'?'gold':'blue'}>{String(m).toUpperCase()}</Tag> },
            { title:'Started', dataIndex:'startedAt', render:(v)=> new Date(v).toLocaleString() },
            { title:'Open pos', dataIndex:'openPositions' },
            { title:'PnL (USD)', dataIndex:'pnlUsd', render:(v:any)=> Number(v||0).toFixed(2) },
            { title:'ROI %', dataIndex:'roiPct', render:(v:any)=> Number(v||0).toFixed(2) },
            { title:'', render:(_,r)=> (<Space><Button danger onClick={(e)=> { e.stopPropagation(); stop(r.id); }}>Stop</Button></Space>) }
          ]}
        />
      </Card>

      <Card title="All sessions">
      <Table rowKey="id" dataSource={rows} pagination={{ pageSize: 10 }}
        onRow={(r)=> ({ onClick: async ()=> { if (!r.stoppedAt) { navigate(`/monitor/${r.id}`); } } })}
        columns={[
          { title:'Symbol', dataIndex:'symbol' },
          { title:'Mode', dataIndex:'mode', render:(m)=> <Tag color={m==='live'?'gold':'blue'}>{String(m).toUpperCase()}</Tag> },
          { title:'Started', dataIndex:'startedAt', render:(v)=> new Date(v).toLocaleString() },
          { title:'Stopped', dataIndex:'stoppedAt', render:(v)=> v ? new Date(v).toLocaleString() : <Tag color='green'>ACTIVE</Tag> },
          { title:'Open pos', dataIndex:'openPositions' },
          { title:'PnL (USD)', dataIndex:'pnlUsd', render:(v:any)=> Number(v||0).toFixed(2) },
          { title:'ROI %', dataIndex:'roiPct', render:(v:any)=> Number(v||0).toFixed(2) },
          { title:'', render:(_,r)=> !r.stoppedAt ? (
            <Space><Button danger onClick={(e)=>{ e.stopPropagation(); stop(r.id); }}>Stop</Button></Space>
          ) : (
            <Space>
              <Button onClick={(e)=>{ e.stopPropagation(); relaunch(r); }}>Restart</Button>
              <Button danger onClick={(e)=>{
                e.stopPropagation();
                Modal.confirm({ title:'Delete session?', content:'This will permanently delete session and all associated data (orders, fills, positions, KPI, triggers).', okText:'Delete', okButtonProps:{ danger:true }, onOk: async ()=>{
                  try { await api.deleteSession(r.id); message.success('Deleted'); await load(); } catch { message.error('Delete failed'); }
                } });
              }}>Delete</Button>
            </Space>
          ) }
        ]} />

      <Modal open={open} title='Activate new agent' okText='Start' cancelText='Cancel' onCancel={()=> setOpen(false)} confirmLoading={starting}
        onOk={async ()=>{
          try {
            setStarting(true);
            const v = await form.validateFields();
            // Front guard: cap startBalanceUsd to exchange equity when live
            if (String(v.mode) === 'live' && exBal?.totalUsd != null && v.startBalanceUsd != null) {
              v.startBalanceUsd = Math.min(Number(v.startBalanceUsd||0), Number(exBal.totalUsd||0));
            }
            const res = await api.client.post('/api/agent/start', v);
            message.success('Session started');
            setOpen(false);
            await load();
            // Navigate to the created session (preferred), fallback to first active
            const sid = (res as any)?.data?.id;
            if (sid) navigate(`/monitor/${sid}`); else {
              const list = await api.listSessions();
              const active = list.find((r:any)=> !r.stoppedAt);
              if (active) navigate(`/monitor/${active.id}`);
            }
          } catch (e: any) {
            const msg = String(e?.response?.data?.error || e?.message || e);
            if (msg.includes('active_session_exists')) message.warning('Stop the active session first.');
            else message.error('Failed to start session');
          } finally {
            setStarting(false);
          }
        }}>
        <Form layout='vertical' form={form} initialValues={{ mode:'paper', riskPerTradePct:1.5, maxLeverage:4, dailyLossLimitPct:3.5, budgetPct:100 }}>
          <Form.Item label='Symbol' name='symbol' rules={[{ required:true }]}>
            <Select
              showSearch
              placeholder='Select symbol'
              options={commonSymbols.map(s=>({ value: s, label: s }))}
              filterOption={(input, option)=> (option?.label as string).toLowerCase().includes(input.toLowerCase())}
            />
          </Form.Item>
          <Form.Item label='Mode' name='mode'>
            <Segmented options={['paper','live']} onChange={()=>{ /* re-render to update max */ }} />
          </Form.Item>
          {String(modeVal||'paper') !== 'live' && (
            <Form.Item label='Start balance USD (optional)' name='startBalanceUsd' tooltip={exBal? `Exchange: Free $${Number(exBal.freeUsd||0).toFixed(2)} • Equity $${Number(exBal.totalUsd||0).toFixed(2)}`: undefined}>
              <InputNumber style={{ width: '100%' }} min={0} max={exBal?.totalUsd ?? undefined} />
            </Form.Item>
          )}
          <Form.Item label='Risk % per trade' name='riskPerTradePct' rules={[{ type:'number', min:1, max:2 }]}>
            <InputNumber style={{ width: '100%' }} min={1} max={2} step={0.1} />
          </Form.Item>
          <Form.Item label='Max leverage' name='maxLeverage' rules={[{ type:'number', min:1, max:5 }]}>
            <InputNumber style={{ width: '100%' }} min={1} max={5} step={1} />
          </Form.Item>
          <Form.Item label='Daily loss limit %' name='dailyLossLimitPct' rules={[{ type:'number', min:3, max:4 }]}>
            <InputNumber style={{ width: '100%' }} min={3} max={4} step={0.1} />
          </Form.Item>
          <Form.Item label='Budget % of balance (0-100)' name='budgetPct' rules={[{ type:'number', min:10, max:100 }]}>
            <InputNumber style={{ width: '100%' }} min={10} max={100} step={5} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
    </Space>
  );
}

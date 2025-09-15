import React from 'react';
import { Card, Row, Col, Statistic, Space, Button, Table, Tag, List } from 'antd';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

export default function DashboardPage(){
  const [ov, setOv] = React.useState<any>({});
  const [loading, setLoading] = React.useState<boolean>(false);
  const navigate = useNavigate();
  const load = async ()=>{
    try { setLoading(true); setOv(await api.overview()); } finally { setLoading(false); }
  };
  React.useEffect(()=>{ load(); const t = setInterval(load, 15000); return ()=> clearInterval(t); }, []);
  return (
    <Space direction='vertical' style={{ width:'100%' }}>
      <Row gutter={[12,12]}>
        <Col xs={24} md={4}><Card loading={loading}><Statistic title='Active agents' value={ov?.activeCount || 0} /></Card></Col>
        <Col xs={24} md={4}><Card loading={loading}><Statistic title='Total sessions' value={ov?.sessionsCount || 0} /></Card></Col>
        <Col xs={24} md={4}><Card loading={loading}><Statistic title='Agg ROI %' precision={2} value={Number(ov?.roiPct||0)} /></Card></Col>
        <Col xs={24} md={4}><Card loading={loading}><Statistic title='Agg PnL (USD)' precision={2} value={Number(ov?.pnlUsd||0)} /></Card></Col>
        <Col xs={24} md={4}><Card loading={loading}><Statistic title='AI calls' value={Number(ov?.aiCallsTotal||0)} /></Card></Col>
        <Col xs={24} md={4}><Card loading={loading}><Statistic title='Avg Win Rate %' precision={2} value={Number(ov?.avgWinRate||0)} /></Card></Col>
      </Row>
      <Row gutter={[12,12]}>
        <Col xs={24} md={12}>
          <Card title='Recent Alerts' loading={loading} extra={<Button size='small' onClick={load}>Refresh</Button>}>
            <Space size='large' wrap style={{ marginBottom: 8 }}>
              <Tag color='red'>High: {ov?.alerts?.severityCounts?.high || 0}</Tag>
              <Tag color='orange'>Med: {ov?.alerts?.severityCounts?.med || 0}</Tag>
              <Tag color='blue'>Low: {ov?.alerts?.severityCounts?.low || 0}</Tag>
            </Space>
            <List size='small' dataSource={ov?.alerts?.recent || []}
              renderItem={(it:any)=> (
                <List.Item>
                  <Space>
                    <Tag color={it.severity==='high'?'red': it.severity==='med'?'orange':'blue'}>{it.kind}</Tag>
                    <span>{it.symbol || '-'}</span>
                    <span style={{ color:'#888' }}>{new Date(it.createdAt).toLocaleString()}</span>
                  </Space>
                </List.Item>
              )}
            />
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card title='Active symbols'>
            <Space wrap>
              {(ov?.symbols||[]).map((s:string)=> <Tag key={s}>{s}</Tag>)}
            </Space>
          </Card>
        </Col>
      </Row>
      <Row gutter={[12,12]}>
        <Col xs={24} md={12}>
          <Card loading={loading} title='Exchange (Live)'>
            <Space size='large' wrap>
              <Statistic title='Equity (USD)' value={Number(ov?.exchangeBalance?.totalUsd||0)} precision={2} />
              <Statistic title='Free (USD)' value={Number(ov?.exchangeBalance?.freeUsd||0)} precision={2} />
              <Statistic title='Used (USD)' value={Number(ov?.exchangeBalance?.usedUsd||0)} precision={2} />
            </Space>
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card loading={loading} title='Paper (Active)'>
            <Space size='large' wrap>
              <Statistic title='Equity (USD)' value={Number(ov?.paperBalance?.equityUsd||0)} precision={2} />
              <Statistic title='Free (USD)' value={Number(ov?.paperBalance?.freeUsd||0)} precision={2} />
              <Statistic title='Committed (USD)' value={Number(ov?.paperBalance?.committedUsd||0)} precision={2} />
            </Space>
          </Card>
        </Col>
      </Row>
      <Card title='Active sessions' extra={<Button size='small' onClick={load}>Refresh</Button>}>
        <Table rowKey='id' size='small' dataSource={ov?.sessions||[]} pagination={{ pageSize: 8 }}
          columns={[
            { title:'Symbol', dataIndex:'symbol' },
            { title:'Mode', dataIndex:'mode', render:(m:any)=> <Tag color={m==='live'?'gold':'blue'}>{String(m).toUpperCase()}</Tag> },
            { title:'State', dataIndex:'state' },
            { title:'Bias', dataIndex:'bias', render:(v:any)=> v? <Tag color={v==='long'?'green':'red'}>{v}</Tag> : '-' },
            { title:'ROI %', dataIndex:'roiPct', render:(v:any)=> Number(v||0).toFixed(2) },
            { title:'PnL (USD)', dataIndex:'pnlUsd', render:(v:any)=> Number(v||0).toFixed(2) },
            { title:'AI', dataIndex:'aiCalls' },
            { title:'Open qty', dataIndex:'openQty', render:(v:any)=> Number(v||0).toFixed(6) },
            { title:'Started', dataIndex:'startedAt', render:(v:any)=> new Date(v).toLocaleString() },
            { title:'', render:(_:any,r:any)=> <Button onClick={()=> navigate(`/monitor/${r.id}`)}>Open</Button> },
          ]}
        />
      </Card>
      <Card>
        <Space>
          <Button type='primary' onClick={()=> navigate('/sessions')}>Go to Sessions</Button>
          {/* Quick shortcut opens the first active session's monitor if present */}
          <Button onClick={()=> { const s = (ov?.sessions||[])[0]; if (s?.id) navigate(`/monitor/${s.id}`); }}>Open first monitor</Button>
        </Space>
      </Card>
    </Space>
  );
}

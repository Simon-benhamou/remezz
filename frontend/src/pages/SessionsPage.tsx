import React from 'react';
import { Card, Table, Tag, Button, Space, message } from 'antd';
import { api } from '../api';

export default function SessionsPage(){
  const [rows, setRows] = React.useState<any[]>([]);
  const load = async ()=>{ try { setRows(await api.listSessions()); } catch {} };
  React.useEffect(()=>{ load(); }, []);
  const stop = async (id:string)=>{
    // Only current active session can be stopped via main control; here we just hint
    message.info('Use Monitor > Stop to end the active session');
  };
  return (
    <Card title="Sessions">
      <Table rowKey="id" dataSource={rows} pagination={{ pageSize: 10 }}
        columns={[
          { title:'Symbol', dataIndex:'symbol' },
          { title:'Mode', dataIndex:'mode', render:(m)=> <Tag color={m==='live'?'gold':'blue'}>{String(m).toUpperCase()}</Tag> },
          { title:'Started', dataIndex:'startedAt', render:(v)=> new Date(v).toLocaleString() },
          { title:'Stopped', dataIndex:'stoppedAt', render:(v)=> v ? new Date(v).toLocaleString() : <Tag color='green'>ACTIVE</Tag> },
          { title:'Open pos', dataIndex:'openPositions' },
          { title:'', render:(_,r)=> !r.stoppedAt ? (<Space><Button danger onClick={()=> stop(r.id)}>Stop</Button></Space>) : null }
        ]} />
    </Card>
  );
}

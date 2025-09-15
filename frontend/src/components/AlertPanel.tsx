import React from 'react';
import { Card, List, Tag } from 'antd';
import { api } from '../api';

export default function AlertPanel({ sessionId }: { sessionId?: string }){
  const [items, setItems] = React.useState<any[]>([]);
  React.useEffect(()=>{
    if (!sessionId) return; let t:any;
    const load = async ()=> { try { setItems(await api.getAlerts(sessionId)); } catch {} };
    load(); t = setInterval(load, 10000); return ()=> clearInterval(t);
  }, [sessionId]);
  return (
    <Card title="Policy Alerts (recent)">
      <List size='small' dataSource={items}
        renderItem={(it:any)=> (
          <List.Item>
            <div style={{ display:'flex', gap:8, alignItems:'center' }}>
              <Tag color={it.severity==='high'?'red': it.severity==='med'?'orange':'blue'}>{it.kind}</Tag>
              <span>{new Date(it.ts).toLocaleTimeString()} — {it.symbol}</span>
            </div>
          </List.Item>
        )}
      />
    </Card>
  );
}


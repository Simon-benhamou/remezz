import React from 'react';
import { Card, Descriptions, List, Space, Statistic, DatePicker, Button, message } from 'antd';
import dayjs from 'dayjs';
import { api } from '../api';

export default function DailyReviewPanel({ sessionId }: { sessionId?: string }){
  const [date, setDate] = React.useState(dayjs());
  const [report, setReport] = React.useState<any>(null);
  const load = async (d: string) => { if (!sessionId) return; try { setReport(await api.getDailyReport(sessionId, d)); } catch {} };
  React.useEffect(()=>{ if (sessionId) load(date.format('YYYY-MM-DD')); }, [sessionId]);
  return (
    <Card title="Daily Review">
      <Space direction='vertical' style={{ width:'100%' }}>
        <Space>
          <DatePicker value={date} onChange={(v)=>{ if (!v) return; setDate(v); load(v.format('YYYY-MM-DD')); }} />
          <Button onClick={()=> load(date.format('YYYY-MM-DD'))}>Refresh</Button>
          {report && <Button type='primary' onClick={async ()=>{ try { await api.saveDailyReport(sessionId!, date.format('YYYY-MM-DD'), report); message.success('Saved'); } catch { message.error('Save failed'); } }}>Save</Button>}
        </Space>
        {report && (
          <>
            <Space size='large' wrap>
              <Statistic title='Trades' value={report?.stats?.trades||0} />
              <Statistic title='WinRate %' value={(report?.stats?.winRate||0)*100} precision={1} />
              <Statistic title='Avg Win %' value={report?.stats?.avgWin||0} precision={2} />
              <Statistic title='Avg Loss %' value={report?.stats?.avgLoss||0} precision={2} />
              <Statistic title='Expectancy %' value={report?.stats?.expectancy||0} precision={2} />
              <Statistic title='PnL (USD)' value={report?.stats?.pnlUsd||0} precision={2} />
            </Space>
            <Descriptions bordered size='small' column={1} style={{ marginTop: 12 }}>
              <Descriptions.Item label='Summary'>{report?.llm?.summary || '-'}</Descriptions.Item>
            </Descriptions>
            <Space align='start' style={{ width:'100%', marginTop: 12 }}>
              <Card title='What went well' style={{ flex:1 }}>
                <List size='small' dataSource={report?.llm?.what_went_well || []} renderItem={(it:any)=> <List.Item>{it}</List.Item>} />
              </Card>
              <Card title='Issues' style={{ flex:1 }}>
                <List size='small' dataSource={report?.llm?.issues || []} renderItem={(it:any)=> <List.Item>{it}</List.Item>} />
              </Card>
              <Card title='Suggestions' style={{ flex:1 }}>
                <List size='small' dataSource={report?.llm?.suggestions || []} renderItem={(it:any)=> <List.Item>{it}</List.Item>} />
              </Card>
            </Space>
          </>
        )}
      </Space>
    </Card>
  );
}

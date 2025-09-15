import React from 'react';
import { Card, Table, Tag, Space, Statistic } from 'antd';

type Stat = { n:number; wins:number; losses:number; avgWin:number; avgLoss:number; expectancy:number };

export default function PerfBreakdownPanel({ sessionId, api }: { sessionId?: string; api: any }){
  const [data, setData] = React.useState<any>(null);
  React.useEffect(()=>{ (async()=>{ try { if (sessionId) setData(await api.getPerfBreakdown(sessionId)); } catch{} })(); }, [sessionId]);
  const bySide = data?.bySide || { long: {}, short: {} };
  const columns = [
    { title:'Symbol', dataIndex:'symbol' },
    { title:'Trades', dataIndex:'n' },
    { title:'Win%', dataIndex:'winrate', render:(v:any)=> typeof v==='number'? v.toFixed(1):'-' },
    { title:'Avg Win %', dataIndex:'avgWin', render:(v:any)=> typeof v==='number'? v.toFixed(2):'-' },
    { title:'Avg Loss %', dataIndex:'avgLoss', render:(v:any)=> typeof v==='number'? v.toFixed(2):'-' },
    { title:'Expectancy %', dataIndex:'expectancy', render:(v:any)=> typeof v==='number'? v.toFixed(2):'-' },
  ];
  const rows = Object.entries(data?.bySymbol || {}).map(([symbol, s]: any)=>{
    const n = s.n || 0; const winrate = n? (s.wins/n)*100:0;
    return { key: symbol, symbol, n, winrate, avgWin: s.avgWin, avgLoss: s.avgLoss, expectancy: s.expectancy };
  });
  const color = (x:number)=> x>=0? '#1f8f1f':'#c0392b';
  const winr = (s:Stat)=> s.n? (s.wins/s.n)*100:0;
  return (
    <Card title="Performance Breakdown">
      <Space size="large" wrap style={{ marginBottom: 12 }}>
        <Statistic title={<span>All — Expectancy (%)</span>} value={data?.totals?.expectancy||0} precision={2} valueStyle={{ color: color(data?.totals?.expectancy||0) }} />
        <Statistic title={<span>Long — Win%</span>} value={winr(bySide.long||{})} precision={1} />
        <Statistic title={<span>Short — Win%</span>} value={winr(bySide.short||{})} precision={1} />
        <Tag>Sample: {data?.sample||0}</Tag>
      </Space>
      <Table size="small" columns={columns as any} dataSource={rows} pagination={{ pageSize: 5 }} />
    </Card>
  );
}


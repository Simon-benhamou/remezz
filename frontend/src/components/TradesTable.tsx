import React from 'react';
import { Card, Table, Tag } from 'antd';

export default function TradesTable({ rows = [] }: any) {
  const cols: any = [
    { title: 'Time', dataIndex: 'createdAt', render: (v:any)=> new Date(v).toLocaleString() },
    { title: 'Symbol', dataIndex: 'symbol' },
    { title: 'Direction', dataIndex: 'positionSide', render: (v:any)=> v? <Tag color={v==='long'?'green':'red'}>{v}</Tag> : '-' },
    { title: 'Qty', dataIndex: 'qty', render: (v:any)=> Number(v||0).toFixed(4) },
    { title: 'Entry', dataIndex: 'entryPrice', render: (v:any)=> v!=null ? Number(v).toFixed(4) : '-' },
    { title: 'Exit', dataIndex: 'exitPrice', render: (v:any)=> v!=null ? Number(v).toFixed(4) : '-' },
    { title: 'Est Lev', dataIndex: 'estLev', render: (v:any)=> v!=null ? `x${Number(v).toFixed(2)}` : '-' },
    { title: '% Change', dataIndex: 'pctChange', render: (v:any)=> v!=null ? `${Number(v).toFixed(2)}%` : '-' },
    { title: 'ROI est. (%)', dataIndex: 'roePct', render: (v:any)=> v!=null ? <span style={{ color: Number(v)>=0?'#1f8f1f':'#c0392b' }}>{Number(v).toFixed(2)}%</span> : '-' },
    { title: 'Realized PnL (USD)', dataIndex: 'realizedPnlUsd', render: (v:any)=> <span style={{ color: Number(v)>=0?'#1f8f1f':'#c0392b' }}>${Number(v||0).toFixed(2)}</span> },
    { title: 'Lev', dataIndex: 'leverage', render: (v:any)=> v? `x${v}`:'-' },
  ];
  return (
    <Card title="Trades">
      <Table rowKey="id" dataSource={rows} columns={cols} size="small" />
    </Card>
  );
}

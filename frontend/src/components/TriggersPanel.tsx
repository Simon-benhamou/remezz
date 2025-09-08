import React from "react";
import { Card, Table, Tag } from "antd";

function levelInfo(kind: string, payload: any){
  if (!payload) return { level: '-', value: '-' };
  if (kind.includes('support')) return { level: 'Support', value: (payload.support||0).toFixed?.(2) };
  if (kind.includes('resistance')) return { level: 'Resistance', value: (payload.resistance||0).toFixed?.(2) };
  if (kind.includes('pivot-S1')) return { level: 'Pivot S1', value: (payload.pivots?.S1||0).toFixed?.(2) };
  if (kind.includes('pivot-R1')) return { level: 'Pivot R1', value: (payload.pivots?.R1||0).toFixed?.(2) };
  return { level: '-', value: '-' };
}

export default function TriggersPanel({ rows = [] }: any) {
  const cols: any = [
    { title: "Time", dataIndex: "createdAt", render: (v: any) => new Date(v).toLocaleString() },
    { title: "Kind", dataIndex: "kind", render: (v:string)=> <Tag color={v.includes('support')? 'green': v.includes('resistance')? 'red': 'blue'}>{v}</Tag> },
    { title: "Symbol", dataIndex: "symbol" },
    { title: "Price", dataIndex: ["payload","price"], render: (v:any)=> v?.toFixed?.(2) ?? '-' },
    { title: "Level", render: (_:any, row:any)=> levelInfo(row.kind, row.payload).level },
    { title: "Level Value", render: (_:any, row:any)=> levelInfo(row.kind, row.payload).value },
  ];
  return (
    <Card title="Market Triggers">
      <Table rowKey="id" dataSource={rows} columns={cols} size="small" pagination={{ pageSize: 8 }} />
    </Card>
  );
}

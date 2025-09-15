import React from "react";
import { Card, Table, Tag } from "antd";
export default function OrdersTable({ rows = [] }: any) {
  const cols: any = [
    {
      title: "Time",
      dataIndex: "createdAt",
      render: (v: any) => new Date(v).toLocaleString(),
    },
    { title: "ClientID", dataIndex: "clientOrderId" },
    { title: "Symbol", dataIndex: "symbol" },
    {
      title: "Kind",
      dataIndex: "clientOrderId",
      render: (v: string) => (v && v.endsWith('.exit') ? <Tag>exit</Tag> : <Tag color="blue">entry</Tag>),
    },
    {
      title: "Side",
      dataIndex: "side",
      render: (v: any) => <Tag color={v === "buy" ? "green" : "red"}>{v}</Tag>,
    },
    {
      title: "Direction",
      dataIndex: "positionSide",
      render: (v: any) => v ? <Tag color={v === 'long' ? 'green' : 'red'}>{v}</Tag> : '-',
    },
    { title: "Type", dataIndex: "type" },
  { title: "Qty", dataIndex: "qty", render: (v:any)=> Number(v||0).toFixed(4) },
  { title: "Price", dataIndex: "price", render: (v:any)=> v!=null ? Number(v).toFixed(4) : '-' },
    {
      title: "Notional (USD)",
      render: (_: any, r: any) => {
        const v = (Number(r.qty) || 0) * (Number(r.price) || 0);
        return v ? `$${v.toFixed(2)}` : '-';
      },
    },
    {
      title: "Lev",
      dataIndex: "leverage",
      render: (v: any) => (v ? `x${v}` : '-'),
    },
    { title: "SL", dataIndex: "sl", render: (v:any)=> v!=null ? Number(v).toFixed(4) : '-' },
    { title: "TP", dataIndex: "tp", render: (v:any)=> v!=null ? Number(v).toFixed(4) : '-' },
    {
      title: "% Change",
      dataIndex: "pctChange",
      render: (v:any)=> v!=null ? `${Number(v).toFixed(2)}%` : '-',
    },
    {
      title: "ROI est. (%)",
      dataIndex: "roePct",
      render: (v:any, r:any)=>{
        if (!r.clientOrderId?.endsWith?.('.exit')) return '-';
        if (v==null) return '-';
        const val = Number(v||0);
        const color = val>=0? '#1f8f1f':'#c0392b';
        return <span style={{ color }}>{val.toFixed(2)}%</span>;
      }
    },
    {
      title: "Realized PnL (USD)",
      dataIndex: "realizedPnlUsd",
      render: (v:any, r:any)=>{
        const val = Number(v||0);
        if (!r.clientOrderId?.endsWith?.('.exit')) return '-';
        const color = val>=0? '#1f8f1f':'#c0392b';
        return <span style={{ color }}>${val.toFixed(2)}</span>;
      }
    },
    { title: "Status", dataIndex: "status" },
  ];
  return (
    <Card title="Orders">
      <Table rowKey="id" dataSource={rows} columns={cols} size="small" />
    </Card>
  );
}

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
    { title: "Type", dataIndex: "type" },
    { title: "Qty", dataIndex: "qty" },
    { title: "Price", dataIndex: "price" },
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
    { title: "SL", dataIndex: "sl" },
    { title: "TP", dataIndex: "tp" },
    { title: "Status", dataIndex: "status" },
  ];
  return (
    <Card title="Orders">
      <Table rowKey="id" dataSource={rows} columns={cols} size="small" />
    </Card>
  );
}

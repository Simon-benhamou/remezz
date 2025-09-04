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
      title: "Side",
      dataIndex: "side",
      render: (v: any) => <Tag color={v === "buy" ? "green" : "red"}>{v}</Tag>,
    },
    { title: "Type", dataIndex: "type" },
    { title: "Qty", dataIndex: "qty" },
    { title: "Price", dataIndex: "price" },
    { title: "SL", dataIndex: "sl" },
    { title: "TP", dataIndex: "tp" },
    { title: "Status", dataIndex: "status" },
  ];
  return (
    <Card title="Orders (journal)">
      <Table rowKey="id" dataSource={rows} columns={cols} size="small" />
    </Card>
  );
}

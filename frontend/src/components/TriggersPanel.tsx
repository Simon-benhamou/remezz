import React from "react";
import { Card, Table } from "antd";
export default function TriggersPanel({ rows = [] }: any) {
  const cols: any = [
    {
      title: "Time",
      dataIndex: "createdAt",
      render: (v: any) => new Date(v).toLocaleString(),
    },
    { title: "Kind", dataIndex: "kind" },
    { title: "Symbol", dataIndex: "symbol" },
    {
      title: "Payload",
      dataIndex: "payload",
      render: (v: any) => (
        <pre style={{ margin: 0 }}>{JSON.stringify(v, null, 2)}</pre>
      ),
    },
  ];
  return (
    <Card title="Triggers (marché)">
      <Table rowKey="id" dataSource={rows} columns={cols} size="small" />
    </Card>
  );
}

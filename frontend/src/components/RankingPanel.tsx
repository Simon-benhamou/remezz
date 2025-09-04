import React from "react";
import { Card, Table, Button } from "antd";
export default function RankingPanel({ rows = [], onPick }: any) {
  const cols: any = [
    { title: "Symbol", dataIndex: "symbol" },
    {
      title: "Score",
      dataIndex: "score",
      render: (v: any) => v?.toFixed?.(3) ?? v,
    },
    {
      title: "Actions",
      render: (_: any, row: any) => (
        <Button onClick={() => onPick?.(row.symbol)}>Choisir & Générer</Button>
      ),
    },
  ];
  return (
    <Card title="Top Perps (IA Ranking)">
      <Table
        rowKey="symbol"
        dataSource={rows}
        columns={cols}
        size="small"
        pagination={false}
      />
    </Card>
  );
}

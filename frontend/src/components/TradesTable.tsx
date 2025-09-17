import React from 'react';
import { Card, Table, Tag, Tooltip } from 'antd';

export default function TradesTable({ rows = [] }: any) {
  const cols: any = [
    { title: <Tooltip title="Horodatage de la clôture du trade">Time</Tooltip>, dataIndex: 'createdAt', render: (v:any)=> new Date(v).toLocaleString() },
    { title: <Tooltip title="Marché concerné par le trade">Symbol</Tooltip>, dataIndex: 'symbol' },
    { title: <Tooltip title="Orientation de la position tenue">Direction</Tooltip>, dataIndex: 'positionSide', render: (v:any)=> v? <Tag color={v==='long'?'green':'red'}>{v}</Tag> : '-' },
    { title: <Tooltip title="Quantité totale clôturée">Qty</Tooltip>, dataIndex: 'qty', render: (v:any)=> Number(v||0).toFixed(4) },
    { title: <Tooltip title="Prix d'entrée moyen du trade">Entry</Tooltip>, dataIndex: 'entryPrice', render: (v:any)=> v!=null ? Number(v).toFixed(4) : '-' },
    { title: <Tooltip title="Prix de sortie moyen du trade">Exit</Tooltip>, dataIndex: 'exitPrice', render: (v:any)=> v!=null ? Number(v).toFixed(4) : '-' },
    { title: <Tooltip title="Levier estimé utilisé durant le trade">Est Lev</Tooltip>, dataIndex: 'estLev', render: (v:any)=> v!=null ? `x${Number(v).toFixed(2)}` : '-' },
    { title: <Tooltip title="Variation en pourcentage du trade">% Change</Tooltip>, dataIndex: 'pctChange', render: (v:any)=> v!=null ? `${Number(v).toFixed(2)}%` : '-' },
    { title: <Tooltip title="Retour sur investissement estimé (prend en compte le levier)">ROI est. (%)</Tooltip>, dataIndex: 'roePct', render: (v:any)=> v!=null ? <span style={{ color: Number(v)>=0?'#1f8f1f':'#c0392b' }}>{Number(v).toFixed(2)}%</span> : '-' },
    { title: <Tooltip title="Profit ou perte effectivement réalisé en USD">Realized PnL (USD)</Tooltip>, dataIndex: 'realizedPnlUsd', render: (v:any)=> <span style={{ color: Number(v)>=0?'#1f8f1f':'#c0392b' }}>${Number(v||0).toFixed(2)}</span> },
    { title: <Tooltip title="Levier demandé lors de l'exécution">Lev</Tooltip>, dataIndex: 'leverage', render: (v:any)=> v? `x${v}`:'-' },
  ];
  return (
    <Card title="Trades">
      <Table rowKey="id" dataSource={rows} columns={cols} size="small" />
    </Card>
  );
}

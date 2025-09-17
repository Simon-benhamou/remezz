import React from "react";
import { Card, Table, Tag, Tooltip } from "antd";
export default function OrdersTable({ rows = [] }: any) {
  const cols: any = [
    {
      title: <Tooltip title="Horodatage d'exécution de l'ordre (heure locale)">Time</Tooltip>,
      dataIndex: "createdAt",
      render: (v: any) => new Date(v).toLocaleString(),
    },
    { title: <Tooltip title="Identifiant interne de l'ordre envoyé par l'agent">ClientID</Tooltip>, dataIndex: "clientOrderId" , style:{maxWidth: '150px'} },
    { title: <Tooltip title="Marché traité (base/quote)">Symbol</Tooltip>, dataIndex: "symbol" },
    {
      title: <Tooltip title="Type d'ordre : entrée ou sortie">Kind</Tooltip>,
      dataIndex: "clientOrderId",
      render: (v: string) => (v && v.endsWith('.exit') ? <Tag>exit</Tag> : <Tag color="blue">entry</Tag>),
    },
    {
      title: <Tooltip title="Sens de l'opération (achat = long, vente = short)">Side</Tooltip>,
      dataIndex: "side",
      render: (v: any) => <Tag color={v === "buy" ? "green" : "red"}>{v}</Tag>,
    },
    {
      title: <Tooltip title="Direction de position après exécution (long ou short)">Direction</Tooltip>,
      dataIndex: "positionSide",
      render: (v: any) => v ? <Tag color={v === 'long' ? 'green' : 'red'}>{v}</Tag> : '-',
    },
    { title: <Tooltip title="Nature de l'ordre envoyé à l'échange (market, limit, etc.)">Type</Tooltip>, dataIndex: "type" },
  { title: <Tooltip title="Quantité d'actif traitée">Qty</Tooltip>, dataIndex: "qty", render: (v:any)=> Number(v||0).toFixed(4) },
  { title: <Tooltip title="Prix d'exécution de l'ordre">Price</Tooltip>, dataIndex: "price", render: (v:any)=> v!=null ? Number(v).toFixed(4) : '-' },
    {
      title: <Tooltip title="Valeur notionnelle = quantité × prix, exprimée en USD">Notional (USD)</Tooltip>,
      render: (_: any, r: any) => {
        const v = (Number(r.qty) || 0) * (Number(r.price) || 0);
        return v ? `$${v.toFixed(2)}` : '-';
      },
    },
    {
      title: <Tooltip title="Levier estimé, compte tenu du budget autorisé">Est Lev</Tooltip>,
      dataIndex: "estLev",
      render: (v:any)=> v!=null ? `x${Number(v).toFixed(2)}` : '-',
    },
    {
      title: <Tooltip title="Levier demandé à l'échange pour cet ordre">Lev</Tooltip>,
      dataIndex: "leverage",
      render: (v: any) => (v ? `x${v}` : '-'),
    },
    { title: <Tooltip title="Prix de stop-loss transmis à l'échange">SL</Tooltip>, dataIndex: "sl", render: (v:any)=> v!=null ? Number(v).toFixed(4) : '-' },
    { title: <Tooltip title="Prix de take-profit transmis à l'échange">TP</Tooltip>, dataIndex: "tp", render: (v:any)=> v!=null ? Number(v).toFixed(4) : '-' },
    {
      title: <Tooltip title="Variation en pourcentage entre l'entrée et la sortie">% Change</Tooltip>,
      dataIndex: "pctChange",
      render: (v:any)=> v!=null ? `${Number(v).toFixed(2)}%` : '-',
    },
    {
      title: <Tooltip title="Retour sur investissement estimé, en tenant compte du levier">ROI est. (%)</Tooltip>,
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
      title: <Tooltip title="Profit ou perte réellement cristallisé lors de cette sortie">Realized PnL (USD)</Tooltip>,
      dataIndex: "realizedPnlUsd",
      render: (v:any, r:any)=>{
        const val = Number(v||0);
        if (!r.clientOrderId?.endsWith?.('.exit')) return '-';
        const color = val>=0? '#1f8f1f':'#c0392b';
        return <span style={{ color }}>${val.toFixed(2)}</span>;
      }
    },
    { title: <Tooltip title="Statut rapporté par l'échange (filled, canceled, etc.)">Status</Tooltip>, dataIndex: "status" },
  ];
  return (
    <Card title="Orders">
      <Table rowKey="id" dataSource={rows} columns={cols} size="small" />
    </Card>
  );
}

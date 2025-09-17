import React from 'react';
import { Card, Table, Tag, Tooltip } from 'antd';
import dayjs from 'dayjs';

type Props = {
  rows?: any[];
  loading?: boolean;
  onRefresh?: () => void;
};

export default function OpsLLMPanel({ rows = [], loading, onRefresh }: Props) {
  const columns = [
    { title: <Tooltip title="Horodatage de l'appel IA">Time</Tooltip>, dataIndex: 'createdAt', render: (v: string) => dayjs(v).format('HH:mm:ss') },
    { title: <Tooltip title="Type de requête (plan, stratégie, audit...)">Kind</Tooltip>, dataIndex: 'kind', render: (v: string) => v ? <Tag color="blue">{v}</Tag> : '-' },
    { title: <Tooltip title="Modèle LLM utilisé">Model</Tooltip>, dataIndex: 'model', render: (v: string, r: any) => <Tag color={r.provider === 'openai' ? 'geekblue' : 'purple'}>{v || r.provider}</Tag> },
    { title: <Tooltip title="Tokens consommés (entrée/sortie)">Tokens</Tooltip>, render: (_: any, r: any) => `${r.tokensIn ?? 0}/${r.tokensOut ?? 0}` },
    { title: <Tooltip title="Coût estimé en USD">Cost</Tooltip>, dataIndex: 'costUsd', render: (v: number) => v ? `$${v.toFixed(4)}` : '-' },
    { title: <Tooltip title="Plan récupéré du cache ?">Cached</Tooltip>, dataIndex: 'cached', render: (v: boolean) => v ? <Tag color="green">yes</Tag> : <Tag>no</Tag> },
    { title: <Tooltip title="Erreur éventuelle remontée par le LLM">Error</Tooltip>, dataIndex: 'error', render: (v: string) => v ? <Tag color="red">{v.slice(0, 32)}{v.length > 32 ? '…' : ''}</Tag> : '-' },
  ];

  return (
    <Card
      title={<Tooltip title="Journal des appels IA (prompts et réponses)">AI Prompt Log</Tooltip>}
      loading={loading}
      style={{ borderRadius: 12 }}
      extra={onRefresh ? <a onClick={onRefresh}>Refresh</a> : null}
    >
      <Table
        size="small"
        rowKey="id"
        dataSource={rows}
        columns={columns as any}
        pagination={{ pageSize: 10 }}
      />
    </Card>
  );
}

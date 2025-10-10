import React from 'react';
import { Card, Table, Tag, Space, Statistic, Tooltip } from 'antd';

type Stat = { n:number; wins:number; losses:number; avgWin:number; avgLoss:number; expectancy:number };

export default function PerfBreakdownPanel({ sessionId, api }: { sessionId?: string; api: any }){
  const [data, setData] = React.useState<any>(null);
  React.useEffect(()=>{ (async()=>{ try { if (sessionId) setData(await api.getPerfBreakdown(sessionId)); } catch{} })(); }, [sessionId]);
  const bySide = data?.bySide || { long: {}, short: {} };
  const adaptive = data?.adaptiveRisk;
  const columns = [
    { title: <Tooltip title="Marché concerné">Symbol</Tooltip>, dataIndex:'symbol' },
    { title: <Tooltip title="Nombre de trades sur ce symbole">Trades</Tooltip>, dataIndex:'n' },
    { title: <Tooltip title="Proportion de trades gagnants">Win%</Tooltip>, dataIndex:'winrate', render:(v:any)=> typeof v==='number'? v.toFixed(1):'-' },
    { title: <Tooltip title="Gain moyen sur les trades gagnants">Avg Win %</Tooltip>, dataIndex:'avgWin', render:(v:any)=> typeof v==='number'? v.toFixed(2):'-' },
    { title: <Tooltip title="Perte moyenne sur les trades perdants">Avg Loss %</Tooltip>, dataIndex:'avgLoss', render:(v:any)=> typeof v==='number'? v.toFixed(2):'-' },
    { title: <Tooltip title="Gain moyen par trade (positif ou négatif)">Expectancy %</Tooltip>, dataIndex:'expectancy', render:(v:any)=> typeof v==='number'? v.toFixed(2):'-' },
    { title: <Tooltip title="Sharpe calculé sur le symbole">Sharpe</Tooltip>, dataIndex:'sharpe', render:(v:any)=> typeof v==='number'? v.toFixed(2):'-' },
    { title: <Tooltip title="Max drawdown observé (en %)">Max DD %</Tooltip>, dataIndex:'maxDd', render:(v:any)=> typeof v==='number'? v.toFixed(2):'-' },
    { title: <Tooltip title="Multiplicateur de risque proposé pour ce symbole">Risk Multiplier</Tooltip>, dataIndex:'multiplier', render:(v:any)=> typeof v==='number'? v.toFixed(2):'-' },
  ];
  const rows = Object.entries(data?.bySymbol || {}).map(([symbol, s]: any)=>{
    const n = s.n || 0; const winrate = n? (s.wins/n)*100:0;
    const symbolRisk = adaptive?.symbolMultipliers?.[symbol];
    return {
      key: symbol,
      symbol,
      n,
      winrate,
      avgWin: s.avgWin,
      avgLoss: s.avgLoss,
      expectancy: s.expectancy,
      sharpe: symbolRisk?.sharpe,
      maxDd: symbolRisk?.maxDrawdownPct,
      multiplier: symbolRisk?.multiplier,
    };
  });
  const color = (x:number)=> x>=0? '#1f8f1f':'#c0392b';
  const winr = (s:Stat)=> s.n? (s.wins/s.n)*100:0;
  return (
    <Card title={<Tooltip title="Analyse détaillée des performances par direction et par symbole">Performance Breakdown</Tooltip>}>
      <Space size="large" wrap style={{ marginBottom: 12 }}>
        <Statistic title={<Tooltip title="Expectancy : gain moyen par trade, toutes directions confondues">All — Expectancy (%)</Tooltip>} value={data?.totals?.expectancy||0} precision={2} valueStyle={{ color: color(data?.totals?.expectancy||0) }} />
        <Statistic title={<Tooltip title="Taux de réussite sur les positions longues">Long — Win%</Tooltip>} value={winr(bySide.long||{})} precision={1} />
        <Statistic title={<Tooltip title="Taux de réussite sur les positions shorts">Short — Win%</Tooltip>} value={winr(bySide.short||{})} precision={1} />
        <Tooltip title="Nombre total de trades utilisés pour ces statistiques"><Tag>Sample: {data?.sample||0}</Tag></Tooltip>
        {adaptive ? (
          <>
            <Statistic title={<Tooltip title="Risque de base paramétré dans le profil">Base Risk %</Tooltip>} value={adaptive.baseRiskPct||0} precision={2} />
            <Statistic title={<Tooltip title="Risque proposé par le moteur adaptatif (après plafonnement)">Adaptive Risk %</Tooltip>} value={adaptive.riskPct||0} precision={2} valueStyle={{ color: adaptive.riskPct >= adaptive.baseRiskPct ? '#1f8f1f' : '#c0392b' }} />
            <Tooltip title="Multiplicateur symbolique appliqué sur la période récente">
              <Tag color={adaptive.appliedSymbolMultiplier > 1 ? 'green' : undefined}>
                Symbol Boost: ×{adaptive.appliedSymbolMultiplier?.toFixed ? adaptive.appliedSymbolMultiplier.toFixed(2) : adaptive.appliedSymbolMultiplier}
              </Tag>
            </Tooltip>
            {adaptive.dominantSymbol ? (
              <Tooltip title="Symbole le plus performant utilisé pour ce boost">
                <Tag color="blue">Focus: {adaptive.dominantSymbol}</Tag>
              </Tooltip>
            ) : null}
          </>
        ) : null}
      </Space>
      <Table size="small" columns={columns as any} dataSource={rows} pagination={{ pageSize: 5 }} />
    </Card>
  );
}

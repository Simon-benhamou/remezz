import React from 'react';
import { Card, Col, Row, Statistic, Tooltip, Tag, Space } from 'antd';

type Props = {
  agent?: any;
  price?: number;
};

export default function PositionStatsBlock({ agent, price }: Props) {
  const [now, setNow] = React.useState<number>(Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(id);
  }, []);

  const pos = agent?.pos;
  const plan = agent?.plan;
  if (!pos) {
    return (
      <Card title='Position stats'>
        <div style={{ color: '#666' }}>No active position yet. Stats will appear once the agent is in a trade.</div>
      </Card>
    );
  }

  const rawStopDistance = plan?.stopDistance || Math.abs(pos.entry - (pos.stop ?? pos.entry));
  const stopDistance = rawStopDistance && rawStopDistance !== 0 ? rawStopDistance : null;
  const dir = pos.side === 'buy' ? 1 : -1;
  const rNow = price != null && stopDistance ? (dir * (price - pos.entry)) / stopDistance : 0;
  const riskUsd = Math.abs((pos.stop ?? pos.entry) - pos.entry) * pos.qty;
  const pnlUsd = price != null ? dir * (price - pos.entry) * pos.qty : 0;
  const pnlPct = price != null && pos.entry ? (dir * (price - pos.entry) / pos.entry) * 100 : 0;
  const tpNext = Array.isArray(pos.tp) ? pos.tp[0] : undefined;
  const tpDistPct = price != null && tpNext != null && price !== 0 ? (Math.abs(tpNext - price) / Math.abs(price)) * 100 : null;
  const timeInMin = Math.max(0, Math.floor((now - (pos.openedAt || now)) / 60000));
  const maeR = pos.maeR != null ? Math.abs(pos.maeR) : 0;
  const mfeR = pos.mfeR != null ? Math.max(0, pos.mfeR) : 0;
  const rColor = rNow >= 0 ? '#1f8f1f' : '#c0392b';
  const protectionLabel = [pos.slOrderId ? 'SL' : '—', pos.tpOrderId ? 'TP' : '—'].join('/');
  const breakeven = pos.breakeven ?? pos.entry;

  return (
    <Card title='Position stats' extra={
      <Space size='small'>
        <Tag color={rNow >= 0 ? 'green' : 'red'}>{rNow >= 0 ? 'Gain' : 'Risk'}</Tag>
        <Tag color={pos.partialTaken ? 'blue' : 'default'}>{pos.partialTaken ? 'Partial taken' : 'Waiting partial'}</Tag>
      </Space>
    }>
      <Row gutter={[12, 12]}>
        <Col xs={12} md={6}><Statistic title={<Tooltip title='R multiple from entry based on stop distance'>Live R multiple</Tooltip>} value={rNow} precision={2} valueStyle={{ color: rColor }} /></Col>
        <Col xs={12} md={6}><Statistic title={<Tooltip title='Unrealized profit/loss in USD'>Unrealized PnL (USD)</Tooltip>} value={pnlUsd} precision={2} valueStyle={{ color: rColor }} /></Col>
        <Col xs={12} md={6}><Statistic title={<Tooltip title='Unrealized PnL in percent of entry'>Unrealized %</Tooltip>} value={pnlPct} precision={2} suffix='%' valueStyle={{ color: rColor }} /></Col>
        <Col xs={12} md={6}><Statistic title={<Tooltip title='Risk at stop in USD'>Risk @ SL (USD)</Tooltip>} value={riskUsd} precision={2} /></Col>
        <Col xs={12} md={6}><Statistic title={<Tooltip title='Minutes since entry fill'>Time in trade (min)</Tooltip>} value={timeInMin} /></Col>
        <Col xs={12} md={6}><Statistic title={<Tooltip title='Maximum adverse excursion since entry (in R)'>MAE (R)</Tooltip>} value={maeR} precision={2} /></Col>
        <Col xs={12} md={6}><Statistic title={<Tooltip title='Maximum favorable excursion since entry (in R)'>MFE (R)</Tooltip>} value={mfeR} precision={2} /></Col>
        <Col xs={12} md={6}><Statistic title={<Tooltip title='Distance from last price to the next take-profit level'>Next TP dist (%)</Tooltip>} value={tpDistPct ?? 0} precision={2} suffix='%' /></Col>
        <Col xs={12} md={6}><Statistic title={<Tooltip title='Break-even price (includes partial adjustments)'>Break-even</Tooltip>} value={breakeven} precision={4} /></Col>
        <Col xs={12} md={6}><Statistic title={<Tooltip title='Current protective orders that the exchange holds'>Protection</Tooltip>} value={protectionLabel} /></Col>
      </Row>
    </Card>
  );
}

import React from 'react';
import { Card, Tabs, Space, Statistic, Tag, Descriptions, Tooltip, Progress } from 'antd';

export default function AnalysisTabs({ analysis }: any){
  const technical = analysis?.technical;
  const sentiment = analysis?.sentiment;
  const indicators = analysis?.indicators;
  const news = analysis?.news;
  const projection = analysis?.projection;

  const techItems = (
    <Space size='large' wrap>
      <Statistic title={<Tooltip title="20-bar Exponential Moving Average. Rising suggests short-term uptrend.">EMA 20 (short trend)</Tooltip>} value={technical?.ema20} precision={2} />
      <Statistic title={<Tooltip title="50-bar Exponential Moving Average. Rising suggests medium-term uptrend.">EMA 50 (medium trend)</Tooltip>} value={technical?.ema50} precision={2} />
      <Statistic title={<Tooltip title="Relative Strength Index (14). 30–70 is typical; higher means stronger momentum.">RSI 14 (momentum)</Tooltip>} value={technical?.rsi14} precision={1} />
      <Statistic title={<Tooltip title="Average True Range as percent of price. Higher means more volatility.">ATR% (volatility)</Tooltip>} value={technical?.atrPct} precision={2} />
      <Statistic title={<Tooltip title="Average Directional Index (14). >20 indicates a stronger trend.">ADX 14 (trend strength)</Tooltip>} value={technical?.adx14} precision={1} />
      <div>
        <div style={{ fontSize:12, color:'#888' }}>
          <Tooltip title="Are we closer to support or resistance right now?">S/R bias</Tooltip>
        </div>
        <Tag color={technical?.srBias==='nearSupport'?'green': technical?.srBias==='nearResistance'?'red':'default'}>{technical?.srBias || '-'}</Tag>
      </div>
    </Space>
  );
  const srItems = (
    <Descriptions column={3} size='small' bordered>
      <Descriptions.Item label={<Tooltip title="Nearest key low area where buyers stepped in">Support</Tooltip>}>{technical?.support?.toFixed?.(4)}</Descriptions.Item>
      <Descriptions.Item label={<Tooltip title="Nearest key high area where sellers stepped in">Resistance</Tooltip>}>{technical?.resistance?.toFixed?.(4)}</Descriptions.Item>
      <Descriptions.Item label={<Tooltip title="Current price">Last</Tooltip>}>{technical?.last?.toFixed?.(4)}</Descriptions.Item>
    </Descriptions>
  );
  const piv = technical?.pivots;
  const pivotItems = (
    <Descriptions column={5} size='small' bordered>
      <Descriptions.Item label={<Tooltip title="Pivot Point: intraday reference midpoint">P</Tooltip>}>{piv?.P?.toFixed?.(4) ?? '-'}</Descriptions.Item>
      <Descriptions.Item label={<Tooltip title="First support below the pivot">S1</Tooltip>}>{piv?.S1?.toFixed?.(4) ?? '-'}</Descriptions.Item>
      <Descriptions.Item label={<Tooltip title="Second support below the pivot">S2</Tooltip>}>{piv?.S2?.toFixed?.(4) ?? '-'}</Descriptions.Item>
      <Descriptions.Item label={<Tooltip title="First resistance above the pivot">R1</Tooltip>}>{piv?.R1?.toFixed?.(4) ?? '-'}</Descriptions.Item>
      <Descriptions.Item label={<Tooltip title="Second resistance above the pivot">R2</Tooltip>}>{piv?.R2?.toFixed?.(4) ?? '-'}</Descriptions.Item>
    </Descriptions>
  );
  const biasColorMap: Record<string, string> = {
    bullish: '#16a34a',
    neutral: '#3b82f6',
    bearish: '#ef4444',
  };
  const projectionContent = projection ? (
    <Space direction='vertical' size='large' style={{ width: '100%' }}>
      <Space size='large' wrap>
        <Statistic title="Upside potential (24h)" value={projection?.rangeUpPct} suffix="%" precision={2} valueStyle={{ color: '#15803d' }} />
        <Statistic title="Downside potential (24h)" value={projection?.rangeDownPct} suffix="%" precision={2} valueStyle={{ color: '#b91c1c' }} />
        <Statistic title="Envelope half-range" value={(projection?.rangePct ?? 0) / 2} suffix="%" precision={2} />
        <Statistic title="Confidence" value={Math.round((projection?.confidence ?? 0) * 100)} suffix="%" precision={0} />
      </Space>
      <Space size='large' wrap>
        <Tag color={biasColorMap[projection?.biasDirection] || 'default'}>
          Bias: {projection?.biasDirection ?? 'neutral'} (score {projection?.biasScore?.toFixed?.(2) ?? 0})
        </Tag>
        <Tag color='cyan'>Upside target ≈ {projection?.rangeUpPrice?.toFixed?.(4) ?? '-'}</Tag>
        <Tag color='purple'>Downside target ≈ {projection?.rangeDownPrice?.toFixed?.(4) ?? '-'}</Tag>
      </Space>
      <div style={{ maxWidth: 360 }}>
        <Progress
          percent={Math.round((projection?.confidence ?? 0) * 100)}
          strokeColor={biasColorMap[projection?.biasDirection] || '#3b82f6'}
          showInfo
        />
      </div>
      {projection?.components && (
        <div>
          <b>Confidence components:</b>
          <ul>
            {Object.entries(projection.components).map(([key, val]) => (
              <li key={key}>{key}: {(Number(val) * 100).toFixed(0)}%</li>
            ))}
          </ul>
        </div>
      )}
      <details><summary>Raw JSON</summary><pre style={{ margin:0 }}>{JSON.stringify(projection, null, 2)}</pre></details>
    </Space>
  ) : <>No projection data available.</>;
  return (
    <Card>
      <Tabs
        items={[
          {
            key: 'technical',
            label: 'Technical',
            children: <div style={{ display:'grid', gap:16 }}>
              {techItems}
              {srItems}
              {pivotItems}
              <details><summary>Raw JSON</summary><pre style={{ margin:0 }}>{JSON.stringify(technical, null, 2)}</pre></details>
            </div>
          },
          {
            key: 'projection',
            label: 'Outlook (24h)',
            children: projectionContent
          },
          {
            key: 'sent',
            label: 'Sentiment (LLM)',
            children: sentiment ? (
              <div>
                <div><b>Label:</b> {sentiment.label} &nbsp; <b>Score:</b> {sentiment.score}</div>
                <ul>{(sentiment.bullets||[]).map((b:string, i:number)=><li key={i}>{b}</li>)}</ul>
              </div>
            ) : <>No data (LLM disabled or unavailable — using technicals only)</>
          },
          {
            key: 'news',
            label: 'News (LLM)',
            children: news ? (
              <div>
                <div>{news.summary}</div>
                <ul>{(news.bullets||[]).map((b:string, i:number)=><li key={i}>{b}</li>)}</ul>
              </div>
            ) : <>No data (LLM disabled or unavailable)</>
          },
        ]}
      />
    </Card>
  );
}

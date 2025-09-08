import React from 'react';
import { Card, Tabs, Space, Statistic, Tag, Descriptions, Tooltip } from 'antd';

export default function AnalysisTabs({ analysis }: any){
  const technical = analysis?.technical;
  const sentiment = analysis?.sentiment;
  const indicators = analysis?.indicators;
  const news = analysis?.news;

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
            key: 'sent',
            label: 'Sentiment (LLM)',
            children: sentiment ? (
              <div>
                <div><b>Label:</b> {sentiment.label} &nbsp; <b>Score:</b> {sentiment.score}</div>
                <ul>{(sentiment.bullets||[]).map((b:string, i:number)=><li key={i}>{b}</li>)}</ul>
              </div>
            ) : <>No data</>
          },
          {
            key: 'news',
            label: 'News (LLM)',
            children: news ? (
              <div>
                <div>{news.summary}</div>
                <ul>{(news.bullets||[]).map((b:string, i:number)=><li key={i}>{b}</li>)}</ul>
              </div>
            ) : <>No data</>
          },
        ]}
      />
    </Card>
  );
}

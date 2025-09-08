import React from 'react';
import { Card, Tabs, Space, Statistic, Tag, Descriptions } from 'antd';

export default function AnalysisTabs({ analysis }: any){
  const technical = analysis?.technical;
  const sentiment = analysis?.sentiment;
  const indicators = analysis?.indicators;
  const news = analysis?.news;

  const techItems = (
    <Space size='large' wrap>
      <Statistic title='EMA20' value={technical?.ema20} precision={2} />
      <Statistic title='EMA50' value={technical?.ema50} precision={2} />
      <Statistic title='RSI14' value={technical?.rsi14} precision={1} />
      <Statistic title='ATR%' value={technical?.atrPct} precision={2} />
      <Statistic title='ADX14' value={technical?.adx14} precision={1} />
      <div>
        <div style={{ fontSize:12, color:'#888' }}>SR bias</div>
        <Tag color={technical?.srBias==='nearSupport'?'green': technical?.srBias==='nearResistance'?'red':'default'}>{technical?.srBias || '-'}</Tag>
      </div>
    </Space>
  );
  const srItems = (
    <Descriptions column={3} size='small' bordered>
      <Descriptions.Item label='Support'>{technical?.support?.toFixed?.(2)}</Descriptions.Item>
      <Descriptions.Item label='Resistance'>{technical?.resistance?.toFixed?.(2)}</Descriptions.Item>
      <Descriptions.Item label='Last'>{technical?.last?.toFixed?.(2)}</Descriptions.Item>
    </Descriptions>
  );
  const piv = technical?.pivots;
  const pivotItems = (
    <Descriptions column={5} size='small' bordered>
      <Descriptions.Item label='P'>{piv?.P?.toFixed?.(2) ?? '-'}</Descriptions.Item>
      <Descriptions.Item label='S1'>{piv?.S1?.toFixed?.(2) ?? '-'}</Descriptions.Item>
      <Descriptions.Item label='S2'>{piv?.S2?.toFixed?.(2) ?? '-'}</Descriptions.Item>
      <Descriptions.Item label='R1'>{piv?.R1?.toFixed?.(2) ?? '-'}</Descriptions.Item>
      <Descriptions.Item label='R2'>{piv?.R2?.toFixed?.(2) ?? '-'}</Descriptions.Item>
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

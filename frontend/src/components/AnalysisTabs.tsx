import React from 'react';
import { Card, Tabs } from 'antd';

export default function AnalysisTabs({ analysis }: any){
  const technical = analysis?.technical;
  const sentiment = analysis?.sentiment;
  const indicators = analysis?.indicators;
  const news = analysis?.news;

  return (
    <Card>
      <Tabs
        items={[
          {
            key: 'tech',
            label: 'Technique',
            children: <pre style={{ margin:0 }}>{JSON.stringify(technical, null, 2)}</pre>
          },
          {
            key: 'sent',
            label: 'Sentiment (Grok)',
            children: sentiment ? (
              <div>
                <div><b>Label:</b> {sentiment.label} &nbsp; <b>Score:</b> {sentiment.score}</div>
                <ul>{(sentiment.bullets||[]).map((b:string, i:number)=><li key={i}>{b}</li>)}</ul>
              </div>
            ) : <>No data</>
          },
          {
            key: 'indi',
            label: 'Indicateurs',
            children: <pre style={{ margin:0 }}>{JSON.stringify(indicators, null, 2)}</pre>
          },
          {
            key: 'news',
            label: 'News (Grok)',
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

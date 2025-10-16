import React from 'react';
import { Card, Tabs, Space, Tag, Alert, Collapse, Typography, Progress, Row, Col } from 'antd';
import {
  BulbOutlined,
  FileTextOutlined,
  HeartOutlined,
  ArrowUpOutlined,
  BookOutlined,
  RobotOutlined,
} from '../icons';

const { Text, Paragraph } = Typography;
const { Panel } = Collapse;

interface SentimentData {
  score: number;
  label: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  factors?: string[];
}

interface NewsItem {
  title: string;
  impact: 'high' | 'medium' | 'low';
  sentiment: 'positive' | 'negative' | 'neutral';
  timestamp: string;
  summary?: string;
}

interface DailyReview {
  date: string;
  summary: string;
  highlights: string[];
  concerns: string[];
  recommendations: string[];
  performance_score: number;
}

interface AIInsightsProps {
  sentiment?: SentimentData;
  news?: NewsItem[];
  dailyReview?: DailyReview;
  style?: React.CSSProperties;
}

export default function AIInsightsCard({ 
  sentiment, 
  news = [], 
  dailyReview,
  style 
}: AIInsightsProps) {
  
  const getSentimentColor = (label: string) => {
    switch (label) {
      case 'bullish': return '#10b981';
      case 'bearish': return '#ef4444';
      case 'neutral': return '#6b7280';
      default: return '#6b7280';
    }
  };

  const getImpactColor = (impact: string) => {
    switch (impact) {
      case 'high': return 'error';
      case 'medium': return 'warning';
      case 'low': return 'default';
      default: return 'default';
    }
  };

  const tabItems = [
    {
      key: 'sentiment',
      label: (
        <Space>
          <HeartOutlined />
          <span>Sentiment</span>
          {sentiment && (
            <Tag color={sentiment.label === 'bullish' ? 'success' : sentiment.label === 'bearish' ? 'error' : 'default'}>
              {sentiment.label}
            </Tag>
          )}
        </Space>
      ),
      children: (
        <Space direction="vertical" style={{ width: '100%' }} size="small">
          {sentiment ? (
            <>
              <Row gutter={[16, 16]}>
                <Col span={12}>
                  <div style={{ textAlign: 'center', padding: '16px', background: '#f9fafb', borderRadius: 8 }}>
                    <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase', marginBottom: 4 }}>
                      Sentiment Score
                    </div>
                    <div style={{ 
                      fontSize: 24, 
                      fontWeight: 700, 
                      color: getSentimentColor(sentiment.label),
                      fontFamily: 'Monaco, monospace'
                    }}>
                      {sentiment.score.toFixed(1)}
                    </div>
                    <Tag color={sentiment.label === 'bullish' ? 'success' : sentiment.label === 'bearish' ? 'error' : 'default'}>
                      {sentiment.label.toUpperCase()}
                    </Tag>
                  </div>
                </Col>
                <Col span={12}>
                  <div style={{ textAlign: 'center', padding: '16px', background: '#f9fafb', borderRadius: 8 }}>
                    <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase', marginBottom: 4 }}>
                      Confidence
                    </div>
                    <Progress 
                      type="circle"
                      percent={sentiment.confidence}
                      size={60}
                      strokeColor={sentiment.confidence > 70 ? '#10b981' : sentiment.confidence > 50 ? '#f59e0b' : '#ef4444'}
                    />
                  </div>
                </Col>
              </Row>
              
              {sentiment.factors && sentiment.factors.length > 0 && (
                <div>
                  <Text strong style={{ fontSize: 12, color: '#374151' }}>Key Factors:</Text>
                  <Space direction="vertical" size={2} style={{ width: '100%', marginTop: 4 }}>
                    {sentiment.factors.map((factor, index) => (
                      <div key={index} style={{
                        padding: '6px 10px',
                        background: '#f9fafb',
                        borderRadius: 4,
                        fontSize: 11,
                        color: '#374151',
                        borderLeft: `3px solid ${getSentimentColor(sentiment.label)}`
                      }}>
                        • {factor}
                      </div>
                    ))}
                  </Space>
                </div>
              )}
            </>
          ) : (
            <Alert 
              type="info" 
              message="No sentiment data available" 
              description="Sentiment analysis will appear here when available"
              showIcon 
            />
          )}
        </Space>
      ),
    },
    {
      key: 'news',
      label: (
        <Space>
          <FileTextOutlined />
          <span>News</span>
          {news.length > 0 && (
            <Tag color="blue">{news.length}</Tag>
          )}
        </Space>
      ),
      children: (
        <Space direction="vertical" style={{ width: '100%' }} size="small">
          {news.length > 0 ? (
            news.slice(0, 5).map((item, index) => (
              <div key={index} style={{
                padding: '10px',
                background: '#f9fafb',
                borderRadius: 6,
                border: '1px solid #e5e7eb'
              }}>
                <Space style={{ width: '100%', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#111827', marginBottom: 4 }}>
                      {item.title}
                    </div>
                    {item.summary && (
                      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>
                        {item.summary}
                      </div>
                    )}
                    <div style={{ fontSize: 10, color: '#9ca3af' }}>
                      {new Date(item.timestamp).toLocaleString()}
                    </div>
                  </div>
                  <Space direction="vertical" size={2}>
                    <Tag color={getImpactColor(item.impact)}>
                      {item.impact}
                    </Tag>
                    <Tag color={item.sentiment === 'positive' ? 'success' : item.sentiment === 'negative' ? 'error' : 'default'}>
                      {item.sentiment}
                    </Tag>
                  </Space>
                </Space>
              </div>
            ))
          ) : (
            <Alert 
              type="info" 
              message="No recent news" 
              description="Market news analysis will appear here when available"
              showIcon 
            />
          )}
        </Space>
      ),
    },
    {
      key: 'review',
      label: (
        <Space>
          <BookOutlined />
          <span>Daily Review</span>
          {dailyReview && (
            <Tag color={dailyReview.performance_score > 70 ? 'success' : dailyReview.performance_score > 40 ? 'warning' : 'error'}>
              {dailyReview.performance_score}/100
            </Tag>
          )}
        </Space>
      ),
      children: (
        <Space direction="vertical" style={{ width: '100%' }} size="small">
          {dailyReview ? (
            <>
              <div style={{ 
                padding: '12px', 
                background: 'linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%)',
                borderRadius: 8,
                border: '1px solid #bae6fd'
              }}>
                <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontSize: 11, color: '#0369a1', fontWeight: 600 }}>
                      Performance Score
                    </div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: '#0284c7' }}>
                      {dailyReview.performance_score}/100
                    </div>
                  </div>
                  <Progress 
                    type="circle"
                    percent={dailyReview.performance_score}
                    size={50}
                    strokeColor={dailyReview.performance_score > 70 ? '#10b981' : dailyReview.performance_score > 40 ? '#f59e0b' : '#ef4444'}
                  />
                </Space>
              </div>

              <div style={{ fontSize: 12, color: '#374151', lineHeight: 1.5 }}>
                <Text strong>Summary:</Text>
                <Paragraph style={{ fontSize: 11, margin: '4px 0 8px 0' }}>
                  {dailyReview.summary}
                </Paragraph>
              </div>

              <Collapse ghost size="small">
                <Panel 
                  header={
                    <Space>
                      <Tag color="success">Highlights ({dailyReview.highlights.length})</Tag>
                    </Space>
                  } 
                  key="highlights"
                >
                  <Space direction="vertical" size={2} style={{ width: '100%' }}>
                    {dailyReview.highlights.map((highlight, index) => (
                      <div key={index} style={{
                        padding: '6px 10px',
                        background: '#ecfdf5',
                        borderRadius: 4,
                        fontSize: 11,
                        color: '#065f46',
                        borderLeft: '3px solid #10b981'
                      }}>
                        ✓ {highlight}
                      </div>
                    ))}
                  </Space>
                </Panel>
                
                <Panel 
                  header={
                    <Space>
                      <Tag color="warning">Concerns ({dailyReview.concerns.length})</Tag>
                    </Space>
                  } 
                  key="concerns"
                >
                  <Space direction="vertical" size={2} style={{ width: '100%' }}>
                    {dailyReview.concerns.map((concern, index) => (
                      <div key={index} style={{
                        padding: '6px 10px',
                        background: '#fffbeb',
                        borderRadius: 4,
                        fontSize: 11,
                        color: '#92400e',
                        borderLeft: '3px solid #f59e0b'
                      }}>
                        ⚠ {concern}
                      </div>
                    ))}
                  </Space>
                </Panel>
                
                <Panel 
                  header={
                    <Space>
                      <Tag color="blue">Recommendations ({dailyReview.recommendations.length})</Tag>
                    </Space>
                  } 
                  key="recommendations"
                >
                  <Space direction="vertical" size={2} style={{ width: '100%' }}>
                    {dailyReview.recommendations.map((rec, index) => (
                      <div key={index} style={{
                        padding: '6px 10px',
                        background: '#eff6ff',
                        borderRadius: 4,
                        fontSize: 11,
                        color: '#1e40af',
                        borderLeft: '3px solid #2563eb'
                      }}>
                        💡 {rec}
                      </div>
                    ))}
                  </Space>
                </Panel>
              </Collapse>
            </>
          ) : (
            <Alert 
              type="info" 
              message="No daily review available" 
              description="AI-generated daily performance review will appear here"
              showIcon 
            />
          )}
        </Space>
      ),
    },
  ];

  return (
    <Card 
      title={
        <Space>
          <RobotOutlined style={{ color: '#2563eb' }} />
          <span>🤖 AI Insights</span>
        </Space>
      }
      size="small"
      style={style}
    >
      <Tabs
        defaultActiveKey="sentiment"
        items={tabItems}
        size="small"
        style={{ minHeight: 200 }}
      />
    </Card>
  );
}

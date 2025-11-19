/**
 * Predictor Model Status Component
 * Displays predictor training history, feature importance, and accuracy metrics
 */

import React, { useState, useEffect } from 'react';
import { Card, Alert, Spin, Progress, Tag, Row, Col, Timeline } from 'antd';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, LineChart, Line } from 'recharts';
import { CheckCircleOutlined, ClockCircleOutlined, WarningOutlined } from '@ant-design/icons';
import { api } from '../../api';

interface TrainingHistory {
  trainedAt: string;
  sampleCount: number;
  crossValScore: number | null;
  trainingDurationMs: number;
  modelVersion: string;
}

interface FeatureImportance {
  feature: string;
  importance: number;
}

interface AccuracyByClass {
  long: { correct: number; total: number; accuracy: number };
  none: { correct: number; total: number; accuracy: number };
  short: { correct: number; total: number; accuracy: number };
}

interface Calibration {
  temperature: number;
  isCalibrated: boolean;
  lastCalibrationDate: string | null;
}

interface ModelMetadata {
  lastTrainingDate: string | null;
  trainingSamplesCount: number;
  modelVersion: string;
  trainingDurationMs: number;
  crossValScore: number | null;
}

interface PredictorStatusData {
  trainingHistory: TrainingHistory[];
  featureImportance: FeatureImportance[];
  accuracyByClass: AccuracyByClass;
  calibration: Calibration;
  modelMetadata: ModelMetadata;
  totalDecisionsLast30Days: number;
}

const PredictorModelStatus: React.FC = () => {
  const [data, setData] = useState<PredictorStatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchPredictorStatus();
  }, []);

  const fetchPredictorStatus = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await api.getPredictorStatus();
      setData(response);
    } catch (err) {
      console.error('Failed to fetch predictor status:', err);
      setError('Failed to load predictor model status');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <Card title="Predictor Model Status" style={{ marginTop: 20 }}>
        <div style={{ padding: '50px', textAlign: 'center' }}>
          <Spin size="large" />
          <p style={{ marginTop: 20 }}>Loading predictor status...</p>
        </div>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card title="Predictor Model Status" style={{ marginTop: 20 }}>
        <Alert message="Error" description={error || 'No data available'} type="error" showIcon />
      </Card>
    );
  }

  // Feature importance chart data (top 10 features)
  const featureChartData = data.featureImportance.slice(0, 10).map((f) => ({
    feature: f.feature.replace(/_/g, ' ').substring(0, 20), // truncate long names
    importance: (f.importance * 100).toFixed(2),
  }));

  // Training history chart data
  const trainingChartData = data.trainingHistory.slice(0, 7).reverse().map((t) => ({
    date: new Date(t.trainedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    samples: t.sampleCount,
    score: t.crossValScore ? (t.crossValScore * 100).toFixed(1) : null,
    duration: (t.trainingDurationMs / 1000).toFixed(1), // convert to seconds
  }));

  // Accuracy by class data
  const accuracyData = [
    { class: 'Long', accuracy: (data.accuracyByClass.long.accuracy * 100).toFixed(1), total: data.accuracyByClass.long.total },
    { class: 'None', accuracy: (data.accuracyByClass.none.accuracy * 100).toFixed(1), total: data.accuracyByClass.none.total },
    { class: 'Short', accuracy: (data.accuracyByClass.short.accuracy * 100).toFixed(1), total: data.accuracyByClass.short.total },
  ];

  const formatTimestamp = (timestamp: string | null) => {
    if (!timestamp) return 'Never';
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays > 0) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
    if (diffHours > 0) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    return 'Recently';
  };

  return (
    <div>
      <h3>Predictor Model Status</h3>

      {/* Model Metadata Cards */}
      <Row gutter={16} style={{ marginBottom: 20 }}>
        <Col span={6}>
          <Card>
            <div style={{ fontSize: 18, fontWeight: 'bold' }}>{data.modelMetadata.modelVersion || 'N/A'}</div>
            <div style={{ color: '#888', fontSize: 12 }}>Model Version</div>
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <div style={{ fontSize: 18, fontWeight: 'bold' }}>{formatTimestamp(data.modelMetadata.lastTrainingDate)}</div>
            <div style={{ color: '#888', fontSize: 12 }}>Last Training</div>
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <div style={{ fontSize: 18, fontWeight: 'bold' }}>{data.modelMetadata.trainingSamplesCount.toLocaleString()}</div>
            <div style={{ color: '#888', fontSize: 12 }}>Training Samples</div>
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <div style={{ fontSize: 18, fontWeight: 'bold' }}>{data.totalDecisionsLast30Days}</div>
            <div style={{ color: '#888', fontSize: 12 }}>Decisions (30d)</div>
          </Card>
        </Col>
      </Row>

      {/* Calibration Status */}
      <Card
        title="Calibration Status"
        style={{ marginBottom: 20 }}
        extra={
          data.calibration.isCalibrated ? (
            <Tag icon={<CheckCircleOutlined />} color="success">
              Calibrated
            </Tag>
          ) : (
            <Tag icon={<WarningOutlined />} color="warning">
              Not Calibrated
            </Tag>
          )
        }
      >
        <Row gutter={16}>
          <Col span={8}>
            <div style={{ fontSize: 14, color: '#888' }}>Temperature</div>
            <div style={{ fontSize: 20, fontWeight: 'bold' }}>{data.calibration.temperature.toFixed(2)}</div>
          </Col>
          <Col span={8}>
            <div style={{ fontSize: 14, color: '#888' }}>Last Calibration</div>
            <div style={{ fontSize: 20, fontWeight: 'bold' }}>{formatTimestamp(data.calibration.lastCalibrationDate)}</div>
          </Col>
          <Col span={8}>
            <div style={{ fontSize: 14, color: '#888' }}>Cross-Val Score</div>
            <div style={{ fontSize: 20, fontWeight: 'bold' }}>
              {data.modelMetadata.crossValScore ? `${(data.modelMetadata.crossValScore * 100).toFixed(1)}%` : 'N/A'}
            </div>
          </Col>
        </Row>
      </Card>

      <Row gutter={16}>
        {/* Feature Importance */}
        <Col span={12}>
          <Card title="Top Feature Importance">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={featureChartData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" />
                <YAxis type="category" dataKey="feature" width={150} />
                <Tooltip formatter={(value) => `${value}%`} />
                <Bar dataKey="importance" fill="#1890ff" />
              </BarChart>
            </ResponsiveContainer>
            <div style={{ marginTop: 10, fontSize: 12, color: '#888' }}>
              Shows the top 10 most important features used by the predictor model
            </div>
          </Card>
        </Col>

        {/* Accuracy by Class */}
        <Col span={12}>
          <Card title="Accuracy by Decision Class">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={accuracyData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="class" />
                <YAxis label={{ value: 'Accuracy (%)', angle: -90, position: 'insideLeft' }} />
                <Tooltip />
                <Bar dataKey="accuracy" fill="#52c41a">
                  {accuracyData.map((entry, index) => {
                    const acc = parseFloat(entry.accuracy);
                    const color = acc >= 60 ? '#52c41a' : acc >= 40 ? '#faad14' : '#f5222d';
                    return <rect key={index} fill={color} />;
                  })}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <div style={{ marginTop: 10, fontSize: 12, color: '#888' }}>
              Accuracy = decisions with confidence &gt; 0.6 | Total decisions: Long={accuracyData[0].total}, None=
              {accuracyData[1].total}, Short={accuracyData[2].total}
            </div>
          </Card>
        </Col>
      </Row>

      {/* Training History Timeline */}
      <Card title="Training History" style={{ marginTop: 20 }}>
        {data.trainingHistory.length > 0 ? (
          <>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={trainingChartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis yAxisId="left" />
                <YAxis yAxisId="right" orientation="right" />
                <Tooltip />
                <Legend />
                <Line yAxisId="left" type="monotone" dataKey="samples" stroke="#1890ff" strokeWidth={2} name="Sample Count" />
                <Line yAxisId="right" type="monotone" dataKey="score" stroke="#52c41a" strokeWidth={2} name="CV Score (%)" />
              </LineChart>
            </ResponsiveContainer>
            <Timeline style={{ marginTop: 20 }}>
              {data.trainingHistory.slice(0, 5).map((t, idx) => (
                <Timeline.Item
                  key={idx}
                  dot={idx === 0 ? <ClockCircleOutlined style={{ fontSize: 16 }} /> : undefined}
                  color={idx === 0 ? 'green' : 'gray'}
                >
                  <div>
                    <strong>{formatTimestamp(t.trainedAt)}</strong> - {t.modelVersion}
                  </div>
                  <div style={{ fontSize: 12, color: '#888' }}>
                    {t.sampleCount.toLocaleString()} samples | {(t.trainingDurationMs / 1000).toFixed(1)}s training |{' '}
                    {t.crossValScore ? `${(t.crossValScore * 100).toFixed(1)}% CV score` : 'No CV score'}
                  </div>
                </Timeline.Item>
              ))}
            </Timeline>
          </>
        ) : (
          <Alert message="No training history available" type="info" showIcon />
        )}
      </Card>
    </div>
  );
};

export default PredictorModelStatus;

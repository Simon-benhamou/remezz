/**
 * Portfolio View Page
 * Displays portfolio correlation matrix, risk distribution, and leverage usage
 */

import React, { useState, useEffect } from 'react';
import { Card, Row, Col, Alert, Spin, Table, Progress, Tag } from 'antd';
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { api } from '../api';

interface CorrelationData {
  matrix: {
    symbol1: string;
    symbol2: string;
    correlation: number;
  }[];
  portfolioHeat: number;
  hedgingRecommendations: string[];
}

interface RiskDistribution {
  bySymbol: {
    symbol: string;
    riskAmount: number;
    positionValue: number;
    leverage: number;
    stopDistance: number;
    portfolioRiskPercent: number;
  }[];
  leverageDistribution: {
    leverage: number;
    count: number;
    totalValue: number;
  }[];
  totalPortfolioValue: number;
  totalRiskAmount: number;
  avgLeverage: number;
}

const PortfolioViewPage: React.FC = () => {
  const [correlationData, setCorrelationData] = useState<CorrelationData | null>(null);
  const [riskData, setRiskData] = useState<RiskDistribution | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchPortfolioData();
  }, []);

  const fetchPortfolioData = async () => {
    try {
      setLoading(true);
      setError(null);
      const [correlation, risk] = await Promise.all([
        api.getPortfolioCorrelation(),
        api.getPortfolioRiskDistribution(),
      ]);
      setCorrelationData(correlation);
      setRiskData(risk);
    } catch (err) {
      console.error('Failed to fetch portfolio data:', err);
      setError('Failed to load portfolio data');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: '50px', textAlign: 'center' }}>
        <Spin size="large" />
        <p style={{ marginTop: 20 }}>Loading portfolio data...</p>
      </div>
    );
  }

  if (error || !correlationData || !riskData) {
    return (
      <div style={{ padding: 20 }}>
        <Alert message="Error" description={error || 'No data available'} type="error" showIcon />
      </div>
    );
  }

  // Check if matrix data is available
  if (!correlationData.matrix || !Array.isArray(correlationData.matrix) || correlationData.matrix.length === 0) {
    return (
      <div style={{ padding: 20 }}>
        <Alert 
          message="No Portfolio Data" 
          description="No active positions to display correlation data. Create some agents with positions to see portfolio analytics." 
          type="info" 
          showIcon 
        />
      </div>
    );
  }

  // Build correlation matrix for heatmap visualization
  const symbols = [...new Set(correlationData.matrix.flatMap((m) => [m.symbol1, m.symbol2]))];
  const matrixData = symbols.map((sym1) => {
    const row: any = { symbol: sym1 };
    symbols.forEach((sym2) => {
      if (sym1 === sym2) {
        row[sym2] = 1.0;
      } else {
        const entry = correlationData.matrix.find(
          (m) => (m.symbol1 === sym1 && m.symbol2 === sym2) || (m.symbol1 === sym2 && m.symbol2 === sym1)
        );
        row[sym2] = entry ? entry.correlation : 0;
      }
    });
    return row;
  });

  // Correlation color scale
  const getCorrelationColor = (value: number) => {
    if (value > 0.7) return '#f5222d'; // strong positive (red = risk)
    if (value > 0.4) return '#faad14'; // moderate positive (orange)
    if (value > 0.1) return '#52c41a'; // weak positive (green = diversified)
    if (value > -0.1) return '#1890ff'; // near zero (blue)
    return '#722ed1'; // negative correlation (purple = hedge)
  };

  // Risk distribution pie chart data
  const riskPieData = riskData.bySymbol.map((r) => ({
    name: r.symbol,
    value: parseFloat(r.portfolioRiskPercent.toFixed(2)),
  }));

  const COLORS = ['#1890ff', '#52c41a', '#faad14', '#f5222d', '#722ed1', '#13c2c2', '#eb2f96'];

  // Leverage distribution bar chart data
  const leverageBarData = riskData.leverageDistribution.map((l) => ({
    leverage: `${l.leverage}x`,
    count: l.count,
    totalValue: l.totalValue.toFixed(0),
  }));

  // Risk table columns
  const riskColumns = [
    {
      title: 'Symbol',
      dataIndex: 'symbol',
      key: 'symbol',
      render: (text: string) => <strong>{text}</strong>,
    },
    {
      title: 'Leverage',
      dataIndex: 'leverage',
      key: 'leverage',
      render: (lev: number) => (
        <Tag color={lev >= 10 ? 'red' : lev >= 5 ? 'orange' : 'green'}>{lev}x</Tag>
      ),
    },
    {
      title: 'Position Value',
      dataIndex: 'positionValue',
      key: 'positionValue',
      render: (val: number) => `$${val.toFixed(2)}`,
    },
    {
      title: 'Risk Amount',
      dataIndex: 'riskAmount',
      key: 'riskAmount',
      render: (val: number) => <span style={{ color: '#f5222d' }}>${val.toFixed(2)}</span>,
    },
    {
      title: 'Stop Distance',
      dataIndex: 'stopDistance',
      key: 'stopDistance',
      render: (val: number) => `${(val * 100).toFixed(2)}%`,
    },
    {
      title: 'Portfolio Risk %',
      dataIndex: 'portfolioRiskPercent',
      key: 'portfolioRiskPercent',
      render: (val: number) => (
        <Progress
          percent={parseFloat(val.toFixed(1))}
          size="small"
          status={val > 3 ? 'exception' : val > 2 ? 'active' : 'success'}
        />
      ),
    },
  ];

  return (
    <div style={{ padding: 20 }}>
      <h2>Portfolio View</h2>

      {/* Summary Cards */}
      <Row gutter={16} style={{ marginBottom: 20 }}>
        <Col span={6}>
          <Card>
            <div style={{ fontSize: 24, fontWeight: 'bold' }}>${riskData.totalPortfolioValue.toFixed(2)}</div>
            <div style={{ color: '#888' }}>Total Portfolio Value</div>
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <div style={{ fontSize: 24, fontWeight: 'bold', color: '#f5222d' }}>${riskData.totalRiskAmount.toFixed(2)}</div>
            <div style={{ color: '#888' }}>Total Risk Amount</div>
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <div style={{ fontSize: 24, fontWeight: 'bold' }}>{riskData.avgLeverage.toFixed(1)}x</div>
            <div style={{ color: '#888' }}>Average Leverage</div>
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <div
              style={{
                fontSize: 24,
                fontWeight: 'bold',
                color: correlationData.portfolioHeat > 0.6 ? '#f5222d' : correlationData.portfolioHeat > 0.4 ? '#faad14' : '#52c41a',
              }}
            >
              {(correlationData.portfolioHeat * 100).toFixed(1)}%
            </div>
            <div style={{ color: '#888' }}>Portfolio Heat</div>
          </Card>
        </Col>
      </Row>

      {/* Hedging Recommendations */}
      {correlationData.hedgingRecommendations.length > 0 && (
        <Alert
          message="Hedging Recommendations"
          description={
            <ul style={{ marginBottom: 0 }}>
              {correlationData.hedgingRecommendations.map((rec, idx) => (
                <li key={idx}>{rec}</li>
              ))}
            </ul>
          }
          type="warning"
          showIcon
          style={{ marginBottom: 20 }}
        />
      )}

      {/* Correlation Matrix Heatmap */}
      <Card title="Correlation Matrix" style={{ marginBottom: 20 }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th style={{ padding: 8, border: '1px solid #ddd' }}></th>
                {symbols.map((sym) => (
                  <th key={sym} style={{ padding: 8, border: '1px solid #ddd', fontWeight: 'bold' }}>
                    {sym}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrixData.map((row) => (
                <tr key={row.symbol}>
                  <td style={{ padding: 8, border: '1px solid #ddd', fontWeight: 'bold' }}>{row.symbol}</td>
                  {symbols.map((sym) => {
                    const value = row[sym] as number;
                    return (
                      <td
                        key={sym}
                        style={{
                          padding: 8,
                          border: '1px solid #ddd',
                          backgroundColor: getCorrelationColor(value),
                          color: 'white',
                          textAlign: 'center',
                          fontWeight: 'bold',
                        }}
                      >
                        {value.toFixed(2)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 15, fontSize: 12, color: '#888' }}>
          Color scale: Red (&gt;0.7) = High correlation risk | Orange (0.4-0.7) = Moderate | Green (0.1-0.4) = Diversified | Blue
          (-0.1 to 0.1) = Uncorrelated | Purple (&lt;-0.1) = Hedge
        </div>
      </Card>

      <Row gutter={16}>
        {/* Risk Distribution Pie Chart */}
        <Col span={12}>
          <Card title="Risk Distribution by Symbol">
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie data={riskPieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={100} label>
                  {riskPieData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(value) => `${value}%`} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </Card>
        </Col>

        {/* Leverage Usage Bar Chart */}
        <Col span={12}>
          <Card title="Leverage Distribution">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={leverageBarData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="leverage" />
                <YAxis label={{ value: 'Position Count', angle: -90, position: 'insideLeft' }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="count" fill="#1890ff" />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </Col>
      </Row>

      {/* Risk Details Table */}
      <Card title="Position Risk Details" style={{ marginTop: 20 }}>
        <Table dataSource={riskData.bySymbol} columns={riskColumns} rowKey="symbol" pagination={false} size="small" />
      </Card>
    </div>
  );
};

export default PortfolioViewPage;

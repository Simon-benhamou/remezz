import React, { useEffect, useState } from 'react';
import { Card, Row, Col, Statistic, Table, Select, Spin, Typography, Space, Tag } from 'antd';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { 
  StrategyPerformanceResponse,
  DetailedStrategyResponse,
  HeatmapResponse,
  STRATEGY_COLORS,
  STRATEGY_LABELS,
  StrategyType,
} from '../types/strategy';
import StrategyBadge from './StrategyBadge';
import { TrophyOutlined, RiseOutlined, FallOutlined } from '@ant-design/icons';
import { api } from '../api';

const { Title, Text } = Typography;
const { Option } = Select;

interface StrategyPerformanceDashboardProps {
  apiBaseUrl: string;
}

export default function StrategyPerformanceDashboard({ apiBaseUrl }: StrategyPerformanceDashboardProps) {
  const [loading, setLoading] = useState(false);
  const [days, setDays] = useState(30);
  const [summary, setSummary] = useState<StrategyPerformanceResponse | null>(null);
  const [detailed, setDetailed] = useState<DetailedStrategyResponse | null>(null);
  const [heatmap, setHeatmap] = useState<HeatmapResponse | null>(null);

  useEffect(() => {
    loadData();
  }, [days]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [summaryRes, detailedRes, heatmapRes] = await Promise.all([
        api.getStrategyPerformanceSummary(days),
        api.getStrategyPerformanceDetailed(days),
        api.getStrategyPerformanceHeatmap(days),
      ]);

      setSummary(summaryRes);
      setDetailed(detailedRes);
      setHeatmap(heatmapRes);
    } catch (error) {
      console.error('Error loading strategy performance:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading || !summary || !detailed || !heatmap) {
    return (
      <div style={{ textAlign: 'center', padding: '50px' }}>
        <Spin size="large" />
      </div>
    );
  }

  // Stats globales (with safety checks for empty data)
  const totalTrades = summary.global.reduce((sum, s) => sum + (s.totalTrades || 0), 0);
  const totalPnl = summary.global.reduce((sum, s) => sum + (s.totalPnlUsd || 0), 0);
  const avgWinRate = summary.global.length > 0
    ? summary.global.reduce((sum, s) => sum + (s.winRate || 0), 0) / summary.global.length
    : 0;

  // Best performer (with null check)
  const bestStrategy = summary.global.length > 0
    ? summary.global.reduce((best, current) =>
        (current.totalPnlUsd || 0) > (best.totalPnlUsd || 0) ? current : best
      , summary.global[0])
    : null;

  // Données pour le chart de comparaison
  const comparisonData = summary.global.map(s => ({
    strategy: STRATEGY_LABELS[s.strategy] || s.strategy,
    winRate: (s.winRate || 0) * 100,
    profitFactor: s.profitFactor || 0,
    trades: s.totalTrades || 0,
    pnl: s.totalPnlUsd || 0,
  }));

  // Données pour le pie chart des trades
  const tradesDistribution = summary.global.map(s => ({
    name: STRATEGY_LABELS[s.strategy] || s.strategy,
    value: s.totalTrades || 0,
    color: STRATEGY_COLORS[s.strategy] || '#8884d8',
  }));

  // Top cryptos par stratégie
  const topCryptosByStrategy = summary.bySymbol
    .sort((a, b) => {
      const aPnl = a.strategies.reduce((sum, s) => sum + (s.totalPnlUsd || 0), 0);
      const bPnl = b.strategies.reduce((sum, s) => sum + (s.totalPnlUsd || 0), 0);
      return bPnl - aPnl;
    })
    .slice(0, 10);

  return (
    <div style={{ padding: '20px' }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        {/* En-tête */}
        <Row justify="space-between" align="middle">
          <Col>
            <Title level={2}>📊 Performance par Stratégie</Title>
          </Col>
          <Col>
            <Space>
              <Text>Période:</Text>
              <Select value={days} onChange={setDays} style={{ width: 120 }}>
                <Option value={7}>7 jours</Option>
                <Option value={14}>14 jours</Option>
                <Option value={30}>30 jours</Option>
                <Option value={60}>60 jours</Option>
                <Option value={90}>90 jours</Option>
              </Select>
            </Space>
          </Col>
        </Row>

        {/* KPIs globaux */}
        <Row gutter={16}>
          <Col span={6}>
            <Card>
              <Statistic
                title="Total Trades"
                value={totalTrades}
                prefix="🎯"
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic
                title="PnL Total"
                value={totalPnl}
                precision={2}
                prefix={totalPnl >= 0 ? <RiseOutlined /> : <FallOutlined />}
                suffix="$"
                valueStyle={{ color: totalPnl >= 0 ? '#3f8600' : '#cf1322' }}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic
                title="Win Rate Moyen"
                value={avgWinRate * 100}
                precision={1}
                suffix="%"
                valueStyle={{ color: avgWinRate >= 0.5 ? '#3f8600' : '#cf1322' }}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic
                title="Meilleure Stratégie"
                value={bestStrategy ? bestStrategy.totalPnlUsd : 0}
                precision={2}
                prefix={<TrophyOutlined />}
                suffix="$"
                valueStyle={{ color: '#faad14' }}
              />
              {bestStrategy && (
                <div style={{ marginTop: 8 }}>
                  <StrategyBadge strategy={bestStrategy.strategy} size="small" />
                </div>
              )}
              {!bestStrategy && (
                <div style={{ marginTop: 8, color: '#999' }}>
                  <Text type="secondary">Aucune donnée</Text>
                </div>
              )}
            </Card>
          </Col>
        </Row>

        {/* Charts de comparaison */}
        <Row gutter={16}>
          <Col span={12}>
            <Card title="🎯 Win Rate par Stratégie">
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={comparisonData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="strategy" />
                  <YAxis />
                  <Tooltip />
                  <Bar dataKey="winRate" fill="#1890ff" name="Win Rate (%)" />
                </BarChart>
              </ResponsiveContainer>
            </Card>
          </Col>
          <Col span={12}>
            <Card title="💰 PnL par Stratégie">
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={comparisonData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="strategy" />
                  <YAxis />
                  <Tooltip />
                  <Bar dataKey="pnl" fill="#52c41a" name="PnL ($)" />
                </BarChart>
              </ResponsiveContainer>
            </Card>
          </Col>
        </Row>

        {/* Distribution et Profit Factor */}
        <Row gutter={16}>
          <Col span={12}>
            <Card title="📈 Distribution des Trades">
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={tradesDistribution}
                    cx="50%"
                    cy="50%"
                    labelLine={true}
                    label={entry => `${entry.name}: ${entry.value}`}
                    outerRadius={100}
                    fill="#8884d8"
                    dataKey="value"
                  >
                    {tradesDistribution.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </Card>
          </Col>
          <Col span={12}>
            <Card title="⚖️ Profit Factor par Stratégie">
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={comparisonData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="strategy" />
                  <YAxis />
                  <Tooltip />
                  <Bar dataKey="profitFactor" fill="#fa8c16" name="Profit Factor" />
                </BarChart>
              </ResponsiveContainer>
            </Card>
          </Col>
        </Row>

        {/* Tableau détaillé */}
        <Card title="📋 Statistiques Détaillées par Stratégie">
          <Table
            dataSource={detailed.strategies}
            rowKey="strategy"
            pagination={false}
            size="small"
            columns={[
              {
                title: 'Stratégie',
                dataIndex: 'strategy',
                key: 'strategy',
                render: (strategy: StrategyType) => <StrategyBadge strategy={strategy} />,
              },
              {
                title: 'Trades',
                dataIndex: 'totalTrades',
                key: 'totalTrades',
                align: 'right',
              },
              {
                title: 'Wins',
                dataIndex: 'wins',
                key: 'wins',
                align: 'right',
                render: (wins: number, record: any) => (
                  <Text style={{ color: '#52c41a' }}>{wins}</Text>
                ),
              },
              {
                title: 'Losses',
                dataIndex: 'losses',
                key: 'losses',
                align: 'right',
                render: (losses: number) => (
                  <Text style={{ color: '#f5222d' }}>{losses}</Text>
                ),
              },
              {
                title: 'Win Rate',
                dataIndex: 'winRate',
                key: 'winRate',
                align: 'right',
                render: (wr: number) => (
                  <Tag color={wr >= 0.5 ? 'green' : 'red'}>
                    {(wr * 100).toFixed(1)}%
                  </Tag>
                ),
              },
              {
                title: 'Avg Win',
                dataIndex: 'avgWin',
                key: 'avgWin',
                align: 'right',
                render: (val: number) => <Text type="success">${val.toFixed(2)}</Text>,
              },
              {
                title: 'Avg Loss',
                dataIndex: 'avgLoss',
                key: 'avgLoss',
                align: 'right',
                render: (val: number) => <Text type="danger">${val.toFixed(2)}</Text>,
              },
              {
                title: 'Profit Factor',
                dataIndex: 'profitFactor',
                key: 'profitFactor',
                align: 'right',
                render: (pf: number) => (
                  <Tag color={pf >= 1.5 ? 'green' : pf >= 1.0 ? 'orange' : 'red'}>
                    {pf.toFixed(2)}
                  </Tag>
                ),
              },
              {
                title: 'Total PnL',
                dataIndex: 'totalPnl',
                key: 'totalPnl',
                align: 'right',
                render: (pnl: number) => (
                  <Text strong style={{ color: pnl >= 0 ? '#3f8600' : '#cf1322' }}>
                    ${pnl.toFixed(2)}
                  </Text>
                ),
              },
            ]}
          />
        </Card>

        {/* Top cryptos par stratégie recommandée */}
        <Card title="🏆 Top Cryptos - Meilleure Stratégie">
          <Table
            dataSource={topCryptosByStrategy}
            rowKey="symbol"
            pagination={false}
            size="small"
            columns={[
              {
                title: 'Crypto',
                dataIndex: 'symbol',
                key: 'symbol',
                render: (symbol: string) => <Text strong>{symbol}</Text>,
              },
              {
                title: 'Recommandée',
                dataIndex: 'recommendedStrategy',
                key: 'recommendedStrategy',
                render: (strategy: StrategyType, record: any) => (
                  <Space>
                    <StrategyBadge 
                      strategy={strategy} 
                      confidence={record.confidence}
                    />
                  </Space>
                ),
              },
              {
                title: 'Raison',
                dataIndex: 'reason',
                key: 'reason',
                ellipsis: true,
              },
              {
                title: 'Stratégies Testées',
                dataIndex: 'strategies',
                key: 'strategies',
                render: (strategies: any[]) => (
                  <Space size="small">
                    {strategies.map((s, idx) => (
                      <StrategyBadge 
                        key={idx}
                        strategy={s.strategy} 
                        size="small"
                        showIcon={false}
                      />
                    ))}
                  </Space>
                ),
              },
            ]}
          />
        </Card>

        {/* Heatmap crypto x stratégie */}
        <Card title="🔥 Heatmap: Crypto × Stratégie (PnL)">
          <Table
            dataSource={heatmap.heatmap}
            rowKey="symbol"
            pagination={{ pageSize: 20 }}
            size="small"
            scroll={{ x: 'max-content' }}
            columns={[
              {
                title: 'Crypto',
                dataIndex: 'symbol',
                key: 'symbol',
                fixed: 'left',
                width: 100,
                render: (symbol: string) => <Text strong>{symbol}</Text>,
              },
              ...(['trend_following', 'mean_reversion', 'breakout', 'momentum'] as StrategyType[]).map(strategy => ({
                title: (
                  <div style={{ textAlign: 'center' }}>
                    <StrategyBadge strategy={strategy} size="small" showIcon={false} />
                  </div>
                ),
                dataIndex: ['strategies', strategy],
                key: strategy,
                align: 'center' as const,
                width: 120,
                render: (cell: any) => {
                  if (!cell || cell.trades === 0) {
                    return <Text type="secondary">-</Text>;
                  }
                  
                  const bgColor = cell.pnl > 0 
                    ? `rgba(82, 196, 26, ${Math.min(Math.abs(cell.pnl) / 100, 0.3)})` 
                    : `rgba(245, 34, 45, ${Math.min(Math.abs(cell.pnl) / 100, 0.3)})`;
                  
                  return (
                    <div style={{ 
                      backgroundColor: bgColor, 
                      padding: '4px 8px',
                      borderRadius: '4px',
                    }}>
                      <div style={{ fontSize: '12px', fontWeight: 500 }}>
                        ${cell.pnl.toFixed(1)}
                      </div>
                      <div style={{ fontSize: '10px', opacity: 0.8 }}>
                        {cell.trades}t · {(cell.winRate * 100).toFixed(0)}%
                      </div>
                    </div>
                  );
                },
              })),
            ]}
          />
        </Card>
      </Space>
    </div>
  );
}

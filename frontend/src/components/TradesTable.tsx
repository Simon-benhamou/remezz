import React from 'react';
import { Table, Tag, Tooltip, Space, Progress, Badge } from 'antd';
import { TrophyOutlined, FireOutlined, ThunderboltOutlined } from '../icons';

export default function TradesTable({ rows = [] }: any) {
  const getTradeBadge = (pnl: number, roi: number) => {
    const isWin = pnl > 0;
    const isSignificant = Math.abs(roi) > 5;
    const isBigWin = roi > 10;
    
    if (isBigWin) {
      return <Badge status="default" text={<Space size={2}><TrophyOutlined style={{ color: '#6b7280' }} /><span style={{ color: '#374151', fontWeight: 600 }}>Big Win</span></Space>} />;
    } else if (isWin && isSignificant) {
      return <Badge status="default" text={<Space size={2}><ThunderboltOutlined style={{ color: '#6b7280' }} /><span style={{ color: '#374151', fontWeight: 500 }}>Win</span></Space>} />;
    } else if (isWin) {
      return <Badge status="default" text={<span style={{ color: '#6b7280', fontWeight: 500 }}>Small Win</span>} />;
    } else if (isSignificant) {
      return <Badge status="default" text={<Space size={2}><FireOutlined style={{ color: '#6b7280' }} /><span style={{ color: '#6b7280', fontWeight: 600 }}>Big Loss</span></Space>} />;
    } else {
      return <Badge status="default" text={<span style={{ color: '#6b7280', fontWeight: 500 }}>Loss</span>} />;
    }
  };

  const getDurationBadge = (duration: number) => {
    if (duration < 300) { // < 5 min
      return <Tag style={{ fontSize: 10, background: '#f9fafb', color: '#6b7280', border: '1px solid #e5e7eb' }}>Scalp</Tag>;
    } else if (duration < 3600) { // < 1h
      return <Tag style={{ fontSize: 10, background: '#f9fafb', color: '#6b7280', border: '1px solid #e5e7eb' }}>Quick</Tag>;
    } else if (duration < 86400) { // < 1 day
      return <Tag style={{ fontSize: 10, background: '#f9fafb', color: '#6b7280', border: '1px solid #e5e7eb' }}>Intraday</Tag>;
    } else {
      return <Tag style={{ fontSize: 10, background: '#f9fafb', color: '#6b7280', border: '1px solid #e5e7eb' }}>Swing</Tag>;
    }
  };

  const formatDuration = (seconds: number) => {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
  };

  const cols: any = [
    {
      title: 'Time',
      dataIndex: 'createdAt',
      width: 140,
      render: (v: any, record: any) => {
        const duration = record.durationSeconds || 0;
        return (
          <div style={{ fontSize: 12 }}>
            <div style={{ fontWeight: 500, color: '#374151' }}>
              {new Date(v).toLocaleDateString()}
            </div>
            <div style={{ color: '#6b7280' }}>
              {new Date(v).toLocaleTimeString()}
            </div>
            <div style={{ marginTop: 2 }}>
              {getDurationBadge(duration)}
              <span style={{ color: '#9ca3af', fontSize: 10, marginLeft: 4 }}>
                {formatDuration(duration)}
              </span>
            </div>
          </div>
        );
      },
    },
    {
      title: 'Position',
      width: 100,
      render: (_: any, record: any) => (
        <Space direction="vertical" size={2}>
          <Tag 
            color={record.positionSide === 'long' ? 'success' : 'error'} 
            style={{ margin: 0, fontSize: 12, fontWeight: 600 }}
          >
            {record.positionSide?.toUpperCase() || 'N/A'}
          </Tag>
          <span style={{ fontSize: 10, color: '#6b7280' }}>
            {record.symbol}
          </span>
        </Space>
      ),
    },
    {
      title: 'Entry',
      width: 100,
      align: 'right',
      render: (_: any, record: any) => (
        <Space direction="vertical" size={1} style={{ alignItems: 'flex-end' }}>
          <span style={{ 
            fontSize: 12, 
            fontWeight: 600, 
            color: '#111827',
            fontFamily: 'Monaco, monospace'
          }}>
            ${Number(record.entryPrice || 0).toFixed(4)}
          </span>
          <span style={{ fontSize: 10, color: '#6b7280' }}>
            {Number(record.qty || 0).toFixed(4)}
          </span>
        </Space>
      )
    },
    {
      title: 'Exit',
      width: 100,
      align: 'right',
      render: (_: any, record: any) => (
        <Space direction="vertical" size={1} style={{ alignItems: 'flex-end' }}>
          <span style={{ 
            fontSize: 12, 
            fontWeight: 600, 
            color: '#111827',
            fontFamily: 'Monaco, monospace'
          }}>
            ${Number(record.exitPrice || 0).toFixed(4)}
          </span>
          <span style={{ fontSize: 10, color: '#6b7280' }}>
            {((Number(record.exitPrice || 0) - Number(record.entryPrice || 0)) / Number(record.entryPrice || 1) * 100).toFixed(2)}%
          </span>
        </Space>
      )
    },
    {
      title: 'Size & Leverage',
      width: 120,
      align: 'center',
      render: (_: any, record: any) => {
        const notional = (Number(record.qty) || 0) * (Number(record.entryPrice) || 0);
        const leverage = record.leverage || record.estLev || 1;
        
        return (
          <Space direction="vertical" size={2} style={{ alignItems: 'center' }}>
            <span style={{ 
              fontSize: 12, 
              fontWeight: 600, 
              color: '#2563eb',
              fontFamily: 'Monaco, monospace'
            }}>
              ${notional.toFixed(2)}
            </span>
            <Tag style={{ margin: 0, fontSize: 10, background: '#f9fafb', color: '#6b7280', border: '1px solid #e5e7eb' }}>
              {Number(leverage).toFixed(1)}x
            </Tag>
          </Space>
        );
      },
    },
    {
      title: 'Performance',
      width: 140,
      align: 'right',
      render: (_: any, record: any) => {
        const pnl = Number(record.realizedPnlUsd || 0);
        const roi = Number(record.roePct || 0);
        const pctChange = Number(record.pctChange || 0);
        const isProfit = pnl >= 0;
        
        return (
          <Space direction="vertical" size={2} style={{ alignItems: 'flex-end' }}>
            <span style={{ 
              color: isProfit ? '#059669' : '#dc2626', // Ultra-discret
              fontSize: 14,
              fontWeight: 700,
              fontFamily: 'Monaco, monospace'
            }}>
              ${pnl.toFixed(2)}
            </span>
            <span style={{ 
              color: isProfit ? '#059669' : '#dc2626', // Ultra-discret
              fontSize: 12,
              fontWeight: 600
            }}>
              {roi >= 0 ? '+' : ''}{roi.toFixed(1)}% ROI
            </span>
            <Progress 
              percent={Math.min(Math.abs(roi), 100)} 
              strokeColor={isProfit ? '#059669' : '#dc2626'} // Ultra-discret
              showInfo={false}
              size="small"
              style={{ width: 60 }}
            />
          </Space>
        );
      },
    },
    {
      title: 'Result',
      width: 120,
      align: 'center',
      render: (_: any, record: any) => {
        const pnl = Number(record.realizedPnlUsd || 0);
        const roi = Number(record.roePct || 0);
        return getTradeBadge(pnl, roi);
      },
    },
  ];

  // Calculate summary stats
  const totalTrades = rows.length;
  const winningTrades = rows.filter((r: any) => Number(r.realizedPnlUsd || 0) > 0).length;
  const winRate = totalTrades > 0 ? (winningTrades / totalTrades * 100).toFixed(1) : '0';
  const totalPnl = rows.reduce((sum: number, r: any) => sum + Number(r.realizedPnlUsd || 0), 0);

  return (
    <div>
      {totalTrades > 0 && (
        <div style={{ 
          padding: '12px 16px', 
          background: '#fafafa', 
          borderRadius: '8px 8px 0 0',
          borderBottom: '1px solid #f0f0f0'
        }}>
          <Space split={<span style={{ color: '#d1d5db' }}>|</span>}>
            <span style={{ fontSize: 12, color: '#374151' }}>
              <span style={{ fontWeight: 600 }}>{totalTrades}</span> trades
            </span>
            <span style={{ fontSize: 12, color: '#374151' }}>
              <span style={{ fontWeight: 600, color: winningTrades > totalTrades / 2 ? '#059669' : '#dc2626' }}> {/* Ultra-discret */}
                {winRate}%
              </span> win rate
            </span>
            <span style={{ fontSize: 12, color: '#374151' }}>
              <span style={{ 
                fontWeight: 600, 
                color: totalPnl >= 0 ? '#10b981' : '#ef4444',
                fontFamily: 'Monaco, monospace'
              }}>
                ${totalPnl.toFixed(2)}
              </span> total PnL
            </span>
          </Space>
        </div>
      )}
      
      <Table 
        rowKey="id" 
        dataSource={rows} 
        columns={cols} 
        size="small" 
        pagination={{
          pageSize: 10,
          showSizeChanger: false,
          showQuickJumper: false,
          showTotal: (total) => `${total} trades`
        }}
        scroll={{ x: 800 }}
        className="enhanced-trades-table"
      />
    </div>
  );
}

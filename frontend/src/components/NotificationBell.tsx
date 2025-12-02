/**
 * Notification Bell Button
 * 
 * Shows current notification status and allows toggling
 */

import React from 'react';
import { Badge, Popover, Switch, Space, Typography, Divider, List, Tag } from 'antd';
import { BellOutlined, SoundOutlined, CheckCircleOutlined } from '@ant-design/icons';
import { useTradeNotifications } from '../providers/TradeNotificationProvider';

const { Text } = Typography;

function formatSymbol(symbol: string): string {
  return symbol.replace('/USDT:USDT', '').replace('/USDT', '');
}

export default function NotificationBell() {
  const { 
    enabled, 
    soundEnabled, 
    setEnabled, 
    setSoundEnabled,
    browserPermission,
    requestBrowserPermission,
    recentNotifications 
  } = useTradeNotifications();
  
  const [open, setOpen] = React.useState(false);
  
  const content = (
    <div style={{ width: 280 }}>
      <div style={{ marginBottom: 12 }}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Space>
              <BellOutlined />
              <Text strong>Trade Notifications</Text>
            </Space>
            <Switch 
              size="small" 
              checked={enabled} 
              onChange={setEnabled}
            />
          </div>
          
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Space>
              <SoundOutlined />
              <Text>Sound Alerts</Text>
            </Space>
            <Switch 
              size="small" 
              checked={soundEnabled} 
              onChange={setSoundEnabled}
              disabled={!enabled}
            />
          </div>
          
          {browserPermission === 'default' && (
            <button
              onClick={requestBrowserPermission}
              style={{
                width: '100%',
                padding: '6px 12px',
                borderRadius: 6,
                border: '1px solid #60a5fa',
                background: 'rgba(96, 165, 250, 0.1)',
                color: '#60a5fa',
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              Enable Browser Notifications
            </button>
          )}
          
          {browserPermission === 'granted' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#52c41a', fontSize: 12 }}>
              <CheckCircleOutlined />
              Browser notifications enabled
            </div>
          )}
          
          {browserPermission === 'denied' && (
            <Text type="danger" style={{ fontSize: 11 }}>
              Browser notifications blocked. Check browser settings.
            </Text>
          )}
        </Space>
      </div>
      
      {recentNotifications.length > 0 && (
        <>
          <Divider style={{ margin: '8px 0' }} />
          <Text type="secondary" style={{ fontSize: 11, marginBottom: 8, display: 'block' }}>
            Recent Notifications
          </Text>
          <List
            size="small"
            dataSource={recentNotifications.slice(0, 5)}
            style={{ maxHeight: 200, overflowY: 'auto' }}
            renderItem={(item) => {
              const isEntry = item.type === 'trade_entry';
              const isWin = (item.pnlUsd ?? 0) >= 0;
              
              return (
                <List.Item style={{ padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ width: '100%' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Space size={4}>
                        <Tag color={item.mode === 'live' ? 'red' : 'blue'} style={{ fontSize: 10, margin: 0 }}>
                          {item.mode.toUpperCase()}
                        </Tag>
                        <Text strong style={{ fontSize: 12 }}>{formatSymbol(item.symbol)}</Text>
                        <Text style={{ fontSize: 11, color: item.side === 'long' ? '#52c41a' : '#ff4d4f' }}>
                          {item.side.toUpperCase()}
                        </Text>
                      </Space>
                      <Text type="secondary" style={{ fontSize: 10 }}>
                        {new Date(item.timestamp).toLocaleTimeString()}
                      </Text>
                    </div>
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)' }}>
                      {isEntry ? (
                        <>Entry @ ${item.price.toFixed(4)} · ${item.notionalUsd.toFixed(0)}</>
                      ) : (
                        <span style={{ color: isWin ? '#52c41a' : '#ff4d4f' }}>
                          {isWin ? '+' : ''}${item.pnlUsd?.toFixed(2)} ({isWin ? '+' : ''}{item.pnlPct?.toFixed(2)}%)
                        </span>
                      )}
                    </div>
                  </div>
                </List.Item>
              );
            }}
          />
        </>
      )}
    </div>
  );
  
  // Count unviewed notifications (last 5 minutes)
  const recentCount = recentNotifications.filter(
    n => Date.now() - n.timestamp < 5 * 60 * 1000
  ).length;
  
  return (
    <Popover
      content={content}
      title={null}
      trigger="click"
      placement="bottomRight"
      open={open}
      onOpenChange={setOpen}
    >
      <Badge count={recentCount} size="small" offset={[-2, 2]}>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            background: enabled ? 'rgba(96, 165, 250, 0.15)' : 'rgba(255, 255, 255, 0.05)',
            border: '1px solid rgba(148, 163, 184, 0.2)',
            transition: 'all 0.2s',
          }}
        >
          <BellOutlined style={{ 
            fontSize: 18, 
            color: enabled ? '#60a5fa' : 'rgba(148, 163, 184, 0.6)' 
          }} />
        </div>
      </Badge>
    </Popover>
  );
}

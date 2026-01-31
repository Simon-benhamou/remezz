/**
 * Notification Bell Button
 * 
 * Shows current notification status and allows toggling
 */

import React from 'react';
import { Badge, Popover, Switch, Space, Typography, Divider, List, Tag } from 'antd';
import { useTradeNotifications } from '../providers/TradeNotificationProvider';
import { Bell, Volume2, CheckCircle } from 'lucide-react';
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
              <Bell size={16} />
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
              <Volume2 size={16} />
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
                border: '1px solid var(--accent)',
                background: 'rgba(6, 182, 212, 0.1)',
                color: 'var(--accent)',
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              Enable Browser Notifications
            </button>
          )}
          
          {browserPermission === 'granted' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--success)', fontSize: 12 }}>
              <CheckCircle size={14} />
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
            dataSource={recentNotifications.slice(0, 8)}
            style={{ maxHeight: 250, overflowY: 'auto' }}
            renderItem={(item) => {
              const isEntry = item.type === 'trade_entry';
              const isExit = item.type === 'trade_exit' || item.type === 'stop_loss_hit' || item.type === 'take_profit_hit';
              const isTrade = isEntry || isExit;
              const isWin = (item.pnlUsd ?? 0) >= 0;
              
              // Get icon/color based on notification type
              const getTypeInfo = () => {
                switch (item.type) {
                  case 'trade_entry': return { icon: '🚀', color: 'var(--accent)' };
                  case 'trade_exit': return { icon: isWin ? '✅' : '❌', color: isWin ? 'var(--success)' : 'var(--error)' };
                  case 'stop_loss_hit': return { icon: '🛑', color: 'var(--error)' };
                  case 'take_profit_hit': return { icon: '🎯', color: 'var(--success)' };
                  case 'agent_started': return { icon: '🤖', color: 'var(--success)' };
                  case 'agent_stopped': return { icon: '⏹️', color: '#faad14' };
                  case 'regime_change': return { icon: '🔄', color: '#722ed1' };
                  case 'high_volatility': return { icon: '⚡', color: '#faad14' };
                  case 'signal_detected': return { icon: '📊', color: '#13c2c2' };
                  default: return { icon: '📢', color: '#8c8c8c' };
                }
              };
              
              const typeInfo = getTypeInfo();
              
              return (
                <List.Item style={{ padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ width: '100%' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Space size={4}>
                        <span style={{ fontSize: 12 }}>{typeInfo.icon}</span>
                        {item.mode && (
                          <Tag color={item.mode === 'live' ? 'red' : 'blue'} style={{ fontSize: 10, margin: 0 }}>
                            {item.mode.toUpperCase()}
                          </Tag>
                        )}
                        <Text strong style={{ fontSize: 12 }}>{formatSymbol(item.symbol)}</Text>
                        {item.side && (
                          <Text style={{ fontSize: 11, color: item.side === 'long' ? 'var(--success)' : 'var(--error)' }}>
                            {item.side.toUpperCase()}
                          </Text>
                        )}
                      </Space>
                      <Text type="secondary" style={{ fontSize: 10 }}>
                        {new Date(item.timestamp).toLocaleTimeString()}
                      </Text>
                    </div>
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)' }}>
                      {isEntry ? (
                        <>Entry @ ${item.price?.toFixed(4) ?? '0'} · ${item.notionalUsd?.toFixed(0) ?? '0'}</>
                      ) : isExit ? (
                        <span style={{ color: isWin ? 'var(--success)' : 'var(--error)' }}>
                          {isWin ? '+' : ''}${item.pnlUsd?.toFixed(2) ?? '0'} ({isWin ? '+' : ''}{item.pnlPct?.toFixed(2) ?? '0'}%)
                        </span>
                      ) : (
                        <Text type="secondary" style={{ fontSize: 11 }}>
                          {(item as any).title || (item as any).message || item.type?.replace(/_/g, ' ')}
                        </Text>
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
            transition: 'all 0.2s',
          }}
        >
          <Bell style={{ 
            fontSize: 18, 
            color: enabled ? 'var(--accent)' : 'var(--text-muted)'
          }} />
        </div>
      </Badge>
    </Popover>
  );
}

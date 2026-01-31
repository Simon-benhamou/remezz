/**
 * Trade Notification Provider
 * 
 * Global provider that listens for trade notifications via WebSocket
 * and displays them using browser notifications and Ant Design toasts.
 */

import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { notification as antNotification } from 'antd';
import { 
  RiseOutlined, 
  FallOutlined, 
  DollarOutlined,
  WarningOutlined,
  BellOutlined,
  SoundOutlined
} from '@ant-design/icons';
import { openWS } from '../ws';

export interface TradeNotification {
  type: 'trade_entry' | 'trade_exit' | 'stop_loss_hit' | 'take_profit_hit' | 
        'agent_started' | 'agent_stopped' | 'regime_change' | 'high_volatility' | 
        'signal_detected' | 'sync_failure' | 'daily_loss_limit' | 'trailing_activated' |
        'long_hold' | 'liquidation_warning';
  symbol: string;
  side?: 'long' | 'short';
  price?: number;
  qty?: number;
  notionalUsd?: number;
  marginUsd?: number;
  leverage?: number;
  pnlUsd?: number;
  pnlPct?: number;
  reason?: string;
  stopLoss?: number;
  entryPrice?: number;
  exitPrice?: number;
  mode?: 'paper' | 'live';
  timestamp: number;
  // For non-trade notifications
  title?: string;
  message?: string;
  severity?: 'info' | 'warning' | 'error' | 'success';
}

interface NotificationContextValue {
  enabled: boolean;
  soundEnabled: boolean;
  setEnabled: (enabled: boolean) => void;
  setSoundEnabled: (enabled: boolean) => void;
  browserPermission: NotificationPermission | 'unsupported';
  requestBrowserPermission: () => Promise<boolean>;
  recentNotifications: TradeNotification[];
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

// Storage keys
const STORAGE_KEY_ENABLED = 'remezz_notifications_enabled';
const STORAGE_KEY_SOUND = 'remezz_notifications_sound';

// Fallback: Create sounds programmatically
function playBeep(frequency: number = 800, duration: number = 200, volume: number = 0.3) {
  try {
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    oscillator.frequency.value = frequency;
    oscillator.type = 'sine';
    gainNode.gain.value = volume;
    
    oscillator.start();
    setTimeout(() => {
      oscillator.stop();
      audioContext.close();
    }, duration);
  } catch (e) {
    // Audio not supported
  }
}

function playSound(type: 'entry' | 'win' | 'loss') {
  if (type === 'entry') {
    playBeep(880, 150, 0.2);
    setTimeout(() => playBeep(1100, 150, 0.2), 160);
  } else if (type === 'win') {
    playBeep(523, 100, 0.25); // C note
    setTimeout(() => playBeep(659, 100, 0.25), 110); // E note
    setTimeout(() => playBeep(784, 200, 0.25), 220); // G note
  } else {
    playBeep(440, 300, 0.2);
  }
}

// Format symbol for display
function formatSymbol(symbol: string): string {
  return symbol.replace('/USDT:USDT', '').replace('/USDT', '');
}

// Show browser notification
function showBrowserNotification(title: string, body: string) {
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    return;
  }
  
  try {
    const notif = new Notification(title, {
      body,
      icon: '/favicon.ico',
      badge: '/favicon.ico',
      tag: 'trade-notification',
      requireInteraction: false,
    });
    
    setTimeout(() => notif.close(), 10000);
  } catch (e) {
    console.warn('Failed to show browser notification:', e);
  }
}

export function TradeNotificationProvider({ children }: { children: React.ReactNode }) {
  const [enabled, setEnabledState] = useState(() => {
    const stored = localStorage.getItem(STORAGE_KEY_ENABLED);
    return stored !== 'false'; // Default to enabled
  });
  
  const [soundEnabled, setSoundEnabledState] = useState(() => {
    const stored = localStorage.getItem(STORAGE_KEY_SOUND);
    return stored !== 'false'; // Default to enabled
  });
  
  const [browserPermission, setBrowserPermission] = useState<NotificationPermission | 'unsupported'>(() => {
    if (!('Notification' in window)) return 'unsupported';
    return Notification.permission;
  });
  
  const [recentNotifications, setRecentNotifications] = useState<TradeNotification[]>([]);
  const notificationKeyRef = useRef(0);
  const wsRef = useRef<ReturnType<typeof openWS> | null>(null);
  
  const setEnabled = useCallback((value: boolean) => {
    setEnabledState(value);
    localStorage.setItem(STORAGE_KEY_ENABLED, String(value));
  }, []);
  
  const setSoundEnabled = useCallback((value: boolean) => {
    setSoundEnabledState(value);
    localStorage.setItem(STORAGE_KEY_SOUND, String(value));
  }, []);
  
  const requestBrowserPermission = useCallback(async (): Promise<boolean> => {
    if (!('Notification' in window)) {
      return false;
    }
    
    if (Notification.permission === 'granted') {
      setBrowserPermission('granted');
      return true;
    }
    
    if (Notification.permission === 'denied') {
      setBrowserPermission('denied');
      return false;
    }
    
    const permission = await Notification.requestPermission();
    setBrowserPermission(permission);
    return permission === 'granted';
  }, []);
  
  const handleTradeNotification = useCallback((data: TradeNotification) => {
    // Add to recent notifications (keep last 20)
    setRecentNotifications(prev => [data, ...prev].slice(0, 20));
    
    if (!enabled) return;
    
    // Only show in-app notifications for actual trades (entry/exit)
    // Skip other notification types like regime_change, agent_started, etc.
    const isTradeNotification = data.type === 'trade_entry' || data.type === 'trade_exit' || 
                                 data.type === 'stop_loss_hit' || data.type === 'take_profit_hit';
    if (!isTradeNotification) return;
    
    const symbol = formatSymbol(data.symbol);
    const isEntry = data.type === 'trade_entry';
    const isWin = (data.pnlUsd ?? 0) >= 0;
    const modeTag = data.mode === 'live' ? '🔴 LIVE' : '📝 PAPER';
    const sideLabel = data.side?.toUpperCase() ?? '';
    
    // Play sound
    if (soundEnabled) {
      if (isEntry) {
        playSound('entry');
      } else {
        playSound(isWin ? 'win' : 'loss');
      }
    }
    
    // Show in-app notification
    const key = `trade-${notificationKeyRef.current++}`;
    
    if (isEntry) {
      antNotification.info({
        key,
        message: (
          <span>
            {modeTag} {symbol} {sideLabel} Entry
          </span>
        ),
        description: (
          <div style={{ fontSize: 12 }}>
            <div>📍 Price: <strong>${data.price?.toFixed(4) ?? '0'}</strong></div>
            <div>💰 Size: <strong>${data.notionalUsd?.toFixed(2) ?? '0'}</strong> ({data.leverage}x)</div>
            <div>🎯 Margin: <strong>${data.marginUsd?.toFixed(2)}</strong></div>
            {data.stopLoss && <div>🛡️ Stop Loss: <strong>${data.stopLoss.toFixed(4)}</strong></div>}
          </div>
        ),
        icon: data.side === 'long' 
          ? <RiseOutlined style={{ color: 'var(--success)' }} />
          : <FallOutlined style={{ color: 'var(--error)' }} />,
        duration: 15,
        placement: 'topRight',
        style: { 
          borderLeft: data.side === 'long' ? '4px solid var(--success)' : '4px solid var(--error)',
          background: data.mode === 'live' ? 'rgba(255, 247, 230, 0.95)' : 'rgba(15, 23, 42, 0.95)',
        },
      });
      
      showBrowserNotification(
        `${modeTag} ${symbol} ${sideLabel}`,
        `Entry @ $${data.price?.toFixed(4) ?? '0'} | Size: $${data.notionalUsd?.toFixed(2) ?? '0'} (${data.leverage}x)`
      );
      
    } else {
      const pnlPrefix = isWin ? '+' : '';
      const pnlColor = isWin ? 'var(--success)' : 'var(--error)';
      const exitType = data.type === 'stop_loss_hit' ? '🛑 STOP LOSS' : 
                       data.type === 'take_profit_hit' ? '🎯 TAKE PROFIT' : 
                       isWin ? '✅ WIN' : '❌ LOSS';
      
      antNotification[isWin ? 'success' : 'error']({
        key,
        message: (
          <span>
            {modeTag} {symbol} {exitType}
          </span>
        ),
        description: (
          <div style={{ fontSize: 12 }}>
            <div>📍 Exit Price: <strong>${(data.exitPrice ?? data.price ?? 0).toFixed(4)}</strong></div>
            <div style={{ color: pnlColor, fontWeight: 'bold', fontSize: 14 }}>
              💵 PnL: {pnlPrefix}${data.pnlUsd?.toFixed(2)} ({pnlPrefix}{data.pnlPct?.toFixed(2)}%)
            </div>
            <div>📝 Reason: {data.reason}</div>
          </div>
        ),
        icon: isWin 
          ? <DollarOutlined style={{ color: 'var(--success)' }} />
          : <WarningOutlined style={{ color: 'var(--error)' }} />,
        duration: 20,
        placement: 'topRight',
        style: { 
          borderLeft: `4px solid ${pnlColor}`,
          background: data.mode === 'live' ? 'rgba(255, 247, 230, 0.95)' : 'rgba(15, 23, 42, 0.95)',
        },
      });
      
      showBrowserNotification(
        `${modeTag} ${symbol} ${exitType}`,
        `PnL: ${pnlPrefix}$${data.pnlUsd?.toFixed(2)} (${pnlPrefix}${data.pnlPct?.toFixed(2)}%)`
      );
    }
  }, [enabled, soundEnabled]);
  
  // Setup WebSocket listener for trade notifications
  useEffect(() => {
    const API_BASE = (import.meta as any).env.VITE_API_BASE || 'http://localhost:4000';
    const apiKey = localStorage.getItem('apiKey') || '';
    
    if (!apiKey) return;
    
    wsRef.current = openWS(
      API_BASE,
      apiKey,
      undefined, // No specific symbol - listen to all
      (msg: any) => {
        if (msg?.type === 'trade_notification' && msg?.data) {
          handleTradeNotification(msg.data as TradeNotification);
        }
      },
      undefined,
      undefined,
      undefined
    );
    
    return () => {
      try {
        wsRef.current?.close();
      } catch {}
      wsRef.current = null;
    };
  }, [handleTradeNotification]);
  
  // Request permission on mount if enabled
  useEffect(() => {
    if (enabled && browserPermission === 'default') {
      requestBrowserPermission();
    }
  }, [enabled, browserPermission, requestBrowserPermission]);
  
  const contextValue: NotificationContextValue = {
    enabled,
    soundEnabled,
    setEnabled,
    setSoundEnabled,
    browserPermission,
    requestBrowserPermission,
    recentNotifications,
  };
  
  return (
    <NotificationContext.Provider value={contextValue}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useTradeNotifications() {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error('useTradeNotifications must be used within a TradeNotificationProvider');
  }
  return context;
}

// Settings component for notification preferences
export function NotificationSettings() {
  const { 
    enabled, 
    soundEnabled, 
    setEnabled, 
    setSoundEnabled, 
    browserPermission,
    requestBrowserPermission 
  } = useTradeNotifications();
  
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <BellOutlined /> Trade Notifications
        </span>
        <label className="ant-switch" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            style={{ display: 'none' }}
          />
          <span style={{
            display: 'inline-block',
            width: 44,
            height: 22,
            background: enabled ? 'var(--success)' : '#e5e5e5',
            borderRadius: 100,
            position: 'relative',
            transition: 'background 0.3s',
          }}>
            <span style={{
              position: 'absolute',
              top: 2,
              left: enabled ? 24 : 2,
              width: 18,
              height: 18,
              background: 'white',
              borderRadius: '50%',
              transition: 'left 0.3s',
            }} />
          </span>
        </label>
      </div>
      
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <SoundOutlined /> Sound Alerts
        </span>
        <label style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={soundEnabled}
            onChange={(e) => setSoundEnabled(e.target.checked)}
            style={{ display: 'none' }}
          />
          <span style={{
            display: 'inline-block',
            width: 44,
            height: 22,
            background: soundEnabled ? 'var(--success)' : '#e5e5e5',
            borderRadius: 100,
            position: 'relative',
            transition: 'background 0.3s',
          }}>
            <span style={{
              position: 'absolute',
              top: 2,
              left: soundEnabled ? 24 : 2,
              width: 18,
              height: 18,
              background: 'white',
              borderRadius: '50%',
              transition: 'left 0.3s',
            }} />
          </span>
        </label>
      </div>
      
      {browserPermission !== 'granted' && browserPermission !== 'unsupported' && (
        <button
          onClick={() => requestBrowserPermission()}
          style={{
            padding: '8px 16px',
            borderRadius: 8,
            border: '1px solid var(--accent)',
            background: 'transparent',
            color: 'var(--accent)',
            cursor: 'pointer',
            marginTop: 8,
          }}
        >
          Enable Browser Notifications
        </button>
      )}
      
      {browserPermission === 'denied' && (
        <div style={{ color: 'var(--error)', fontSize: 12 }}>
          Browser notifications are blocked. Please enable them in your browser settings.
        </div>
      )}
    </div>
  );
}

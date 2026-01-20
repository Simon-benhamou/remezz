/**
 * V5.72: SessionCockpitPage (Redesigned)
 *
 * All-in-one trading dashboard with:
 * - PnL-focused header with sparkline
 * - Full-width professional chart
 * - Conditional position banner with health gauge
 * - Tabbed orders/trades with smart defaults
 * - Simplified performance with parity verification
 * - Activity feed with signal radar events
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, Navigate, useNavigate } from 'react-router-dom';
import { Skeleton, message } from 'antd';
import {
  CockpitHeader,
  LiveMetricsBar,
  PositionBanner,
  OrdersTradesPanel,
  PerformanceSummary,
  ActivityFeed,
} from '../components/cockpit';
import ProfessionalChart from '../components/charts/ProfessionalChart';
import { useSessionState } from '../hooks/useSessionState';
import type { TradeFilters } from '../types/cockpit';
import '../styles/sessionMonitor.css';

// ============================================================================
// LOADING OVERLAY
// ============================================================================

interface LoadingOverlayProps {
  isLoading: boolean;
  progress: number;
  message: string;
  onContinue: () => void;
  onBack: () => void;
}

const LoadingOverlay: React.FC<LoadingOverlayProps> = ({
  isLoading,
  progress,
  message,
  onContinue,
  onBack,
}) => {
  if (!isLoading) return null;

  return (
    <div className="cockpit-loading-overlay">
      <div className="cockpit-loading-card">
        <div className="cockpit-loading-header">
          <div className="cockpit-loading-icon">📊</div>
          <h3>Loading Trading Monitor</h3>
        </div>

        <div className="cockpit-loading-progress">
          <div
            className="cockpit-loading-progress-bar"
            style={{ width: `${progress}%` }}
          />
        </div>

        <p className="cockpit-loading-message">{message}</p>

        <div className="cockpit-loading-actions">
          <button onClick={onContinue} className="cockpit-loading-btn cockpit-loading-btn--text">
            Continue with available data
          </button>
          <button onClick={onBack} className="cockpit-loading-btn">
            ← Back to Sessions
          </button>
        </div>
      </div>

      <style>{loadingStyles}</style>
    </div>
  );
};

const loadingStyles = `
  .cockpit-loading-overlay {
    position: fixed;
    top: 0;
    left: 200px;
    right: 0;
    bottom: 0;
    background: rgba(15, 23, 42, 0.85);
    backdrop-filter: blur(8px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  @media (max-width: 768px) {
    .cockpit-loading-overlay {
      left: 0;
      z-index: 1001;
    }
  }

  .cockpit-loading-card {
    background: rgba(30, 41, 59, 0.95);
    border: 1px solid rgba(148, 163, 184, 0.2);
    border-radius: 16px;
    padding: 32px;
    min-width: 360px;
    max-width: 90%;
    text-align: center;
    box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
  }

  .cockpit-loading-header {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    margin-bottom: 24px;
  }

  .cockpit-loading-icon {
    width: 44px;
    height: 44px;
    background: linear-gradient(135deg, #3b82f6, #06b6d4);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
  }

  .cockpit-loading-header h3 {
    margin: 0;
    color: #f8fafc;
    font-size: 18px;
    font-weight: 600;
  }

  .cockpit-loading-progress {
    height: 8px;
    background: rgba(100, 116, 139, 0.3);
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 16px;
  }

  .cockpit-loading-progress-bar {
    height: 100%;
    background: linear-gradient(90deg, #3b82f6, #10b981);
    border-radius: 4px;
    transition: width 0.3s ease;
  }

  .cockpit-loading-message {
    color: rgba(226, 232, 240, 0.7);
    font-size: 14px;
    margin-bottom: 24px;
  }

  .cockpit-loading-actions {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .cockpit-loading-btn {
    padding: 10px 20px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    background: rgba(59, 130, 246, 0.2);
    border: 1px solid rgba(59, 130, 246, 0.3);
    color: #60a5fa;
  }

  .cockpit-loading-btn:hover {
    background: rgba(59, 130, 246, 0.3);
  }

  .cockpit-loading-btn--text {
    background: transparent;
    border: none;
    color: rgba(226, 232, 240, 0.6);
  }

  .cockpit-loading-btn--text:hover {
    color: rgba(226, 232, 240, 0.9);
  }
`;

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export default function SessionCockpitPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();

  // Loading state
  const [showLoading, setShowLoading] = useState(true);
  const [loadingProgress, setLoadingProgress] = useState(10);
  const [loadingMessage, setLoadingMessage] = useState('Initializing monitor...');

  // Trade filters
  const [tradeFilters, setTradeFilters] = useState<TradeFilters>({});

  // Redirect if no sessionId
  if (!sessionId) {
    return <Navigate to="/agents" replace />;
  }

  // Use the centralized hook
  const [state, actions] = useSessionState({ sessionId });

  const {
    session,
    symbol,
    mode,
    state: sessionState,
    isLoading,
    error,
    agent,
    hasPosition,
    position,
    ticker,
    tickerStatus,
    orders,
    trades,
    performance,
    parity,
    activityEvents,
    wsConnected,
    netPnl,
    roiPct,
    sparklineData,
  } = state;

  // Update loading state based on data
  useEffect(() => {
    if (session) {
      setLoadingProgress(40);
      setLoadingMessage('Loading market data...');
    }
    if (ticker) {
      setLoadingProgress(60);
      setLoadingMessage('Loading trades and orders...');
    }
    if (trades.length > 0 || orders.length > 0) {
      setLoadingProgress(80);
      setLoadingMessage('Loading performance data...');
    }
    if (!isLoading) {
      setLoadingProgress(100);
      setLoadingMessage('Monitor ready!');
      // Small delay before hiding overlay
      const timer = setTimeout(() => setShowLoading(false), 500);
      return () => clearTimeout(timer);
    }
  }, [session, ticker, trades, orders, isLoading]);

  // Handle error state
  useEffect(() => {
    if (error && !session) {
      message.error(`Monitor unavailable: ${error}`);
    }
  }, [error, session]);

  // Allow interaction to dismiss loading
  useEffect(() => {
    if (!showLoading) return;

    const handleInteraction = () => {
      if (loadingProgress > 50) {
        setShowLoading(false);
      }
    };

    const events = ['click', 'keydown', 'scroll'];
    events.forEach((e) => document.addEventListener(e, handleInteraction, { once: true }));
    return () => {
      events.forEach((e) => document.removeEventListener(e, handleInteraction));
    };
  }, [showLoading, loadingProgress]);

  // Default tab based on session state
  const defaultOrdersTab = useMemo(
    () => (sessionState === 'IN_POSITION' ? 'orders' : 'trades'),
    [sessionState]
  );

  // Filtered orders and trades by symbol
  const filteredOrders = useMemo(() => {
    if (!symbol) return orders;
    const normalizedSymbol = symbol.toUpperCase().replace(/[/:]/g, '');
    return orders.filter((o) => {
      const orderSymbol = (o.symbol || '').toUpperCase().replace(/[/:]/g, '');
      return !orderSymbol || orderSymbol === normalizedSymbol;
    });
  }, [orders, symbol]);

  const filteredTrades = useMemo(() => {
    if (!symbol) return trades;
    const normalizedSymbol = symbol.toUpperCase().replace(/[/:]/g, '');
    return trades.filter((t) => {
      const tradeSymbol = (t.symbol || '').toUpperCase().replace(/[/:]/g, '');
      return !tradeSymbol || tradeSymbol === normalizedSymbol;
    });
  }, [trades, symbol]);

  // Refresh handler
  const handleRefresh = useCallback(async () => {
    await actions.refresh();
    message.success('Data refreshed');
  }, [actions]);

  // Redirect on error after timeout
  if (!isLoading && !session && error) {
    return <Navigate to="/agents" replace />;
  }

  return (
    <div className="session-monitor-page">
      <LoadingOverlay
        isLoading={showLoading}
        progress={loadingProgress}
        message={loadingMessage}
        onContinue={() => setShowLoading(false)}
        onBack={() => navigate('/agents')}
      />

      <div className="cockpit-container">
        {/* Header */}
        <CockpitHeader
          symbol={symbol}
          netPnl={netPnl}
          roiPct={roiPct}
          mode={mode}
          state={sessionState}
          wsConnected={wsConnected}
          sparklineData={sparklineData}
          sessionName={session?.profileJson?.name as string | undefined}
          onRefresh={handleRefresh}
          isRefreshing={isLoading}
        />

        {/* Live Metrics Bar */}
        <LiveMetricsBar symbol={symbol} ticker={ticker} status={tickerStatus} />

        {/* Position Banner (conditional) */}
        {hasPosition && position && <PositionBanner position={position} />}

        {/* Main Content Grid */}
        <div className="cockpit-grid">
          {/* Chart - Full Width */}
          <div className="cockpit-chart">
            {symbol ? (
              <ProfessionalChart
                symbol={symbol}
                sessionId={sessionId}
                orders={filteredOrders}
                fills={filteredTrades}
                position={
                  position
                    ? {
                        entryPrice: position.entryPrice,
                        stopPrice: position.stopPrice,
                        targets: position.targets,
                        side: position.side,
                      }
                    : null
                }
                technicalLevels={null}
                strategy={
                  agent?.plan?.bias
                    ? { bias: agent.plan.bias }
                    : null
                }
              />
            ) : (
              <Skeleton active paragraph={{ rows: 10 }} />
            )}
          </div>

          {/* Orders & Trades Panel */}
          <div className="cockpit-panel cockpit-panel--orders">
            <OrdersTradesPanel
              orders={filteredOrders}
              trades={filteredTrades}
              defaultTab={defaultOrdersTab}
              filters={tradeFilters}
              onFilterChange={setTradeFilters}
            />
          </div>

          {/* Performance Summary */}
          <div className="cockpit-panel cockpit-panel--perf">
            <PerformanceSummary
              performance={performance}
              parity={parity}
              loading={isLoading}
            />
          </div>

          {/* Activity Feed */}
          <div className="cockpit-panel cockpit-panel--activity">
            <ActivityFeed
              sessionId={sessionId}
              events={activityEvents}
              loading={isLoading}
            />
          </div>
        </div>
      </div>

      <style>{pageStyles}</style>
    </div>
  );
}

// ============================================================================
// PAGE STYLES
// ============================================================================

const pageStyles = `
  .cockpit-container {
    padding: 20px 24px;
    max-width: 1800px;
    margin: 0 auto;
  }

  .cockpit-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: auto auto auto;
    gap: 16px;
    margin-top: 16px;
  }

  .cockpit-chart {
    grid-column: 1 / -1;
    background: rgba(15, 23, 42, 0.92);
    border-radius: 16px;
    border: 1px solid rgba(100, 116, 139, 0.18);
    overflow: hidden;
    min-height: 400px;
  }

  .cockpit-panel--orders {
    grid-column: 1 / -1;
  }

  .cockpit-panel--perf {
    grid-column: 1;
  }

  .cockpit-panel--activity {
    grid-column: 2;
  }

  @media (max-width: 1024px) {
    .cockpit-grid {
      grid-template-columns: 1fr;
    }

    .cockpit-panel--perf,
    .cockpit-panel--activity {
      grid-column: 1;
    }
  }

  @media (max-width: 768px) {
    .cockpit-container {
      padding: 12px;
    }

    .cockpit-grid {
      gap: 12px;
    }

    .cockpit-chart {
      min-height: 300px;
    }
  }
`;

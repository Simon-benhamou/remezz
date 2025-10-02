import React from 'react';
import { Card, Table, Tag, Button, Space, message, Modal, Form, Input, InputNumber, Select, Row, Col, Tooltip, Progress, Badge, Switch, Dropdown, MenuProps, Slider } from 'antd';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useMode } from '../contexts/ModeContext';
import { useSessionsCache } from '../hooks/useSessionsCache';
import { useCacheNotifications } from '../hooks/useCacheNotifications';
import { useSmartCacheInvalidation } from '../hooks/useSmartCacheInvalidation';
import { SearchOutlined, FilterOutlined, DownloadOutlined, EyeOutlined, SettingOutlined, PlayCircleOutlined, StopOutlined, DeleteOutlined, ReloadOutlined, RocketOutlined, ThunderboltOutlined } from '@ant-design/icons';
import TradingDiagnosticsCollapsible from '../components/TradingDiagnosticsCollapsible';
import ApiKeyStatusBanner from '../components/ApiKeyStatusBanner';
import ApiKeyDiagnostics from '../components/ApiKeyDiagnostics';
import ApiKeyMigrationTool from '../components/ApiKeyMigrationTool';

type AggressivenessLevel = 'conservative' | 'reactive' | 'aggressive';

const AGGRESSIVENESS_PRESETS: Record<AggressivenessLevel, { risk: number; dailyLoss: number; note: string }> = {
  conservative: {
    risk: 1.0,
    dailyLoss: 3.0,
    note: 'Tight exposure for steady accumulation.',
  },
  reactive: {
    risk: 1.5,
    dailyLoss: 3.5,
    note: 'Balanced profile with adaptive rotations.',
  },
  aggressive: {
    risk: 2.2,
    dailyLoss: 3.8,
    note: 'Faster rotations and higher tolerance to drawdown swings.',
  },
};

export default function SessionsPage(){
  const [rows, setRows] = React.useState<any[]>([]);
  const [filteredRows, setFilteredRows] = React.useState<any[]>([]);
  const [open, setOpen] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [restartSessionId, setRestartSessionId] = React.useState<string | null>(null);
  const [form] = Form.useForm();
  const navigate = useNavigate();
  const [exBal, setExBal] = React.useState<{ totalUsd?: number; freeUsd?: number } | null>(null);
  const { mode } = useMode();
  const modeVal = Form.useWatch?.('mode', form);
  const smartAutoMode = Form.useWatch?.('smartAutoMode', form);
  const aggressivenessValue = (Form.useWatch?.('aggressiveness', form) as AggressivenessLevel | undefined) || 'conservative';
  const leverageValue = Form.useWatch?.('maxLeverage', form) ?? 4;
  const riskPreset = React.useMemo(() => AGGRESSIVENESS_PRESETS[aggressivenessValue], [aggressivenessValue]);
  const [apiKeyHealth, setApiKeyHealth] = React.useState<any>(null);
  
  // Cache intelligent pour les sessions
  const {
    loading: sessionsLoading,
    loadSessions,
    getCachedSessions,
    invalidateCache,
    setupAutoRefresh,
    isCacheValid,
  } = useSessionsCache();

  // Notifications de cache
  const { notifyModeSwitch, notifyCacheRefresh, notifyCacheHit, notifyError } = useCacheNotifications();
  
  // Invalidation intelligente du cache
  const { invalidateSmartly } = useSmartCacheInvalidation();
  
  // Clear symbol field when Auto-Select Mode is enabled
  React.useEffect(() => {
    if (smartAutoMode) {
      form.setFieldValue('symbol', undefined);
      console.log('🔄 Cleared symbol field for Auto-Select mode');
    }
  }, [smartAutoMode, form]);
  
  // Filter states
  const [statusFilter, setStatusFilter] = React.useState<string>('all');
  const [modeFilter, setModeFilter] = React.useState<string>('all');
  const [symbolFilter, setSymbolFilter] = React.useState<string>('all');
  const [aggressivenessFilter, setAggressivenessFilter] = React.useState<string>('all');
  const [searchText, setSearchText] = React.useState<string>('');
  const [compactView, setCompactView] = React.useState<boolean>(true);
  
  const commonSymbols = ['BTC/USDT','ETH/USDT','SOL/USDT','XRP/USDT','BNB/USDT','ADA/USDT','AVAX/USDT','DOGE/USDT','TON/USDT','LINK/USDT','MATIC/USDT','DOT/USDT'];
  
  const enrichSessionData = async (sessions: any[]) => {
    return Promise.all(sessions.map(async (session: any) => {
      try {
        // Pull KPI metrics for all sessions (cheap lookup)
        const perf = session.id ? await api.getPerf(session.id).catch(() => null) : null;
        const health = session.id && !session.stoppedAt ? await api.getHealth(session.id).catch(() => null) : null;
        const agentState = session.id && !session.stoppedAt ? await api.getAgentState(session.id).catch(() => null) : null;
        const diagnostics = session.id && !session.stoppedAt ? await api.getDiagnostics(session.id).catch(() => null) : null;

        // Get pending orders (lightweight)
        const orders = session.id ? await api.getOrders(session.id).catch(() => []) : [];
        const pendingOrders = orders.filter((o: any) => 
          ['new', 'open', 'partially_filled'].includes(o.status)
        );
        
        const rawWinRate = Number(perf?.winRate ?? 0);
        const normalizedWinRate = rawWinRate > 0 && rawWinRate <= 1 ? rawWinRate * 100 : rawWinRate;
        const roiPct = Number(perf?.roiPct ?? 0);

        return {
          ...session,
          // PnL & ROI metrics
          realizedPnl: Number(perf?.realizedPnlUsd ?? 0),
          portfolioUnrealizedPnl: Number(perf?.unrealizedPnlUsd ?? 0),
          pnlUsd: Number(perf?.realizedPnlUsd ?? 0) + Number(perf?.unrealizedPnlUsd ?? 0),
          roiPct,
          winRate: normalizedWinRate,
          // Performance metrics
          totalTrades: perf?.totalTrades || 0,
          todayTrades: perf?.todayTrades || 0,
          pnl24h: perf?.pnl24h || 0,
          maxDrawdown: perf?.maxDrawdown || 0,
          uptime: session.startedAt ? Date.now() - new Date(session.startedAt).getTime() : 0,
          lastActivity: perf?.lastTradeAt || session.startedAt,
          
          // Position info
          currentPosition: agentState?.position || null,
          
          // Orders info
          pendingOrders: pendingOrders,
          pendingOrdersCount: pendingOrders.length,

          // Health status
          healthStatus: health?.status || 'unknown',
          healthScore: health?.score || 0,
          alertCount: health?.alerts?.length || 0,

          // Trading diagnostics snapshot for quick gauge
          tradingReadiness: diagnostics ? {
            canTrade: !!diagnostics.canTrade,
            reason: diagnostics.reason,
            summary: diagnostics.summary,
            qualityScore: diagnostics.checks?.qualityScore,
            percent: (() => {
              const qs = diagnostics.checks?.qualityScore;
              if (qs && Number(qs.required)) {
                return Math.round(Math.max(0, Math.min(100, (qs.current / qs.required) * 100)));
              }
              return diagnostics.canTrade ? 100 : 0;
            })(),
          } : null,
          diagnosticsInitial: diagnostics || null,
        };
      } catch {
        return session;
      }
    }));
  };

  const load = React.useCallback(async (forceRefresh = false) => { 
    try {
      console.log(`🔄 Loading sessions for mode: ${mode} ${forceRefresh ? '(force refresh)' : ''}`);
      
      // Utiliser le cache intelligent
      const sessions = await loadSessions(mode as any, false, forceRefresh);
      
      // ✅ FIX: Forcer le filtre par mode côté client (défense en profondeur)
      const filteredByMode = sessions.filter((s: any) => s.mode === mode);
      console.log(`🔍 Filtered ${sessions.length} → ${filteredByMode.length} sessions for mode=${mode}`);
      
      const enrichedSessions = await enrichSessionData(filteredByMode);
      setRows(enrichedSessions);
      
      if (forceRefresh) {
        notifyCacheRefresh(mode as any, enrichedSessions.length);
      }
      
      console.log(`✅ Loaded ${enrichedSessions.length} sessions for ${mode} mode`);
    } catch(e) {
      console.error('Failed to load sessions:', e);
      notifyError(`Failed to load ${mode} sessions`);
    } 
  }, [mode, loadSessions, notifyCacheRefresh, notifyError]);
  
  // Apply filters
  React.useEffect(() => {
    let filtered = rows;
    
    // Status filter
    if (statusFilter !== 'all') {
      filtered = filtered.filter(r => 
        statusFilter === 'active' ? !r.stoppedAt : !!r.stoppedAt
      );
    }
    
    // Mode filter
    if (modeFilter !== 'all') {
      filtered = filtered.filter(r => r.mode === modeFilter);
    }
    
    // Symbol filter
    if (symbolFilter !== 'all') {
      filtered = filtered.filter(r => r.symbol === symbolFilter);
    }
    
    // Aggressiveness filter
    if (aggressivenessFilter !== 'all') {
      filtered = filtered.filter(r => (r.aggressiveness || 'conservative') === aggressivenessFilter);
    }
    
    // Search text
    if (searchText) {
      filtered = filtered.filter(r => 
        r.symbol?.toLowerCase().includes(searchText.toLowerCase()) ||
        r.id?.toLowerCase().includes(searchText.toLowerCase())
      );
    }
    
    setFilteredRows(filtered);
  }, [rows, statusFilter, modeFilter, symbolFilter, aggressivenessFilter, searchText]);

  // Chargement initial et gestion du changement de mode
  React.useEffect(() => {
    console.log(`📋 Mode changed to: ${mode}`);
    
    // ✅ FIX: Invalider le cache de l'AUTRE mode lors du switch
    // Cela force un refresh propre des données
    const otherMode = mode === 'live' ? 'paper' : 'live';
    invalidateCache(otherMode as any, false);
    console.log(`🗑️ Invalidated cache for ${otherMode} mode on switch`);
    
    // Vérifier si on a des données cachées valides pour le mode actuel
    const hasCachedData = getCachedSessions(mode as any, false);
    const hasValidCache = !!hasCachedData;
    
    // Notifier le changement de mode
    notifyModeSwitch(mode as any, hasValidCache);
    
    // ✅ FIX: Toujours forcer un refresh lors du switch de mode
    // Cela garantit que les données affichées correspondent au mode actuel
    console.log(`⚡ Force refresh for mode=${mode}`);
    load(true);

    // Configurer l'auto-refresh pour ce mode
    setupAutoRefresh(mode as any, false);
  }, [mode, getCachedSessions, load, setupAutoRefresh, notifyModeSwitch, invalidateCache]);

  React.useEffect(()=>{ 
    form.setFieldsValue({ mode }); 
  }, [mode, form]);
  
  React.useEffect(()=>{
    let t:any; const pull = async ()=>{ try { const o = await api.overview(mode); setExBal(o?.exchangeBalance || null); } catch{} };
    pull(); t = setInterval(pull, 15000); return ()=> clearInterval(t);
  }, [mode]);
  
  // Load API key health status
  React.useEffect(() => {
    const loadApiKeyHealth = async () => {
      try {
        const health = await api.client.get('/api/user/api-keys/health');
        setApiKeyHealth(health.data);
      } catch (error) {
        console.error('Failed to load API key health:', error);
      }
    };
    loadApiKeyHealth();
  }, []);
  
  // Helper functions
  const formatDuration = (ms: number) => {
    const hours = Math.floor(ms / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60))}m`;
    return `${Math.floor(ms / (1000 * 60))}m`;
  };
  
  const getHealthColor = (status: string, score: number) => {
    if (status === 'error' || score < 30) return '#ff4d4f';
    if (status === 'warning' || score < 70) return '#faad14';
    return '#52c41a';
  };
  
  const exportToCsv = () => {
    const csvData = filteredRows.map(r => ({
      Symbol: r.symbol,
      Mode: r.mode,
      Status: r.stoppedAt ? 'Stopped' : 'Active',
      Aggressiveness: r.aggressiveness || 'conservative',
      'Win Rate %': (r.winRate || 0).toFixed(1),
      'PnL USD': (r.pnlUsd || 0).toFixed(2),
      'ROI %': (r.roiPct || 0).toFixed(2),
      'Readiness %': (r.tradingReadiness?.percent || 0).toFixed(0),
      'Total Trades': r.totalTrades || 0,
      'Started': new Date(r.startedAt).toISOString(),
      'Stopped': r.stoppedAt ? new Date(r.stoppedAt).toISOString() : ''
    }));
    
    if (csvData.length === 0) {
      message.warning('No data to export');
      return;
    }
    
    const csv = [
      Object.keys(csvData[0]).join(','),
      ...csvData.map(row => Object.values(row).join(','))
    ].join('\n');
    
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trading-sessions-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  const stop = async (id:string)=>{
    Modal.confirm({
      title: 'Stop session?',
      content: 'This will stop the agent. Close any open position now?',
      okText: 'Stop', 
      cancelText: 'Cancel', 
      okButtonProps:{ danger:true },
      onOk: async ()=>{
        try {
          await api.stopSession(id, true);
          // Invalider le cache après l'arrêt de la session
          invalidateSmartly('session_stopped', { mode: mode as any });
          message.success('Session stopped');
          await load(true); // Force refresh after cache invalidation
        } catch { 
          message.error('Stop failed'); 
        }
      }
    });
  };
  
  const bulkActions: MenuProps['items'] = [
    {
      key: 'stop-all',
      label: 'Stop All Active',
      danger: true,
      onClick: () => {
        const activeSessions = filteredRows.filter(r => !r.stoppedAt);
        if (activeSessions.length === 0) {
          message.info('No active sessions to stop');
          return;
        }
        Modal.confirm({
          title: `Stop ${activeSessions.length} active sessions?`,
          content: 'This will stop all active sessions and close open positions.',
          okText: 'Stop All',
          okButtonProps: { danger: true },
          onOk: async () => {
            for (const session of activeSessions) {
              try {
                await api.stopSession(session.id, true);
                // Invalider le cache pour chaque session arrêtée
                invalidateSmartly('session_stopped', { mode: session.mode as any });
              } catch (e) {
                console.error(`Failed to stop session ${session.id}:`, e);
              }
            }
            message.success(`Stopped ${activeSessions.length} sessions`);
            await load();
          }
        });
      }
    },
    {
      key: 'export',
      label: 'Export to CSV',
      icon: <DownloadOutlined />,
      onClick: exportToCsv
    }
  ];

  const relaunch = async (r:any)=>{
    const p = r.profile || {};
    setRestartSessionId(r.id);
    form.setFieldsValue({
      symbol: r.symbol,
      mode: r.mode,
      startBalanceUsd: r.startBalanceUsd,
      maxLeverage: Math.min(10, Math.max(1, p.maxLeverage ?? 4)),
      aggressiveness: p.aggressiveness || 'conservative',
      smartAutoMode: !!r.isSmartAgent,
    });
    setOpen(true);
  };

  return (
    <div style={{ 
      background: 'linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%)',
      minHeight: '100vh',
      padding: '24px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif'
    }}>
      <Space direction='vertical' style={{ width:'100%' }} size="large">
        {/* API Key Status Warning */}
        <ApiKeyStatusBanner 
          mode={mode as 'live' | 'paper'}
          onConfigureKeys={() => {
            // Open user settings modal - you'll need to implement this
            console.log('Open user settings for API keys');
          }}
          showTitle={false}
        />

        {/* Debug Tool for API Keys - Only show if there are issues */}
        {apiKeyHealth?.needsDiagnostics && (
          <ApiKeyDiagnostics />
        )}

        {/* Migration Tool for Broken Keys - Only show if migration needed */}
        {apiKeyHealth?.needsMigration && (
          <ApiKeyMigrationTool />
        )}
        
        <Card 
          style={{
            borderRadius: '16px',
            border: '1px solid #e2e8f0',
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.08)',
            background: 'white'
          }}
          title={
            <Row justify="space-between" align="middle">
              <Col>
                <Space size="large">
                  <span style={{
                    fontSize: '28px',
                    fontWeight: '700',
                    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif'
                  }}>Trading Sessions</span>
                  <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      background: 'linear-gradient(135deg, #10b981, #059669)',
                      padding: '6px 14px',
                      borderRadius: '20px',
                      color: 'white',
                      fontSize: '13px',
                      fontWeight: '600',
                      boxShadow: '0 2px 8px rgba(16, 185, 129, 0.3)'
                    }}>
                      <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'white' }} />
                      {filteredRows.filter(r => !r.stoppedAt).length} Active
                    </div>
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      background: 'linear-gradient(135deg, #64748b, #475569)',
                      padding: '6px 14px',
                      borderRadius: '20px',
                      color: 'white',
                      fontSize: '13px',
                      fontWeight: '600'
                    }}>
                      <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'white' }} />
                      {filteredRows.filter(r => !!r.stoppedAt).length} Stopped
                    </div>
                  </div>
                </Space>
              </Col>
              <Col>
                <Space size="middle">
                  <Tooltip title="Compact View">
                    <Switch 
                      checkedChildren={<EyeOutlined />} 
                      unCheckedChildren={<EyeOutlined />}
                      checked={compactView}
                      onChange={setCompactView}
                      style={{ 
                        background: compactView ? 'linear-gradient(135deg, #667eea, #764ba2)' : undefined,
                        boxShadow: compactView ? '0 2px 8px rgba(102, 126, 234, 0.3)' : undefined
                      }}
                    />
                  </Tooltip>
                  <Tooltip title={`Refresh (Cache: ${isCacheValid(mode as any, false) ? '✅ Valid' : '❌ Expired'})`}>
                    <Button 
                      icon={<ReloadOutlined />}
                      loading={sessionsLoading}
                      onClick={() => {
                        console.log('🔄 Manual refresh triggered');
                        load(true); // Force refresh
                      }}
                      style={{
                        borderRadius: '10px',
                        fontWeight: '500',
                        border: `1px solid ${isCacheValid(mode as any, false) ? '#10b981' : '#ef4444'}`,
                        background: 'white',
                        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
                        height: '40px',
                        color: isCacheValid(mode as any, false) ? '#10b981' : '#ef4444'
                      }}
                    >
                      {isCacheValid(mode as any, false) ? 'Cached' : 'Refresh'}
                    </Button>
                  </Tooltip>
                  <Dropdown menu={{ items: bulkActions }} placement="bottomRight">
                    <Button 
                      icon={<SettingOutlined />}
                      style={{
                        borderRadius: '10px',
                        fontWeight: '500',
                        border: '1px solid #e2e8f0',
                        background: 'white',
                        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
                        height: '40px'
                      }}
                    >
                      Actions
                    </Button>
                  </Dropdown>
                  <Button 
                    type='primary' 
                    icon={<PlayCircleOutlined />}
                    onClick={()=>{ 
                      setRestartSessionId(null);
                      form.setFieldsValue({ 
                        symbol:'BTC/USDT', 
                        mode, 
                        startBalanceUsd: undefined,
                        maxLeverage:4, 
                        aggressiveness:'conservative',
                        smartAutoMode: false
                      }); 
                      setOpen(true); 
                    }}
                    style={{
                      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                      border: 'none',
                      borderRadius: '10px',
                      fontWeight: '600',
                      boxShadow: '0 4px 12px rgba(102, 126, 234, 0.4)',
                      fontSize: '14px',
                      height: '40px'
                    }}
                  >
                    New Agent
                  </Button>
                </Space>
              </Col>
            </Row>
          }
        >
          {/* Modern Filters Section */}
          <div style={{
            background: 'linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%)',
            borderRadius: '12px',
            padding: '24px',
            marginBottom: '24px',
            border: '1px solid #e2e8f0'
          }}>
            <Row gutter={[16, 16]}>
              <Col xs={24} sm={12} md={6}>
                <Input
                  placeholder="Search symbol or ID..."
                  prefix={<SearchOutlined style={{ color: '#64748b' }} />}
                  value={searchText}
                  onChange={e => setSearchText(e.target.value)}
                  allowClear
                  style={{
                    borderRadius: '10px',
                    border: '1px solid #e2e8f0',
                    boxShadow: '0 2px 6px rgba(0, 0, 0, 0.08)',
                    fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif',
                    height: '40px'
                  }}
                />
              </Col>
              <Col xs={12} sm={6} md={4}>
                <Select
                  placeholder="Status"
                  style={{ 
                    width: '100%',
                    fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif'
                  }}
                  value={statusFilter}
                  onChange={setStatusFilter}
                  options={[
                    { value: 'all', label: 'All Status' },
                    { value: 'active', label: 'Active' },
                    { value: 'stopped', label: 'Stopped' }
                  ]}
                />
              </Col>
              <Col xs={12} sm={6} md={4}>
                <Select
                  placeholder="Mode"
                  style={{ 
                    width: '100%',
                    fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif'
                  }}
                  value={modeFilter}
                  onChange={setModeFilter}
                  options={[
                    { value: 'all', label: 'All Modes' },
                    { value: 'live', label: 'Live' },
                    { value: 'paper', label: 'Paper' }
                  ]}
                />
              </Col>
              <Col xs={12} sm={6} md={5}>
                <Select
                  placeholder="Symbol"
                  style={{ 
                    width: '100%',
                    fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif'
                  }}
                  value={symbolFilter}
                  onChange={setSymbolFilter}
                  options={[
                    { value: 'all', label: 'All Symbols' },
                    ...Array.from(new Set(rows.map(r => r.symbol))).map(s => ({ value: s, label: s }))
                  ]}
                />
              </Col>
              <Col xs={12} sm={6} md={5}>
                <Select
                  placeholder="Aggressiveness"
                  style={{ 
                    width: '100%',
                    fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif'
                  }}
                  value={aggressivenessFilter}
                  onChange={setAggressivenessFilter}
                  options={[
                    { value: 'all', label: 'All Levels' },
                    { value: 'conservative', label: 'Conservative' },
                    { value: 'reactive', label: 'Reactive' },
                    { value: 'aggressive', label: 'Aggressive' }
                  ]}
                />
              </Col>
            </Row>
          </div>
          
          {/* Modern Enhanced Table */}
          <Table 
            rowKey="id" 
            dataSource={filteredRows} 
            pagination={{ 
              pageSize: 20, 
              showSizeChanger: true,
              showQuickJumper: true,
              showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} sessions`,
              style: { fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif' }
            }}
            onRow={(r)=> ({ 
              onClick: async ()=> { 
                if (!r.stoppedAt) navigate(`/monitor/${r.id}`); 
              },
              style: { 
                cursor: !r.stoppedAt ? 'pointer' : 'default',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif'
              }
            })}
            scroll={{ x: compactView ? 800 : 1400 }}
            size={compactView ? 'small' : 'middle'}
            style={{
              borderRadius: '12px',
              border: '1px solid #f1f5f9',
              overflow: 'hidden',
              background: '#ffffff',
              boxShadow: '0 10px 24px -18px rgba(15, 23, 42, 0.35)'
            }}
            columns={[
              { 
                title:'Status', 
                width: 80,
                render:(_,r)=> (
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px'
                  }}>
                    <div style={{
                      width: '8px',
                      height: '8px',
                      borderRadius: '50%',
                      background: r.stoppedAt ? '#94a3b8' : '#10b981',
                      boxShadow: r.stoppedAt ? 'none' : '0 0 8px rgba(16, 185, 129, 0.5)'
                    }} />
                    <span style={{
                      fontSize: '12px',
                      fontWeight: '600',
                      color: r.stoppedAt ? '#64748b' : '#059669',
                      fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif'
                    }}>
                      {r.stoppedAt ? 'Stopped' : 'Active'}
                    </span>
                  </div>
                ),
                sorter: (a, b) => (a.stoppedAt ? 1 : 0) - (b.stoppedAt ? 1 : 0)
              },
              { 
                title:'Symbol', 
                dataIndex:'symbol',
                width: 120,
                render: (symbol, record) => {
                  // Check both isSmartAgent field and profileJson.isIntelligent
                  const isSmartAgent = record.isSmartAgent || record.profileJson?.isIntelligent;
                  return (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      {isSmartAgent && (
                        <span style={{ 
                          fontSize: '14px',
                          background: 'linear-gradient(135deg, #7c3aed, #6d28d9)',
                          borderRadius: '50%',
                          width: '16px',
                          height: '16px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center'
                        }}>
                          🧠
                        </span>
                      )}
                      <span style={{
                        fontWeight: '600',
                        fontSize: '14px',
                        color: isSmartAgent ? '#7c3aed' : '#1e293b',
                        fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif',
                      }}>
                        {symbol}
                      </span>
                      {isSmartAgent && (
                        <Tag color="purple" style={{ fontSize: '10px', lineHeight: '14px', padding: '0 4px' }}>
                          AUTO
                        </Tag>
                      )}
                    </div>
                  );
                },
                sorter: (a, b) => a.symbol.localeCompare(b.symbol)
              },
              { 
                title:'Mode', 
                dataIndex:'mode', 
                width: 80,
                render:(m)=> (
                  <Tag style={{ 
                    background: m === 'live' 
                      ? 'linear-gradient(135deg, #ef4444, #dc2626)' 
                      : 'linear-gradient(135deg, #3b82f6, #2563eb)',
                    color: 'white',
                    border: 'none',
                    fontWeight: '600',
                    borderRadius: '6px',
                    fontSize: '11px',
                    fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif'
                  }}>
                    {String(m).toUpperCase()}
                  </Tag>
                ),
                sorter: (a, b) => a.mode.localeCompare(b.mode)
              },
              { 
                title:'Type', 
                dataIndex:'isSmartAgent',
                width: 90,
                render:(_, record)=> {
                  const isSmartAgent = record.isSmartAgent || record.profileJson?.isIntelligent;
                  return isSmartAgent ? (
                    <Tag style={{ 
                      background: 'linear-gradient(135deg, #7c3aed, #6d28d9)', 
                      color: 'white', 
                      border: 'none',
                      fontWeight: '600',
                      borderRadius: '6px',
                      fontSize: '11px',
                      fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif'
                    }}>
                      🎯 AUTO
                    </Tag>
                  ) : (
                    <Tag style={{ 
                      background: 'rgba(248, 250, 252, 0.8)', 
                      color: '#64748b', 
                      border: '1px solid #e2e8f0',
                      fontWeight: '500',
                      borderRadius: '6px',
                      fontSize: '11px',
                      fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif'
                    }}>
                      MANUAL
                    </Tag>
                  );
                },
                sorter: (a, b) => {
                  const aIsSmartAgent = a.isSmartAgent || a.profileJson?.isIntelligent;
                  const bIsSmartAgent = b.isSmartAgent || b.profileJson?.isIntelligent;
                  return (bIsSmartAgent ? 1 : 0) - (aIsSmartAgent ? 1 : 0);
                }
              },
              { 
                title:'Aggressiveness', 
                dataIndex:'aggressiveness',
                width: 130,
                render:(a)=> {
                  const level = a || 'conservative';
                  const colors = {
                    conservative: '#64748b',
                    reactive: '#f59e0b', 
                    aggressive: '#ef4444'
                  };
                  return (
                    <Tag style={{ 
                      background: 'rgba(248, 250, 252, 0.8)', 
                      color: colors[level as keyof typeof colors] || '#64748b', 
                      border: `1px solid ${colors[level as keyof typeof colors] || '#e2e8f0'}`,
                      fontWeight: '500',
                      borderRadius: '6px',
                      fontSize: '11px',
                      fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif'
                    }}>
                      {level.toUpperCase()}
                    </Tag>
                  );
                },
                sorter: (a, b) => (a.aggressiveness || 'conservative').localeCompare(b.aggressiveness || 'conservative')
              },
              ...(compactView ? [] : [
                { 
                  title:'Health', 
                  width: 100,
                  render:(_:any,r:any)=> (
                    <Space>
                      <Progress 
                        type="circle" 
                        size={32}
                        percent={r.healthScore || 0}
                        strokeColor={getHealthColor(r.healthStatus, r.healthScore)}
                        format={() => ''}
                        strokeWidth={6}
                      />
                      {r.alertCount > 0 && (
                        <Badge 
                          count={r.alertCount} 
                          size="small"
                          style={{
                            background: '#ef4444',
                            fontSize: '10px'
                          }}
                        />
                      )}
                    </Space>
                  ),
                  sorter: (a: any, b: any) => (a.healthScore || 0) - (b.healthScore || 0)
                },
                { 
                  title:'Uptime', 
                  width: 80,
                  render:(_:any,r:any)=> (
                    <span style={{
                      fontSize: '12px',
                      color: '#64748b',
                      fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif',
                    }}>
                      {r.stoppedAt ? '-' : formatDuration(r.uptime || 0)}
                    </span>
                  ),
                  sorter: (a: any, b: any) => (a.uptime || 0) - (b.uptime || 0)
                },
                { 
                  title:'Trades', 
                  width: 100,
                  render:(_:any,r:any)=> (
                    <Space direction="vertical" size="small">
                      <span style={{ 
                        fontSize: '13px', 
                        color: '#1e293b',
                        fontWeight: '600',
                        fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif'
                      }}>
                        Total: {r.totalTrades || 0}
                      </span>
                      <span style={{ 
                        fontSize: '11px', 
                        color: '#64748b',
                      fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif',
                      }}>
                        Today: {r.todayTrades || 0}
                      </span>
                    </Space>
                  ),
                  sorter: (a: any, b: any) => (a.totalTrades || 0) - (b.totalTrades || 0)
                }
              ]),
              { 
                title:'Win Rate', 
                dataIndex:'winRate',
                width: 100,
                render:(v:any)=> {
                  const rate = Number(v||0);
                  return (
                    <span style={{ 
                      fontWeight: '700', 
                    fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif',
                      color: rate > 60 ? '#059669' : rate > 40 ? '#0ea5e9' : '#64748b',
                      fontSize: '14px'
                    }}>
                      {rate.toFixed(1)}%
                    </span>
                  );
                },
                sorter: (a, b) => (a.winRate || 0) - (b.winRate || 0)
              },
              { 
                title:'PnL (USD)', 
                width: 120,
                render:(_:any,r:any)=> (
                  <Space direction="vertical" size="small">
                    <span style={{ 
                      color: (r.pnlUsd || 0) >= 0 ? '#10b981' : '#dc2626',
                      fontWeight: '700',
                      fontSize: '14px',
                      fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif'
                    }}>
                      ${(r.pnlUsd || 0).toFixed(2)}
                    </span>
                    {!compactView && (
                      <span style={{ 
                        fontSize: '11px', 
                        color: '#64748b',
                      fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif'
                      }}>
                        24h: ${(r.pnl24h || 0).toFixed(2)}
                      </span>
                    )}
                  </Space>
                ),
                sorter: (a, b) => (a.pnlUsd || 0) - (b.pnlUsd || 0)
              },
              {
                title:'Activity',
                width: 140,
                render:(_:any,r:any)=> (
                  <Space direction="vertical" size={2}>
                    <span style={{
                      fontWeight: 600,
                      color: '#0f172a',
                      fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif'
                    }}>
                      {r.pendingOrdersCount || 0} open orders
                    </span>
                    <span style={{
                      fontSize: '11px',
                      color: '#64748b',
                      fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif'
                    }}>
                      {r.totalTrades || 0} trades · {r.todayTrades || 0} today
                    </span>
                  </Space>
                ),
                sorter: (a, b) => (a.pendingOrdersCount || 0) - (b.pendingOrdersCount || 0)
              },
              { 
                title:'Readiness', 
                width: 120,
                render:(_:any,r:any)=> {
                  if (r.stoppedAt) {
                    return <Tag color="#94a3b8">STOPPED</Tag>;
                  }
                  const readiness = r.tradingReadiness;
                  if (!readiness) {
                    return <Tag color="#d9d9d9">NO DATA</Tag>;
                  }
                  const color = readiness.canTrade ? '#16a34a' : '#dc2626';
                  const percent = readiness.percent ?? 0;
                  return (
                    <Tooltip
                      title={
                        <div>
                          <div style={{ fontWeight: 600 }}>{readiness.reason}</div>
                          {readiness.qualityScore && (
                            <div style={{ marginTop: 4 }}>
                              Quality: {readiness.qualityScore.current}/{readiness.qualityScore.required}
                            </div>
                          )}
                        </div>
                      }
                    >
                      <Space direction="vertical" size={6}>
                        <div
                          style={{
                            width: 118,
                            height: 6,
                            borderRadius: 999,
                            background: '#e2e8f0',
                            overflow: 'hidden'
                          }}
                        >
                          <div
                            style={{
                              width: `${Math.round(Math.max(4, Math.min(100, percent)))}%`,
                              height: '100%',
                              background: color,
                              transition: 'width 0.3s ease'
                            }}
                          />
                        </div>
                        <Space size={6} align="center">
                          <Badge status={readiness.canTrade ? 'success' : 'error'} text={readiness.canTrade ? 'Ready' : 'Blocked'} />
                          <span style={{ fontSize: '12px', color: '#475569', fontWeight: 600 }}>
                            {Math.round(Math.max(0, Math.min(100, percent)))}%
                          </span>
                        </Space>
                      </Space>
                    </Tooltip>
                  );
                },
                sorter: (a, b) => (a.tradingReadiness?.percent || 0) - (b.tradingReadiness?.percent || 0)
              },
              { 
                title:'ROI %', 
                dataIndex:'roiPct',
                width: 80,
                render:(v:any)=> {
                  const roi = Number(v||0);
                  return (
                    <span style={{ 
                      color: roi >= 0 ? '#10b981' : '#dc2626',
                      fontWeight: '700',
                      fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif',
                      fontSize: '14px'
                    }}>
                      {roi.toFixed(2)}%
                    </span>
                  );
                },
                sorter: (a, b) => (a.roiPct || 0) - (b.roiPct || 0)
              },
              ...(compactView ? [] : [
                { 
                  title:'Position', 
                  width: 120,
                  render:(_:any,r:any)=> {
                    if (!r.currentPosition) return (
                      <span style={{ color: '#94a3b8', fontSize: '12px' }}>-</span>
                    );
                    const pos = r.currentPosition;
                    return (
                      <Space direction="vertical" size="small">
                        <Tag style={{
                          background: pos.side === 'long' 
                            ? 'linear-gradient(135deg, #10b981, #059669)'
                            : 'linear-gradient(135deg, #ef4444, #dc2626)',
                          color: 'white',
                          border: 'none',
                          margin: 0,
                          fontWeight: '600',
                          fontSize: '11px',
                          borderRadius: '6px'
                        }}>
                          {pos.side?.toUpperCase()} {pos.size?.toFixed(4)}
                        </Tag>
                        <span style={{ 
                          fontSize: '11px',
                          color: (pos.unrealizedPnl || 0) >= 0 ? '#059669' : '#dc2626',
                          fontWeight: '600',
                          fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif',
                        }}>
                          ${(pos.unrealizedPnl || 0).toFixed(2)}
                        </span>
                      </Space>
                    );
                  }
                },
                { 
                  title:'Orders', 
                  width: 90,
                  render:(_:any,r:any)=> {
                    if (r.pendingOrdersCount === 0) return (
                      <span style={{ color: '#94a3b8', fontSize: '12px' }}>-</span>
                    );
                    return (
                      <Tooltip title={`${r.pendingOrdersCount} pending order(s)`}>
                        <div style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          background: 'linear-gradient(135deg, #f59e0b, #d97706)',
                          padding: '4px 8px',
                          borderRadius: '12px',
                          color: 'white',
                          fontSize: '11px',
                          fontWeight: '600',
                          cursor: 'pointer'
                        }}>
                          <div style={{ width: '4px', height: '4px', borderRadius: '50%', background: 'white' }} />
                          {r.pendingOrdersCount}
                        </div>
                      </Tooltip>
                    );
                  }
                },
                { 
                  title:'Diagnostics', 
                  width: 120,
                  render:(_:any,r:any)=> {
                    if (r.stoppedAt) {
                      return (
                        <span style={{ color: '#94a3b8', fontSize: '12px' }}>Inactive</span>
                      );
                    }
                    
                    return (
                      <div style={{
                        padding: '4px 8px',
                        borderRadius: '8px',
                        background: '#3b82f6',
                        border: '1px solid #2563eb',
                        color: 'white',
                        fontSize: '11px',
                        fontWeight: '600',
                        textAlign: 'center',
                        cursor: 'pointer'
                      }}>
                        Click to View
                      </div>
                    );
                  }
                },
                { 
                  title:'Max DD', 
                  width: 80,
                  render:(_:any,r:any)=> (
                    <span style={{ 
                      color: '#dc2626', 
                      fontSize: '12px',
                      fontWeight: '600',
                      fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif',
                    }}>
                      {(r.maxDrawdown || 0).toFixed(2)}%
                    </span>
                  ),
                  sorter: (a: any, b: any) => (a.maxDrawdown || 0) - (b.maxDrawdown || 0)
                }
              ]),
              { 
                title:'Started', 
                dataIndex:'startedAt',
                width: 120,
                render:(v)=> (
                  <span style={{
                    fontSize: '12px',
                    color: '#64748b',
                      fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif',
                  }}>
                    {new Date(v).toLocaleString('en-US', { 
                      month: 'short', 
                      day: 'numeric', 
                      hour: '2-digit', 
                      minute: '2-digit' 
                    })}
                  </span>
                ),
                sorter: (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
              },
              { 
                title:'Actions', 
                width: 120,
                render:(_,r)=> {
                  if (!r.stoppedAt) {
                    return (
                      <Button 
                        danger 
                        size="small"
                        icon={<StopOutlined />}
                        onClick={(e)=> { e.stopPropagation(); stop(r.id); }}
                        style={{
                          borderRadius: '8px',
                          fontWeight: '500',
                          height: '32px'
                        }}
                      >
                        Stop
                      </Button>
                    );
                  } else {
                    return (
                      <Space>
                        <Button 
                          size="small"
                          icon={<ReloadOutlined />}
                          onClick={(e)=>{ e.stopPropagation(); relaunch(r); }}
                          style={{
                            borderRadius: '8px',
                            fontWeight: '500',
                            border: '1px solid #e2e8f0',
                            height: '32px'
                          }}
                        >
                          Restart
                        </Button>
                        <Button 
                          danger 
                          size="small"
                          icon={<DeleteOutlined />}
                          onClick={(e)=>{
                            e.stopPropagation();
                            Modal.confirm({ 
                              title:'Delete session?', 
                              content:'This will permanently delete session and all associated data.', 
                              okText:'Delete', 
                              okButtonProps:{ danger:true }, 
                              onOk: async ()=>{
                                try { 
                                  await api.deleteSession(r.id); 
                                  message.success('Deleted'); 
                                  await load(); 
                                } catch { 
                                  message.error('Delete failed'); 
                                }
                              } 
                            });
                          }}
                          style={{
                            borderRadius: '8px',
                            fontWeight: '500',
                            height: '32px'
                          }}
                        >
                          Delete
                        </Button>
                      </Space>
                    );
                  }
                }
              }
            ]}
          expandedRowRender={(record) => (
              <TradingDiagnosticsCollapsible 
                sessionId={record.id} 
                isActive={!record.stoppedAt} 
                initialDiagnostics={record.diagnosticsInitial}
              />
            )}
          />
        </Card>

        {/* Modern Modal */}
        <Modal 
          open={open} 
          title={
            <span style={{
              fontSize: '20px',
              fontWeight: '600',
              color: '#1e293b',
              fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif'
            }}>
              {restartSessionId ? '🔄 Restart Agent' : '🚀 Activate New Agent'}
            </span>
          }
          okText={restartSessionId ? 'Restart Agent' : 'Start Agent'} 
          cancelText='Cancel' 
          onCancel={()=> { setOpen(false); setRestartSessionId(null); }} 
          confirmLoading={starting}
          style={{
            fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif'
          }}
          onOk={async ()=>{
            let hide: (() => void) | null = null;
            const sessionIdForRestart = restartSessionId;
            const isRestart = Boolean(sessionIdForRestart);
            try {
              setStarting(true);
              const v = await form.validateFields();

              console.log('🔍 Form values BEFORE processing:', v);
              console.log('🎯 Auto-Select Mode:', v.smartAutoMode);

              const level = (v.aggressiveness || 'conservative') as AggressivenessLevel;
              const preset = AGGRESSIVENESS_PRESETS[level];
              v.riskPerTradePct = preset.risk;
              v.dailyLossLimitPct = preset.dailyLoss;
              if (typeof v.budgetPct === 'undefined') v.budgetPct = 100;

              if (v.smartAutoMode && !isRestart) {
                console.log('🔄 Processing Auto-Select mode...');
                console.log('📋 Symbol before delete:', v.symbol);
                delete v.symbol;
                console.log('📋 Symbol after delete:', v.symbol);
                v.isSmartAgent = true;
                v.smartConfig = {
                  minHoldDuration: 24 * 60 * 60 * 1000,
                  rescanInterval: 6 * 60 * 60 * 1000,
                  momentumThreshold: 0.5,
                  volumeThreshold: 10000
                };

                if (!v.smartConfig.minHoldDuration || !v.smartConfig.rescanInterval) {
                  message.error('Smart Agent configuration is invalid. Please try again.');
                  setStarting(false);
                  return;
                }
              } else if (isRestart) {
                delete v.smartAutoMode;
                delete v.smartConfig;
              }

              if (isRestart && sessionIdForRestart) {
                v.sessionId = sessionIdForRestart;
              }

              if (String(v.mode) === 'live') {
                try {
                  const apiStatus = await api.client.get('/api/user/api-keys/status');
                  if (!apiStatus.data.canUseLive) {
                    message.error('Live trading requires valid API keys. Please configure your Crypto.com API keys first.');
                    setStarting(false);
                    return;
                  }
                } catch (error) {
                  message.error('Unable to verify API keys. Please check your configuration.');
                  setStarting(false);
                  return;
                }
              }

              if (String(v.mode) === 'live' && exBal?.totalUsd != null && v.startBalanceUsd != null) {
                v.startBalanceUsd = Math.min(Number(v.startBalanceUsd || 0), Number(exBal.totalUsd || 0));
              }

              hide = message.loading(isRestart ? 'Restarting agent...' : 'Starting agent...', 0);
              setOpen(false);

              const res = await (isRestart
                ? api.client.post('/api/agent/restart', v)
                : api.client.post('/api/agent/start', v));

              if (hide) hide();

              const cacheEvent = isRestart ? 'settings_changed' : 'session_created';
              const sessionIdentifier = sessionIdForRestart || (res as any)?.data?.id;
              invalidateSmartly(cacheEvent, { mode: v.mode as any, sessionId: sessionIdentifier });

              if (isRestart) {
                message.success('Agent restarted successfully!');
              } else {
                message.success(v.smartAutoMode ? 'Auto-Select Agent started! Scanning for best opportunities...' : 'Session started successfully!');
              }

              await load(true);

              if (isRestart && sessionIdForRestart) {
                navigate(`/monitor/${sessionIdForRestart}`);
              } else {
                const sid = (res as any)?.data?.id;
                if (sid) navigate(`/monitor/${sid}`); else {
                  const list = await api.listSessions(mode);
                  const active = list.find((r:any)=> !r.stoppedAt);
                  if (active) navigate(`/monitor/${active.id}`);
                }
              }
            } catch (e: any) {
              if (typeof hide === 'function') hide();
              const msg = String(e?.response?.data?.error || e?.message || e);
              if (!isRestart && msg.includes('active_session_exists')) {
                message.warning('Stop the active session first.');
              } else {
                message.error(isRestart ? 'Failed to restart session' : 'Failed to start session');
              }
            } finally {
              setStarting(false);
              setRestartSessionId(null);
            }
          }}
        >
          <Form 
            layout='vertical' 
            form={form} 
            initialValues={{ 
              mode, 
              maxLeverage:4, 
              aggressiveness:'conservative',
              smartAutoMode: false
            }}
            style={{
              fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif'
            }}
          >
            {/* Auto-Select Mode Toggle */}
            <Form.Item 
              label={
                <Space>
                  <RocketOutlined style={{ color: '#722ed1' }} />
                  <span style={{ fontWeight: 600 }}>Auto-Select Mode</span>
                </Space>
              } 
              name='smartAutoMode' 
              valuePropName="checked"
              tooltip="Automatically analyzes 50+ cryptocurrencies and selects the best performing one. Uses the same advanced trading logic, but switches to new opportunities when they arise."
            >
              <Switch 
                checkedChildren="🎯 Auto" 
                unCheckedChildren="Manual" 
                style={{
                  background: smartAutoMode ? 'linear-gradient(135deg, #722ed1, #9254de)' : undefined
                }}
                disabled={!!restartSessionId}
              />
            </Form.Item>

            {/* Smart Mode Info Banner */}
            {smartAutoMode && (
              <div style={{
                background: 'linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%)',
                border: '1px solid #0ea5e9',
                borderRadius: '10px',
                padding: '16px',
                marginBottom: '16px'
              }}>
                <Space direction="vertical" size="small" style={{ width: '100%' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <ThunderboltOutlined style={{ color: '#0ea5e9', fontSize: '16px' }} />
                    <span style={{ fontWeight: 600, color: '#0369a1' }}>Auto-Select Agent Configuration</span>
                  </div>
                  <div style={{ fontSize: '12px', color: '#0369a1', lineHeight: '1.5' }}>
                    • <strong>Crypto Selection:</strong> Analyzes 50+ cryptocurrencies and selects the best performer<br/>
                    • <strong>Same Trading Logic:</strong> Uses identical strategies and risk management as manual mode<br/>
                    • <strong>Automatic Switching:</strong> Changes to new opportunities when better ones are found<br/>
                    • <strong>High Liquidity Focus:</strong> Only trades cryptocurrencies with sufficient volume
                  </div>
                </Space>
              </div>
            )}

            {/* Traditional Symbol Selection - Hidden in Smart Mode */}
            {!smartAutoMode && (
              <Form.Item label='Trading Symbol' name='symbol' rules={[{ required: !smartAutoMode }]}>
                <Select
                  showSearch
                  placeholder='Select trading symbol'
                  options={commonSymbols.map(s=>({ value: s, label: s }))}
                  filterOption={(input, option)=> (option?.label as string).toLowerCase().includes(input.toLowerCase())}
                  style={{
                    fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif'
                  }}
                  disabled={!!restartSessionId}
                />
              </Form.Item>
            )}

            {/* Current Symbol Display for Smart Mode */}
            {smartAutoMode && (
              <div style={{
                background: '#f8fafc',
                border: '1px solid #e2e8f0',
                borderRadius: '8px',
                padding: '12px',
                marginBottom: '16px'
              }}>
                <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '4px' }}>
                  Trading Symbol
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <RocketOutlined style={{ color: '#722ed1' }} />
                  <span style={{ fontWeight: 600, color: '#1e293b' }}>
                    Will be auto-selected from best opportunities
                  </span>
                </div>
              </div>
            )}
            <Form.Item label='Trading Mode'>
              <Tag style={{ 
                background: modeVal === 'live' 
                  ? 'linear-gradient(135deg, #ef4444, #dc2626)' 
                  : 'linear-gradient(135deg, #3b82f6, #2563eb)',
                color: 'white',
                border: 'none',
                fontWeight: '600',
                borderRadius: '6px',
                padding: '4px 12px',
                fontSize: '12px',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif'
              }}>
                {String(modeVal ?? mode).toUpperCase()}
              </Tag>
              <Form.Item name='mode' hidden>
                <Input type='hidden' />
              </Form.Item>
            </Form.Item>
            {String(modeVal||'paper') !== 'live' && (
              <Form.Item 
                label='Start balance USD (optional)' 
                name='startBalanceUsd' 
                tooltip={exBal? `Exchange: Free $${Number(exBal.freeUsd||0).toFixed(2)} • Equity $${Number(exBal.totalUsd||0).toFixed(2)}`: undefined}
              >
                <InputNumber 
                  style={{ width: '100%' }} 
                  min={0} 
                  max={exBal?.totalUsd ?? undefined} 
                />
              </Form.Item>
            )}
            <Form.Item label='Max leverage' name='maxLeverage' rules={[{ type:'number', min:1, max:10 }]}> 
              <div style={{ padding: '0 4px' }}>
                <Slider
                  min={1}
                  max={10}
                  step={1}
                  tooltip={{ formatter: (value?: number) => `${value}x` }}
                  disabled={!!restartSessionId}
                />
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: '12px',
                  color: '#475569',
                  marginTop: 8
                }}>
                  <span>Leverage: <strong>{Number(leverageValue || 1)}x</strong></span>
                  <span>Cap 10x</span>
                </div>
              </div>
            </Form.Item>
            <Form.Item label='Aggressiveness Level' name='aggressiveness'>
              <Select
                options={[
                  { value:'conservative', label:'Conservative' },
                  { value:'reactive', label:'Reactive' },
                  { value:'aggressive', label:'Aggressive' }
                ]}
              />
            </Form.Item>
            <div style={{
              background: '#f8fafc',
              border: '1px solid #e2e8f0',
              borderRadius: '10px',
              padding: '12px 16px',
              marginTop: -4,
              marginBottom: 16
            }}>
              <Space direction="vertical" size={4}>
                <span style={{ fontWeight: 600, color: '#1e293b' }}>Risk profile derived automatically</span>
                <span style={{ color: '#475569' }}>
                  Risk per trade: <strong>{riskPreset.risk.toFixed(1)}%</strong>
                </span>
                <span style={{ color: '#475569' }}>
                  Daily loss cap: <strong>{riskPreset.dailyLoss.toFixed(1)}%</strong>
                </span>
                <span style={{ color: '#64748b', fontSize: 12 }}>{riskPreset.note}</span>
              </Space>
            </div>
          </Form>
        </Modal>
      </Space>
    </div>
  );
}

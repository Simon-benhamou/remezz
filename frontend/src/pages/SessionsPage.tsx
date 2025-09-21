import React from 'react';
import { Card, Table, Tag, Button, Space, message, Modal, Form, Input, InputNumber, Select, Row, Col, Tooltip, Progress, Badge, Switch, Dropdown, MenuProps } from 'antd';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useMode } from '../contexts/ModeContext';
import { SearchOutlined, FilterOutlined, DownloadOutlined, EyeOutlined, SettingOutlined, PlayCircleOutlined, StopOutlined, DeleteOutlined, ReloadOutlined, RocketOutlined, ThunderboltOutlined } from '@ant-design/icons';
import TradingDiagnosticsOverview from '../components/TradingDiagnosticsOverview';
import ApiKeyStatusBanner from '../components/ApiKeyStatusBanner';
import ApiKeyDiagnostics from '../components/ApiKeyDiagnostics';
import ApiKeyMigrationTool from '../components/ApiKeyMigrationTool';

export default function SessionsPage(){
  const [rows, setRows] = React.useState<any[]>([]);
  const [filteredRows, setFilteredRows] = React.useState<any[]>([]);
  const [open, setOpen] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [form] = Form.useForm();
  const navigate = useNavigate();
  const [exBal, setExBal] = React.useState<{ totalUsd?: number; freeUsd?: number } | null>(null);
  const { mode } = useMode();
  const modeVal = Form.useWatch?.('mode', form);
  const smartAutoMode = Form.useWatch?.('smartAutoMode', form);
  const [apiKeyHealth, setApiKeyHealth] = React.useState<any>(null);
  
  // Filter states
  const [statusFilter, setStatusFilter] = React.useState<string>('all');
  const [modeFilter, setModeFilter] = React.useState<string>('all');
  const [symbolFilter, setSymbolFilter] = React.useState<string>('all');
  const [aggressivenessFilter, setAggressivenessFilter] = React.useState<string>('all');
  const [searchText, setSearchText] = React.useState<string>('');
  const [compactView, setCompactView] = React.useState<boolean>(true);
  
  const commonSymbols = ['BTC/USDT','ETH/USDT','SOL/USDT','XRP/USDT','BNB/USDT','ADA/USDT','AVAX/USDT','DOGE/USDT','TON/USDT','LINK/USDT','MATIC/USDT','DOT/USDT'];
  
  const load = React.useCallback(async ()=>{ 
    try { 
      const sessions = await api.listSessions(mode);
      // Enrich sessions with additional data
      const enrichedSessions = await Promise.all(sessions.map(async (session: any) => {
        try {
          // Get additional metrics
          const perf = session.id ? await api.getPerf(session.id).catch(() => null) : null;
          const health = session.id && !session.stoppedAt ? await api.getHealth(session.id).catch(() => null) : null;
          const agentState = session.id && !session.stoppedAt ? await api.getAgentState(session.id).catch(() => null) : null;
          
          // Get pending orders
          const orders = session.id ? await api.getOrders(session.id).catch(() => []) : [];
          const pendingOrders = orders.filter((o: any) => 
            ['new', 'open', 'partially_filled'].includes(o.status)
          );
          
          // Get trading diagnostics for active sessions
          const diagnostics = session.id && !session.stoppedAt ? 
            await api.getDiagnostics(session.id).catch(() => null) : null;
          
          return {
            ...session,
            // Performance metrics
            totalTrades: perf?.totalTrades || 0,
            todayTrades: perf?.todayTrades || 0,
            pnl24h: perf?.pnl24h || 0,
            maxDrawdown: perf?.maxDrawdown || 0,
            uptime: session.startedAt ? Date.now() - new Date(session.startedAt).getTime() : 0,
            lastActivity: perf?.lastTradeAt || session.startedAt,
            
            // Position info
            currentPosition: agentState?.position || null,
            unrealizedPnl: agentState?.position?.unrealizedPnl || 0,
            
            // Orders info
            pendingOrders: pendingOrders,
            pendingOrdersCount: pendingOrders.length,
            
            // Trading diagnostics
            tradeVibes: diagnostics?.tradeVibes || null,
            marketTriggers: diagnostics?.marketTriggers || null,
            tradingSignal: diagnostics?.tradingSignal || 'neutral',
            
            // Health status
            healthStatus: health?.status || 'unknown',
            healthScore: health?.score || 0,
            alertCount: health?.alerts?.length || 0,
          };
        } catch {
          return session;
        }
      }));
      
      setRows(enrichedSessions);
    } catch(e) {
      console.error('Failed to load sessions:', e);
    } 
  }, [mode]);
  
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

  React.useEffect(()=>{ load(); }, [load]);
  React.useEffect(()=>{ form.setFieldsValue({ mode }); }, [mode, form]);
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
          message.success('Session stopped');
          await load();
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
    form.setFieldsValue({
      symbol: r.symbol,
      mode,
      startBalanceUsd: r.startBalanceUsd,
      riskPerTradePct: Math.min(5, Math.max(0.5, p.riskPerTradePct ?? 1.5)),
      maxLeverage: Math.min(10, Math.max(1, p.maxLeverage ?? 4)),
      dailyLossLimitPct: p.dailyLossLimitPct ?? 3.5,
      budgetPct: p.budgetPct ?? 100,
      aggressiveness: p.aggressiveness || 'conservative',
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
        {/* Trading Diagnostics Overview */}
        <TradingDiagnosticsOverview activeSessions={filteredRows.filter(r => !r.stoppedAt)} />
        
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
                      form.setFieldsValue({ 
                        symbol:'BTC/USDT', 
                        mode, 
                        riskPerTradePct:1.5, 
                        maxLeverage:4, 
                        dailyLossLimitPct:3.5, 
                        budgetPct:100,
                        aggressiveness:'conservative'
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
              border: '1px solid #e2e8f0',
              overflow: 'hidden'
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
                render: (symbol) => (
                  <span style={{
                    fontWeight: '600',
                    fontSize: '14px',
                    color: '#1e293b',
                      fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif',
                  }}>
                    {symbol}
                  </span>
                ),
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
                  title:'Trade Signal', 
                  width: 100,
                  render:(_:any,r:any)=> {
                    if (!r.tradingSignal || r.tradingSignal === 'neutral') return (
                      <span style={{ color: '#94a3b8', fontSize: '12px' }}>Neutral</span>
                    );
                    
                    const signalColors = {
                      bullish: '#10b981',
                      bearish: '#ef4444',
                      strong_buy: '#059669',
                      strong_sell: '#dc2626',
                      caution: '#f59e0b'
                    };
                    
                    const color = signalColors[r.tradingSignal as keyof typeof signalColors] || '#64748b';
                    
                    return (
                      <div style={{
                        padding: '2px 8px',
                        borderRadius: '8px',
                        background: `${color}20`,
                        border: `1px solid ${color}40`,
                        color: color,
                        fontSize: '11px',
                        fontWeight: '600',
                        textAlign: 'center'
                      }}>
                        {r.tradingSignal.replace('_', ' ').toUpperCase()}
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
              🚀 Activate New Agent
            </span>
          }
          okText='Start Agent' 
          cancelText='Cancel' 
          onCancel={()=> setOpen(false)} 
          confirmLoading={starting}
          style={{
            fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif'
          }}
          onOk={async ()=>{
            try {
              setStarting(true);
              const v = await form.validateFields();
              
              // If Smart Auto Mode is enabled, remove symbol requirement and add smart mode flags
              if (v.smartAutoMode) {
                delete v.symbol; // Remove symbol requirement
                v.isSmartAgent = true; // Flag for backend
                v.smartConfig = {
                  minHoldDuration: 24 * 60 * 60 * 1000, // 24h in ms
                  rescanInterval: 6 * 60 * 60 * 1000,    // 6h in ms
                  momentumThreshold: 0.5,                 // Très bas pour garantir des résultats
                  volumeThreshold: 10000                  // Volume minimum très bas ($10K)
                };
                
                // Validate smart config
                if (!v.smartConfig.minHoldDuration || !v.smartConfig.rescanInterval) {
                  message.error('Smart Agent configuration is invalid. Please try again.');
                  setStarting(false);
                  return;
                }
              }
              
              // Check API keys for live mode
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
              
              // Front guard: cap startBalanceUsd to exchange equity when live
              if (String(v.mode) === 'live' && exBal?.totalUsd != null && v.startBalanceUsd != null) {
                v.startBalanceUsd = Math.min(Number(v.startBalanceUsd||0), Number(exBal.totalUsd||0));
              }
              const res = await api.client.post('/api/agent/start', v);
              message.success(v.smartAutoMode ? 'Smart Auto Agent started! Scanning for best opportunities...' : 'Session started successfully!');
              setOpen(false);
              await load();
              // Navigate to the created session (preferred), fallback to first active
              const sid = (res as any)?.data?.id;
              if (sid) navigate(`/monitor/${sid}`); else {
                const list = await api.listSessions(mode);
                const active = list.find((r:any)=> !r.stoppedAt);
                if (active) navigate(`/monitor/${active.id}`);
              }
            } catch (e: any) {
              const msg = String(e?.response?.data?.error || e?.message || e);
              if (msg.includes('active_session_exists')) message.warning('Stop the active session first.');
              else message.error('Failed to start session');
            } finally {
              setStarting(false);
            }
          }}
        >
          <Form 
            layout='vertical' 
            form={form} 
            initialValues={{ 
              mode, 
              riskPerTradePct:1.5, 
              maxLeverage:4, 
              dailyLossLimitPct:3.5, 
              budgetPct:100, 
              aggressiveness:'conservative',
              smartAutoMode: false
            }}
            style={{
              fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif'
            }}
          >
            {/* Smart Auto Mode Toggle */}
            <Form.Item 
              label={
                <Space>
                  <RocketOutlined style={{ color: '#722ed1' }} />
                  <span style={{ fontWeight: 600 }}>Smart Auto Mode</span>
                </Space>
              } 
              name='smartAutoMode' 
              valuePropName="checked"
              tooltip="Automatically scans and selects the best performing cryptocurrencies. Agent will switch to new opportunities every 24h or when trades complete."
            >
              <Switch 
                checkedChildren="🤖 Smart" 
                unCheckedChildren="Manual" 
                style={{
                  background: smartAutoMode ? 'linear-gradient(135deg, #722ed1, #9254de)' : undefined
                }}
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
                    <span style={{ fontWeight: 600, color: '#0369a1' }}>Smart Auto Agent Configuration</span>
                  </div>
                  <div style={{ fontSize: '12px', color: '#0369a1', lineHeight: '1.5' }}>
                    • <strong>Auto Symbol Selection:</strong> Scans 20+ popular cryptocurrencies every 6 hours<br/>
                    • <strong>Minimum Hold:</strong> 24 hours per position (or until trade completion)<br/>
                    • <strong>Smart Selection:</strong> Finds the best available crypto regardless of momentum<br/>
                    • <strong>High Liquidity:</strong> Focuses on major cryptocurrencies for optimal trading
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
            <Form.Item label='Risk % per trade' name='riskPerTradePct' rules={[{ type:'number', min:0.5, max:5 }]}>
              <InputNumber style={{ width: '100%' }} min={0.5} max={5} step={0.1} />
            </Form.Item>
            <Form.Item label='Max leverage' name='maxLeverage' rules={[{ type:'number', min:1, max:10 }]}>
              <InputNumber style={{ width: '100%' }} min={1} max={10} step={1} />
            </Form.Item>
            <Form.Item label='Daily loss limit %' name='dailyLossLimitPct' rules={[{ type:'number', min:3, max:4 }]}>
              <InputNumber style={{ width: '100%' }} min={3} max={4} step={0.1} />
            </Form.Item>
            <Form.Item label='Budget % of balance (0-100)' name='budgetPct' rules={[{ type:'number', min:10, max:100 }]}>
              <InputNumber style={{ width: '100%' }} min={10} max={100} step={5} />
            </Form.Item>
            <Form.Item label='Aggressiveness Level' name='aggressiveness'>
              <Select
                options={[
                  { value:'conservative', label:'Conservative (default)' },
                  { value:'reactive', label:'Reactive' },
                  { value:'aggressive', label:'Aggressive (controlled)' }
                ]}
              />
            </Form.Item>
          </Form>
        </Modal>
      </Space>
    </div>
  );
}
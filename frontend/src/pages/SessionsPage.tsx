import React from 'react';
import { Card, Table, Tag, Button, Space, message, Modal, Form, Input, InputNumber, Select, Row, Col, Tooltip, Progress, Badge, Switch, Dropdown, MenuProps } from 'antd';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useMode } from '../contexts/ModeContext';
import { SearchOutlined, FilterOutlined, DownloadOutlined, EyeOutlined, SettingOutlined } from '@ant-design/icons';

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
      okText: 'Stop', cancelText: 'Cancel', okButtonProps:{ danger:true },
      onOk: async ()=>{
        try {
          await api.stopSession(id, true);
          message.success('Session stopped');
          await load();
        } catch { message.error('Stop failed'); }
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
    <Space direction='vertical' style={{ width:'100%' }}>
      <Card title={
        <Row justify="space-between" align="middle">
          <Col>
            <Space>
              <span>Trading Sessions</span>
              <Badge count={filteredRows.filter(r => !r.stoppedAt).length} showZero color="green" />
              <Badge count={filteredRows.filter(r => !!r.stoppedAt).length} showZero color="gray" />
            </Space>
          </Col>
          <Col>
            <Space>
              <Tooltip title="Compact View">
                <Switch 
                  checkedChildren={<EyeOutlined />} 
                  unCheckedChildren={<EyeOutlined />}
                  checked={compactView}
                  onChange={setCompactView}
                />
              </Tooltip>
              <Dropdown menu={{ items: bulkActions }} placement="bottomRight">
                <Button icon={<SettingOutlined />}>Actions</Button>
              </Dropdown>
              <Button type='primary' onClick={()=>{ 
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
              }}>+ New Agent</Button>
            </Space>
          </Col>
        </Row>
      }>
        {/* Filters Row */}
        <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
          <Col xs={24} sm={12} md={6}>
            <Input
              placeholder="Search symbol or ID..."
              prefix={<SearchOutlined />}
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              allowClear
            />
          </Col>
          <Col xs={12} sm={6} md={4}>
            <Select
              placeholder="Status"
              style={{ width: '100%' }}
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
              style={{ width: '100%' }}
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
              style={{ width: '100%' }}
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
              style={{ width: '100%' }}
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
        
        {/* Unified Enhanced Table */}
        <Table 
          rowKey="id" 
          dataSource={filteredRows} 
          pagination={{ 
            pageSize: 20, 
            showSizeChanger: true,
            showQuickJumper: true,
            showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} sessions`
          }}
          onRow={(r)=> ({ onClick: async ()=> { 
            if (!r.stoppedAt) navigate(`/monitor/${r.id}`); 
          }})}
          scroll={{ x: compactView ? 800 : 1400 }}
          size={compactView ? 'small' : 'middle'}
          columns={[
            { 
              title:'Status', 
              width: 80,
              render:(_,r)=> (
                <Badge 
                  status={r.stoppedAt ? 'default' : 'processing'} 
                  text={r.stoppedAt ? 'Stopped' : 'Active'}
                />
              ),
              sorter: (a, b) => (a.stoppedAt ? 1 : 0) - (b.stoppedAt ? 1 : 0)
            },
            { 
              title:'Symbol', 
              dataIndex:'symbol',
              width: 120,
              sorter: (a, b) => a.symbol.localeCompare(b.symbol)
            },
            { 
              title:'Mode', 
              dataIndex:'mode', 
              width: 80,
              render:(m)=> <Tag color={m==='live'?'gold':'blue'}>{String(m).toUpperCase()}</Tag>,
              sorter: (a, b) => a.mode.localeCompare(b.mode)
            },
            { 
              title:'Aggressiveness', 
              dataIndex:'aggressiveness',
              width: 130,
              render:(a)=> {
                const colors = { conservative: 'blue', reactive: 'orange', aggressive: 'red' };
                const level = a || 'conservative';
                return <Tag color={colors[level as keyof typeof colors]}>{level.toUpperCase()}</Tag>;
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
                      size="small" 
                      percent={r.healthScore || 0}
                      strokeColor={getHealthColor(r.healthStatus, r.healthScore)}
                      format={() => ''}
                    />
                    {r.alertCount > 0 && <Badge count={r.alertCount} size="small" />}
                  </Space>
                ),
                sorter: (a: any, b: any) => (a.healthScore || 0) - (b.healthScore || 0)
              },
              { 
                title:'Uptime', 
                width: 80,
                render:(_:any,r:any)=> r.stoppedAt ? '-' : formatDuration(r.uptime || 0),
                sorter: (a: any, b: any) => (a.uptime || 0) - (b.uptime || 0)
              },
              { 
                title:'Trades', 
                width: 100,
                render:(_:any,r:any)=> (
                  <Space direction="vertical" size="small">
                    <span style={{ fontSize: '12px', color: '#666' }}>
                      Total: {r.totalTrades || 0}
                    </span>
                    <span style={{ fontSize: '11px', color: '#999' }}>
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
                const color = rate >= 60 ? 'green' : rate >= 50 ? 'orange' : 'red';
                return <Tag color={color}>{rate.toFixed(1)}%</Tag>;
              },
              sorter: (a, b) => (a.winRate || 0) - (b.winRate || 0)
            },
            { 
              title:'PnL (USD)', 
              width: 120,
              render:(_:any,r:any)=> (
                <Space direction="vertical" size="small">
                  <span style={{ 
                    color: (r.pnlUsd || 0) >= 0 ? '#52c41a' : '#ff4d4f',
                    fontWeight: 'bold'
                  }}>
                    ${(r.pnlUsd || 0).toFixed(2)}
                  </span>
                  {!compactView && (
                    <span style={{ fontSize: '11px', color: '#999' }}>
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
                return <span style={{ color: roi >= 0 ? '#52c41a' : '#ff4d4f' }}>
                  {roi.toFixed(2)}%
                </span>;
              },
              sorter: (a, b) => (a.roiPct || 0) - (b.roiPct || 0)
            },
            ...(compactView ? [] : [
              { 
                title:'Position', 
                width: 120,
                render:(_:any,r:any)=> {
                  if (!r.currentPosition) return '-';
                  const pos = r.currentPosition;
                  return (
                    <Space direction="vertical" size="small">
                      <Tag color={pos.side === 'buy' ? 'green' : 'red'}>
                        {pos.side?.toUpperCase()} {pos.size?.toFixed(4)}
                      </Tag>
                      <span style={{ 
                        fontSize: '11px',
                        color: (pos.unrealizedPnl || 0) >= 0 ? '#52c41a' : '#ff4d4f'
                      }}>
                        ${(pos.unrealizedPnl || 0).toFixed(2)}
                      </span>
                    </Space>
                  );
                }
              },
              { 
                title:'Max DD', 
                width: 80,
                render:(_:any,r:any)=> (
                  <span style={{ color: '#ff4d4f' }}>
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
              render:(v)=> new Date(v).toLocaleString('en-US', { 
                month: 'short', 
                day: 'numeric', 
                hour: '2-digit', 
                minute: '2-digit' 
              }),
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
                      onClick={(e)=> { e.stopPropagation(); stop(r.id); }}
                    >
                      Stop
                    </Button>
                  );
                } else {
                  return (
                    <Space>
                      <Button 
                        size="small"
                        onClick={(e)=>{ e.stopPropagation(); relaunch(r); }}
                      >
                        Restart
                      </Button>
                      <Button 
                        danger 
                        size="small"
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

      <Modal open={open} title='Activate new agent' okText='Start' cancelText='Cancel' onCancel={()=> setOpen(false)} confirmLoading={starting}
        onOk={async ()=>{
          try {
            setStarting(true);
            const v = await form.validateFields();
            // Front guard: cap startBalanceUsd to exchange equity when live
            if (String(v.mode) === 'live' && exBal?.totalUsd != null && v.startBalanceUsd != null) {
              v.startBalanceUsd = Math.min(Number(v.startBalanceUsd||0), Number(exBal.totalUsd||0));
            }
            const res = await api.client.post('/api/agent/start', v);
            message.success('Session started');
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
        }}>
        <Form layout='vertical' form={form} initialValues={{ mode, riskPerTradePct:1.5, maxLeverage:4, dailyLossLimitPct:3.5, budgetPct:100, aggressiveness:'conservative' }}>
          <Form.Item label='Symbol' name='symbol' rules={[{ required:true }]}>
            <Select
              showSearch
              placeholder='Select symbol'
              options={commonSymbols.map(s=>({ value: s, label: s }))}
              filterOption={(input, option)=> (option?.label as string).toLowerCase().includes(input.toLowerCase())}
            />
          </Form.Item>
          <Form.Item label='Mode'>
            <Tag color={String(modeVal ?? mode).toLowerCase()==='live' ? 'gold' : 'blue'}>{String(modeVal ?? mode).toUpperCase()}</Tag>
            <Form.Item name='mode' hidden>
              <Input type='hidden' />
            </Form.Item>
          </Form.Item>
          {String(modeVal||'paper') !== 'live' && (
            <Form.Item label='Start balance USD (optional)' name='startBalanceUsd' tooltip={exBal? `Exchange: Free $${Number(exBal.freeUsd||0).toFixed(2)} • Equity $${Number(exBal.totalUsd||0).toFixed(2)}`: undefined}>
              <InputNumber style={{ width: '100%' }} min={0} max={exBal?.totalUsd ?? undefined} />
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
          <Form.Item label='Aggressiveness' name='aggressiveness'>
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
    </Card>
    </Space>
  );
}

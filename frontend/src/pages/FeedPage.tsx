import React from 'react';
import { Card, Space, Tag, Typography, Timeline, Spin, Empty, Button, Tooltip, Badge, Select, Switch } from 'antd';
import { 
  RobotOutlined, 
  CheckCircleOutlined, 
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  SyncOutlined,
  ThunderboltOutlined,
  DollarOutlined,
  LineChartOutlined,
  EyeOutlined,
  ReloadOutlined,
  FilterOutlined,
} from '@ant-design/icons';
import { api } from '../api';
import { useMode } from '../contexts/ModeContext';

const { Text, Title } = Typography;

interface AgentLog {
  timestamp: string;
  sessionId: string;
  symbol: string;
  kind: string;
  message: string;
  level: 'info' | 'warn' | 'error';
  details?: Record<string, any>;
}

interface AgentState {
  sessionId: string;
  symbol: string;
  running: boolean;
  hasPosition: boolean;
  bias: 'long' | 'short' | null;
  lastDecision: string | null;
  marketConditions: any;
}

function getLogIcon(kind: string) {
  switch (kind) {
    case 'tick': return <SyncOutlined style={{ color: '#8c8c8c' }} />;
    case 'signal': return <EyeOutlined style={{ color: '#52c41a' }} />;
    case 'entry': return <ThunderboltOutlined style={{ color: '#52c41a' }} />;
    case 'exit': return <DollarOutlined style={{ color: '#1890ff' }} />;
    case 'order': return <SyncOutlined style={{ color: '#722ed1' }} />;
    case 'market': return <LineChartOutlined style={{ color: '#13c2c2' }} />;
    case 'error': return <CloseCircleOutlined style={{ color: '#ff4d4f' }} />;
    case 'support-touch':
    case 'resistance-touch': return <LineChartOutlined style={{ color: '#faad14' }} />;
    case 'volume-spike':
    case 'sudden-move': return <ExclamationCircleOutlined style={{ color: '#ff4d4f' }} />;
    default: return <RobotOutlined style={{ color: '#8c8c8c' }} />;
  }
}

function getLogColor(kind: string, level: string) {
  if (level === 'error') return '#ff4d4f';
  if (level === 'warn') return '#faad14';
  switch (kind) {
    case 'tick': return '#8c8c8c';
    case 'signal': return '#52c41a';
    case 'entry': return '#52c41a';
    case 'exit': return '#1890ff';
    case 'order': return '#722ed1';
    case 'market': return '#13c2c2';
    case 'error': return '#ff4d4f';
    case 'support-touch':
    case 'resistance-touch': return '#faad14';
    default: return '#8c8c8c';
  }
}

// Parse condensed tick message: "🔄 [SOL] #1 WATCH | $127.16 | ❌ reason | live"
function parseTickMessage(message: string): { 
  tickNum?: number; 
  status?: string; 
  price?: string; 
  reason?: string;
  mode?: string;
  hasPosition?: boolean;
} | null {
  // Match patterns like: [SOL] #1 WATCH | $127.16 | ❌ reason | live
  // Or: [SOL] #1 IN_SHORT@$127.00 | $126.50 | live
  const watchMatch = message.match(/#(\d+)\s+(WATCH|IN_\w+@?\$?[\d.]*)\s*\|\s*\$?([\d.]+)\s*\|\s*(?:❌\s*)?([^|]+)?\s*\|\s*(\w+)/);
  if (watchMatch) {
    const status = watchMatch[2];
    return {
      tickNum: parseInt(watchMatch[1]),
      status: status,
      price: watchMatch[3],
      reason: watchMatch[4]?.trim() || undefined,
      mode: watchMatch[5],
      hasPosition: status.startsWith('IN_'),
    };
  }
  return null;
}

export default function FeedPage() {
  const [logs, setLogs] = React.useState<AgentLog[]>([]);
  const [agentStates, setAgentStates] = React.useState<AgentState[]>([]);
  const [activeSessions, setActiveSessions] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [autoRefresh, setAutoRefresh] = React.useState(true);
  const [filterKind, setFilterKind] = React.useState<string>('all');
  const [filterSymbol, setFilterSymbol] = React.useState<string>('all');
  const [logSource, setLogSource] = React.useState<'memory' | 'db' | 'all'>('memory');
  const { mode } = useMode();
  
  const loadLogs = React.useCallback(async () => {
    try {
      // Use memory source for real-time agent logs
      const res = await api.getAgentLogs(mode, 100, logSource) as any;
      if (res) {
        setLogs(res.logs || []);
        setAgentStates(res.agentStates || []);
        setActiveSessions(res.activeSessions || 0);
      }
    } catch (err) {
      console.error('Failed to load logs:', err);
    } finally {
      setLoading(false);
    }
  }, [mode, logSource]);
  
  React.useEffect(() => {
    loadLogs();
  }, [loadLogs]);
  
  React.useEffect(() => {
    if (!autoRefresh) return;
    // Refresh every 3s for memory logs (real-time), 10s for DB logs
    const interval = setInterval(loadLogs, logSource === 'memory' ? 3000 : 10000);
    return () => clearInterval(interval);
  }, [autoRefresh, loadLogs, logSource]);
  
  const symbols = React.useMemo(() => {
    const unique = new Set(logs.map(l => l.symbol));
    return Array.from(unique);
  }, [logs]);
  
  const filteredLogs = React.useMemo(() => {
    return logs.filter(log => {
      if (filterKind !== 'all' && log.kind !== filterKind) return false;
      if (filterSymbol !== 'all' && log.symbol !== filterSymbol) return false;
      return true;
    });
  }, [logs, filterKind, filterSymbol]);
  
  // Stats
  const stats = React.useMemo(() => {
    const entries = logs.filter(l => l.kind === 'entry').length;
    const exits = logs.filter(l => l.kind === 'exit').length;
    const orders = logs.filter(l => l.kind === 'order').length;
    const triggers = logs.filter(l => ['support-touch', 'resistance-touch', 'volume-spike', 'sudden-move'].includes(l.kind)).length;
    return { entries, exits, orders, triggers };
  }, [logs]);
  
  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '50vh' }}>
        <Spin size="large" />
      </div>
    );
  }
  
  return (
    <div style={{ padding: '0 24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <Title level={3} style={{ margin: 0, color: '#f0f0f0' }}>
            <RobotOutlined /> Agent Feed
          </Title>
          <Text type="secondary">
            {activeSessions} active session(s) • Real-time agent activity ({mode})
          </Text>
        </div>
        <Space>
          <Switch
            checked={autoRefresh}
            onChange={setAutoRefresh}
            checkedChildren="Auto"
            unCheckedChildren="Manual"
          />
          <Button icon={<ReloadOutlined />} onClick={loadLogs}>
            Refresh
          </Button>
        </Space>
      </div>
      
      {/* Agent States Overview */}
      {agentStates.length > 0 && (
        <Card size="small" style={{ marginBottom: 16 }} title="Active Agents">
          <Space size={16} wrap>
            {agentStates.map(agent => (
              <Card 
                key={agent.sessionId}
                size="small"
                style={{
                  backgroundColor: agent.hasPosition 
                    ? 'rgba(82, 196, 26, 0.1)' 
                    : 'rgba(24, 144, 255, 0.1)',
                  border: `1px solid ${agent.hasPosition ? 'rgba(82, 196, 26, 0.3)' : 'rgba(24, 144, 255, 0.3)'}`,
                  minWidth: 150,
                }}
              >
                <Space direction="vertical" size={2}>
                  <Tag color={agent.running ? 'success' : 'default'}>{agent.symbol}</Tag>
                  <Text style={{ fontSize: 12 }}>
                    {agent.hasPosition ? (
                      <span style={{ color: '#52c41a' }}>
                        <ThunderboltOutlined /> In Position ({agent.bias?.toUpperCase()})
                      </span>
                    ) : (
                      <span style={{ color: '#1890ff' }}>
                        <EyeOutlined /> Watching
                      </span>
                    )}
                  </Text>
                </Space>
              </Card>
            ))}
          </Space>
        </Card>
      )}
      
      {/* Stats Summary */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space size={24} wrap>
          <Tooltip title="Positions opened">
            <Badge count={stats.entries} style={{ backgroundColor: '#52c41a' }}>
              <Tag icon={<ThunderboltOutlined />} color="success">Entries</Tag>
            </Badge>
          </Tooltip>
          <Tooltip title="Positions closed">
            <Badge count={stats.exits} style={{ backgroundColor: '#1890ff' }}>
              <Tag icon={<DollarOutlined />} color="blue">Exits</Tag>
            </Badge>
          </Tooltip>
          <Tooltip title="Orders executed">
            <Badge count={stats.orders} style={{ backgroundColor: '#722ed1' }}>
              <Tag icon={<SyncOutlined />} color="purple">Orders</Tag>
            </Badge>
          </Tooltip>
          <Tooltip title="Market triggers detected">
            <Badge count={stats.triggers} style={{ backgroundColor: '#faad14' }}>
              <Tag icon={<ExclamationCircleOutlined />} color="warning">Triggers</Tag>
            </Badge>
          </Tooltip>
        </Space>
      </Card>
      
      {/* Filters */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          <FilterOutlined />
          <Select
            style={{ width: 150 }}
            value={logSource}
            onChange={setLogSource}
            options={[
              { value: 'memory', label: '🔴 Live Logs' },
              { value: 'db', label: '💾 Trade History' },
              { value: 'all', label: '📋 All Logs' },
            ]}
          />
          <Select
            style={{ width: 150 }}
            value={filterKind}
            onChange={setFilterKind}
            options={[
              { value: 'all', label: 'All Types' },
              { value: 'tick', label: '🔄 Tick' },
              { value: 'signal', label: '🔍 Signal' },
              { value: 'entry', label: '🚀 Entry' },
              { value: 'exit', label: '💰 Exit' },
              { value: 'market', label: '📊 Market' },
              { value: 'order', label: '📋 Order' },
              { value: 'error', label: '❌ Error' },
            ]}
          />
          <Select
            style={{ width: 180 }}
            value={filterSymbol}
            onChange={setFilterSymbol}
            options={[
              { value: 'all', label: 'All Symbols' },
              ...symbols.map(s => ({ value: s, label: s })),
            ]}
          />
        </Space>
      </Card>
      
      {/* Feed Timeline */}
      <Card 
        title="Activity Feed"
        style={{ maxHeight: 'calc(100vh - 400px)', overflow: 'auto' }}
      >
        {filteredLogs.length === 0 ? (
          <Empty 
            description={
              activeSessions === 0 
                ? "No active agents. Start an agent to see the feed."
                : "No activity yet. Waiting for market events..."
            }
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        ) : (
          <Timeline
            items={filteredLogs.map((log, idx) => {
              // Parse tick messages for better display
              const tickData = log.kind === 'tick' ? parseTickMessage(log.message) : null;
              
              return {
                key: `${log.timestamp}-${idx}`,
                dot: getLogIcon(log.kind),
                color: tickData?.hasPosition ? '#52c41a' : getLogColor(log.kind, log.level),
                children: (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
                      <Space size={4}>
                        <Tag>{log.symbol}</Tag>
                        {tickData ? (
                          // Condensed tick display
                          <>
                            <Tag color={tickData.hasPosition ? 'green' : 'default'}>
                              #{tickData.tickNum}
                            </Tag>
                            <Text style={{ color: tickData.hasPosition ? '#52c41a' : '#8c8c8c' }}>
                              {tickData.status}
                            </Text>
                            <Text type="secondary">${tickData.price}</Text>
                            {tickData.reason && (
                              <Text type="secondary" style={{ fontSize: 11, color: '#ff7875' }}>
                                ❌ {tickData.reason}
                              </Text>
                            )}
                          </>
                        ) : (
                          // Other log types
                          <>
                            <Tag color={
                              log.kind === 'entry' ? 'green' :
                              log.kind === 'exit' ? 'blue' :
                              log.kind === 'signal' ? 'gold' :
                              log.kind === 'order' ? 'purple' :
                              'default'
                            }>{log.kind}</Tag>
                            <Text strong>{log.message}</Text>
                          </>
                        )}
                      </Space>
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </Text>
                    </div>
                    
                    {/* Entry details */}
                    {log.kind === 'entry' && log.details && (
                      <Card 
                        size="small" 
                        style={{ 
                          marginTop: 8, 
                          backgroundColor: 'rgba(82, 196, 26, 0.1)',
                          border: '1px solid rgba(82, 196, 26, 0.3)'
                        }}
                      >
                        <Space direction="vertical" size={4}>
                          <Text>Position ID: {log.details.positionId}</Text>
                          {log.details.leverage && <Text type="secondary">Leverage: {log.details.leverage}x</Text>}
                        </Space>
                      </Card>
                    )}
                    
                    {/* Exit details */}
                    {log.kind === 'exit' && log.details && (
                      <Card 
                        size="small" 
                        style={{ 
                          marginTop: 8, 
                          backgroundColor: log.level === 'warn' 
                            ? 'rgba(255, 77, 79, 0.1)' 
                            : 'rgba(82, 196, 26, 0.1)',
                          border: `1px solid ${log.level === 'warn' ? 'rgba(255, 77, 79, 0.3)' : 'rgba(82, 196, 26, 0.3)'}`
                        }}
                      >
                        <Space direction="vertical" size={4}>
                          {log.details.exitPrice && <Text>Exit Price: ${log.details.exitPrice}</Text>}
                          {log.details.exitReason && <Tag>{log.details.exitReason}</Tag>}
                        </Space>
                      </Card>
                    )}
                    
                    {/* Order details */}
                    {log.kind === 'order' && log.details && (
                      <Card 
                        size="small" 
                        style={{ 
                          marginTop: 8, 
                          backgroundColor: 'rgba(114, 46, 209, 0.1)',
                          border: '1px solid rgba(114, 46, 209, 0.3)'
                        }}
                      >
                        <Space>
                          <Tag color={log.details.status === 'filled' ? 'success' : 'default'}>
                            {log.details.status}
                          </Tag>
                          {log.details.fills && <Text type="secondary">{log.details.fills} fill(s)</Text>}
                        </Space>
                      </Card>
                    )}
                    
                    {/* Trigger details */}
                    {['support-touch', 'resistance-touch', 'volume-spike', 'sudden-move'].includes(log.kind) && log.details && (
                      <Card 
                        size="small" 
                        style={{ 
                          marginTop: 8, 
                          backgroundColor: 'rgba(250, 173, 20, 0.1)',
                          border: '1px solid rgba(250, 173, 20, 0.3)'
                        }}
                      >
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {log.details.price && <span>Price: ${log.details.price} </span>}
                          {log.details.support && <span>Support: ${log.details.support} </span>}
                          {log.details.resistance && <span>Resistance: ${log.details.resistance} </span>}
                          {log.details.volumeRatio && <span>Volume: {log.details.volumeRatio.toFixed(1)}x </span>}
                          {log.details.changePercent && <span>Change: {log.details.changePercent.toFixed(2)}% </span>}
                        </Text>
                      </Card>
                    )}
                  </div>
                ),
              };
            })}
          />
        )}
      </Card>
    </div>
  );
}

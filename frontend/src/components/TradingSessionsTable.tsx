import {
  AlertOutlined,
  ClockCircleOutlined,
  InfoCircleOutlined,
  MoreOutlined,
  PauseCircleOutlined,
  PlayCircleFilled,
  StopOutlined,
} from "../icons";
import {
  Button,
  Dropdown,
  Input,
  MenuProps,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
} from "antd";
import type { ColumnsType, TableProps } from "antd/es/table";
import React, { useEffect, useMemo, useState } from "react";
import "../styles/trading-ui.css";
import {
  Money,
  formatExposure,
  formatPercent,
  formatSignedCurrency,
} from "../utils/money";
import { formatDisplaySymbol } from "../utils/symbols";

type SessionStatus = "running" | "waiting" | "blocked" | "stopped";
type SessionMode = "paper" | "live";
type AggressivenessLevel = "conservative" | "reactive" | "aggressive";

type TradingSession = {
  id: string;
  agent: string;
  symbol: string;
  profile: string;
  mode: SessionMode;
  status: SessionStatus;
  aggressiveness: AggressivenessLevel;
  pnl: Money;
  roi: number;
  exposure: number;
  readiness: "ready" | "waiting" | "blocked";
  readinessTooltip: string;
  lastActivityUtc: string;
  blockedReasons?: string[];
  recentLogs: string[];
  health: number;
  sharpe: number;
  drawdown: number;
  latencyMs: number;
  winRate: number;
};

const REFERENCE_TIME = new Date("2024-10-05T00:00:00Z");

const sessionsSeed: TradingSession[] = [
  {
    id: "sess-btc-01",
    agent: "Helios-Delta",
    symbol: "BTC",
    profile: "Momentum scalper",
    mode: "paper",
    status: "running",
    aggressiveness: "aggressive",
    pnl: 1_240_500n,
    roi: 4.6,
    exposure: 1.12,
    readiness: "ready",
    readinessTooltip: "Signal armed",
    lastActivityUtc: "2024-10-04T19:40:00Z",
    recentLogs: ["Executed 12 orders", "Risk sync confirmed"],
    blockedReasons: [],
    health: 0.86,
    sharpe: 1.9,
    drawdown: 4.1,
    latencyMs: 38,
    winRate: 61,
  },
  {
    id: "sess-eth-02",
    agent: "Atlas-Neutral",
    symbol: "ETH",
    profile: "Market maker",
    mode: "live",
    status: "running",
    aggressiveness: "reactive",
    pnl: 2_780_900n,
    roi: 7.8,
    exposure: 1.24,
    readiness: "ready",
    readinessTooltip: "Signal armed",
    lastActivityUtc: "2024-10-04T19:55:00Z",
    recentLogs: ["Spread tightened", "Inventory rebalanced"],
    blockedReasons: [],
    health: 0.92,
    sharpe: 2.4,
    drawdown: 3.4,
    latencyMs: 24,
    winRate: 68,
  },
  {
    id: "sess-sol-03",
    agent: "Orion-Vantage",
    symbol: "SOL",
    profile: "Breakout chaser",
    mode: "paper",
    status: "waiting",
    aggressiveness: "aggressive",
    pnl: -340_200n,
    roi: -2.3,
    exposure: 0.58,
    readiness: "waiting",
    readinessTooltip: "Waiting for volatility window",
    lastActivityUtc: "2024-10-04T17:15:00Z",
    recentLogs: ["Threshold unmet", "Order book stable"],
    blockedReasons: [],
    health: 0.74,
    sharpe: 1.1,
    drawdown: 6.7,
    latencyMs: 52,
    winRate: 54,
  },
  {
    id: "sess-ava-04",
    agent: "Nova-Spiral",
    symbol: "AVAX",
    profile: "Adaptive trend",
    mode: "paper",
    status: "blocked",
    aggressiveness: "reactive",
    pnl: -125_800n,
    roi: -1.1,
    exposure: 0.34,
    readiness: "blocked",
    readinessTooltip: "Blocked by circuit breaker",
    lastActivityUtc: "2024-10-04T15:02:00Z",
    recentLogs: ["Volatility halt", "Circuit breaker engaged"],
    blockedReasons: ["Circuit breaker cool-down"],
    health: 0.42,
    sharpe: 0.8,
    drawdown: 9.4,
    latencyMs: 65,
    winRate: 49,
  },
  {
    id: "sess-dot-05",
    agent: "Vega-Anchor",
    symbol: "DOT",
    profile: "Range mean reversion",
    mode: "live",
    status: "running",
    aggressiveness: "conservative",
    pnl: 980_400n,
    roi: 5.6,
    exposure: 0.95,
    readiness: "ready",
    readinessTooltip: "Signal armed",
    lastActivityUtc: "2024-10-04T19:48:00Z",
    recentLogs: ["Range pivot filled", "Delta neutral"],
    blockedReasons: [],
    health: 0.81,
    sharpe: 1.7,
    drawdown: 4.9,
    latencyMs: 31,
    winRate: 63,
  },
  {
    id: "sess-matic-06",
    agent: "Quanta-Fuse",
    symbol: "MATIC",
    profile: "Micro structure arb",
    mode: "paper",
    status: "stopped",
    aggressiveness: "conservative",
    pnl: 150_000n,
    roi: 1.2,
    exposure: 0.0,
    readiness: "waiting",
    readinessTooltip: "Awaiting manual restart",
    lastActivityUtc: "2024-10-04T10:20:00Z",
    recentLogs: ["Session terminated"],
    blockedReasons: ["Manual stop"],
    health: 0.58,
    sharpe: 1.2,
    drawdown: 2.5,
    latencyMs: 47,
    winRate: 57,
  },
];

const statusColorMap: Record<SessionStatus, string> = {
  running: "#22c55e",
  waiting: "#0ea5e9",
  blocked: "#f97316",
  stopped: "#94a3b8",
};

const aggressivenessMeta: Record<
  AggressivenessLevel,
  { label: string; color: string }
> = {
  conservative: { label: "Conservative", color: "#0ea5e9" },
  reactive: { label: "Reactive", color: "#a855f7" },
  aggressive: { label: "Aggressive", color: "#ef4444" },
};

const readinessIconMap: Record<
  TradingSession["readiness"],
  { icon: React.ReactNode; color: string }
> = {
  ready: { icon: <PlayCircleFilled />, color: "#22c55e" },
  waiting: { icon: <ClockCircleOutlined />, color: "#0ea5e9" },
  blocked: { icon: <PauseCircleOutlined />, color: "#f97316" },
};

const computeRelativeTime = (timestamp: string) => {
  const target = new Date(timestamp);
  const diff = REFERENCE_TIME.getTime() - target.getTime();
  const minutes = Math.round(diff / (60 * 1000));
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  return `${days}d ago`;
};

const TradingSessionsTable: React.FC = () => {
  const [viewMode, setViewMode] = useState<"simple" | "advanced">("simple");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<SessionStatus | "all">("all");
  const [modeFilter, setModeFilter] = useState<SessionMode | "all">("all");
  const [symbolFilter, setSymbolFilter] = useState<string | undefined>(undefined);
  const [aggressivenessFilter, setAggressivenessFilter] = useState<
    AggressivenessLevel | undefined
  >(undefined);
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);

  useEffect(() => {
    if (viewMode === "advanced") {
      setExpandedKeys(sessionsSeed.map((session) => session.id));
    } else {
      setExpandedKeys([]);
    }
  }, [viewMode]);

  const handleReset = () => {
    setSearch("");
    setStatusFilter("all");
    setModeFilter("all");
    setSymbolFilter(undefined);
    setAggressivenessFilter(undefined);
  };

  const filteredSessions = useMemo(() => {
    return sessionsSeed.filter((session) => {
      if (
        search &&
        !`${session.agent} ${session.symbol}`
          .toLowerCase()
          .includes(search.toLowerCase())
      ) {
        return false;
      }
      if (statusFilter !== "all" && session.status !== statusFilter) {
        return false;
      }
      if (modeFilter !== "all" && session.mode !== modeFilter) {
        return false;
      }
      if (symbolFilter && session.symbol !== symbolFilter) {
        return false;
      }
      if (aggressivenessFilter && session.aggressiveness !== aggressivenessFilter) {
        return false;
      }
      return true;
    });
  }, [aggressivenessFilter, modeFilter, search, statusFilter, symbolFilter]);

  const bulkActionsVisible = selectedRowKeys.length > 0;

  const toolbarRight = (
    <div className="toolbar-right">
      {bulkActionsVisible && (
        <div className="bulk-actions">
          <Button danger icon={<StopOutlined />}>
            Stop selected
          </Button>
          <Button icon={<AlertOutlined />}>Delete</Button>
        </div>
      )}
      <Segmented
        options={[
          { label: "Mode simple", value: "simple" },
          { label: "Mode avancé", value: "advanced" },
        ]}
        value={viewMode}
        onChange={(value) => setViewMode(value as "simple" | "advanced")}
      />
    </div>
  );

  const actionMenu: MenuProps["items"] = [
    { key: "stop", icon: <StopOutlined />, label: "Stop" },
    { key: "modify", icon: <InfoCircleOutlined />, label: "Modify" },
    { key: "delete", icon: <AlertOutlined />, label: "Delete", danger: true },
  ];

  const baseColumns: ColumnsType<TradingSession> = [
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      width: 120,
      render: (value: SessionStatus) => (
        <span>
          <span
            className="status-dot"
            style={{ background: statusColorMap[value] }}
            aria-hidden
          />
          <span style={{ textTransform: "capitalize", fontWeight: 600 }}>{value}</span>
        </span>
      ),
    },
    {
      title: "Agent / Symbol",
      dataIndex: "agent",
      key: "agent",
      width: 220,
      render: (_: string, record) => (
        <div className="agent-meta">
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontWeight: 600 }}>{record.agent}</span>
            <span className={`mode-pill ${record.mode === "live" ? "live" : ""}`}>
              {record.mode}
            </span>
          </div>
          <div className="profile">{record.profile}</div>
          <div className="id">{formatDisplaySymbol(record.symbol)}</div>
        </div>
      ),
    },
    {
      title: "Aggressiveness",
      dataIndex: "aggressiveness",
      key: "aggressiveness",
      width: 150,
      render: (value: AggressivenessLevel) => {
        const meta = aggressivenessMeta[value];
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    {
      title: "P&L $",
      dataIndex: "pnl",
      key: "pnl",
      align: "right",
      render: (value: Money) => (
        <span
          className={`numeric-cell ${value === 0n ? "" : value > 0n ? "pnl-positive" : "pnl-negative"}`}
        >
          {formatSignedCurrency(value)}
        </span>
      ),
    },
    {
      title: "ROI %",
      dataIndex: "roi",
      key: "roi",
      align: "right",
      render: (value: number) => (
        <span className={`numeric-cell ${value === 0 ? "" : value > 0 ? "pnl-positive" : "pnl-negative"}`}>
          {formatPercent(value, 2)}
        </span>
      ),
    },
    {
      title: "Exposure",
      dataIndex: "exposure",
      key: "exposure",
      align: "right",
      render: (value: number) => <span className="numeric-cell">{formatExposure(value, 2)}</span>,
    },
    {
      title: "Signal",
      dataIndex: "readiness",
      key: "readiness",
      width: 120,
      render: (_: TradingSession["readiness"], record) => {
        const iconConfig = readinessIconMap[record.readiness];
        return (
          <Tooltip title={record.readinessTooltip}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, color: iconConfig.color }}>
              {iconConfig.icon}
              <span style={{ textTransform: "capitalize" }}>{record.readiness}</span>
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: "Last activity",
      dataIndex: "lastActivityUtc",
      key: "lastActivity",
      width: 120,
      render: (value: string) => <span className="numeric-cell">{computeRelativeTime(value)}</span>,
    },
    {
      title: "Actions",
      key: "actions",
      width: 80,
      render: () => (
        <Dropdown menu={{ items: actionMenu }} trigger={["click"]}>
          <Button type="text" icon={<MoreOutlined />} aria-label="Actions de session" />
        </Dropdown>
      ),
    },
  ];

  const advancedColumns: ColumnsType<TradingSession> = [
    ...baseColumns,
    {
      title: "Sharpe",
      dataIndex: "sharpe",
      key: "sharpe",
      align: "right",
      render: (value: number) => <span className="numeric-cell">{value.toFixed(2)}</span>,
    },
    {
      title: "Max DD %",
      dataIndex: "drawdown",
      key: "drawdown",
      align: "right",
      render: (value: number) => <span className="numeric-cell">{formatPercent(value, 2)}</span>,
    },
    {
      title: "Latency (ms)",
      dataIndex: "latencyMs",
      key: "latency",
      align: "right",
      render: (value: number) => <span className="numeric-cell">{value.toFixed(0)}</span>,
    },
    {
      title: "Win rate %",
      dataIndex: "winRate",
      key: "winRate",
      align: "right",
      render: (value: number) => <span className="numeric-cell">{formatPercent(value, 1)}</span>,
    },
  ];

  const columns = viewMode === "advanced" ? advancedColumns : baseColumns;

  const rowSelection: TableProps<TradingSession>["rowSelection"] = {
    selectedRowKeys,
    onChange: (keys) => setSelectedRowKeys(keys),
  };

  return (
    <div className="sessions-table-card">
      <div className="sessions-table-toolbar">
        <Space className="filters" wrap>
          <Input
            className="search-field"
            placeholder="Search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            allowClear
          />
          <Select<SessionStatus | "all">
            value={statusFilter}
            onChange={setStatusFilter}
            options={[
              { label: "All statuses", value: "all" },
              { label: "Running", value: "running" },
              { label: "Waiting", value: "waiting" },
              { label: "Blocked", value: "blocked" },
              { label: "Stopped", value: "stopped" },
            ]}
            aria-label="Filtrer par statut"
          />
          <Select<SessionMode | "all">
            value={modeFilter}
            onChange={setModeFilter}
            options={[
              { label: "All modes", value: "all" },
              { label: "Paper", value: "paper" },
              { label: "Live", value: "live" },
            ]}
            aria-label="Filtrer par mode"
          />
          <Select<string>
            placeholder="Symbol"
            value={symbolFilter}
            onChange={setSymbolFilter}
            allowClear
            options={[...new Set(sessionsSeed.map((session) => session.symbol))].map((symbol) => ({
              label: symbol,
              value: symbol,
            }))}
            aria-label="Filtrer par symbole"
          />
          <Select<AggressivenessLevel>
            placeholder="Aggressiveness"
            value={aggressivenessFilter}
            onChange={(value) => setAggressivenessFilter(value ?? undefined)}
            allowClear
            options={(Object.keys(aggressivenessMeta) as AggressivenessLevel[]).map((key) => ({
              label: aggressivenessMeta[key].label,
              value: key,
            }))}
            aria-label="Filter by aggressiveness"
          />
          <Button type="text" onClick={handleReset}>
            Reset filters
          </Button>
        </Space>
        {toolbarRight}
      </div>
      <Table<TradingSession>
        className="sessions-table"
        dataSource={filteredSessions}
        columns={columns}
        rowKey={(record) => record.id}
        rowSelection={rowSelection}
        pagination={{ pageSize: 5, position: ["bottomRight"] }}
        sticky
        scroll={{ y: 360, x: "max-content" }}
        expandable={{
          expandedRowKeys: expandedKeys,
          onExpandedRowsChange: (keys) =>
            setExpandedKeys(Array.isArray(keys) ? [...keys] : Array.from(keys)),
          expandedRowRender: (record) => (
            <div className="expand-panel">
              <div className="section">
                <span className="title">Justification</span>
                {record.blockedReasons && record.blockedReasons.length > 0 ? (
                  record.blockedReasons.map((reason) => (
                    <span key={reason}>{reason}</span>
                  ))
                ) : (
                  <span>Operational</span>
                )}
              </div>
              <div className="section">
                <span className="title">Derniers logs</span>
                {record.recentLogs.map((log) => (
                  <span key={log}>{log}</span>
                ))}
                <div className="health-bar" aria-label="Health">
                  <div className="fill" style={{ width: `${Math.round(record.health * 100)}%` }} />
                </div>
              </div>
            </div>
          ),
        }}
        size="small"
      />
    </div>
  );
};

export default TradingSessionsTable;

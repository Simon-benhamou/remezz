import { InfoCircleOutlined, MoreOutlined, ReloadOutlined } from "../icons";
import {
  Button,
  Collapse,
  Dropdown,
  InputNumber,
  MenuProps,
  Progress,
  Slider,
  Space,
  Table,
  Tooltip,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import React, { useMemo, useState } from "react";
import "../styles/trading-ui.css";
import {
  Money,
  formatCurrency,
  formatExposure,
  formatPercent,
  formatSignedCurrency,
  fromDecimalString,
  sumMoney,
  toDecimalString,
  zeroMoney,
} from "../utils/money";

type AllocationAgent = {
  id: string;
  symbol: string;
  targetPercent: number;
  allocated: Money;
  pnl: Money;
  roi: number;
  exposure: number;
  status: "active" | "inactive";
};

const INITIAL_AGENTS: AllocationAgent[] = [
  {
    id: "btc-core",
    symbol: "BTC",
    targetPercent: 34,
    allocated: 8_900_000n,
    pnl: 720_500n,
    roi: 9.4,
    exposure: 0.92,
    status: "active",
  },
  {
    id: "eth-flow",
    symbol: "ETH",
    targetPercent: 28,
    allocated: 7_200_000n,
    pnl: 312_400n,
    roi: 6.1,
    exposure: 0.88,
    status: "active",
  },
  {
    id: "sol-shift",
    symbol: "SOL",
    targetPercent: 18,
    allocated: 4_650_000n,
    pnl: -210_300n,
    roi: -4.3,
    exposure: 1.05,
    status: "active",
  },
  {
    id: "ava-scout",
    symbol: "AVAX",
    targetPercent: 12,
    allocated: 2_900_000n,
    pnl: 96_700n,
    roi: 3.2,
    exposure: 0.67,
    status: "active",
  },
  {
    id: "matic-rebal",
    symbol: "MATIC",
    targetPercent: 6,
    allocated: 1_200_000n,
    pnl: 42_500n,
    roi: 2.8,
    exposure: 0.58,
    status: "inactive",
  },
  {
    id: "dot-latency",
    symbol: "DOT",
    targetPercent: 2,
    allocated: 450_000n,
    pnl: -15_800n,
    roi: -1.1,
    exposure: 0.34,
    status: "inactive",
  },
];

const formatFooterValue = (value: Money) => (
  <span className="footer-value">{formatCurrency(value)}</span>
);

const PortfolioAllocation: React.FC = () => {
  const [agents, setAgents] = useState<AllocationAgent[]>(INITIAL_AGENTS);
  const [paperBalance, setPaperBalance] = useState<Money>(25_000_000n);
  const [pendingBalance, setPendingBalance] = useState<string>(
    toDecimalString(25_000_000n),
  );

  const totals = useMemo(() => {
    const activeAgents = agents.filter((agent) => agent.status === "active");
    const allocated = sumMoney(activeAgents.map((agent) => agent.allocated));
    const freeCapital = paperBalance - allocated;
    const targetPercent = activeAgents.reduce(
      (acc, agent) => acc + agent.targetPercent,
      0,
    );
    const exposureUsed =
      activeAgents.reduce((acc, agent) => acc + agent.exposure * agent.targetPercent, 0) /
      (targetPercent === 0 ? 1 : targetPercent);

    const pnlTotal = sumMoney(activeAgents.map((agent) => agent.pnl));

    return {
      activeAgents,
      inactiveAgents: agents.filter((agent) => agent.status === "inactive"),
      allocated,
      freeCapital,
      targetPercent,
      exposureUsed: Number.isFinite(exposureUsed) ? exposureUsed : 0,
      pnlTotal,
    };
  }, [agents, paperBalance]);

  const allocationPercent = useMemo(() => {
    if (paperBalance === zeroMoney) {
      return 0;
    }
    const ratio = (Number(totals.allocated) / Number(paperBalance)) * 100;
    return Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0), 999) : 0;
  }, [paperBalance, totals.allocated]);

  const handleBalanceUpdate = () => {
    const parsed = fromDecimalString(pendingBalance);
    if (parsed === null) {
      message.warning("Montant invalide");
      return;
    }
    setPaperBalance(parsed);
  };

  const handleTargetChange = (id: string, value: number) => {
    setAgents((prev) =>
      prev.map((agent) =>
        agent.id === id
          ? {
              ...agent,
              targetPercent: value,
            }
          : agent,
      ),
    );
  };

  const agentActions: MenuProps["items"] = [
    { key: "rebalance", label: "Rebalance" },
    { key: "mute", label: "Mettre en pause" },
    { type: "divider" },
    { key: "remove", danger: true, label: "Supprimer" },
  ];

  const columns: ColumnsType<AllocationAgent> = [
    {
      title: "Symbol",
      dataIndex: "symbol",
      key: "symbol",
      width: 120,
      render: (value: string) => (
        <span style={{ fontWeight: 600, letterSpacing: "0.04em" }}>{value}</span>
      ),
    },
    {
      title: "Target %",
      dataIndex: "targetPercent",
      key: "target",
      width: 180,
      render: (value: number, record) => (
        <div style={{ minWidth: 160 }}>
          <Slider
            min={0}
            max={100}
            step={1}
            value={value}
            onChange={(next) => handleTargetChange(record.id, next as number)}
            tooltip={{ formatter: (val) => `${val}%` }}
          />
        </div>
      ),
    },
    {
      title: "Pool usage $",
      dataIndex: "allocated",
      key: "allocated",
      align: "right",
      render: (value: Money) => (
        <span className="numeric-cell">{formatCurrency(value)}</span>
      ),
    },
    {
      title: "P&L $",
      dataIndex: "pnl",
      key: "pnl",
      align: "right",
      render: (value: Money) => (
        <span
          className={`numeric-cell ${value === zeroMoney ? "" : value > 0 ? "pnl-positive" : "pnl-negative"}`}
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
        <span
          className={`numeric-cell ${value === 0 ? "" : value > 0 ? "pnl-positive" : "pnl-negative"}`}
        >
          {formatPercent(value, 2)}
        </span>
      ),
    },
    {
      title: "Exposure",
      dataIndex: "exposure",
      key: "exposure",
      align: "right",
      render: (value: number) => (
        <span className="numeric-cell">{formatExposure(value, 2)}</span>
      ),
    },
    {
      title: "Actions",
      key: "actions",
      width: 80,
      render: () => (
        <Dropdown menu={{ items: agentActions }} trigger={["click"]}>
          <Button
            type="text"
            icon={<MoreOutlined />}
            aria-label="Actions de l'agent"
          />
        </Dropdown>
      ),
    },
  ];

  return (
    <div className="portfolio-allocation">
      <div className="pa-header">
        <div className="pa-kpis">
          <div className="pa-kpi">
            <span className="label">Paper balance</span>
            <span className="value">{formatCurrency(paperBalance)}</span>
          </div>
          <div className="pa-kpi">
            <span className="label">Pool usage</span>
            <span className="value">{formatCurrency(totals.allocated)}</span>
          </div>
          <div className="pa-kpi">
            <span className="label">Free capital</span>
            <span className="value">{formatCurrency(totals.freeCapital)}</span>
          </div>
          <div className="pa-kpi">
            <span className="label">Exposure used</span>
            <span className="value">{formatExposure(totals.exposureUsed, 2)}</span>
          </div>
        </div>
        <Space className="pa-actions" size={12} wrap>
          <Tooltip title="Rafraîchir les allocations">
            <Button
              type="default"
              icon={<ReloadOutlined />}
              aria-label="Actualiser les données"
            />
          </Tooltip>
          <Button type="primary">Rebalance Paper</Button>
          <Button danger type="primary">
            Rebalance Live
          </Button>
          <Space className="balance-editor">
            <Tooltip title="Mettre à jour la trésorerie paper">
              <InfoCircleOutlined style={{ color: "#64748b" }} />
            </Tooltip>
            <InputNumber
              value={pendingBalance}
              stringMode
              min="0"
              formatter={(value) =>
                value ? `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0") : ""
              }
              parser={(value) => value?.replace(/[^0-9.-]/g, "") ?? ""}
              onChange={(value) => setPendingBalance((value ?? "").toString())}
              controls={false}
              aria-label="Paper balance"
            />
            <Button type="default" onClick={handleBalanceUpdate}>
              Update
            </Button>
          </Space>
        </Space>
      </div>

      <div className="pa-overview">
        <div className="pa-overview-card">
          <span className="title">Capital allocation</span>
          <Progress
            type="dashboard"
            percent={Number(allocationPercent.toFixed(1))}
            strokeWidth={10}
            strokeColor={{
              "0%": "#2563eb",
              "100%": "#1e3a8a",
            }}
            trailColor="#e2e8f0"
            format={() => `${allocationPercent.toFixed(1)}%`}
          />
        </div>
        <div className="pa-overview-card">
          <span className="title">Exposure utilisation</span>
          <div className="value">{formatExposure(totals.exposureUsed, 2)}</div>
          <Progress
            percent={Math.min((totals.exposureUsed / 1.5) * 100, 100)}
            strokeColor={totals.exposureUsed > 1 ? "#f97316" : "#2563eb"}
            showInfo={false}
          />
          <div style={{ fontSize: 12, color: "#6b7280" }}>Cap à 1.5x</div>
        </div>
      </div>

      <div className="pa-table-wrapper">
        <Table<AllocationAgent>
          className="compact-table"
          dataSource={totals.activeAgents}
          columns={columns}
          pagination={false}
          rowKey={(record) => record.id}
          scroll={{ x: 920 }}
        />
      </div>

      {totals.inactiveAgents.length > 0 && (
        <Collapse
          bordered={false}
          items={[
            {
              key: "inactive",
              label: `Inactifs (${totals.inactiveAgents.length})`,
              children: (
                <Table<AllocationAgent>
                  className="compact-table"
                  dataSource={totals.inactiveAgents}
                  columns={columns.map((column) =>
                    column.key === "target"
                      ? { ...column, render: () => <span>0%</span> }
                      : column,
                  )}
                  pagination={false}
                  rowKey={(record) => record.id}
                  size="small"
                />
              ),
            },
          ]}
        />
      )}

      <div className="pa-footer">
        <div>
          <div className="footer-label">Target %</div>
          <div className="footer-value">{formatPercent(totals.targetPercent, 0)}</div>
        </div>
        <div>
          <div className="footer-label">Pool usage</div>
          {formatFooterValue(totals.allocated)}
        </div>
        <div>
          <div className="footer-label">Free capital</div>
          {formatFooterValue(totals.freeCapital)}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button type="primary">Rebalance</Button>
        </div>
      </div>
    </div>
  );
};

export default PortfolioAllocation;

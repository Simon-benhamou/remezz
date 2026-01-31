import React from 'react';
import { Card, Progress, Space, Tag, Tooltip, Flex } from 'antd';
import { TrendingUp, TrendingDown, Target, BarChart3 } from 'lucide-react';

type Stat = { n: number; wins: number; losses: number; avgWin: number; avgLoss: number; expectancy: number };

export default function PerfBreakdownPanel({ sessionId, api }: { sessionId?: string; api: any }) {
  const [data, setData] = React.useState<any>(null);

  React.useEffect(() => {
    (async () => {
      try {
        if (sessionId) setData(await api.getPerfBreakdown(sessionId));
      } catch { /* ignore */ }
    })();
  }, [sessionId, api]);

  if (!data || !data.sample) {
    return (
      <Card size="small" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}>
        <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 16 }}>
          Pas encore de trades clôturés
        </div>
      </Card>
    );
  }

  const totals = data.totals || {};
  const bySide = data.bySide || { long: {}, short: {} };
  const bySymbol = data.bySymbol || {};
  const adaptive = data.adaptiveRisk;

  const winRate = totals.n ? ((totals.wins / totals.n) * 100) : 0;
  const longWinRate = bySide.long?.n ? ((bySide.long.wins / bySide.long.n) * 100) : 0;
  const shortWinRate = bySide.short?.n ? ((bySide.short.wins / bySide.short.n) * 100) : 0;
  const expectancy = totals.expectancy || 0;

  // Top 3 symbols by trade count
  const topSymbols = Object.entries(bySymbol)
    .map(([symbol, s]: [string, any]) => ({
      symbol: symbol.replace('/USDT:USDT', ''),
      n: s.n || 0,
      winRate: s.n ? ((s.wins / s.n) * 100) : 0,
      expectancy: s.expectancy || 0,
    }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 4);

  const getColor = (val: number) => val >= 0 ? 'var(--success)' : 'var(--error)';

  return (
    <Card
      size="small"
      title={
        <Flex align="center" gap={8}>
          <BarChart3 size={16} style={{ color: 'var(--accent)' }} />
          <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Performance</span>
          <Tag style={{ marginLeft: 'auto', background: 'rgba(6, 182, 212, 0.15)', border: 'none', color: 'var(--accent)' }}>
            {data.sample} trades
          </Tag>
        </Flex>
      }
      style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}
      styles={{ header: { borderBottom: '1px solid var(--border-subtle)', padding: '12px 16px' }, body: { padding: 16 } }}
    >
      {/* Main Stats Row */}
      <Flex gap={24} wrap="wrap" style={{ marginBottom: 16 }}>
        {/* Win Rate */}
        <div style={{ minWidth: 100 }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 4 }}>WIN RATE</div>
          <Flex align="baseline" gap={4}>
            <span style={{ fontSize: 22, fontWeight: 700, color: getColor(winRate - 50) }}>
              {winRate.toFixed(0)}%
            </span>
          </Flex>
          <Progress
            percent={winRate}
            showInfo={false}
            strokeColor={getColor(winRate - 50)}
            trailColor="var(--border-subtle)"
            size="small"
            style={{ marginTop: 4 }}
          />
        </div>

        {/* Expectancy */}
        <div style={{ minWidth: 100 }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 4 }}>EXPECTANCY</div>
          <Flex align="baseline" gap={4}>
            <span style={{ fontSize: 22, fontWeight: 700, color: getColor(expectancy) }}>
              {expectancy >= 0 ? '+' : ''}{expectancy.toFixed(2)}%
            </span>
          </Flex>
          <div style={{ color: 'var(--text-muted)', fontSize: 10, marginTop: 4 }}>
            par trade
          </div>
        </div>

        {/* Avg Win / Avg Loss */}
        <div style={{ minWidth: 120 }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 4 }}>AVG WIN / LOSS</div>
          <Flex align="center" gap={8}>
            <span style={{ color: 'var(--success)', fontWeight: 600, fontSize: 14 }}>
              +{(totals.avgWin || 0).toFixed(2)}%
            </span>
            <span style={{ color: 'var(--text-muted)' }}>/</span>
            <span style={{ color: 'var(--error)', fontWeight: 600, fontSize: 14 }}>
              {(totals.avgLoss || 0).toFixed(2)}%
            </span>
          </Flex>
        </div>
      </Flex>

      {/* Direction Stats */}
      <Flex gap={16} style={{ marginBottom: 16 }}>
        <Flex align="center" gap={8} style={{ padding: '8px 12px', background: 'rgba(52, 211, 153, 0.08)', borderRadius: 8, flex: 1 }}>
          <TrendingUp size={14} style={{ color: 'var(--success)' }} />
          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Long</span>
          <span style={{ color: 'var(--success)', fontWeight: 600, marginLeft: 'auto' }}>
            {longWinRate.toFixed(0)}%
          </span>
          <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
            ({bySide.long?.n || 0})
          </span>
        </Flex>
        <Flex align="center" gap={8} style={{ padding: '8px 12px', background: 'rgba(248, 113, 113, 0.08)', borderRadius: 8, flex: 1 }}>
          <TrendingDown size={14} style={{ color: 'var(--error)' }} />
          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Short</span>
          <span style={{ color: 'var(--error)', fontWeight: 600, marginLeft: 'auto' }}>
            {shortWinRate.toFixed(0)}%
          </span>
          <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
            ({bySide.short?.n || 0})
          </span>
        </Flex>
      </Flex>

      {/* Top Symbols */}
      {topSymbols.length > 0 && (
        <div>
          <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 8 }}>TOP SYMBOLS</div>
          <Flex gap={8} wrap="wrap">
            {topSymbols.map(s => (
              <Tooltip key={s.symbol} title={`Win: ${s.winRate.toFixed(0)}% | Exp: ${s.expectancy >= 0 ? '+' : ''}${s.expectancy.toFixed(2)}%`}>
                <Tag
                  style={{
                    background: s.expectancy >= 0 ? 'rgba(52, 211, 153, 0.1)' : 'rgba(248, 113, 113, 0.1)',
                    border: `1px solid ${s.expectancy >= 0 ? 'rgba(52, 211, 153, 0.25)' : 'rgba(248, 113, 113, 0.25)'}`,
                    color: s.expectancy >= 0 ? 'var(--success)' : 'var(--error)',
                    borderRadius: 6,
                  }}
                >
                  {s.symbol} <span style={{ opacity: 0.7 }}>({s.n})</span>
                </Tag>
              </Tooltip>
            ))}
          </Flex>
        </div>
      )}

      {/* Adaptive Risk - compact */}
      {adaptive && (
        <Flex
          align="center"
          gap={12}
          style={{
            marginTop: 12,
            padding: '8px 12px',
            background: 'rgba(6, 182, 212, 0.08)',
            borderRadius: 8,
            border: '1px solid rgba(6, 182, 212, 0.15)',
          }}
        >
          <Target size={14} style={{ color: 'var(--accent)' }} />
          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Risk</span>
          <span style={{ color: 'var(--accent)', fontWeight: 600 }}>
            {(adaptive.riskPct || 0).toFixed(2)}%
          </span>
          {adaptive.appliedSymbolMultiplier && adaptive.appliedSymbolMultiplier !== 1 && (
            <Tag style={{ background: 'rgba(52, 211, 153, 0.15)', border: 'none', color: 'var(--success)', fontSize: 10 }}>
              ×{adaptive.appliedSymbolMultiplier.toFixed(2)}
            </Tag>
          )}
          {adaptive.dominantSymbol && (
            <span style={{ color: 'var(--text-muted)', fontSize: 11, marginLeft: 'auto' }}>
              Focus: {adaptive.dominantSymbol.replace('/USDT:USDT', '')}
            </span>
          )}
        </Flex>
      )}
    </Card>
  );
}

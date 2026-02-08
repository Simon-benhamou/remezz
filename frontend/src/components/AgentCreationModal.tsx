import React from 'react';
import {
  Rocket,
  CheckCircle,
  Zap,
  Trophy,
  Flame,
  Info,
  Loader2,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { api } from '../api';
import type { AppMode } from '../store';

// ═══════════════════════════════════════════════════════════════════════════
// CRYPTOS V5.93 - Classées par PnL combiné backtest 12 mois (Jan - Dec 2025)
// Combined: +1308% ROI, 61% WR, 29.8% DD ($2000, 4.5x, 710 trades)
// ═══════════════════════════════════════════════════════════════════════════

// RECOMMANDEES V5.93 - Top 10 winners en backtest combine
const V5_RECOMMENDED_CRYPTOS = [
  { symbol: 'AVAX/USDT', name: 'Avalanche', category: 'TOP 1', icon: '\u{1F53A}', roi: '+$4,850', badge: 'gold', recommended: true },
  { symbol: 'FET/USDT', name: 'Fetch.ai', category: 'TOP 2', icon: '\u{1F916}', roi: '+$4,558', badge: 'gold', recommended: true },
  { symbol: 'WIF/USDT', name: 'dogwifhat', category: 'TOP 3', icon: '\u{1F3A9}', roi: '+$3,686', badge: 'gold', recommended: true },
  { symbol: 'DOT/USDT', name: 'Polkadot', category: 'TOP 4', icon: '\u{2B24}', roi: '+$3,630', badge: 'gold', recommended: true },
  { symbol: 'TIA/USDT', name: 'Celestia', category: 'Excellent', icon: '\u{1F30C}', roi: '+$3,087', badge: 'green', recommended: true },
  { symbol: 'IMX/USDT', name: 'Immutable X', category: 'Excellent', icon: '\u{1F537}', roi: '+$2,552', badge: 'green', recommended: true },
  { symbol: 'STX/USDT', name: 'Stacks', category: 'Bon', icon: '\u{1F4E6}', roi: '+$1,761', badge: 'blue', recommended: true },
  { symbol: 'DOGE/USDT', name: 'Dogecoin', category: 'Bon', icon: '\u{1F415}', roi: '+$1,617', badge: 'blue', recommended: true },
  { symbol: 'ADA/USDT', name: 'Cardano', category: 'Bon', icon: '\u{20B3}', roi: '+$1,241', badge: 'blue', recommended: true },
  { symbol: 'BTC/USDT', name: 'Bitcoin', category: 'Stable', icon: '\u{20BF}', roi: '+$339', badge: 'cyan', recommended: true },
];

// AUTRES CRYPTOS - Disponibles mais pas dans le top 10 combine
const NON_RECOMMENDED_CRYPTOS = [
  { symbol: 'RENDER/USDT', name: 'Render', category: 'OK solo', icon: '\u{1F3A8}', roi: '+15%', badge: 'default', recommended: false },
  { symbol: 'SOL/USDT', name: 'Solana', category: 'OK solo', icon: '\u{25CE}', roi: '+25%', badge: 'default', recommended: false },
  { symbol: 'XRP/USDT', name: 'Ripple', category: 'OK solo', icon: '\u{2715}', roi: '+12%', badge: 'default', recommended: false },
  { symbol: 'NEAR/USDT', name: 'NEAR Protocol', category: 'OK solo', icon: '\u{1F310}', roi: '+19%', badge: 'default', recommended: false },
  { symbol: 'LINK/USDT', name: 'Chainlink', category: 'OK solo', icon: '\u{1F517}', roi: '+7%', badge: 'default', recommended: false },
  { symbol: 'ETH/USDT', name: 'Ethereum', category: 'Marginal', icon: '\u{039E}', roi: '~0%', badge: 'default', recommended: false },
  { symbol: 'SEI/USDT', name: 'Sei', category: 'Neg. combine', icon: '\u{1F30A}', roi: '-$1,160', badge: 'default', recommended: false },
];

// Combiner les deux listes (recommandees d'abord)
const ALL_CRYPTOS = [...V5_RECOMMENDED_CRYPTOS, ...NON_RECOMMENDED_CRYPTOS];

interface RankedCrypto {
  symbol: string;
  rank: number;
  score: number;
  volumeUsd24h: number;
  change24h: number;
  technical: {
    rsi: number;
    adx: number;
    atrPct: number;
    trend: string;
  };
  opportunity: {
    type: string;
    direction: string;
    confidence: number;
  };
  aiReasoning: string[];
}

interface AgentCreationModalProps {
  visible: boolean;
  mode: AppMode;
  onClose: () => void;
  onSuccess: () => void;
}

function getBadgeClasses(badge: string): string {
  switch (badge) {
    case 'gold':
      return 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/40';
    case 'green':
      return 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40';
    case 'blue':
      return 'bg-blue-500/20 text-blue-400 border border-blue-500/40';
    case 'cyan':
      return 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/40';
    case 'purple':
      return 'bg-purple-500/20 text-purple-400 border border-purple-500/40';
    default:
      return 'bg-muted text-muted-foreground border border-border';
  }
}

function getTrendClasses(trend: string): string {
  switch (trend) {
    case 'bullish':
      return 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40';
    case 'bearish':
      return 'bg-red-500/20 text-red-400 border border-red-500/40';
    default:
      return 'bg-muted text-muted-foreground border border-border';
  }
}

export default function AgentCreationModal({
  visible,
  mode,
  onClose,
  onSuccess,
}: AgentCreationModalProps) {
  const [maxLeverage, setMaxLeverage] = React.useState(4);
  const [activeTab, setActiveTab] = React.useState<'manual' | 'ai'>('manual');
  const [selectedSymbol, setSelectedSymbol] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [rankedCryptos, setRankedCryptos] = React.useState<RankedCrypto[]>([]);
  const [loadingRanking, setLoadingRanking] = React.useState(false);

  // Load crypto ranking when AI tab is opened
  React.useEffect(() => {
    if (visible && activeTab === 'ai' && rankedCryptos.length === 0) {
      loadCryptoRanking();
    }
  }, [visible, activeTab]);

  const loadCryptoRanking = async () => {
    setLoadingRanking(true);
    try {
      const ranking = await api.getCryptoRanking({ limit: 20 });
      setRankedCryptos(Array.isArray(ranking) ? ranking : []);
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Failed to load crypto ranking');
      setRankedCryptos([]);
    } finally {
      setLoadingRanking(false);
    }
  };

  const handleCreate = async () => {
    if (!selectedSymbol) {
      toast.warning('Please select a crypto first');
      return;
    }

    try {
      setCreating(true);

      const payload = {
        mode,
        symbol: selectedSymbol,
        maxLeverage,
        strategyEngine: 'meta_adaptive',
      };

      const prepare = await api.prepareAgentCreation(payload);
      const creationId = prepare?.creationId;

      if (!creationId) {
        throw new Error('No creation ID returned');
      }

      await api.createAgentSession(creationId, selectedSymbol);
      await api.activateAgentCreation(creationId);

      toast.success(`Agent created for ${selectedSymbol}`);
      onSuccess();
      handleClose();
    } catch (error: any) {
      const detail = error?.response?.data?.message || error?.message || error;
      toast.error(typeof detail === 'string' ? detail : 'Failed to create agent');
    } finally {
      setCreating(false);
    }
  };

  const handleClose = () => {
    setSelectedSymbol(null);
    setActiveTab('manual');
    setMaxLeverage(4);
    onClose();
  };

  return (
    <Dialog
      open={visible}
      onOpenChange={(open) => {
        if (!open && !creating) handleClose();
      }}
    >
      <DialogContent
        className={cn(
          'border-[var(--border-subtle)] bg-[var(--bg-primary)] text-[var(--text-primary)] p-0 gap-0',
          activeTab === 'ai' ? 'max-w-[1200px]' : 'max-w-[800px]'
        )}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        {/* Header */}
        <DialogHeader className="border-b border-[var(--border-subtle)] bg-[var(--bg-primary)] px-6 py-4">
          <DialogTitle className="flex items-center gap-2 text-[var(--text-primary)]">
            <Rocket className="h-5 w-5 text-[var(--accent-secondary)]" />
            <span>Create AI Trading Agent</span>
          </DialogTitle>
          <DialogDescription className="sr-only">
            Select a cryptocurrency and configure your AI trading agent.
          </DialogDescription>
        </DialogHeader>

        {/* Body */}
        <div
          className="p-6 max-h-[70vh] overflow-y-auto"
          style={{ background: 'var(--card-gradient)' }}
        >
          <Tabs
            value={activeTab}
            onValueChange={(value) => setActiveTab(value as 'manual' | 'ai')}
          >
            <TabsList className="mb-4">
              <TabsTrigger value="manual" className="flex items-center gap-1.5">
                <CheckCircle className="h-4 w-4" />
                Manual Selection
              </TabsTrigger>
              <TabsTrigger value="ai" className="flex items-center gap-1.5">
                <Zap className="h-4 w-4" />
                AI Suggestions
                <span className={cn(
                  'ml-1 inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold',
                  'bg-purple-500/20 text-purple-400 border border-purple-500/40'
                )}>
                  NEW
                </span>
              </TabsTrigger>
            </TabsList>

            {/* ── Manual Tab ── */}
            <TabsContent value="manual">
              <Alert className="mb-4 rounded-xl bg-emerald-500/10 border-emerald-500/30">
                <Trophy className="h-4 w-4 text-emerald-400" />
                <AlertTitle className="text-emerald-400">
                  Cryptos Backtestees V5.6 (24 mois)
                </AlertTitle>
                <AlertDescription className="text-[var(--text-secondary)]">
                  Toutes ces cryptos ont un <strong>ROI positif</strong> sur 24 mois (Nov 2023 - Nov 2025)
                  avec la strategie V5 (Momentum Simple). Win Rate moyen: 65-68%.
                </AlertDescription>
              </Alert>

              {/* V5 RECOMMENDED */}
              <span className="block mb-3 text-sm font-semibold text-[var(--success)]">
                TOUTES RECOMMANDEES - ROI Positif sur 24 mois
              </span>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 mb-6">
                {V5_RECOMMENDED_CRYPTOS.map((crypto) => {
                  const isSelected = selectedSymbol === crypto.symbol;
                  return (
                    <div
                      key={crypto.symbol}
                      onClick={() => setSelectedSymbol(crypto.symbol)}
                      className={cn(
                        'rounded-xl text-center cursor-pointer transition-all duration-300 p-3.5 hover:scale-[1.02]',
                        isSelected
                          ? 'bg-gradient-to-br from-emerald-500/30 to-emerald-700/20 border-2 border-[var(--success)] shadow-lg shadow-emerald-500/10'
                          : 'bg-gradient-to-br from-emerald-500/[0.08] to-slate-800/55 border border-emerald-500/30 hover:border-emerald-500/50'
                      )}
                    >
                      <div className="text-[28px] mb-1.5">{crypto.icon}</div>
                      <span className="block font-semibold text-[var(--text-primary)] mb-0.5">
                        {crypto.symbol.replace('/USDT', '')}
                      </span>
                      <span className="block text-[11px] text-[var(--text-secondary)] mb-1.5">
                        {crypto.name}
                      </span>
                      <span
                        className={cn(
                          'inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-semibold mb-1',
                          getBadgeClasses(crypto.badge)
                        )}
                      >
                        {crypto.category}
                      </span>
                      <div>
                        <span
                          className={cn(
                            'text-[13px] font-bold',
                            crypto.roi.startsWith('+') ? 'text-[var(--success)]' : 'text-[var(--error)]'
                          )}
                        >
                          {crypto.roi}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* NON RECOMMENDED */}
              <Alert className="mb-3 mt-4 rounded-xl bg-[var(--bg-card-hover)] border-blue-500/25">
                <Info className="h-4 w-4 text-blue-400" />
                <AlertTitle className="text-blue-400">
                  Autres Cryptos Disponibles
                </AlertTitle>
                <AlertDescription className="text-[var(--text-secondary)]">
                  Ces cryptos n'ont pas ete testees sur 24 mois avec notre strategie.
                </AlertDescription>
              </Alert>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 mb-6">
                {NON_RECOMMENDED_CRYPTOS.map((crypto) => {
                  const isSelected = selectedSymbol === crypto.symbol;
                  return (
                    <div
                      key={crypto.symbol}
                      onClick={() => setSelectedSymbol(crypto.symbol)}
                      className={cn(
                        'rounded-xl text-center cursor-pointer transition-all duration-300 p-3.5 opacity-70 hover:opacity-90',
                        isSelected
                          ? 'bg-gradient-to-br from-red-500/25 to-red-800/15 border-2 border-[var(--error)] shadow-lg'
                          : 'bg-slate-800/40 border border-[rgba(71,107,176,0.12)] hover:border-[rgba(71,107,176,0.3)]'
                      )}
                    >
                      <div className="text-[28px] mb-1.5">{crypto.icon}</div>
                      <span className="block font-semibold text-[var(--text-secondary)] mb-0.5">
                        {crypto.symbol.replace('/USDT', '')}
                      </span>
                      <span className="block text-[11px] text-[var(--text-secondary)] mb-1.5">
                        {crypto.name}
                      </span>
                      <span
                        className={cn(
                          'inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-semibold mb-1',
                          getBadgeClasses(crypto.badge)
                        )}
                      >
                        {crypto.category}
                      </span>
                      <div>
                        <span className="text-xs font-semibold text-[var(--error)]">
                          {crypto.roi}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </TabsContent>

            {/* ── AI Tab ── */}
            <TabsContent value="ai">
              <Alert className="mb-4 rounded-xl bg-emerald-500/[0.08] border-emerald-500/25">
                <Flame className="h-4 w-4 text-emerald-400" />
                <AlertTitle className="text-emerald-400">
                  AI-Ranked Opportunities
                </AlertTitle>
                <AlertDescription className="text-[var(--text-secondary)]">
                  These cryptos are identified by AI as having high potential based on technical
                  analysis, volume, and market conditions. All suggestions have sufficient volume
                  for safe trading.
                </AlertDescription>
              </Alert>

              {loadingRanking ? (
                <div className="flex flex-col items-center justify-center py-12">
                  <Loader2 className="h-8 w-8 animate-spin text-[var(--text-secondary)]" />
                  <span className="block mt-4 text-[var(--text-secondary)]">
                    Analyzing market opportunities...
                  </span>
                </div>
              ) : rankedCryptos.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12">
                  <span className="text-[var(--text-secondary)]">No ranking data available</span>
                  <Button onClick={loadCryptoRanking} className="mt-4">
                    Load Ranking
                  </Button>
                </div>
              ) : (
                <>
                  <div className="mb-4 flex items-center gap-2">
                    <Trophy className="h-4 w-4 text-[var(--success)]" />
                    <span className="text-xs text-[var(--text-secondary)]">Opportunities Found</span>
                    <span className="text-lg font-semibold text-[var(--success)]">
                      {rankedCryptos.length}
                    </span>
                  </div>

                  <div className="max-h-[400px] overflow-y-auto rounded-lg border border-[var(--border-subtle)]">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-[var(--border-subtle)]">
                          <TableHead className="w-[60px]">Rank</TableHead>
                          <TableHead>Symbol</TableHead>
                          <TableHead>Score</TableHead>
                          <TableHead>Volume 24h</TableHead>
                          <TableHead>Change</TableHead>
                          <TableHead>Trend</TableHead>
                          <TableHead>Opportunity</TableHead>
                          <TableHead>Confidence</TableHead>
                          <TableHead>Action</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rankedCryptos.map((record) => (
                          <TableRow
                            key={record.symbol}
                            className={cn(
                              'border-[var(--border-subtle)]',
                              selectedSymbol === record.symbol && 'bg-primary/10'
                            )}
                          >
                            <TableCell>
                              <span
                                className={cn(
                                  'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold',
                                  record.rank <= 3
                                    ? getBadgeClasses('gold')
                                    : record.rank <= 10
                                      ? getBadgeClasses('blue')
                                      : getBadgeClasses('default')
                                )}
                              >
                                #{record.rank}
                              </span>
                            </TableCell>
                            <TableCell>
                              <span className="font-semibold text-[var(--text-primary)]">
                                {record.symbol}
                              </span>
                            </TableCell>
                            <TableCell>
                              <span className="font-semibold text-[var(--success)]">
                                {(record.score * 100).toFixed(0)}%
                              </span>
                            </TableCell>
                            <TableCell>
                              <span className="text-[#cbd5f5]">
                                ${(record.volumeUsd24h / 1_000_000).toFixed(1)}M
                              </span>
                            </TableCell>
                            <TableCell>
                              <span
                                className={cn(
                                  'font-semibold',
                                  record.change24h >= 0
                                    ? 'text-[var(--success)]'
                                    : 'text-[var(--error)]'
                                )}
                              >
                                {record.change24h >= 0 ? '+' : ''}
                                {record.change24h.toFixed(2)}%
                              </span>
                            </TableCell>
                            <TableCell>
                              <span
                                className={cn(
                                  'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold',
                                  getTrendClasses(record.technical.trend)
                                )}
                              >
                                {record.technical.trend}
                              </span>
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-col gap-0.5">
                                <span className="text-xs text-[var(--text-primary)]">
                                  {record.opportunity.type}
                                </span>
                                <span
                                  className={cn(
                                    'inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold w-fit',
                                    record.opportunity.direction === 'long'
                                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                                      : 'bg-red-500/20 text-red-400 border border-red-500/40'
                                  )}
                                >
                                  {record.opportunity.direction.toUpperCase()}
                                </span>
                              </div>
                            </TableCell>
                            <TableCell>
                              <span
                                className={cn(
                                  'font-medium',
                                  record.opportunity.confidence >= 0.7
                                    ? 'text-[var(--success)]'
                                    : record.opportunity.confidence >= 0.5
                                      ? 'text-[var(--warning)]'
                                      : 'text-[var(--error)]'
                                )}
                              >
                                {(record.opportunity.confidence * 100).toFixed(0)}%
                              </span>
                            </TableCell>
                            <TableCell>
                              <Button
                                variant={selectedSymbol === record.symbol ? 'default' : 'outline'}
                                size="sm"
                                onClick={() => setSelectedSymbol(record.symbol)}
                              >
                                {selectedSymbol === record.symbol ? 'Selected' : 'Select'}
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </>
              )}
            </TabsContent>
          </Tabs>

          <Separator className="my-6" />

          {/* Configuration */}
          <div className="space-y-4">
            {/* Leverage Slider */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-sm text-[var(--text-primary)]">Max Leverage</span>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-3.5 w-3.5 text-[var(--text-secondary)] cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent>
                      Maximum leverage the agent can use for trades
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <span className="ml-auto text-sm font-semibold text-[var(--text-primary)]">
                  {maxLeverage}x
                </span>
              </div>
              <div className="px-1">
                <Slider
                  min={1}
                  max={10}
                  step={1}
                  value={[maxLeverage]}
                  onValueChange={(value) => setMaxLeverage(value[0])}
                />
                <div className="flex justify-between mt-1.5 text-xs text-[var(--text-secondary)]">
                  <span>1x</span>
                  <span>5x</span>
                  <span>10x</span>
                </div>
              </div>
            </div>

            {/* Strategy summary card */}
            <div className="bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded-xl p-4 flex flex-wrap gap-6">
              <div className="flex-1 min-w-[100px]">
                <span className="block text-xs text-[var(--text-secondary)] mb-1">
                  Position Size
                </span>
                <span className="text-lg font-semibold text-[var(--text-primary)]">40%</span>
              </div>
              <div className="flex-1 min-w-[100px]">
                <span className="block text-xs text-[var(--text-secondary)] mb-1">Stop Loss</span>
                <span className="text-lg font-semibold text-[var(--error)]">1.5%</span>
                <span className="block text-[10px] text-[var(--text-secondary)]">
                  ~7.5% avec 5x lev
                </span>
              </div>
              <div className="flex-1 min-w-[100px]">
                <span className="block text-xs text-[var(--text-secondary)] mb-1">Take Profit</span>
                <span className="text-lg font-semibold text-[var(--success)]">3.0%</span>
                <span className="block text-[10px] text-[var(--text-secondary)]">
                  ~15% avec 5x lev
                </span>
              </div>
              <div className="flex-1 min-w-[100px]">
                <span className="block text-xs text-[var(--text-secondary)] mb-1">Strategy</span>
                <span className="text-lg font-semibold text-[var(--success)]">V5 Momentum</span>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <DialogFooter className="border-t border-[var(--border-subtle)] bg-[var(--bg-primary)] px-6 py-4">
          <Button variant="outline" onClick={handleClose} disabled={creating}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={!selectedSymbol || creating}>
            {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create Agent{selectedSymbol ? ` (${selectedSymbol})` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

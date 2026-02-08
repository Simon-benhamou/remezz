import React from 'react';
import {
  Rocket,
  Trophy,
  Info,
  Loader2,
  Check,
  Sparkles,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { api } from '../api';
import type { AppMode } from '../store';

// ═══════════════════════════════════════════════════════════════════════════
// CRYPTOS V5.93 - Classées par PnL combiné backtest 12 mois (Jan - Dec 2025)
// Combined: +1308% ROI, 61% WR, 29.8% DD ($2000, 4.5x, 710 trades)
// ═══════════════════════════════════════════════════════════════════════════

const V5_RECOMMENDED_CRYPTOS = [
  { symbol: 'AVAX/USDT', name: 'Avalanche', category: 'TOP 1', icon: '\u{1F53A}', roi: '+$4,850', badge: 'gold', recommended: true },
  { symbol: 'FET/USDT', name: 'Fetch.ai', category: 'TOP 2', icon: '\u{1F916}', roi: '+$4,558', badge: 'gold', recommended: true },
  { symbol: 'WIF/USDT', name: 'dogwifhat', category: 'TOP 3', icon: '\u{1F3A9}', roi: '+$3,686', badge: 'gold', recommended: true },
  { symbol: 'DOT/USDT', name: 'Polkadot', category: 'TOP 4', icon: '\u{1F30C}', roi: '+$3,630', badge: 'gold', recommended: true },
  { symbol: 'TIA/USDT', name: 'Celestia', category: 'Excellent', icon: '\u{2728}', roi: '+$3,087', badge: 'green', recommended: true },
  { symbol: 'IMX/USDT', name: 'Immutable X', category: 'Excellent', icon: '\u{1F537}', roi: '+$2,552', badge: 'green', recommended: true },
  { symbol: 'STX/USDT', name: 'Stacks', category: 'Bon', icon: '\u{1F4E6}', roi: '+$1,761', badge: 'blue', recommended: true },
  { symbol: 'DOGE/USDT', name: 'Dogecoin', category: 'Bon', icon: '\u{1F415}', roi: '+$1,617', badge: 'blue', recommended: true },
  { symbol: 'ADA/USDT', name: 'Cardano', category: 'Bon', icon: '\u{20B3}', roi: '+$1,241', badge: 'blue', recommended: true },
  { symbol: 'BTC/USDT', name: 'Bitcoin', category: 'Stable', icon: '\u{20BF}', roi: '+$339', badge: 'cyan', recommended: true },
];

const NON_RECOMMENDED_CRYPTOS = [
  { symbol: 'RENDER/USDT', name: 'Render', category: 'OK solo', icon: '\u{1F3A8}', roi: '+15%', badge: 'default', recommended: false },
  { symbol: 'SOL/USDT', name: 'Solana', category: 'OK solo', icon: '\u{25CE}', roi: '+25%', badge: 'default', recommended: false },
  { symbol: 'XRP/USDT', name: 'Ripple', category: 'OK solo', icon: '\u{2715}', roi: '+12%', badge: 'default', recommended: false },
  { symbol: 'NEAR/USDT', name: 'NEAR Protocol', category: 'OK solo', icon: '\u{1F310}', roi: '+19%', badge: 'default', recommended: false },
  { symbol: 'LINK/USDT', name: 'Chainlink', category: 'OK solo', icon: '\u{1F517}', roi: '+7%', badge: 'default', recommended: false },
  { symbol: 'ETH/USDT', name: 'Ethereum', category: 'Marginal', icon: '\u{039E}', roi: '~0%', badge: 'default', recommended: false },
  { symbol: 'SEI/USDT', name: 'Sei', category: 'Neg. combine', icon: '\u{1F30A}', roi: '-$1,160', badge: 'default', recommended: false },
];

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

export default function AgentCreationModal({
  visible,
  mode,
  onClose,
  onSuccess,
}: AgentCreationModalProps) {
  const [maxLeverage, setMaxLeverage] = React.useState(4);
  const [selectedSymbols, setSelectedSymbols] = React.useState<Set<string>>(new Set());
  const [creating, setCreating] = React.useState(false);

  const toggleSymbol = (symbol: string) => {
    setSelectedSymbols((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) {
        next.delete(symbol);
      } else {
        next.add(symbol);
      }
      return next;
    });
  };

  const selectAllRecommended = () => {
    setSelectedSymbols((prev) => {
      const allRecommended = V5_RECOMMENDED_CRYPTOS.map((c) => c.symbol);
      const hasAll = allRecommended.every((s) => prev.has(s));
      if (hasAll) {
        // Deselect all recommended
        const next = new Set(prev);
        allRecommended.forEach((s) => next.delete(s));
        return next;
      }
      // Select all recommended
      const next = new Set(prev);
      allRecommended.forEach((s) => next.add(s));
      return next;
    });
  };

  const allRecommendedSelected = V5_RECOMMENDED_CRYPTOS.every((c) =>
    selectedSymbols.has(c.symbol)
  );

  const handleCreate = async () => {
    if (selectedSymbols.size === 0) {
      toast.warning('Please select at least one crypto');
      return;
    }

    try {
      setCreating(true);
      const symbols = Array.from(selectedSymbols);

      const payload = {
        mode,
        symbols,
        maxLeverage,
        strategyEngine: 'meta_adaptive',
      };

      const result = await api.createBulkAgentSessions(payload);

      if (result?.created > 0) {
        toast.success(
          result.created === 1
            ? `Agent created for ${symbols[0]}`
            : `${result.created} agents created`
        );
      }
      if (result?.errors?.length > 0) {
        result.errors.forEach((err: { symbol: string; error: string }) =>
          toast.error(`${err.symbol}: ${err.error}`)
        );
      }

      onSuccess();
      handleClose();
    } catch (error: any) {
      const detail = error?.response?.data?.message || error?.message || error;
      toast.error(typeof detail === 'string' ? detail : 'Failed to create agents');
    } finally {
      setCreating(false);
    }
  };

  const handleClose = () => {
    setSelectedSymbols(new Set());
    setMaxLeverage(4);
    onClose();
  };

  const selectedCount = selectedSymbols.size;

  return (
    <Dialog
      open={visible}
      onOpenChange={(open) => {
        if (!open && !creating) handleClose();
      }}
    >
      <DialogContent
        className="p-0 gap-0 max-w-[860px] border-0 text-foreground"
        style={{ background: '#0f172a', borderRadius: 16, border: '1px solid rgba(40, 68, 105, 0.4)' }}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        {/* Header */}
        <DialogHeader
          className="px-6 py-4"
          style={{ borderBottom: '1px solid rgba(40, 68, 105, 0.4)', background: '#0c1322' }}
        >
          <DialogTitle className="flex items-center gap-2.5 text-slate-100">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 via-blue-500 to-cyan-500">
              <Rocket className="h-4 w-4 text-white" />
            </div>
            <span className="text-lg font-semibold">Create AI Trading Agent</span>
            {selectedCount > 0 && (
              <span className="ml-2 inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold text-blue-400" style={{ background: 'rgba(99, 102, 241, 0.15)', border: '1px solid rgba(99, 102, 241, 0.3)' }}>
                {selectedCount} selected
              </span>
            )}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Select cryptocurrencies and configure your AI trading agents.
          </DialogDescription>
        </DialogHeader>

        {/* Body */}
        <div className="px-6 py-5 max-h-[65vh] overflow-y-auto" style={{ background: '#0f172a' }}>
          {/* Info banner */}
          <div className="mb-5 rounded-xl p-4 flex gap-3" style={{ background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.08), rgba(59, 130, 246, 0.08), rgba(6, 182, 212, 0.08))', border: '1px solid rgba(99, 102, 241, 0.2)' }}>
            <Sparkles className="h-4 w-4 text-blue-400 mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold text-sm bg-gradient-to-r from-indigo-400 via-blue-400 to-cyan-400 bg-clip-text text-transparent">
                Cryptos Backtestees V5.93 (12 mois)
              </div>
              <p className="text-slate-400 text-[13px] mt-0.5">
                Classees par PnL combine sur 12 mois (Jan - Dec 2025). V5 Momentum Simple.
                Selectionnez une ou plusieurs cryptos pour creer vos agents.
              </p>
            </div>
          </div>

          {/* Select All Recommended */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Trophy className="h-4 w-4 text-yellow-500" />
              <span className="text-sm font-semibold text-slate-100">
                Recommandees — ROI Positif 12 mois
              </span>
            </div>
            <button
              type="button"
              onClick={selectAllRecommended}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all"
              style={allRecommendedSelected ? {
                background: 'linear-gradient(90deg, rgba(99, 102, 241, 0.15), rgba(59, 130, 246, 0.15), rgba(6, 182, 212, 0.15))',
                color: '#60a5fa',
                border: '1px solid rgba(59, 130, 246, 0.3)',
              } : {
                color: '#94a3b8',
                border: '1px solid rgba(40, 68, 105, 0.35)',
              }}
            >
              <Check className="h-3 w-3" />
              {allRecommendedSelected ? 'Deselect All' : 'Select All'}
            </button>
          </div>

          {/* Recommended crypto cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2.5 mb-6">
            {V5_RECOMMENDED_CRYPTOS.map((crypto) => {
              const isSelected = selectedSymbols.has(crypto.symbol);
              return (
                <button
                  key={crypto.symbol}
                  type="button"
                  onClick={() => toggleSymbol(crypto.symbol)}
                  className="relative rounded-xl text-center transition-all duration-200 p-3"
                  style={isSelected ? {
                    background: 'linear-gradient(180deg, rgba(99, 102, 241, 0.18) 0%, rgba(59, 130, 246, 0.12) 50%, rgba(6, 182, 212, 0.18) 100%)',
                    border: '2px solid rgba(59, 130, 246, 0.5)',
                    boxShadow: '0 0 20px rgba(59, 130, 246, 0.15)',
                  } : {
                    background: '#1a2436',
                    border: '1px solid rgba(40, 68, 105, 0.35)',
                  }}
                >
                  {/* Selection indicator */}
                  {isSelected && (
                    <div className="absolute top-1.5 right-1.5 h-5 w-5 rounded-full bg-gradient-to-br from-indigo-500 via-blue-500 to-cyan-500 flex items-center justify-center">
                      <Check className="h-3 w-3 text-white" />
                    </div>
                  )}
                  <div className="text-2xl mb-1">{crypto.icon}</div>
                  <span className="block font-semibold text-sm text-slate-100">
                    {crypto.symbol.replace('/USDT', '')}
                  </span>
                  <span className="block text-[10px] text-slate-400 mb-1.5">
                    {crypto.name}
                  </span>
                  <span
                    className={cn(
                      'inline-flex items-center rounded-md px-1.5 py-0.5 text-[9px] font-semibold mb-1',
                      getBadgeClasses(crypto.badge)
                    )}
                  >
                    {crypto.category}
                  </span>
                  <div>
                    <span className="text-xs font-bold text-emerald-400">
                      {crypto.roi}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Non-recommended section */}
          <div className="mb-3 rounded-xl p-3 flex items-start gap-2.5" style={{ background: '#151e2e', border: '1px solid rgba(40, 68, 105, 0.3)' }}>
            <Info className="h-4 w-4 text-slate-500 mt-0.5 shrink-0" />
            <div>
              <div className="text-sm font-medium text-slate-400">Autres Cryptos Disponibles</div>
              <p className="text-[12px] text-slate-500 mt-0.5">Non testees sur 12 mois en combine. Performances variables.</p>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5 mb-6">
            {NON_RECOMMENDED_CRYPTOS.map((crypto) => {
              const isSelected = selectedSymbols.has(crypto.symbol);
              return (
                <button
                  key={crypto.symbol}
                  type="button"
                  onClick={() => toggleSymbol(crypto.symbol)}
                  className="relative rounded-xl text-center transition-all duration-200 p-3 opacity-60 hover:opacity-85"
                  style={isSelected ? {
                    background: '#1a2436',
                    border: '2px solid rgba(148, 163, 184, 0.4)',
                    opacity: 0.9,
                  } : {
                    background: '#141c2b',
                    border: '1px solid rgba(40, 68, 105, 0.25)',
                  }}
                >
                  {isSelected && (
                    <div className="absolute top-1.5 right-1.5 h-4 w-4 rounded-full flex items-center justify-center" style={{ background: '#94a3b8' }}>
                      <Check className="h-2.5 w-2.5 text-slate-900" />
                    </div>
                  )}
                  <div className="text-xl mb-1">{crypto.icon}</div>
                  <span className="block font-semibold text-xs text-slate-400">
                    {crypto.symbol.replace('/USDT', '')}
                  </span>
                  <span className="block text-[10px] text-slate-500 mb-1">
                    {crypto.name}
                  </span>
                  <span
                    className={cn(
                      'inline-flex items-center rounded-md px-1.5 py-0.5 text-[9px] font-semibold mb-1',
                      getBadgeClasses(crypto.badge)
                    )}
                  >
                    {crypto.category}
                  </span>
                  <div>
                    <span
                      className={cn(
                        'text-[11px] font-semibold',
                        crypto.roi.startsWith('+') || crypto.roi.startsWith('~')
                          ? 'text-slate-500'
                          : 'text-red-400'
                      )}
                    >
                      {crypto.roi}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="my-5" style={{ height: 1, background: 'rgba(40, 68, 105, 0.3)' }} />

          {/* Configuration */}
          <div className="space-y-4">
            {/* Leverage Slider */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-sm text-slate-200">Max Leverage</span>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-3.5 w-3.5 text-slate-500 cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent>
                      Maximum leverage the agent can use for trades
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <span className="ml-auto text-sm font-semibold text-slate-200">
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
                <div className="flex justify-between mt-1.5 text-xs text-slate-500">
                  <span>1x</span>
                  <span>5x</span>
                  <span>10x</span>
                </div>
              </div>
            </div>

            {/* Strategy summary card */}
            <div className="rounded-xl p-4 flex flex-wrap gap-6" style={{ background: '#1a2436', border: '1px solid rgba(40, 68, 105, 0.35)' }}>
              <div className="flex-1 min-w-[100px]">
                <span className="block text-xs text-slate-500 mb-1">
                  Position Size
                </span>
                <span className="text-lg font-semibold text-slate-200">40%</span>
              </div>
              <div className="flex-1 min-w-[100px]">
                <span className="block text-xs text-slate-500 mb-1">Stop Loss</span>
                <span className="text-lg font-semibold text-red-400">1.5%</span>
                <span className="block text-[10px] text-slate-500">
                  ~7.5% avec 5x lev
                </span>
              </div>
              <div className="flex-1 min-w-[100px]">
                <span className="block text-xs text-slate-500 mb-1">Take Profit</span>
                <span className="text-lg font-semibold text-emerald-400">3.0%</span>
                <span className="block text-[10px] text-slate-500">
                  ~15% avec 5x lev
                </span>
              </div>
              <div className="flex-1 min-w-[100px]">
                <span className="block text-xs text-slate-500 mb-1">Strategy</span>
                <span className="text-lg font-semibold bg-gradient-to-r from-indigo-400 via-blue-400 to-cyan-400 bg-clip-text text-transparent">
                  V5 Momentum
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <DialogFooter className="px-6 py-4 flex items-center gap-3" style={{ borderTop: '1px solid rgba(40, 68, 105, 0.4)', background: '#0c1322' }}>
          <Button variant="outline" onClick={handleClose} disabled={creating}>
            Cancel
          </Button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={selectedCount === 0 || creating}
            className={cn(
              'inline-flex items-center justify-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold text-white transition-all',
              'bg-gradient-to-r from-indigo-500 via-blue-500 to-cyan-500',
              'hover:from-indigo-400 hover:via-blue-400 hover:to-cyan-400',
              'shadow-[0_0_20px_rgba(59,130,246,0.3)] hover:shadow-[0_0_30px_rgba(59,130,246,0.4)]',
              'disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none'
            )}
          >
            {creating && <Loader2 className="h-4 w-4 animate-spin" />}
            {creating
              ? 'Creating...'
              : selectedCount === 0
                ? 'Select Cryptos'
                : selectedCount === 1
                  ? `Create Agent (${Array.from(selectedSymbols)[0].replace('/USDT', '')})`
                  : `Create ${selectedCount} Agents`}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

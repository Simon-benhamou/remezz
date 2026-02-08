import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { api } from '../api';

const formatUsd = (value?: number | null) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
};

const formatLeverage = (value?: number | null) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '1x';
  return `${value.toFixed(1)}x`;
};

type Snapshot = {
  totalUSD: number;
  freeUSD: number;
  reservedUSD: number;
  inPositionsUSD: number;
  ts: number;
};

type Reservation = {
  id: string;
  agentId: string;
  symbol: string;
  requestedUSD: number;
  grantedUSD: number;
  leverage?: number;
  expiresAt: number;
  state: 'reserved' | 'committed' | 'released';
};

type PortfolioBalanceModalProps = {
  open: boolean;
  mode: 'live' | 'paper';
  onClose: () => void;
  onUpdated?: () => void;
};

function StatCard({ label, value, tooltip }: { label: string; value: string; tooltip?: string }) {
  const content = (
    <div className="rounded-lg border border-border bg-muted/40 p-3">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className="text-lg font-semibold tracking-tight">{value}</p>
    </div>
  );

  if (tooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    );
  }

  return content;
}

export default function PortfolioBalanceModal({ open, mode, onClose, onUpdated }: PortfolioBalanceModalProps) {
  const [paperSnapshot, setPaperSnapshot] = React.useState<Snapshot | null>(null);
  const [liveSnapshot, setLiveSnapshot] = React.useState<Snapshot | null>(null);
  const [paperReservations, setPaperReservations] = React.useState<Reservation[]>([]);
  const [liveReservations, setLiveReservations] = React.useState<Reservation[]>([]);
  const [paperBalance, setPaperBalance] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(false);

  const loadSnapshots = React.useCallback(async () => {
    try {
      setLoading(true);
      const [paper, live, reservations] = await Promise.all([
        api.getCapitalSnapshot('paper').catch(() => null),
        api.getCapitalSnapshot('live').catch(() => null),
        api.getCapitalReservations().catch(() => ({ paper: [], live: [] })),
      ]);
      setPaperSnapshot(paper);
      setLiveSnapshot(live);
      setPaperReservations(reservations.paper.filter((r: Reservation) => r.state === 'reserved'));
      setLiveReservations(reservations.live.filter((r: Reservation) => r.state === 'reserved'));
      if (paper?.totalUSD != null) {
        setPaperBalance(Number(paper.totalUSD));
      }
    } catch (error) {
      console.error('Failed to load capital snapshots', error);
      toast.error('Unable to load capital snapshots');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (open) {
      void loadSnapshots();
    }
  }, [open, loadSnapshots]);

  const handleSave = async () => {
    if (mode !== 'paper') {
      onClose();
      return;
    }
    if (!Number.isFinite(paperBalance) || paperBalance == null || paperBalance <= 0) {
      toast.error('Enter a valid initial balance');
      return;
    }
    try {
      setLoading(true);
      await api.setPaperCapitalBalance(Number(paperBalance));
      toast.success('Paper balance updated');
      await loadSnapshots();
      onUpdated?.();
      onClose();
    } catch (error) {
      console.error('Failed to update paper balance', error);
      toast.error('Unable to update paper balance');
    } finally {
      setLoading(false);
    }
  };

  const currentSnapshot = mode === 'paper' ? paperSnapshot : liveSnapshot;
  const currentReservations = mode === 'paper' ? paperReservations : liveReservations;

  const renderSnapshot = (snapshot: Snapshot | null, label: string) => (
    <div className="grid grid-cols-2 gap-3 w-full">
      <StatCard label={`${label} Total`} value={formatUsd(snapshot?.totalUSD)} />
      <StatCard label="Free" value={formatUsd(snapshot?.freeUSD)} />
      <StatCard
        label="Reserved (Margin)"
        value={formatUsd(snapshot?.reservedUSD)}
        tooltip="Margin reserved by agents (with leverage applied)"
      />
      <StatCard
        label="In Positions (Margin)"
        value={formatUsd(snapshot?.inPositionsUSD)}
        tooltip="Margin locked in open positions (with leverage applied)"
      />
    </div>
  );

  return (
    <TooltipProvider>
      <Dialog
        open={open}
        onOpenChange={(isOpen) => {
          if (!isOpen && !loading) onClose();
        }}
      >
        <DialogContent
          className={cn(currentReservations.length > 0 ? 'max-w-[800px]' : 'max-w-[600px]')}
          onPointerDownOutside={(e) => { if (loading) e.preventDefault(); }}
          onEscapeKeyDown={(e) => { if (loading) e.preventDefault(); }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg">
              Capital Pool Snapshot
              <span
                className={cn(
                  'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium',
                  mode === 'live'
                    ? 'bg-cyan-500/10 text-cyan-400 ring-1 ring-inset ring-cyan-500/20'
                    : 'bg-blue-500/10 text-blue-400 ring-1 ring-inset ring-blue-500/20'
                )}
              >
                {mode.toUpperCase()}
              </span>
            </DialogTitle>
            <DialogDescription>
              View the shared capital pool for {mode === 'live' ? 'live trading' : 'paper simulation'}.{' '}
              {mode === 'paper'
                ? 'You can adjust the initial paper balance below.'
                : 'Live balances are read-only and sourced from the exchange.'}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-6">
            {renderSnapshot(currentSnapshot, mode === 'paper' ? 'Paper' : 'Live')}

            {currentReservations.length > 0 && (
              <>
                <Separator />
                <div className="flex flex-col gap-2">
                  <span className="text-sm font-semibold">Active Reservations with Leverage</span>
                  <p className="text-sm text-muted-foreground mb-2">
                    Agents reserve margin (not full notional) when using leverage. The &quot;Margin&quot; column shows the actual capital locked from the pool.
                  </p>
                  <div className="overflow-x-auto rounded-md border border-border">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border bg-muted/50">
                          <th className="px-3 py-2 text-left font-medium text-muted-foreground">Symbol</th>
                          <th className="px-3 py-2 text-left font-medium text-muted-foreground">Agent</th>
                          <th className="px-3 py-2 text-left font-medium text-muted-foreground">Notional</th>
                          <th className="px-3 py-2 text-left font-medium text-muted-foreground">Leverage</th>
                          <th className="px-3 py-2 text-left font-medium text-muted-foreground">Margin</th>
                        </tr>
                      </thead>
                      <tbody>
                        {currentReservations.map((r) => (
                          <tr key={r.id} className="border-b border-border last:border-0">
                            <td className="px-3 py-2">{r.symbol}</td>
                            <td className="px-3 py-2 text-muted-foreground">{r.agentId.slice(0, 8)}...</td>
                            <td className="px-3 py-2">{formatUsd(r.requestedUSD)}</td>
                            <td className="px-3 py-2">
                              <span
                                className={cn(
                                  'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
                                  !r.leverage || r.leverage === 1
                                    ? 'bg-muted text-muted-foreground ring-border'
                                    : r.leverage >= 5
                                      ? 'bg-orange-500/10 text-orange-400 ring-orange-500/20'
                                      : 'bg-blue-500/10 text-blue-400 ring-blue-500/20'
                                )}
                              >
                                {formatLeverage(r.leverage)}
                              </span>
                            </td>
                            <td className="px-3 py-2">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="font-semibold cursor-help">{formatUsd(r.grantedUSD)}</span>
                                </TooltipTrigger>
                                <TooltipContent>
                                  {formatUsd(r.requestedUSD)} / {formatLeverage(r.leverage)} = {formatUsd(r.grantedUSD)}
                                </TooltipContent>
                              </Tooltip>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}

            {mode === 'paper' && (
              <>
                <Separator />
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-semibold" htmlFor="paper-balance-input">
                    Initial Cash (USD)
                  </label>
                  <Input
                    id="paper-balance-input"
                    type="number"
                    min={0}
                    step={100}
                    value={paperBalance ?? ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      setPaperBalance(val === '' ? null : Number(val));
                    }}
                  />
                  <p className="text-sm text-muted-foreground">
                    Updating this value resets the paper ledger and applies instantly to all paper agents.
                  </p>
                </div>
              </>
            )}

            <Separator />
            <div className="flex flex-col gap-3">
              <span className="text-sm text-muted-foreground">Live Snapshot</span>
              {renderSnapshot(liveSnapshot, 'Live')}
            </div>
          </div>

          <DialogFooter>
            {mode === 'paper' ? (
              <>
                <Button variant="outline" onClick={onClose} disabled={loading}>
                  Cancel
                </Button>
                <Button onClick={handleSave} disabled={loading}>
                  {loading ? 'Saving...' : 'Save'}
                </Button>
              </>
            ) : (
              <Button onClick={onClose}>Close</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

import crypto from 'crypto';
import {
  BalanceProvider,
  BalanceSnapshot,
  CapitalManagerConfig,
  Reservation,
  USD,
  ZERO_USD,
  ONE,
  usdMax,
  usdMin,
  usdNeg,
  toUSD,
} from './types.js';
import { PreciseDecimal } from '../../quantai/strategies/metaAdaptive/metaAdaptiveAgent.js';

type CapitalStore = {
  reservations: Map<string, Reservation>;
  symbolExposure: Map<string, USD>;
};

export class CapitalManager {
  private mutex: Promise<void> = Promise.resolve();

  constructor(
    private provider: BalanceProvider,
    private cfg: CapitalManagerConfig,
    private readonly store: CapitalStore,
  ) {}

  private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.mutex;
    let release!: () => void;
    this.mutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async getBalance(): Promise<BalanceSnapshot> {
    return this.provider.getSnapshot();
  }

  listReservations(): Reservation[] {
    return Array.from(this.store.reservations.values());
  }

  async clearLedger(): Promise<void> {
    await this.runExclusive(async () => {
      this.store.reservations.clear();
      this.store.symbolExposure.clear();
    });
  }

  private currentSymbolExposureUSD(symbol: string): USD {
    return this.store.symbolExposure.get(symbol) ?? ZERO_USD;
  }

  private setSymbolExposure(symbol: string, value: USD): void {
    const sanitized = value.raw > ZERO_USD.raw ? value : PreciseDecimal.fromRaw(ZERO_USD.raw);
    this.store.symbolExposure.set(symbol, sanitized);
  }

  public getSymbolExposureUsd(symbol: string): USD {
    return this.currentSymbolExposureUSD(symbol);
  }

  private incrementSymbolExposure(symbol: string, delta: USD): void {
    const current = this.currentSymbolExposureUSD(symbol);
    const next = current.plus(delta);
    this.setSymbolExposure(symbol, next);
  }

  private effectivePerSymbolCap(totalPool: USD): USD {
    const cap = totalPool.times(this.cfg.perSymbolCapPct);
    return usdMax(cap, this.cfg.minOrderUSD);
  }

  async reserve(req: {
    agentId: string;
    symbol: string;
    requestedUSD: USD | number | string;
    minUSD?: USD | number | string;
    leverage?: number;
  }): Promise<Reservation | null> {
    return this.runExclusive(() => this.reserveInternal(req));
  }

  private async reserveInternal(req: {
    agentId: string;
    symbol: string;
    requestedUSD: USD | number | string;
    minUSD?: USD | number | string;
    leverage?: number;
  }): Promise<Reservation | null> {
    const requestedNotionalUSD = toUSD(req.requestedUSD);
    const minUSD = toUSD(req.minUSD ?? this.cfg.minOrderUSD);
    const leverage = Math.max(1, Number.isFinite(req.leverage) && (req.leverage ?? 0) > 0 ? req.leverage! : 1);
    
    if (requestedNotionalUSD.raw <= ZERO_USD.raw) return null;

    // Calculate actual margin requirement based on leverage
    const requestedMarginUSD = new PreciseDecimal(requestedNotionalUSD.toNumber() / leverage);

    const snap = await this.provider.getSnapshot();
    const bufferFactor = ONE.minus(this.cfg.reserveBufferPct);
    const freeEff = usdMax(snap.freeUSD.times(bufferFactor), ZERO_USD);

    const symbolUsed = this.currentSymbolExposureUSD(req.symbol);
    const symbolCap = this.effectivePerSymbolCap(snap.totalUSD);
    const symbolRoom = usdMax(symbolCap.minus(symbolUsed), ZERO_USD);

    const room = usdMin(freeEff, symbolRoom);
    const grantMargin = usdMin(requestedMarginUSD, room);
    if (grantMargin.raw < minUSD.raw) {
      return null;
    }

    if (this.cfg.validateLiveBalance) {
      const liveSnap = await this.provider.getSnapshot();
      const liveFreeEff = usdMax(liveSnap.freeUSD.times(bufferFactor), ZERO_USD);
      if (liveFreeEff.raw < grantMargin.raw) {
        return null;
      }
    }

    await this.provider.applyLedgerDelta({ freeUSD: usdNeg(grantMargin), reservedUSD: grantMargin });

    const reservation: Reservation = {
      id: crypto.randomUUID(),
      agentId: req.agentId,
      symbol: req.symbol,
      requestedUSD: requestedNotionalUSD,
      grantedUSD: grantMargin,
      leverage,
      expiresAt: Date.now() + this.cfg.reserveTtlMs,
      state: 'reserved',
    };
    this.store.reservations.set(reservation.id, reservation);
    this.incrementSymbolExposure(req.symbol, grantMargin);
    return reservation;
  }

  async commit(resId: string, actualFilledUSD?: USD | number | string): Promise<boolean> {
    return this.runExclusive(() => this.commitInternal(resId, actualFilledUSD));
  }

  private async commitInternal(resId: string, actualFilledUSD?: USD | number | string): Promise<boolean> {
    const reservation = this.store.reservations.get(resId);
    if (!reservation || reservation.state !== 'reserved') return false;

    const filledCandidate = toUSD(actualFilledUSD ?? reservation.grantedUSD);
    const filled = filledCandidate.raw > reservation.grantedUSD.raw ? reservation.grantedUSD : filledCandidate;
    const rawRefund = reservation.grantedUSD.minus(filled);
    const refund = rawRefund.raw > ZERO_USD.raw ? rawRefund : ZERO_USD;

    await this.provider.applyLedgerDelta({
      reservedUSD: usdNeg(reservation.grantedUSD),
      inPositionsUSD: filled,
      freeUSD: refund,
    });

    const current = this.currentSymbolExposureUSD(reservation.symbol);
    const withoutReserve = current.minus(reservation.grantedUSD);
    const nextExposure = withoutReserve.plus(filled);
    this.setSymbolExposure(reservation.symbol, nextExposure);
    reservation.grantedUSD = filled;
    reservation.state = 'committed';
    this.store.reservations.set(reservation.id, reservation);
    return true;
  }

  async release(resId: string): Promise<boolean> {
    return this.runExclusive(() => this.releaseInternal(resId));
  }

  private async releaseInternal(resId: string): Promise<boolean> {
    const reservation = this.store.reservations.get(resId);
    if (!reservation || reservation.state !== 'reserved') return false;

    await this.provider.applyLedgerDelta({ reservedUSD: usdNeg(reservation.grantedUSD), freeUSD: reservation.grantedUSD });
    const current = this.currentSymbolExposureUSD(reservation.symbol);
    const next = current.minus(reservation.grantedUSD);
    this.setSymbolExposure(reservation.symbol, next);
    reservation.state = 'released';
    this.store.reservations.set(reservation.id, reservation);
    return true;
  }

  async settle(_positionId: string, symbol: string, freedUSD: USD | number | string): Promise<void> {
    await this.runExclusive(() => this.settleInternal(symbol, freedUSD));
  }

  private async settleInternal(symbol: string, freedUSD: USD | number | string): Promise<void> {
    const freed = toUSD(freedUSD);
    await this.provider.applyLedgerDelta({ inPositionsUSD: usdNeg(freed), freeUSD: freed });

    const current = this.currentSymbolExposureUSD(symbol);
    const next = current.minus(freed);
    this.setSymbolExposure(symbol, next);
  }

  async applyPnlDelta(symbol: string, pnlUSD: USD | number | string): Promise<void> {
    const pnl = toUSD(pnlUSD);
    if (pnl.raw === 0n) return;
    await this.runExclusive(async () => {
      await this.provider.applyLedgerDelta({ freeUSD: pnl });
      const current = this.currentSymbolExposureUSD(symbol);
      this.setSymbolExposure(symbol, current);
    });
  }

  async reseedLedger(params: {
    snapshot: BalanceSnapshot;
    exposures: Array<{ symbol: string; exposure: USD }>;
  }): Promise<void> {
    await this.runExclusive(async () => {
      if (typeof (this.provider as any)?.setSnapshot === 'function') {
        (this.provider as any).setSnapshot(params.snapshot);
      } else {
        const currentSnap = await this.provider.getSnapshot();
        const freeDelta = params.snapshot.freeUSD.toNumber() - currentSnap.freeUSD.toNumber();
        const reservedDelta = params.snapshot.reservedUSD.toNumber() - currentSnap.reservedUSD.toNumber();
        const inPositionsDelta = params.snapshot.inPositionsUSD.toNumber() - currentSnap.inPositionsUSD.toNumber();
        await this.provider.applyLedgerDelta({
          freeUSD: toUSD(freeDelta),
          reservedUSD: toUSD(reservedDelta),
          inPositionsUSD: toUSD(inPositionsDelta),
        });
      }

      this.store.reservations.clear();
      this.store.symbolExposure.clear();
      for (const entry of params.exposures) {
        this.setSymbolExposure(entry.symbol, entry.exposure);
      }
    });
  }

  async expireReservations(): Promise<void> {
    await this.runExclusive(async () => {
      const now = Date.now();
      for (const reservation of this.store.reservations.values()) {
        if (reservation.state === 'reserved' && reservation.expiresAt < now) {
          await this.releaseInternal(reservation.id);
        }
      }
    });
  }
}

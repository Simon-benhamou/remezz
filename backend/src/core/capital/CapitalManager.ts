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

export class CapitalManager {
  constructor(
    private provider: BalanceProvider,
    private cfg: CapitalManagerConfig,
    private readonly store: {
      reservations: Map<string, Reservation>;
      symbolExposure: Map<string, USD>;
    },
  ) {}

  async getBalance(): Promise<BalanceSnapshot> {
    return this.provider.getSnapshot();
  }

  listReservations(): Reservation[] {
    return Array.from(this.store.reservations.values());
  }

  clearLedger(): void {
    this.store.reservations.clear();
    this.store.symbolExposure.clear();
  }

  private currentSymbolExposureUSD(symbol: string): USD {
    return this.store.symbolExposure.get(symbol) ?? ZERO_USD;
  }

  private setSymbolExposure(symbol: string, value: USD): void {
    const sanitized = value.raw > ZERO_USD.raw ? value : PreciseDecimal.fromRaw(ZERO_USD.raw);
    this.store.symbolExposure.set(symbol, sanitized);
  }

  private incrementSymbolExposure(symbol: string, delta: USD): void {
    const current = this.currentSymbolExposureUSD(symbol);
    const next = current.plus(delta);
    this.setSymbolExposure(symbol, next);
  }

  private effectivePerSymbolCap(totalPool: USD): USD {
    const cap = totalPool.times(this.cfg.perSymbolCapPct);
    return usdMax(cap, ZERO_USD);
  }

  async reserve(req: {
    agentId: string;
    symbol: string;
    requestedUSD: USD | number | string;
    minUSD?: USD | number | string;
  }): Promise<Reservation | null> {
    const requestedUSD = toUSD(req.requestedUSD);
    const minUSD = toUSD(req.minUSD ?? this.cfg.minOrderUSD);
    if (requestedUSD.raw <= ZERO_USD.raw) return null;

    const snap = await this.provider.getSnapshot();
    const bufferFactor = ONE.minus(this.cfg.reserveBufferPct);
    const freeEff = usdMax(snap.freeUSD.times(bufferFactor), ZERO_USD);

    const symbolUsed = this.currentSymbolExposureUSD(req.symbol);
    const symbolCap = this.effectivePerSymbolCap(snap.totalUSD);
    const symbolRoom = usdMax(symbolCap.minus(symbolUsed), ZERO_USD);

    const room = usdMin(freeEff, symbolRoom);
    const grant = usdMin(requestedUSD, room);
    if (grant.raw < minUSD.raw) {
      return null;
    }

    if (this.cfg.validateLiveBalance) {
      const liveSnap = await this.provider.getSnapshot();
      const liveFreeEff = usdMax(liveSnap.freeUSD.times(bufferFactor), ZERO_USD);
      if (liveFreeEff.raw < grant.raw) {
        return null;
      }
    }

    await this.provider.applyLedgerDelta({ freeUSD: usdNeg(grant), reservedUSD: grant });

    const reservation: Reservation = {
      id: crypto.randomUUID(),
      agentId: req.agentId,
      symbol: req.symbol,
      requestedUSD,
      grantedUSD: grant,
      expiresAt: Date.now() + this.cfg.reserveTtlMs,
      state: 'reserved',
    };
    this.store.reservations.set(reservation.id, reservation);
    this.incrementSymbolExposure(req.symbol, grant);
    return reservation;
  }

  async commit(resId: string, actualFilledUSD?: USD | number | string): Promise<boolean> {
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
    const freed = toUSD(freedUSD);
    await this.provider.applyLedgerDelta({ inPositionsUSD: usdNeg(freed), freeUSD: freed });

    const current = this.currentSymbolExposureUSD(symbol);
    const next = current.minus(freed);
    this.setSymbolExposure(symbol, next);
  }

  async expireReservations(): Promise<void> {
    const now = Date.now();
    for (const reservation of this.store.reservations.values()) {
      if (reservation.state === 'reserved' && reservation.expiresAt < now) {
        await this.release(reservation.id);
      }
    }
  }
}

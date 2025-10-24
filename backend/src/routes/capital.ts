import { Router } from 'express';
import { getCapitalManager, getBalanceSnapshot, setPaperBalance, listReservations } from '../services/capitalPool.js';
import { BalanceSnapshot, Reservation } from '../core/capital/types.js';

const router = Router();

function serializeSnapshot(snapshot: BalanceSnapshot) {
  return {
    totalUSD: snapshot.totalUSD.toNumber(),
    freeUSD: snapshot.freeUSD.toNumber(),
    reservedUSD: snapshot.reservedUSD.toNumber(),
    inPositionsUSD: snapshot.inPositionsUSD.toNumber(),
    ts: snapshot.ts,
  };
}

function serializeReservation(reservation: Reservation) {
  return {
    ...reservation,
    requestedUSD: reservation.requestedUSD.toNumber(),
    grantedUSD: reservation.grantedUSD.toNumber(),
  };
}

router.post('/paper/set-balance', async (req, res) => {
  const value = req.body?.initialUSD;
  if (value === undefined || value === null) {
    return res.status(400).json({ error: 'missing_initial_usd' });
  }
  const snapshot = await setPaperBalance(value);
  res.json(serializeSnapshot(snapshot));
});

router.get('/paper/snapshot', async (_req, res) => {
  const snapshot = await getBalanceSnapshot('paper');
  res.json(serializeSnapshot(snapshot));
});

router.get('/live/snapshot', async (_req, res) => {
  const snapshot = await getBalanceSnapshot('live');
  res.json(serializeSnapshot(snapshot));
});

router.get('/snapshot', async (_req, res) => {
  const [paper, live] = await Promise.all([
    getBalanceSnapshot('paper'),
    getBalanceSnapshot('live'),
  ]);
  res.json({ paper: serializeSnapshot(paper), live: serializeSnapshot(live) });
});

router.get('/reservations', (_req, res) => {
  const paper = listReservations('paper').map(serializeReservation);
  const live = listReservations('live').map(serializeReservation);
  res.json({ paper, live });
});

router.post('/expire', async (_req, res) => {
  await Promise.all([
    getCapitalManager('paper').expireReservations(),
    getCapitalManager('live').expireReservations(),
  ]);
  res.json({ ok: true });
});

export { router };

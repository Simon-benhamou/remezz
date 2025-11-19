import { Router } from 'express';
import { getCapitalManager, getBalanceSnapshot, setPaperBalance, listReservations } from '../services/capitalPool.js';
import { BalanceSnapshot, Reservation } from '../core/capital/types.js';
import { authenticateUser, AuthenticatedRequest } from '../middleware/auth.js';

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

router.post('/paper/set-balance', authenticateUser, async (req: AuthenticatedRequest, res) => {
  if (!req.user?.id) {
    return res.status(401).json({ error: 'auth_required' });
  }

  const value = req.body?.initialUSD;
  if (value === undefined || value === null) {
    return res.status(400).json({ error: 'missing_initial_usd' });
  }
  
  const snapshot = await setPaperBalance(value, req.user.id);
  res.json(serializeSnapshot(snapshot));
});

router.get('/paper/snapshot', authenticateUser, async (req: AuthenticatedRequest, res) => {
  if (!req.user?.id) {
    return res.status(401).json({ error: 'auth_required' });
  }

  const snapshot = await getBalanceSnapshot('paper', req.user.id);
  res.json(serializeSnapshot(snapshot));
});

router.get('/live/snapshot', authenticateUser, async (req: AuthenticatedRequest, res) => {
  if (!req.user?.id) {
    return res.status(401).json({ error: 'auth_required' });
  }

  const snapshot = await getBalanceSnapshot('live', req.user.id);
  res.json(serializeSnapshot(snapshot));
});

router.get('/snapshot', authenticateUser, async (req: AuthenticatedRequest, res) => {
  if (!req.user?.id) {
    return res.status(401).json({ error: 'auth_required' });
  }

  const [paper, live] = await Promise.all([
    getBalanceSnapshot('paper', req.user.id),
    getBalanceSnapshot('live', req.user.id),
  ]);
  res.json({ paper: serializeSnapshot(paper), live: serializeSnapshot(live) });
});

router.get('/reservations', authenticateUser, async (req: AuthenticatedRequest, res) => {
  if (!req.user?.id) {
    return res.status(401).json({ error: 'auth_required' });
  }

  const paper = listReservations('paper', req.user.id).map(serializeReservation);
  const live = listReservations('live', req.user.id).map(serializeReservation);
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

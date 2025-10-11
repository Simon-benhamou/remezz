// Validation programmatique de la logique d'entrée breakout.
import assert from 'node:assert/strict';

function shouldEnterTrade({ playbook, bias, price, zone, maxDistancePct = 0.02 }) {
  const [from, to] = zone;
  const lower = Math.min(from, to);
  const upper = Math.max(from, to);
  const inZone = price >= lower && price <= upper;
  const distanceFromUpper = Math.abs(price - upper) / price;
  const distanceFromLower = Math.abs(price - lower) / price;

  if (playbook === 'momentum_breakout') {
    if (bias === 'long') {
      return price > upper && distanceFromUpper <= maxDistancePct;
    }
    if (bias === 'short') {
      return price < lower && distanceFromLower <= maxDistancePct;
    }
    return false;
  }

  const nearZone =
    (bias === 'long' && price > upper && distanceFromUpper <= maxDistancePct) ||
    (bias === 'short' && price < lower && distanceFromLower <= maxDistancePct);

  return inZone || nearZone;
}

const avntScenario = {
  playbook: 'momentum_breakout',
  bias: 'long',
  price: 2.2077,
  zone: [2.1695, 2.1869]
};

assert.equal(
  shouldEnterTrade(avntScenario),
  true,
  'Une configuration momentum breakout doit déclencher une entrée au-dessus de la zone.'
);

assert.equal(
  shouldEnterTrade({ ...avntScenario, playbook: 'mean_reversion' }),
  true,
  'La logique hybride doit aussi autoriser une entrée si le prix est légèrement au-dessus.'
);

assert.equal(
  shouldEnterTrade({ ...avntScenario, price: 2.25 }),
  false,
  'Le breakout ne doit pas être validé si le prix est trop éloigné (>2%).'
);

assert.equal(
  shouldEnterTrade({ ...avntScenario, bias: 'short' }),
  false,
  'Un biais opposé doit bloquer l\'entrée même en breakout.'
);

assert.equal(
  shouldEnterTrade({ ...avntScenario, playbook: 'mean_reversion', zone: [2.20, 2.24], price: 2.215 }),
  true,
  'Le système doit accepter une entrée lorsque le prix est dans la zone élargie.'
);

assert.equal(
  shouldEnterTrade({ ...avntScenario, playbook: 'mean_reversion', price: 2.18 }),
  true,
  'Quand le prix reste dans la zone, l\'entrée est toujours valable.'
);

console.log('✅ Logique d\'entrée breakout validée sur les scénarios critiques.');

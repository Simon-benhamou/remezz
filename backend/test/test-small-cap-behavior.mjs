// Analyse de la réaction de l'agent sur une crypto à très faible capitalisation.
import assert from 'node:assert/strict';

const BOME_MARKET_DATA = {
  price: 0.001753,
  change24h: 0.14,
  high24h: 0.002039,
  low24h: 0.001683,
  volume24h: 32_800,
  bidAsk: { bid: 0.001747, ask: 0.001749 },
  spread: 0.114
};

function computeVolatilityPct({ price, high24h, low24h }) {
  const range = high24h - low24h;
  return (range / price) * 100;
}

function classifyMarket(data) {
  return {
    isMicroCap: data.volume24h < 100_000,
    spreadTooWide: data.spread > 0.05,
    hourlyVolumeUsd: data.volume24h / 24,
    volatilityPct: Number(computeVolatilityPct(data).toFixed(1))
  };
}

function analyzeSmallCapBehavior(data) {
  const classification = classifyMarket(data);
  const recommendation = classification.isMicroCap || classification.spreadTooWide
    ? 'ÉVITER'
    : 'TRADER_AVEC_PRÉCAUTION';

  return {
    recommendation,
    reason: classification.isMicroCap
      ? 'Volume insuffisant'
      : 'Spread acceptable',
    riskLevel: classification.volatilityPct > 15 ? 'EXTREME' : 'MODÉRÉ',
    suitability: recommendation === 'ÉVITER'
      ? 'NON ADAPTÉ aux agents automatiques'
      : 'ADAPTÉ conditionnellement',
    details: classification
  };
}

const analysis = analyzeSmallCapBehavior(BOME_MARKET_DATA);

assert.strictEqual(
  analysis.recommendation,
  'ÉVITER',
  'Le moteur d\'analyse doit interdire le trading sur un volume aussi faible.'
);
assert.match(
  analysis.reason,
  /Volume insuffisant/,
  'La raison principale doit rappeler le manque de liquidité.'
);
assert.strictEqual(
  analysis.riskLevel,
  'EXTREME',
  'La volatilité observée doit classer l\'actif en risque extrême.'
);
assert.strictEqual(
  analysis.suitability,
  'NON ADAPTÉ aux agents automatiques',
  'Le profil doit marquer l\'actif comme incompatible avec les agents.'
);
assert.ok(
  analysis.details.hourlyVolumeUsd < 2_000,
  'Le volume horaire attendu doit refléter le manque de profondeur de marché.'
);

console.log('✅ Analyse small cap: BOME est correctement rejetée par les filtres.');

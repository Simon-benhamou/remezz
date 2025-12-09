import ccxt from 'ccxt';
import crypto from 'crypto';
const { PrismaClient } = await import('@prisma/client');
const prisma = new PrismaClient();

function decrypt(enc, key) {
  const k = crypto.scryptSync(key, 'apikey-salt', 32);
  const [iv, txt] = enc.split(':');
  const d = crypto.createDecipheriv('aes-256-cbc', k, Buffer.from(iv, 'hex'));
  return Buffer.concat([d.update(Buffer.from(txt, 'hex')), d.final()]).toString();
}

const a = await prisma.userApiKey.findFirst({ where: { exchange: 'binance' } });
const ex = new ccxt.binanceusdm({
  apiKey: decrypt(a.apiKey, process.env.APP_API_KEY),
  secret: decrypt(a.apiSecret, process.env.APP_API_KEY)
});

// Get positions
const positions = await ex.fetchPositions();
const openPos = positions.filter(p => Math.abs(parseFloat(p.contracts)) > 0);

console.log('=== POSITIONS OUVERTES ===');
if (openPos.length === 0) {
  console.log('Aucune position');
} else {
  openPos.forEach(p => console.log(p.symbol + ': ' + p.side + ' ' + p.contracts));
}

// Get all algo orders
const symbols = ['ETHUSDT', 'XRPUSDT', 'LINKUSDT', 'SUIUSDT', 'IMXUSDT', 'SEIUSDT', 'DOGEUSDT'];
console.log('\n=== ALGO ORDERS RESTANTS ===');

let orphanSymbols = [];

for (const symbol of symbols) {
  const result = await ex.fapiPrivateGetOpenAlgoOrders({ symbol });
  const orders = Array.isArray(result) ? result : [];
  
  if (orders.length > 0) {
    // Check if we have a position for this symbol
    const hasPosition = openPos.some(p => p.symbol.includes(symbol.replace('USDT', '')));
    const status = hasPosition ? '(position ouverte)' : 'ORPHELIN - pas de position';
    
    if (!hasPosition) {
      orphanSymbols.push(symbol);
    }
    
    console.log(`\n${symbol}: ${orders.length} ordres - ${status}`);
    orders.forEach(o => {
      const type = o.orderType;
      if (type === 'TRAILING_STOP_MARKET') {
        console.log(`  - TRAILING activate@${o.activatePrice} cb:${o.callbackRate}%`);
      } else {
        console.log(`  - ${type} trigger@${o.triggerPrice}`);
      }
    });
  }
}

// Cleanup orphan orders
if (orphanSymbols.length > 0) {
  console.log('\n=== NETTOYAGE ORDRES ORPHELINS ===\n');
  
  for (const symbol of orphanSymbols) {
    console.log(`Annulation ordres pour ${symbol}...`);
    const ccxtSymbol = symbol.replace('USDT', '/USDT:USDT');
    
    try {
      // Cancel regular orders
      try {
        await ex.cancelAllOrders(ccxtSymbol);
      } catch (e) {
        // Ignore
      }
      
      // Cancel ALGO orders (STOP_MARKET, TRAILING_STOP_MARKET)
      try {
        await ex.cancelAllOrders(ccxtSymbol, { conditional: true });
      } catch (e) {
        // Ignore
      }
      
      console.log(`  OK - ordres annules (regular + algo)`);
    } catch (e) {
      console.log(`  Erreur: ${e.message}`);
    }
  }
  
  console.log('\nNettoyage termine!');
} else {
  console.log('\nAucun ordre orphelin a nettoyer.');
}

await prisma.$disconnect();

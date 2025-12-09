#!/usr/bin/env node
/**
 * 🚨 EMERGENCY SCRIPT: Set Stop Loss AND Trailing Stop on all open positions
 * Run this to protect positions that were opened without SL due to the API bug
 * 
 * This script connects to the database, finds active agents, and places SL orders
 * using direct Binance Algo Order API calls
 */

import ccxt from 'ccxt';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import crypto from 'crypto';

// Dynamic import for Prisma (ESM compatible)
const prismaModule = await import('@prisma/client');
const PrismaClient = prismaModule.PrismaClient;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '.env') });

const prisma = new PrismaClient();

// Configuration - ADJUST THESE VALUES
const STOP_LOSS_PCT = 1.5;  // 1.5% stop loss from entry price
const TRAILING_ACTIVATION_PCT = 1.0;  // Activate trailing at +1%
const TRAILING_DISTANCE_PCT = 0.4;    // Trail by 0.4%

const BINANCE_FAPI_URL = 'https://fapi.binance.com';

// Decrypt API key - same as in src/utils/crypto.ts
function decryptApiKey(ciphertext) {
  const secret = process.env.JWT_SECRET || process.env.APP_API_KEY;
  if (!secret) throw new Error('JWT_SECRET or APP_API_KEY not set');
  
  const key = crypto.scryptSync(secret, 'apikey-salt', 32);
  
  const parts = ciphertext.split(':');
  if (parts.length !== 2) {
    throw new Error('Invalid encrypted data format');
  }
  
  const iv = Buffer.from(parts[0], 'hex');
  const encrypted = parts[1];
  
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

// Create Binance signature
function createSignature(queryString, apiSecret) {
  return crypto
    .createHmac('sha256', apiSecret)
    .update(queryString)
    .digest('hex');
}

// Place stop loss order using Binance Futures API - try STOP (limit) instead of STOP_MARKET
async function placeAlgoStopOrder(apiKey, apiSecret, symbol, side, quantity, stopPrice, useCloseAll = false) {
  const timestamp = Date.now();
  
  // Clean symbol (remove / and :USDT)
  const cleanSymbol = symbol.replace('/', '').replace(':USDT', '');
  
  // Try STOP type with limit price (same as stop price for market-like fill)
  const params = {
    symbol: cleanSymbol,
    side: side.toUpperCase(),
    type: 'STOP',  // Use STOP (limit) instead of STOP_MARKET
    stopPrice: stopPrice,
    price: stopPrice,  // Limit price = stop price for aggressive fill
    quantity: quantity,
    timeInForce: 'GTC',
    workingType: 'MARK_PRICE',
    reduceOnly: 'true',
    timestamp: timestamp,
  };
  
  const queryString = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  
  const signature = createSignature(queryString, apiSecret);
  const fullQuery = `${queryString}&signature=${signature}`;
  
  console.log(`   DEBUG: POST /fapi/v1/order type=STOP`);
  
  const response = await fetch(`${BINANCE_FAPI_URL}/fapi/v1/order`, {
    method: 'POST',
    headers: {
      'X-MBX-APIKEY': apiKey,
    },
    body: fullQuery,
  });
  
  const responseText = await response.text();
  
  let data;
  try {
    data = JSON.parse(responseText);
  } catch (e) {
    throw new Error(`Invalid response: ${responseText.substring(0, 100)}`);
  }
  
  if (!response.ok || data.code) {
    throw new Error(`Binance API error: ${JSON.stringify(data)}`);
  }
  
  return data;
}

async function main() {
  console.log('🚨 EMERGENCY: Setting stop losses on all open positions...\n');

  try {
    // Find all active agent sessions (not stopped) with their user's API keys
    const activeSessions = await prisma.agentSession.findMany({
      where: { 
        stoppedAt: null,
        haltedAt: null
      },
      include: {
        user: {
          include: {
            apiKeys: {
              where: { isActive: true }
            }
          }
        },
        positions: true
      }
    });

    console.log(`📊 Found ${activeSessions.length} active session(s)\n`);

    if (activeSessions.length === 0) {
      console.log('ℹ️  No active sessions found.');
      return;
    }

    // Group sessions by user/exchange to avoid creating multiple exchange instances
    const userExchanges = new Map();

    for (const session of activeSessions) {
      const userId = session.userId;
      const apiKeyRecord = session.user?.apiKeys?.[0];

      if (!apiKeyRecord) {
        console.log(`⚠️  Session ${session.id} (${session.symbol}): No API keys found for user`);
        continue;
      }

      const effectiveSymbol = session.currentSymbol || session.symbol;
      
      console.log(`\n🤖 Session: ${effectiveSymbol} (${session.id})`);
      console.log(`   User: ${userId}`);
      console.log(`   Mode: ${session.mode}`);

      // Get or create exchange instance for this user
      let exchangeData = userExchanges.get(userId);
      if (!exchangeData) {
        try {
          const apiKey = decryptApiKey(apiKeyRecord.apiKey);
          const apiSecret = decryptApiKey(apiKeyRecord.apiSecret);

          const exchange = new ccxt.binanceusdm({
            apiKey,
            secret: apiSecret,
            enableRateLimit: true,
            options: {
              defaultType: 'future',
              adjustForTimeDifference: true,
            },
          });

          await exchange.loadMarkets();
          exchangeData = { exchange, apiKey, apiSecret };
          userExchanges.set(userId, exchangeData);
          console.log(`   ✅ Exchange connected`);
        } catch (err) {
          console.error(`   ❌ Failed to connect: ${err.message}`);
          continue;
        }
      }
      
      const { exchange, apiKey, apiSecret } = exchangeData;

      // Fetch positions for this symbol
      try {
        const positions = await exchange.fetchPositions([effectiveSymbol]);
        const openPos = positions.find(p => Math.abs(parseFloat(p.contracts || 0)) > 0);

        if (!openPos) {
          console.log(`   ℹ️  No open position for ${effectiveSymbol}`);
          continue;
        }

        const side = openPos.side;
        const contracts = Math.abs(parseFloat(openPos.contracts));
        const entryPrice = parseFloat(openPos.entryPrice);
        const markPrice = parseFloat(openPos.markPrice);
        const unrealizedPnl = parseFloat(openPos.unrealizedPnl || 0);

        console.log(`   📈 Position: ${side?.toUpperCase()} ${contracts} @ $${entryPrice.toFixed(4)}`);
        console.log(`   💰 Mark: $${markPrice.toFixed(4)} | PnL: $${unrealizedPnl.toFixed(2)}`);

        // Check for existing SL orders
        const openOrders = await exchange.fetchOpenOrders(effectiveSymbol);
        const existingSL = openOrders.find(o => 
          o.type?.toLowerCase().includes('stop') || o.stopPrice || o.triggerPrice
        );

        if (existingSL) {
          console.log(`   ✅ Already has stop order at $${existingSL.stopPrice || existingSL.triggerPrice}`);
          continue;
        }

        // Check if trailing stop should be activated (position already in profit)
        const pnlPct = side === 'long' 
          ? ((markPrice - entryPrice) / entryPrice) * 100
          : ((entryPrice - markPrice) / entryPrice) * 100;

        const shouldUseTrailing = pnlPct >= TRAILING_ACTIVATION_PCT;
        
        // Get proper precision from market
        const market = exchange.markets[effectiveSymbol];
        const pricePrecision = market?.precision?.price || 8;
        const qtyPrecision = market?.precision?.amount || 8;
        
        // Format price properly
        const formatPrice = (p) => exchange.priceToPrecision(effectiveSymbol, p);
        const formatQty = (q) => exchange.amountToPrecision(effectiveSymbol, q);
        
        const orderSide = side === 'long' ? 'sell' : 'buy';
        const formattedQty = formatQty(contracts);
        
        if (shouldUseTrailing) {
          // Use trailing stop - calculate trailing price
          let trailingStopPrice;
          if (side === 'long') {
            trailingStopPrice = markPrice * (1 - TRAILING_DISTANCE_PCT / 100);
          } else {
            trailingStopPrice = markPrice * (1 + TRAILING_DISTANCE_PCT / 100);
          }
          const formattedTrailingPrice = formatPrice(trailingStopPrice);
          
          console.log(`   📈 Position in profit (+${pnlPct.toFixed(2)}%) - Using TRAILING STOP`);
          console.log(`   🎯 Trailing stop at $${formattedTrailingPrice} (${TRAILING_DISTANCE_PCT}% from mark)`);
          
          // Try CCXT createStopMarketOrder method
          try {
            const slOrder = await exchange.createStopMarketOrder(
              effectiveSymbol,
              orderSide,
              parseFloat(formattedQty),
              parseFloat(formattedTrailingPrice),
              {
                reduceOnly: true,
                workingType: 'MARK_PRICE',
              }
            );
            console.log(`   ✅ Stop (trailing level) placed! Order ID: ${slOrder.id}`);
          } catch (err1) {
            console.log(`   ⚠️ createStopMarketOrder failed: ${err1.message}`);
            
            // Try direct API call as fallback
            try {
              console.log(`   🔄 Trying direct API...`);
              const result = await placeAlgoStopOrder(
                apiKey,
                apiSecret,
                effectiveSymbol,
                orderSide,
                formattedQty,
                formattedTrailingPrice
              );
              console.log(`   ✅ Stop placed via direct API! Order ID: ${result.orderId}`);
            } catch (err2) {
              console.error(`   ❌ All methods failed: ${err2.message}`);
            }
          }
        } else {
          // Position not yet in profit - use regular stop loss from entry
          let stopPrice;
          if (side === 'long') {
            stopPrice = entryPrice * (1 - STOP_LOSS_PCT / 100);
          } else {
            stopPrice = entryPrice * (1 + STOP_LOSS_PCT / 100);
          }
          const formattedStopPrice = formatPrice(stopPrice);
          
          console.log(`   🎯 Setting stop loss at $${formattedStopPrice} (${STOP_LOSS_PCT}% from entry)`);

          // Try CCXT createStopMarketOrder method
          try {
            const slOrder = await exchange.createStopMarketOrder(
              effectiveSymbol,
              orderSide,
              parseFloat(formattedQty),
              parseFloat(formattedStopPrice),
              {
                reduceOnly: true,
                workingType: 'MARK_PRICE',
              }
            );
            console.log(`   ✅ Stop loss placed! Order ID: ${slOrder.id}`);
          } catch (orderError) {
            console.error(`   ⚠️ createStopMarketOrder failed: ${orderError.message}`);
            
            // Try direct API call as fallback
            try {
              console.log(`   🔄 Trying direct API...`);
              const result = await placeAlgoStopOrder(
                apiKey,
                apiSecret,
                effectiveSymbol,
                orderSide,
                formattedQty,
                formattedStopPrice
              );
              console.log(`   ✅ Stop loss placed via direct API! Order ID: ${result.orderId}`);
            } catch (err2) {
              console.error(`   ❌ All methods failed: ${err2.message}`);
            }
          }
        }
      } catch (posErr) {
        console.error(`   ❌ Error fetching position: ${posErr.message}`);
      }
    }

    console.log('\n\n✅ Done! Check your Binance Futures positions.\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error);
  } finally {
    await prisma.$disconnect();
  }
}

main();

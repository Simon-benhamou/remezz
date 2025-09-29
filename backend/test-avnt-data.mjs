#!/usr/bin/env node

import ccxt from 'ccxt';

const EXCHANGE_ID = 'cryptocom';

async function testAVNTData() {
  try {
    console.log('🔍 Testing AVNT ticker data...\n');
    
    const ExchangeClass = ccxt[EXCHANGE_ID];
    if (!ExchangeClass) throw new Error('Unknown exchange ' + EXCHANGE_ID);
    
    const exchange = new ExchangeClass({
      sandbox: false,
      enableRateLimit: true,
    });
    
    // Test AVNT/USDT
    const ticker = await exchange.fetchTicker('AVNT/USDT');
    
    console.log('📊 AVNT/USDT Ticker Data:');
    console.log(`   Current Price: ${ticker.last}`);
    console.log(`   Open Price: ${ticker.open}`);
    console.log(`   High 24h: ${ticker.high}`);
    console.log(`   Low 24h: ${ticker.low}`);
    console.log(`   ticker.percentage: ${ticker.percentage}%`);
    console.log(`   ticker.change: ${ticker.change}`);
    console.log(`   Volume: ${ticker.quoteVolume}`);
    console.log('');
    
    console.log('🧮 Real 24h calculation:');
    if (ticker.open && ticker.last) {
      const real24h = ((ticker.last - ticker.open) / ticker.open) * 100;
      console.log(`   Real 24h change: ${real24h.toFixed(3)}%`);
      console.log(`   ticker.percentage: ${ticker.percentage}%`);
      console.log(`   Différence: ${Math.abs(real24h - ticker.percentage).toFixed(3)}% points`);
      
      if (Math.abs(real24h) > 5) {
        console.log(`   🚨 EXTREME MOVEMENT DETECTED: ${real24h.toFixed(2)}%`);
      } else {
        console.log(`   📊 Normal movement: ${real24h.toFixed(2)}%`);
      }
    }
    
    // Test autres cryptos pour comparaison
    console.log('\n🔍 Testing other cryptos for comparison:');
    const otherSymbols = ['BTC/USDT', 'ETH/USDT', 'DOGE/USDT'];
    
    for (const symbol of otherSymbols) {
      try {
        const otherTicker = await exchange.fetchTicker(symbol);
        const real24h = ((otherTicker.last - otherTicker.open) / otherTicker.open) * 100;
        console.log(`   ${symbol}: ticker.percentage=${otherTicker.percentage}%, real24h=${real24h.toFixed(3)}%`);
      } catch (error) {
        console.log(`   ${symbol}: Error - ${error.message}`);
      }
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

testAVNTData();
import { Router } from 'express';
import ccxt from 'ccxt';
import { getConfig } from '../utils/env.js';

export const router = Router();

// Test endpoint to see real 24h performance data
router.get('/top-performers', async (req, res) => {
  try {
    console.log('📊 Fetching real-time top performers from exchange...');
    
    const { EXCHANGE_ID } = getConfig();
    const ExchangeClass = (ccxt as any)[EXCHANGE_ID];
    
    if (!ExchangeClass) {
      return res.json({
        success: false,
        error: 'Exchange not available',
        fallback: 'Using static list'
      });
    }

    const exchange = new ExchangeClass({
      enableRateLimit: true,
      options: { defaultType: 'swap' }
    });

    await exchange.loadMarkets();
    
    // Get all markets and filter for USDT perpetuals
    const allMarkets = Object.keys(exchange.markets || {});
    console.log(`� Total markets available: ${allMarkets.length}`);
    
    const perpetualMarkets = allMarkets.filter(symbol => {
      try {
        if (!symbol || typeof symbol !== 'string') return false;
        
        const market = exchange.markets[symbol];
        if (!market) return false;
        
        // Crypto.com uses USD-settled perpetuals in format: SYMBOL/USD:USD
        return market.swap === true && 
               market.active === true &&
               market.settle === 'USD' && // USD-settled perpetuals
               symbol.includes('/USD:USD'); // Perpetual format on Crypto.com
      } catch (error) {
        return false;
      }
    });

    console.log(`🔍 Found ${perpetualMarkets.length} USDT perpetual markets`);

    // Get a reasonable sample to avoid rate limits (first 30)
    const sampleMarkets = perpetualMarkets.slice(0, 30);
    console.log(`🎯 Testing ${sampleMarkets.length} markets:`, sampleMarkets.slice(0, 5));
    
    // Fetch tickers for the sample
    const tickers = await exchange.fetchTickers(sampleMarkets);
    
    // Convert to array and calculate performance metrics
    const cryptoPerformance = Object.entries(tickers).map(([symbol, ticker]) => {
      const tickerData = ticker as any;
      const change24h = Number(tickerData.percentage || 0);
      const volume24h = Number(tickerData.baseVolume || 0);
      const quoteVolume24h = Number(tickerData.quoteVolume || 0);
      const price = Number(tickerData.last || 0);
      
      // Score based on: performance (50%) + volume (50%) for more balanced selection
      const volumeScore = Math.min(10, Math.log10(Math.max(1, quoteVolume24h))); // Capped at 10
      const performanceScore = Math.abs(change24h); // Direct percentage
      const combinedScore = (performanceScore * 0.5) + (volumeScore * 0.5);
      
      return {
        symbol,
        change24h,
        volume24h,
        quoteVolume24h,
        price,
        combinedScore,
        absChange: Math.abs(change24h),
        volumeScore,
        performanceScore
      };
    }).filter(crypto => 
      crypto.quoteVolume24h > 50000 && // Minimum $50K volume
      crypto.absChange > 0.05 // Minimum 0.05% movement
    );

    // Sort by combined score descending
    cryptoPerformance.sort((a, b) => b.combinedScore - a.combinedScore);
    
    const topPerformers = cryptoPerformance.slice(0, 15);
    
    console.log(`✅ Found ${topPerformers.length} qualifying top performers`);
    console.log('🏆 Top 5:', topPerformers.slice(0, 5).map(c => `${c.symbol}: ${c.change24h.toFixed(2)}%`));

    res.json({
      success: true,
      totalMarkets: allMarkets.length,
      perpetualMarkets: perpetualMarkets.length,
      sampleMarkets: sampleMarkets.length,
      qualifyingCryptos: topPerformers.length,
      topPerformers: topPerformers.map((crypto, i) => ({
        rank: i + 1,
        symbol: crypto.symbol,
        change24h: `${crypto.change24h.toFixed(2)}%`,
        volumeUSD: `$${(crypto.quoteVolume24h/1000000).toFixed(1)}M`,
        price: `$${crypto.price.toFixed(6)}`,
        score: crypto.combinedScore.toFixed(2),
        breakdown: {
          performanceScore: crypto.performanceScore.toFixed(2),
          volumeScore: crypto.volumeScore.toFixed(2)
        }
      })),
      timestamp: new Date().toISOString()
    });
    
  } catch (error: any) {
    console.error('❌ Error fetching top performers:', error);
    res.status(500).json({
      success: false,
      error: error.message || String(error),
      timestamp: new Date().toISOString()
    });
  }
});

// Debug endpoint to see swap market structure specifically
router.get('/debug-swaps', async (req, res) => {
  try {
    const { EXCHANGE_ID } = getConfig();
    const ExchangeClass = (ccxt as any)[EXCHANGE_ID];
    
    if (!ExchangeClass) {
      return res.json({ success: false, error: 'Exchange not available' });
    }

    const exchange = new ExchangeClass({
      enableRateLimit: true,
      options: { defaultType: 'swap' }
    });

    await exchange.loadMarkets();
    
    const allMarkets = Object.keys(exchange.markets || {});
    
    // Get all swap markets
    const swapMarkets = allMarkets.filter(symbol => {
      const market = exchange.markets[symbol];
      return market.swap === true;
    });

    // Sample 20 swap markets to see their structure
    const sampleSwaps = swapMarkets.slice(0, 20).map(symbol => {
      const market = exchange.markets[symbol];
      return {
        symbol,
        base: market.base,
        quote: market.quote,
        settle: market.settle,
        type: market.type,
        active: market.active,
        info: {
          inst_type: market.info?.inst_type,
          display_name: market.info?.display_name
        }
      };
    });

    // Find USDT-settled swaps specifically
    const usdtSwaps = swapMarkets.filter(symbol => {
      const market = exchange.markets[symbol];
      return market.settle === 'USDT' || market.quote === 'USDT' || symbol.includes('USDT');
    }).slice(0, 10);

    res.json({
      success: true,
      totalMarkets: allMarkets.length,
      totalSwaps: swapMarkets.length,
      usdtSwaps: usdtSwaps.length,
      sampleSwaps,
      usdtSwapDetails: usdtSwaps.map(symbol => ({
        symbol,
        market: {
          base: exchange.markets[symbol].base,
          quote: exchange.markets[symbol].quote,
          settle: exchange.markets[symbol].settle,
          active: exchange.markets[symbol].active
        }
      }))
    });
    
  } catch (error: any) {
    console.error('Error debugging swaps:', error);
    res.status(500).json({
      success: false,
      error: error.message || String(error)
    });
  }
});

// Debug endpoint to see market structure
router.get('/debug-markets', async (req, res) => {
  try {
    const { EXCHANGE_ID } = getConfig();
    const ExchangeClass = (ccxt as any)[EXCHANGE_ID];
    
    if (!ExchangeClass) {
      return res.json({ success: false, error: 'Exchange not available' });
    }

    const exchange = new ExchangeClass({
      enableRateLimit: true,
      options: { defaultType: 'swap' }
    });

    await exchange.loadMarkets();
    
    const allMarkets = Object.keys(exchange.markets || {});
    
    // Sample first 20 markets to see structure
    const sampleMarkets = allMarkets.slice(0, 20).map(symbol => {
      const market = exchange.markets[symbol];
      return {
        symbol,
        type: market.type,
        swap: market.swap,
        active: market.active,
        spot: market.spot,
        future: market.future,
        base: market.base,
        quote: market.quote,
        settle: market.settle
      };
    });

    // Count different types
    const types = {};
    allMarkets.forEach(symbol => {
      const market = exchange.markets[symbol];
      const key = `${market.type}${market.swap ? '-swap' : ''}${market.spot ? '-spot' : ''}${market.future ? '-future' : ''}`;
      types[key] = (types[key] || 0) + 1;
    });

    // Find USDT markets
    const usdtMarkets = allMarkets.filter(symbol => symbol.includes('USDT')).slice(0, 10);

    res.json({
      success: true,
      totalMarkets: allMarkets.length,
      marketTypes: types,
      sampleMarkets,
      usdtMarkets: usdtMarkets.map(symbol => ({
        symbol,
        market: exchange.markets[symbol]
      }))
    });
    
  } catch (error: any) {
    console.error('Error debugging markets:', error);
    res.status(500).json({
      success: false,
      error: error.message || String(error)
    });
  }
});

// Test endpoint to compare with current intelligent agent selection
router.get('/compare-selection', async (req, res) => {
  try {
    res.json({
      success: true,
      message: 'Comparison endpoint temporarily disabled for debugging',
      timestamp: new Date().toISOString()
    });
    
  } catch (error: any) {
    console.error('Error comparing selection:', error);
    res.status(500).json({
      success: false,
      error: error.message || String(error)
    });
  }
});
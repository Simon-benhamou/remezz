import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createChart, ColorType, IChartApi, ISeriesApi, LineStyle, UTCTimestamp } from 'lightweight-charts';
import { api } from '../../api';
import { Button, Space, Spin } from 'antd';

interface ProfessionalChartProps {
  symbol: string;
  sessionId?: string;
  orders?: any[];
  fills?: any[];
}

type Timeframe = '1m' | '15m' | '1h' | '4h';

interface CandleData {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export default function ProfessionalChart({ symbol, sessionId, orders = [], fills = [] }: ProfessionalChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  
  const [timeframe, setTimeframe] = useState<Timeframe>('15m');
  const [loading, setLoading] = useState(true);
  const [chartData, setChartData] = useState<CandleData[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Initialize chart
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#0f172a' },
        textColor: '#94a3b8',
        fontSize: 12,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      },
      grid: {
        vertLines: { color: 'rgba(148, 163, 184, 0.06)' },
        horzLines: { color: 'rgba(148, 163, 184, 0.06)' },
      },
      crosshair: {
        mode: 1,
        vertLine: {
          color: 'rgba(148, 163, 184, 0.5)',
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: '#1e40af',
        },
        horzLine: {
          color: 'rgba(148, 163, 184, 0.5)',
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: '#1e40af',
        },
      },
      rightPriceScale: {
        borderColor: 'rgba(148, 163, 184, 0.1)',
        textColor: '#cbd5e1',
        scaleMargins: { top: 0.1, bottom: 0.2 },
      },
      timeScale: {
        borderColor: 'rgba(148, 163, 184, 0.1)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 12,
        barSpacing: 8,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
      width: chartContainerRef.current.clientWidth,
      height: 600,
    });

    // Candlestick series
    const candleSeries = chart.addCandlestickSeries({
      upColor: '#10b981',
      downColor: '#ef4444',
      borderUpColor: '#10b981',
      borderDownColor: '#ef4444',
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
    });

    // Volume series
    const volumeSeries = chart.addHistogramSeries({
      color: '#26a69a',
      priceFormat: {
        type: 'volume',
      },
      priceScaleId: '',
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    // Handle resize
    const handleResize = () => {
      if (chartContainerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width: chartContainerRef.current.clientWidth,
        });
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

  // Fetch historical data
  const fetchHistoricalData = useCallback(async () => {
    if (!symbol) return;
    
    setLoading(true);
    setError(null);
    
    try {
      // Map timeframe to candle count
      const candleCount = {
        '1m': 500,
        '15m': 400,
        '1h': 300,
        '4h': 200,
      }[timeframe];

      // Fetch OHLCV data from backend
      const response = await fetch('/api/market/ohlcv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          timeframe,
          limit: candleCount,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch data: ${response.statusText}`);
      }

      const result = await response.json();
      
      if (!result.data || !Array.isArray(result.data)) {
        throw new Error('Invalid data format received');
      }

      // Transform data to lightweight-charts format
      const candles: CandleData[] = result.data.map((candle: any) => ({
        time: (new Date(candle.timestamp).getTime() / 1000) as UTCTimestamp,
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close),
        volume: Number(candle.volume || 0),
      }));

      // Sort by time
      candles.sort((a, b) => a.time - b.time);
      
      setChartData(candles);
      
      // Update chart
      if (candleSeriesRef.current && candles.length > 0) {
        candleSeriesRef.current.setData(candles);
      }
      
      if (volumeSeriesRef.current && candles.length > 0) {
        const volumeData = candles.map(c => ({
          time: c.time,
          value: c.volume || 0,
          color: c.close >= c.open ? 'rgba(16, 185, 129, 0.5)' : 'rgba(239, 68, 68, 0.5)',
        }));
        volumeSeriesRef.current.setData(volumeData);
      }
      
      // Fit content
      if (chartRef.current) {
        chartRef.current.timeScale().fitContent();
      }
      
    } catch (err) {
      console.error('Failed to fetch chart data:', err);
      setError(err instanceof Error ? err.message : 'Failed to load chart data');
    } finally {
      setLoading(false);
    }
  }, [symbol, timeframe]);

  // Load data when symbol or timeframe changes
  useEffect(() => {
    fetchHistoricalData();
  }, [fetchHistoricalData]);

  // Add order/fill markers
  useEffect(() => {
    if (!candleSeriesRef.current || chartData.length === 0) return;

    const markers: any[] = [];

    // Add entry orders (buy/long)
    orders?.forEach(order => {
      if (!order.createdAt) return;
      
      const time = (new Date(order.createdAt).getTime() / 1000) as UTCTimestamp;
      const isEntry = !order.clientOrderId?.includes?.('.exit');
      const isFilled = order.status?.toLowerCase() === 'filled';
      
      if (isEntry && isFilled) {
        markers.push({
          time,
          position: 'belowBar',
          color: '#10b981',
          shape: 'arrowUp',
          text: `Entry @ ${Number(order.price || 0).toFixed(4)}`,
        });
      }
    });

    // Add exit fills
    fills?.forEach(fill => {
      if (!fill.createdAt) return;
      
      const time = (new Date(fill.createdAt).getTime() / 1000) as UTCTimestamp;
      const isExit = fill.side?.toLowerCase() === 'sell' || fill.side?.toLowerCase() === 'short';
      
      if (isExit) {
        markers.push({
          time,
          position: 'aboveBar',
          color: '#ef4444',
          shape: 'arrowDown',
          text: `Exit @ ${Number(fill.price || 0).toFixed(4)}`,
        });
      }
    });

    // Sort markers by time
    markers.sort((a, b) => a.time - b.time);
    
    candleSeriesRef.current.setMarkers(markers);
  }, [orders, fills, chartData]);

  // Update price line for current order
  useEffect(() => {
    if (!candleSeriesRef.current) return;

    // Find active order for this session
    const activeOrder = orders?.find(o => 
      o.sessionId === sessionId && 
      o.status?.toLowerCase() !== 'filled' &&
      o.status?.toLowerCase() !== 'canceled'
    );

    if (activeOrder && activeOrder.price) {
      const priceLine = candleSeriesRef.current.createPriceLine({
        price: Number(activeOrder.price),
        color: '#3b82f6',
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'Order',
      });

      return () => {
        candleSeriesRef.current?.removePriceLine(priceLine);
      };
    }
  }, [orders, sessionId]);

  const timeframeButtons: Array<{ value: Timeframe; label: string }> = [
    { value: '1m', label: '1m' },
    { value: '15m', label: '15m' },
    { value: '1h', label: '1h' },
    { value: '4h', label: '4h' },
  ];

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {/* Header with timeframe selector */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '16px',
        background: 'rgba(15, 23, 42, 0.8)',
        borderBottom: '1px solid rgba(148, 163, 184, 0.1)',
      }}>
        <div>
          <div style={{ fontSize: '18px', fontWeight: 700, color: '#f1f5f9' }}>
            {symbol}
          </div>
          <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
            {chartData.length > 0 ? `${chartData.length} candles` : 'No data'}
          </div>
        </div>
        
        <Space>
          {timeframeButtons.map(btn => (
            <Button
              key={btn.value}
              type={timeframe === btn.value ? 'primary' : 'default'}
              size="small"
              onClick={() => setTimeframe(btn.value)}
              style={{
                background: timeframe === btn.value ? '#2563eb' : 'transparent',
                borderColor: timeframe === btn.value ? '#2563eb' : '#cbd5e1',
                color: timeframe === btn.value ? '#ffffff' : '#cbd5e1',
              }}
            >
              {btn.label}
            </Button>
          ))}
        </Space>
      </div>

      {/* Chart container */}
      <div style={{ position: 'relative', width: '100%', height: 'calc(100% - 70px)' }}>
        {loading && (
          <div style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 10,
          }}>
            <Spin size="large" tip="Loading chart data..." />
          </div>
        )}
        
        {error && (
          <div style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            background: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid #ef4444',
            borderRadius: '8px',
            padding: '16px 24px',
            color: '#fca5a5',
            zIndex: 10,
          }}>
            ⚠️ {error}
          </div>
        )}
        
        <div
          ref={chartContainerRef}
          style={{
            width: '100%',
            height: '100%',
            opacity: loading ? 0.3 : 1,
            transition: 'opacity 0.3s',
          }}
        />
      </div>
    </div>
  );
}

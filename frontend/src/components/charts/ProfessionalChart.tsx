import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { createChart, ColorType, IChartApi, ISeriesApi, LineStyle, LineWidth, UTCTimestamp, IPriceLine } from 'lightweight-charts';
import { api } from '../../api';
import { Button, Space, Spin } from 'antd';
import { formatPriceDisplay } from '../../utils/number';

interface PositionInfo {
  entryPrice?: number;
  stopPrice?: number;
  targets?: number[];
  side?: 'long' | 'short';
}

interface TechnicalLevels {
  support: number | null;
  resistance: number | null;
  supports: Array<{ price: number; touches: number; strength: number; label: string | null }>;
  resistances: Array<{ price: number; touches: number; strength: number; label: string | null }>;
  pivots: {
    P: number | null;
    S1: number | null;
    S2: number | null;
    R1: number | null;
    R2: number | null;
    refDay: string | null;
  } | null;
  srBias: 'nearSupport' | 'nearResistance' | 'neutral' | null;
}

interface StrategyInfo {
  label?: string;
  bias?: 'long' | 'short' | 'both';
  confidence?: number;
}

interface ProfessionalChartProps {
  symbol: string;
  sessionId?: string;
  orders?: any[];
  fills?: any[];
  position?: PositionInfo | null;
  technicalLevels?: TechnicalLevels | null;
  strategy?: StrategyInfo | null;
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

export default function ProfessionalChart({
  symbol,
  sessionId,
  orders = [],
  fills = [],
  position = null,
  technicalLevels = null,
  strategy = null,
}: ProfessionalChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const entryLineRef = useRef<IPriceLine | null>(null);
  const stopLineRef = useRef<IPriceLine | null>(null);
  const supportLineRef = useRef<IPriceLine | null>(null);
  const resistanceLineRef = useRef<IPriceLine | null>(null);
  const targetLinesRef = useRef<IPriceLine[]>([]);
  
  const [timeframe, setTimeframe] = useState<Timeframe>('15m');
  const [loading, setLoading] = useState(true);
  const [chartData, setChartData] = useState<CandleData[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [chartReady, setChartReady] = useState(false);
  const formatPriceLabel = useCallback((value?: number | null) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return formatPriceDisplay(value);
  }, []);

  // Initialize chart
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const cs = getComputedStyle(document.documentElement);
    const resolve = (v: string, fb: string) => cs.getPropertyValue(v).trim() || fb;
    const bgPrimary = resolve('--bg-primary', '#0a0e1a');
    const textSecondary = resolve('--text-secondary', '#94a3b8');
    const borderSubtle = resolve('--border-subtle', 'rgba(148,163,184,0.1)');
    const success = resolve('--success', '#10b981');
    const error = resolve('--error', '#ef4444');
    const accentSecondary = resolve('--accent-secondary', '#2563eb');

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: bgPrimary },
        textColor: textSecondary,
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
      localization: {
        priceFormatter: (value: number) => {
          // Smart precision: more decimals for lower prices
          if (value >= 1000) return value.toFixed(2);
          if (value >= 100) return value.toFixed(3);
          return value.toFixed(4);
        },
      },
      rightPriceScale: {
        borderColor: borderSubtle,
        textColor: textSecondary,
        scaleMargins: { top: 0.1, bottom: 0.2 },
      },
      timeScale: {
        borderColor: borderSubtle,
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
      upColor: success,
      downColor: error,
      borderUpColor: success,
      borderDownColor: error,
      wickUpColor: success,
      wickDownColor: error,
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

    // Mark chart as ready for data loading
    setChartReady(true);

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
      entryLineRef.current = null;
      stopLineRef.current = null;
      supportLineRef.current = null;
      resistanceLineRef.current = null;
      targetLinesRef.current = [];
      setChartReady(false);
    };
  }, []);

  // Fetch historical data
  const fetchHistoricalData = useCallback(async () => {
    if (!symbol) return;
    if (!candleSeriesRef.current) {
      console.warn('[ProfessionalChart] Series not ready yet, skipping fetch');
      return;
    }

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

      // Fetch OHLCV data from backend using API client
      const response = await api.getOHLCV(symbol, timeframe, candleCount);
      
      if (!response.data || !Array.isArray(response.data)) {
        throw new Error('Invalid data format received');
      }

      // Transform data to lightweight-charts format
      const candles: CandleData[] = response.data.map((candle: any) => ({
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

  // Load data when chart is ready and symbol or timeframe changes
  useEffect(() => {
    if (chartReady) {
      fetchHistoricalData();
    }
  }, [fetchHistoricalData, chartReady]);

  // Overlay price lines for entry/stop/targets/support-resistance
  useEffect(() => {
    if (!candleSeriesRef.current) return;

    const priceOrNull = (value?: number | null): number | null => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      return Number(value.toFixed(4));
    };

    const ensureLine = (
      ref: React.MutableRefObject<IPriceLine | null>,
      price: number | null,
      options: {
        title: string;
        color: string;
        lineWidth?: LineWidth;
        lineStyle?: LineStyle;
      },
    ) => {
      if (!candleSeriesRef.current) return;
      if (price != null) {
        const baseOptions = {
          axisLabelVisible: true,
          lineWidth: (options.lineWidth ?? 2) as LineWidth,
          lineStyle: options.lineStyle ?? LineStyle.Solid,
          color: options.color,
          title: options.title,
          price,
        } as const;
        if (!ref.current) {
          ref.current = candleSeriesRef.current.createPriceLine(baseOptions);
        } else {
          ref.current.applyOptions(baseOptions);
        }
      } else if (ref.current) {
        try {
          candleSeriesRef.current.removePriceLine(ref.current);
        } catch {}
        ref.current = null;
      }
    };

    const primarySupport = technicalLevels?.support ?? technicalLevels?.supports?.[0]?.price ?? null;
    const primaryResistance = technicalLevels?.resistance ?? technicalLevels?.resistances?.[0]?.price ?? null;

    ensureLine(entryLineRef, priceOrNull(position?.entryPrice), {
      title: 'Entry',
      color: '#38bdf8',
      lineWidth: 2,
    });
    ensureLine(stopLineRef, priceOrNull(position?.stopPrice), {
      title: 'Stop',
      color: 'var(--error)',
      lineWidth: 2,
    });
    ensureLine(supportLineRef, priceOrNull(primarySupport), {
      title: 'Support',
      color: '#f97316',
      lineStyle: LineStyle.Dashed,
      lineWidth: 1,
    });
    ensureLine(resistanceLineRef, priceOrNull(primaryResistance), {
      title: 'Resistance',
      color: '#a855f7',
      lineStyle: LineStyle.Dashed,
      lineWidth: 1,
    });

    // Refresh target lines
    targetLinesRef.current.forEach(line => {
      if (line && candleSeriesRef.current) {
        try {
          candleSeriesRef.current.removePriceLine(line);
        } catch {}
      }
    });
    targetLinesRef.current = [];

    if (Array.isArray(position?.targets) && candleSeriesRef.current) {
      position.targets.forEach((target, idx) => {
        const price = priceOrNull(target);
        if (price == null) return;
        const line = candleSeriesRef.current!.createPriceLine({
          price,
          color: 'var(--success)',
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: `TP${idx + 1}`,
        });
        targetLinesRef.current.push(line);
      });
    }

  }, [position, technicalLevels]);

  const infoItems = useMemo(() => {
    const items: Array<{ label: string; value: string; color?: string }> = [];
    const entryLabel = formatPriceLabel(position?.entryPrice);
    if (entryLabel) items.push({ label: 'Entry', value: entryLabel, color: '#38bdf8' });

    const stopLabel = formatPriceLabel(position?.stopPrice);
    if (stopLabel) items.push({ label: 'Stop', value: stopLabel, color: 'var(--error)' });

    if (position?.side) {
      items.push({
        label: 'Side',
        value: position.side.toUpperCase(),
        color: position.side === 'long' ? 'var(--success)' : 'var(--error)',
      });
    }

    if (Array.isArray(position?.targets)) {
      position.targets.slice(0, 3).forEach((target, idx) => {
        const label = formatPriceLabel(target);
        if (label) items.push({ label: `TP${idx + 1}`, value: label, color: 'var(--success)' });
      });
    }

    const supportValue = technicalLevels?.support ?? technicalLevels?.supports?.[0]?.price ?? null;
    const supportLabel = formatPriceLabel(supportValue);
    if (supportLabel) items.push({ label: 'Support', value: supportLabel, color: '#f97316' });

    const resistanceValue = technicalLevels?.resistance ?? technicalLevels?.resistances?.[0]?.price ?? null;
    const resistanceLabel = formatPriceLabel(resistanceValue);
    if (resistanceLabel) items.push({ label: 'Resistance', value: resistanceLabel, color: '#a855f7' });

    if (technicalLevels?.srBias) {
      const srBiasLabel = technicalLevels.srBias === 'nearSupport'
        ? 'Near support'
        : technicalLevels.srBias === 'nearResistance'
          ? 'Near resistance'
          : 'Neutral';
      items.push({ label: 'SR Bias', value: srBiasLabel });
    }

    if (strategy) {
      const detailParts: string[] = [];
      if (strategy.bias) detailParts.push(strategy.bias.toUpperCase());
      if (typeof strategy.confidence === 'number') {
        detailParts.push(`${Math.round(strategy.confidence * 100)}%`);
      }
      items.push({
        label: strategy.label || 'Strategy',
        value: detailParts.join(' • ') || 'Active',
        color: '#0ea5e9',
      });
    }

    return items;
  }, [formatPriceLabel, position, technicalLevels, strategy]);

  // Add order/fill markers
  useEffect(() => {
    if (!candleSeriesRef.current || chartData.length === 0) return;

    const markers: any[] = [];

    // Add markers from orders (both entry and exit)
    const cs = getComputedStyle(document.documentElement);
    const resolvedSuccess = cs.getPropertyValue('--success').trim() || '#10b981';
    const resolvedError = cs.getPropertyValue('--error').trim() || '#ef4444';

    orders?.forEach(order => {
      if (!order.createdAt) return;

      const time = (new Date(order.createdAt).getTime() / 1000) as UTCTimestamp;
      const clientId = order.clientOrderId || '';
      const isExit = clientId.includes('.exit') || clientId.includes('_exit_');
      const isFilled = order.status?.toLowerCase() === 'filled';

      if (isFilled) {
        if (isExit) {
          markers.push({
            time,
            position: 'aboveBar',
            color: resolvedError,
            shape: 'arrowDown',
            text: `Exit @ ${formatPriceDisplay(Number(order.price || order.avgPrice || 0))}`,
          });
        } else {
          markers.push({
            time,
            position: 'belowBar',
            color: resolvedSuccess,
            shape: 'arrowUp',
            text: `Entry @ ${formatPriceDisplay(Number(order.price || order.avgPrice || 0))}`,
          });
        }
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
        color: 'var(--accent-secondary)',
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
        background: 'var(--bg-primary)',
        borderBottom: '1px solid var(--border-subtle)',
      }}>
        <div>
          <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)' }}>
            {symbol}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
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
                background: timeframe === btn.value ? 'var(--accent-secondary)' : 'transparent',
                borderColor: timeframe === btn.value ? 'var(--accent-secondary)' : 'var(--text-secondary)',
                color: timeframe === btn.value ? '#ffffff' : 'var(--text-secondary)',
              }}
            >
              {btn.label}
            </Button>
          ))}
        </Space>
      </div>

      {infoItems.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '8px',
            padding: '12px 16px',
            background: 'var(--bg-primary)',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          {infoItems.map((item, idx) => (
            <div
              key={`${item.label}-${idx}`}
              style={{
                border: `1px solid ${item.color || 'var(--border-subtle)'}`,
                borderRadius: 999,
                padding: '4px 10px',
                fontSize: '12px',
                color: item.color || 'var(--text-primary)',
                display: 'flex',
                gap: '6px',
                letterSpacing: '0.2px',
              }}
            >
              <span style={{ opacity: 0.7 }}>{item.label}</span>
              <span style={{ fontWeight: 600 }}>{item.value}</span>
            </div>
          ))}
        </div>
      )}

      {/* Chart container */}
      <div style={{ position: 'relative', width: '100%', height: 600 }}>
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
            border: '1px solid var(--error)',
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

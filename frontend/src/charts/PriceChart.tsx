import { createChart, ColorType, IChartApi, LineStyle } from 'lightweight-charts';
import React from 'react';

import { api } from '../api';

type Props = {
  symbol?: string;
  price?: number;
  support?: number;
  resistance?: number;
  agentPlan?: any;
  agentPos?: any;
  pivots?: any;
  agentExit?: any;
  orders?: any[];
  trades?: any[];
  projection?: any;
};

export default function PriceChart({
  symbol,
  price,
  support,
  resistance,
  agentPlan,
  agentPos,
  pivots,
  agentExit,
  orders,
  trades,
  projection,
}: Props){
  const ref = React.useRef<HTMLDivElement>(null);
  const seriesRef = React.useRef<any>(null);
  const chartRef = React.useRef<IChartApi|null>(null);
  const zoneRef = React.useRef<HTMLDivElement|null>(null);
  const plSupport = React.useRef<any>(null);
  const plResistance = React.useRef<any>(null);
  const plEntryMin = React.useRef<any>(null);
  const plEntryMax = React.useRef<any>(null);
  const plSL = React.useRef<any>(null);
  const plTP = React.useRef<any>(null);
  const plP = React.useRef<any>(null);
  const plS1 = React.useRef<any>(null);
  const plR1 = React.useRef<any>(null);
  const plBE = React.useRef<any>(null);
  const plProjectionHigh = React.useRef<any>(null);
  const plProjectionLow = React.useRef<any>(null);
  const trailSeriesRef = React.useRef<any>(null);
  const pnlRef = React.useRef<HTMLDivElement|null>(null);
  const markersRef = React.useRef<any[]>([]);
  const tooltipRef = React.useRef<HTMLDivElement|null>(null);

  const [overlays, setOverlays] = React.useState({
    plan: true,
    pivots: true,
    projection: true,
    trades: true,
  });
  
  // State to track historical + live data
  const [chartData, setChartData] = React.useState<Array<{time: number, value: number}>>([]);
  const [isLoadingHistory, setIsLoadingHistory] = React.useState(true);

  const toggleOverlay = React.useCallback((key: keyof typeof overlays) => {
    setOverlays(prev => ({ ...prev, [key]: !prev[key] }));
  }, []);

  React.useEffect(()=> {
    const be = agentPos?.breakeven;
    if (typeof be === 'number' && isFinite(be)) {
      if (!plBE.current && seriesRef.current) {
        plBE.current = seriesRef.current.createPriceLine({ price: be, title: 'Break-even', lineWidth: 1, color: '#888' });
      }
      plBE.current?.applyOptions({ price: be });
    } else if (plBE.current && seriesRef.current) {
      try { seriesRef.current.removePriceLine(plBE.current); } catch {}
      plBE.current = null;
    }
  }, [agentPos?.breakeven]);
  React.useEffect(()=> {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      height: 360,
      layout:{ textColor:'#1e293b', background:{ type: ColorType.Solid, color: 'white' } },
      grid: {
        vertLines: { color: '#e2e8f0', style: LineStyle.Solid },
        horzLines: { color: '#e2e8f0', style: LineStyle.Solid },
      },
      crosshair: {
        mode: 0,
        vertLine: { color: '#94a3b8', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#1d4ed8' },
        horzLine: { color: '#94a3b8', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#1d4ed8' },
      },
      localization: {
        priceFormatter: (value: number) => value.toFixed(4),
      },
      rightPriceScale: { borderVisible: false },
      timeScale: {
        borderVisible: false,
        rightOffset: 12, // Add space on the right for live updates
        barSpacing: 6,   // Adjust bar spacing for better live visualization
      }
    });
    const line = chart.addLineSeries({ 
      priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
      lineWidth: 2, // Make line thicker for better visibility
    });
    const trailSeries = chart.addLineSeries({
      priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
      color: '#c0392b',
      lineStyle: LineStyle.Dashed,
      lineWidth: 1,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    seriesRef.current = line; chartRef.current = chart; trailSeriesRef.current = trailSeries;

    // price lines are created on-demand below

    const pnlOverlay = document.createElement('div');
    pnlOverlay.style.position = 'absolute';
    pnlOverlay.style.left = '0';
    pnlOverlay.style.right = '0';
    pnlOverlay.style.pointerEvents = 'none';
    pnlOverlay.style.display = 'none';
    pnlOverlay.style.background = 'rgba(39, 174, 96, 0.10)';
    pnlOverlay.style.zIndex = '1';
    pnlOverlay.style.overflow = 'hidden'; // Prevent overflow
    pnlOverlay.style.maxHeight = '360px'; // Match chart height

    // Add zone overlay div
    const overlay = document.createElement('div');
    overlay.style.position = 'absolute';
    overlay.style.left = '0';
    overlay.style.right = '0';
    overlay.style.pointerEvents = 'none';
    overlay.style.background = 'rgba(30,144,255,0.06)';
    overlay.style.display = 'none';
    overlay.style.zIndex = '2';
    overlay.style.overflow = 'hidden'; // Prevent overflow
    overlay.style.maxHeight = '360px'; // Match chart height
    const tooltip = document.createElement('div');
    tooltip.style.position = 'absolute';
    tooltip.style.right = '16px';
    tooltip.style.top = '16px';
    tooltip.style.padding = '8px 12px';
    tooltip.style.borderRadius = '8px';
    tooltip.style.background = 'rgba(15, 23, 42, 0.78)';
    tooltip.style.color = '#fff';
    tooltip.style.fontSize = '12px';
    tooltip.style.lineHeight = '1.4';
    tooltip.style.pointerEvents = 'none';
    tooltip.style.display = 'none';
    tooltip.style.backdropFilter = 'blur(6px)';
    tooltip.style.boxShadow = '0 6px 18px rgba(15,23,42,0.25)';

    ref.current.style.position = 'relative';
    ref.current.style.overflow = 'hidden'; // Prevent any child overflow
    ref.current.appendChild(pnlOverlay);
    ref.current.appendChild(overlay);
    ref.current.appendChild(tooltip);
    zoneRef.current = overlay;
    pnlRef.current = pnlOverlay;
    tooltipRef.current = tooltip;

    const handleCrosshairMove = (param: any) => {
      if (!tooltipRef.current || !seriesRef.current) return;
      if (!param || !param.time || !param.seriesPrices) {
        tooltipRef.current.style.display = 'none';
        return;
      }
      const price = param.seriesPrices.get(seriesRef.current);
      if (price == null) {
        tooltipRef.current.style.display = 'none';
        return;
      }
      const date = new Date((param.time as number) * 1000);
      const formattedDate = `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      tooltipRef.current.innerHTML = `
        <div style="font-weight:600; font-size:12px; margin-bottom:4px;">${symbol || ''}</div>
        <div style="font-size:14px;">${Number(price).toFixed(4)}</div>
        <div style="opacity:0.75;">${formattedDate}</div>
      `;
      tooltipRef.current.style.display = 'block';
    };

    chart.subscribeCrosshairMove(handleCrosshairMove);

    return ()=> {
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.remove();
      chartRef.current = null;
      trailSeriesRef.current = null;
      zoneRef.current?.remove();
      zoneRef.current = null;
      pnlRef.current?.remove();
      pnlRef.current = null;
      tooltipRef.current?.remove();
      tooltipRef.current = null;
      plP.current = null;
      plS1.current = null;
      plR1.current = null;
      plBE.current = null;
      // Reset chart data on unmount
      setChartData([]);
      setIsLoadingHistory(true);
    };
  }, []);

  // Load 24h historical data on mount with fallback
  React.useEffect(() => {
    if (!symbol || !seriesRef.current) return;
    
    const loadHistory = async () => {
      try {
        setIsLoadingHistory(true);
        
        // Try to get history, with fallback if API fails
        let historyResult;
        try {
          historyResult = await api.getHistory(symbol);
        } catch (err) {
          console.warn('History API failed, generating fallback data:', err);
          
          // Generate fallback historical data
          const now = Date.now();
          const oneDayAgo = now - 24 * 60 * 60 * 1000;
          const fallbackData = [];
          
          let basePrice = 4527.60; // Fallback price
          const volatility = 0.02; // 2% volatility per hour
          
          for (let i = 0; i < 24; i++) {
            const timestamp = Math.floor((oneDayAgo + i * 60 * 60 * 1000) / 1000);
            const change = (Math.random() - 0.5) * volatility * basePrice;
            basePrice = Math.max(basePrice + change, 1);
            
            fallbackData.push({
              time: timestamp,
              value: Number(basePrice.toFixed(2))
            });
          }
          
          historyResult = { data: fallbackData };
        }
        
        if (historyResult?.data && Array.isArray(historyResult.data)) {
          const historicalData = historyResult.data;
          setChartData(historicalData);
          
          // Set initial data on chart
          if (seriesRef.current && historicalData.length > 0) {
            seriesRef.current.setData(historicalData);
          }
        }
      } catch (err) {
        console.error('Failed to load any historical data:', err);
        // Continue with empty chart if everything fails
        setChartData([]);
      } finally {
        setIsLoadingHistory(false);
      }
    };
    
    loadHistory();
  }, [symbol]);

  // Handle live price updates
  React.useEffect(() => {
    if (typeof price === 'number' && isFinite(price) && seriesRef.current && !isLoadingHistory) {
      const timestamp = Math.floor(Date.now() / 1000);
      const newPoint = { time: timestamp, value: price };
      
      setChartData(prev => {
        // Avoid duplicate timestamps
        const filtered = prev.filter(p => p.time < timestamp);
        const updated = [...filtered, newPoint];
        
        // Keep last 2000 points for performance
        const trimmed = updated.slice(-2000);
        
        // Update chart with complete dataset
        if (seriesRef.current) {
          seriesRef.current.setData(trimmed);
        }
        
        return trimmed;
      });
    }
  }, [price, isLoadingHistory]);

  React.useEffect(()=> {
    if (!trailSeriesRef.current) return;
    const hist = Array.isArray(agentPos?.trail) ? agentPos?.trail || [] : [];
    if (!hist || hist.length === 0) {
      trailSeriesRef.current.setData([]);
      return;
    }
    const data = hist.map((p:any)=> ({ time: Math.floor(p.ts / 1000), value: p.price }));
    if (typeof agentPos?.stop === 'number' && isFinite(agentPos.stop)) {
      data.push({ time: Math.floor(Date.now() / 1000), value: agentPos.stop });
    }
    trailSeriesRef.current.setData(data);
  }, [agentPos?.trail, agentPos?.stop]);

  // ✅ FIX: Support/Resistance depuis status (backend calcule)
  React.useEffect(()=> {
    const ensure = (ref: any, title: string, color: string, lineStyle?: any) => {
      if (!ref.current && seriesRef.current) {
        ref.current = seriesRef.current.createPriceLine({
          price: 0,
          title, 
          lineWidth: 1, 
          color,
          lineStyle: lineStyle || LineStyle.Solid
        });
      }
      return ref.current;
    };
    const remove = (ref: any) => {
      if (ref.current && seriesRef.current) { 
        try { seriesRef.current.removePriceLine(ref.current); } catch {} 
        ref.current = null; 
      }
    };
    
    if (typeof support === 'number' && isFinite(support)) {
      ensure(plSupport, 'Support', '#e74c3c', LineStyle.Dashed)?.applyOptions({ price: support });
    } else {
      remove(plSupport);
    }
    
    if (typeof resistance === 'number' && isFinite(resistance)) {
      ensure(plResistance, 'Resistance', '#3498db', LineStyle.Dashed)?.applyOptions({ price: resistance });
    } else {
      remove(plResistance);
    }
  }, [support, resistance]);

  React.useEffect(() => {
    const ensure = (ref: any, title: string, color: string) => {
      if (!ref.current && seriesRef.current) {
        ref.current = seriesRef.current.createPriceLine({ price: 0, title, lineWidth: 1, color });
      }
      return ref.current;
    };
    const remove = (ref: any) => {
      if (ref.current && seriesRef.current) {
        try { seriesRef.current.removePriceLine(ref.current); } catch {}
        ref.current = null;
      }
    };

    if (!overlays.pivots || !pivots) {
      [plP, plS1, plR1].forEach(remove);
      return;
    }

    ensure(plP, 'Pivot P', '#0f172a')?.applyOptions({ price: pivots.P, color: '#0f172a' });
    ensure(plS1, 'S1', '#dc2626')?.applyOptions({ price: pivots.S1, color: '#dc2626' });
    ensure(plR1, 'R1', '#2563eb')?.applyOptions({ price: pivots.R1, color: '#2563eb' });
  }, [pivots, overlays.pivots]);

  // ✅ FIX: SOURCE UNIQUE = Agent State (plus de strategy obsolète)
  React.useEffect(()=> {
    // Helper functions
    const ensure = (ref: any, title: string, color: string) => {
      if (!ref.current && seriesRef.current) {
        ref.current = seriesRef.current.createPriceLine({ 
          price: 0, 
          title, 
          lineWidth: 2, 
          color 
        });
      }
      return ref.current;
    };
    const remove = (ref: any) => {
      if (ref.current && seriesRef.current) { 
        try { seriesRef.current.removePriceLine(ref.current); } catch {} 
        ref.current = null; 
      }
    };
    
    // ✅ NETTOYER toutes les lines d'abord (éviter overlaps)
    [plEntryMin, plEntryMax, plSL, plTP].forEach(ref => remove(ref));

    if (!overlays.plan) {
      if (zoneRef.current) {
        zoneRef.current.style.display = 'none';
      }
      return;
    }

    // ✅ RECRÉER depuis agent plan uniquement (source de vérité)
    if (agentPlan) {
      const zmin = agentPlan?.zone?.from;
      const zmax = agentPlan?.zone?.to;
      const mid = agentPlan?.zone?.mid;
      const sd = agentPlan?.stopDistance;
      
      // Stop: utiliser agentPos.stop si existe, sinon calculer
      const sl = typeof agentPos?.stop === 'number' ? agentPos.stop : (
        typeof mid === 'number' && typeof sd === 'number'
          ? (agentPlan?.bias==='long' ? (mid - sd) : (mid + sd))
          : undefined
      );
      
      // Target: premier R price
      const tp = agentPlan?.rPrices?.[0]?.price;
      
      // Créer les price lines avec couleurs distinctes
      if (typeof zmin === 'number' && isFinite(zmin)) {
        ensure(plEntryMin, 'Entry Min', '#2ecc71')?.applyOptions({ price: zmin });
      }
      if (typeof zmax === 'number' && isFinite(zmax)) {
        ensure(plEntryMax, 'Entry Max', '#27ae60')?.applyOptions({ price: zmax });
      }
      if (typeof sl === 'number' && isFinite(sl)) {
        ensure(plSL, 'Stop', '#e74c3c')?.applyOptions({ price: sl });
      }
      if (typeof tp === 'number' && isFinite(tp)) {
        ensure(plTP, 'Target', '#3498db')?.applyOptions({ price: tp });
      }
    } else {
      // Pas de plan agent, nettoyer tout
      [plEntryMin, plEntryMax, plSL, plTP].forEach(ref => remove(ref));
    }

    // ✅ Zone shading depuis agent plan
    if (agentPlan && overlays.plan) {
      const zmin = agentPlan?.zone?.from;
      const zmax = agentPlan?.zone?.to;
      
      if (zoneRef.current && seriesRef.current && typeof zmin === 'number' && typeof zmax === 'number' && isFinite(zmin) && isFinite(zmax)) {
        const y1 = seriesRef.current.priceToCoordinate(zmin);
        const y2 = seriesRef.current.priceToCoordinate(zmax);
        if (y1 != null && y2 != null) {
          // Constrain coordinates to chart bounds
          const chartHeight = 360;
          const constrainedY1 = Math.max(0, Math.min(chartHeight, y1));
          const constrainedY2 = Math.max(0, Math.min(chartHeight, y2));
          
          const top = Math.min(constrainedY1, constrainedY2);
          const height = Math.abs(constrainedY1 - constrainedY2);
          
          // Additional safety check
          const maxHeight = chartHeight - top;
          const finalHeight = Math.min(height, maxHeight);
          
          if (finalHeight < 1 || top < 0 || top >= chartHeight) {
            zoneRef.current.style.display = 'none';
            return;
          }
          
          zoneRef.current.style.top = `${top}px`;
          zoneRef.current.style.height = `${finalHeight}px`;
          zoneRef.current.style.display = 'block';
          zoneRef.current.style.background = agentPlan?.bias==='long' ? 'rgba(46, 204, 113, 0.10)' : 'rgba(231, 76, 60, 0.10)';
        } else {
          zoneRef.current.style.display = 'none';
        }
      } else if (zoneRef.current) {
        zoneRef.current.style.display = 'none';
      }
    }
  }, [agentPlan, agentPos, overlays.plan]);

  React.useEffect(()=> {
    if (!pnlRef.current || !seriesRef.current) return;
    const entry = agentPos?.entry;
    if (typeof entry !== 'number' || !isFinite(entry) || typeof price !== 'number' || !isFinite(price)) {
      pnlRef.current.style.display = 'none';
      return;
    }
    try {
      const yEntry = seriesRef.current.priceToCoordinate(entry);
      const yPrice = seriesRef.current.priceToCoordinate(price);
      if (yEntry == null || yPrice == null) {
        pnlRef.current.style.display = 'none';
        return;
      }
      
      // Constrain coordinates to chart bounds to prevent overflow
      const chartHeight = 360; // Chart height from createChart config
      const constrainedYEntry = Math.max(0, Math.min(chartHeight, yEntry));
      const constrainedYPrice = Math.max(0, Math.min(chartHeight, yPrice));
      
      const top = Math.min(constrainedYEntry, constrainedYPrice);
      const height = Math.abs(constrainedYEntry - constrainedYPrice);
      
      // Additional safety check to prevent overflow
      const maxHeight = chartHeight - top;
      const finalHeight = Math.min(height, maxHeight);
      
      if (finalHeight < 1 || top < 0 || top >= chartHeight) {
        pnlRef.current.style.display = 'none';
        return;
      }
      
      pnlRef.current.style.top = `${top}px`;
      pnlRef.current.style.height = `${finalHeight}px`;
      pnlRef.current.style.display = 'block';
      const favorable = agentPos?.side === 'buy' ? price >= entry : price <= entry;
      pnlRef.current.style.background = favorable ? 'rgba(39, 174, 96, 0.12)' : 'rgba(231, 76, 60, 0.12)';
    } catch {
      pnlRef.current.style.display = 'none';
    }
  }, [price, agentPos?.entry, agentPos?.side]);

  // Projected envelope (bias confidence overlay)
  React.useEffect(() => {
    if (!seriesRef.current) return;
    const ensure = (ref: any, title: string, color: string, lineStyle = LineStyle.Dashed) => {
      if (!ref.current && seriesRef.current) {
        ref.current = seriesRef.current.createPriceLine({
          price: 0,
          title,
          lineWidth: 1,
          color,
          lineStyle,
        });
      }
      return ref.current;
    };
    const remove = (ref: any) => {
      if (ref.current && seriesRef.current) {
        try { seriesRef.current.removePriceLine(ref.current); } catch {}
        ref.current = null;
      }
    };

    if (!overlays.projection) {
      remove(plProjectionHigh);
      remove(plProjectionLow);
      return;
    }

    const up = projection?.rangeUpPrice ?? projection?.upsidePrice;
    const down = projection?.rangeDownPrice ?? projection?.downsidePrice;

    if (typeof up === 'number' && isFinite(up)) {
      ensure(plProjectionHigh, 'Projection High', '#3b82f6', LineStyle.Dotted)?.applyOptions({ price: up });
    } else {
      remove(plProjectionHigh);
    }

    if (typeof down === 'number' && isFinite(down)) {
      ensure(plProjectionLow, 'Projection Low', '#8b5cf6', LineStyle.Dotted)?.applyOptions({ price: down });
    } else {
      remove(plProjectionLow);
    }
  }, [projection, overlays.projection]);

  // Markers for orders, trades, and live position
  React.useEffect(() => {
    if (!seriesRef.current) return;

    const cache = new Map<string, any>();
    const pushMarker = (marker: any) => {
      if (marker.time == null || Number.isNaN(marker.time)) return;
      const key = `${marker.time}:${marker.position}:${marker.text}`;
      cache.set(key, marker);
    };

    const safeTs = (value: any): number | null => {
      if (value == null) return null;
      if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.floor(value / 1000);
      }
      const date = new Date(value);
      const ms = date.getTime();
      if (Number.isNaN(ms)) return null;
      return Math.floor(ms / 1000);
    };

    const renderOrders = Array.isArray(orders) ? orders : [];
    renderOrders.forEach((order) => {
      const ts = safeTs(order.createdAt);
      if (ts == null) return;
      const isExit = Boolean(order.clientOrderId?.endsWith?.('.exit'));
      const status = String(order.status || '').toUpperCase();
      const priceNum = Number(order.price);
      const priceLabel = Number.isFinite(priceNum) ? priceNum.toFixed(4) : '';
      pushMarker({
        time: ts,
        position: isExit ? 'aboveBar' : 'belowBar',
        color: isExit ? '#ef4444' : '#22c55e',
        shape: isExit ? 'arrowDown' : 'arrowUp',
        text: `${isExit ? 'Exit' : 'Entry'} ${priceLabel} (${status || 'PENDING'})`,
      });
    });

    const renderTrades = Array.isArray(trades) ? trades : [];
    renderTrades.forEach((trade) => {
      const ts = safeTs(trade.createdAt);
      if (ts == null) return;
      const side = String(trade.positionSide || '').toLowerCase();
      const exitPriceNum = Number(trade.exitPrice);
      const exitPrice = Number.isFinite(exitPriceNum) ? exitPriceNum.toFixed(4) : '-';
      const pnl = Number(trade.realizedPnlUsd || 0);
      const pnlLabel = `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USD`;
      pushMarker({
        time: ts,
        position: side === 'short' ? 'aboveBar' : 'belowBar',
        color: pnl >= 0 ? '#16a34a' : '#dc2626',
        shape: pnl >= 0 ? 'circle' : 'square',
        text: `Trade ${exitPrice} (${pnlLabel})`,
      });
    });

    if (agentPos?.partialInfo?.ts && agentPos?.partialInfo?.price) {
      const ts = safeTs(agentPos.partialInfo.ts);
      const priceLabel = Number(agentPos.partialInfo.price).toFixed?.(4);
      if (ts != null && priceLabel) {
        pushMarker({
          time: ts,
          position: 'aboveBar',
          color: '#0ea5e9',
          shape: 'circle',
          text: `Partial ${priceLabel}`,
        });
      }
    }

    if (agentPos?.openedAt && agentPos?.entry) {
      const ts = safeTs(agentPos.openedAt);
      if (ts != null) {
        pushMarker({
          time: ts,
          position: 'belowBar',
          color: '#1f8f1f',
          shape: 'arrowUp',
          text: `Entry ${Number(agentPos.entry).toFixed(4)}`,
        });
      }
    }

    if (agentExit?.ts && agentExit?.price) {
      const ts = safeTs(agentExit.ts);
      if (ts != null) {
        pushMarker({
          time: ts,
          position: 'aboveBar',
          color: '#c0392b',
          shape: 'arrowDown',
          text: `Exit ${Number(agentExit.price).toFixed?.(4)} ${agentExit.reason ? `(${agentExit.reason})` : ''}`,
        });
      }
    }

    // Replace markers with latest snapshot
    const ordered = Array.from(cache.values()).sort((a, b) => a.time - b.time);
    markersRef.current = overlays.trades ? ordered.slice(-150) : [];
    seriesRef.current.setMarkers(markersRef.current);
  }, [orders, trades, agentPos?.openedAt, agentPos?.entry, agentPos?.partialInfo?.ts, agentExit?.ts, overlays.trades]);

  const latestPoint = chartData[chartData.length - 1];
  const firstPoint = chartData[0];
  const change = latestPoint && firstPoint ? latestPoint.value - firstPoint.value : undefined;
  const changePct = change !== undefined && firstPoint ? (change / firstPoint.value) * 100 : undefined;
  const latestTrade = Array.isArray(trades) && trades.length > 0 ? trades[trades.length - 1] : null;

  const formatUsd = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)} USD`;

  const overlayButtons: Array<{ key: keyof typeof overlays; label: string }> = [
    { key: 'plan', label: 'Plan' },
    { key: 'pivots', label: 'Pivots' },
    { key: 'projection', label: 'Projection' },
    { key: 'trades', label: 'Orders & Trades' },
  ];

  return <div style={{ border:'1px solid #e2e8f0', borderRadius:12, padding:12, background:'#fff', boxShadow:'0 12px 32px -18px rgba(15, 23, 42, 0.35)' }}>
    <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:12 }}>
        <div>
          <div style={{ fontWeight:700, fontSize:16 }}>{symbol} — Historical + Live</div>
          <div style={{ fontSize:12, color:'#64748b' }}>
            {isLoadingHistory ? 'Loading history…' : chartData.length > 0 ? `${chartData.length} data points` : 'No data available'}
          </div>
        </div>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
          {overlayButtons.map(button => (
            <button
              key={button.key}
              onClick={() => toggleOverlay(button.key)}
              style={{
                border:'1px solid #cbd5f5',
                padding:'6px 10px',
                borderRadius:6,
                fontSize:12,
                cursor:'pointer',
                background: overlays[button.key] ? '#2563eb' : '#f8fafc',
                color: overlays[button.key] ? '#fff' : '#0f172a',
                transition:'all 0.2s ease',
              }}
            >
              {overlays[button.key] ? '✓ ' : ''}{button.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{
        display:'grid',
        gridTemplateColumns:'repeat(auto-fit, minmax(140px, 1fr))',
        gap:12,
        fontSize:12,
        color:'#0f172a',
      }}>
        <div style={{ background:'#f8fafc', borderRadius:8, padding:'10px 12px' }}>
          <div style={{ fontSize:11, color:'#64748b', marginBottom:4 }}>Last Price</div>
          <div style={{ fontSize:16, fontWeight:600 }}>{latestPoint ? latestPoint.value.toFixed(4) : '—'}</div>
        </div>
        <div style={{ background:'#f8fafc', borderRadius:8, padding:'10px 12px' }}>
          <div style={{ fontSize:11, color:'#64748b', marginBottom:4 }}>24h Change</div>
          <div style={{ fontSize:16, fontWeight:600, color: change != null && changePct != null ? (change >= 0 ? '#16a34a' : '#dc2626') : '#0f172a' }}>
            {change != null && changePct != null ? `${change >= 0 ? '+' : ''}${change.toFixed(4)} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%)` : '—'}
          </div>
        </div>
        <div style={{ background:'#f8fafc', borderRadius:8, padding:'10px 12px' }}>
          <div style={{ fontSize:11, color:'#64748b', marginBottom:4 }}>Last Trade</div>
          <div style={{ fontSize:14, fontWeight:600 }}>
            {latestTrade?.exitPrice ? Number(latestTrade.exitPrice).toFixed(4) : latestTrade?.entryPrice ? Number(latestTrade.entryPrice).toFixed(4) : '—'}
          </div>
          <div style={{ fontSize:12, color:'#475569' }}>
            {latestTrade?.realizedPnlUsd != null ? formatUsd(Number(latestTrade.realizedPnlUsd)) : ''}
          </div>
        </div>
      </div>
    </div>
    <div ref={ref} style={{ marginTop:16 }} />
  </div>;
}

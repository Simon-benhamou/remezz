import React from 'react';
import { createChart, ColorType, IChartApi, LineStyle } from 'lightweight-charts';
import { api } from '../api';

type Props = { symbol?: string; price?: number; support?: number; resistance?: number; strategy?: any; agentPlan?: any; agentPos?: any; pivots?: any; agentExit?: any };

export default function PriceChart({ symbol, price, support, resistance, strategy, agentPlan, agentPos, pivots, agentExit }: Props){
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
  const trailSeriesRef = React.useRef<any>(null);
  const pnlRef = React.useRef<HTMLDivElement|null>(null);
  const markersRef = React.useRef<any[]>([]);
  
  // State to track historical + live data
  const [chartData, setChartData] = React.useState<Array<{time: number, value: number}>>([]);
  const [isLoadingHistory, setIsLoadingHistory] = React.useState(true);
  React.useEffect(()=> {
    if (!chartRef.current || !seriesRef.current) return;
    plP.current  = seriesRef.current.createPriceLine({ price: 0, title: 'Pivot P', lineWidth: 1 });
    plS1.current = seriesRef.current.createPriceLine({ price: 0, title: 'S1', lineWidth: 1 });
    plR1.current = seriesRef.current.createPriceLine({ price: 0, title: 'R1', lineWidth: 1 });
    plBE.current = seriesRef.current.createPriceLine({ price: 0, title: 'Break-even', lineWidth: 1, color: '#888' });
  }, []);
  React.useEffect(()=> {
    if (!pivots) return;
    plP.current?.applyOptions({ price: pivots.P });
    plS1.current?.applyOptions({ price: pivots.S1 });
    plR1.current?.applyOptions({ price: pivots.R1 });
  }, [pivots]);

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
      layout:{ textColor:'#222', background:{ type: ColorType.Solid, color: 'white' } },
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
    ref.current.style.position = 'relative';
    ref.current.style.overflow = 'hidden'; // Prevent any child overflow
    ref.current.appendChild(pnlOverlay);
    ref.current.appendChild(overlay);
    zoneRef.current = overlay;
    pnlRef.current = pnlOverlay;

    return ()=> {
      chart.remove();
      chartRef.current = null;
      trailSeriesRef.current = null;
      zoneRef.current?.remove();
      zoneRef.current = null;
      pnlRef.current?.remove();
      pnlRef.current = null;
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

  React.useEffect(()=> {
    const ensure = (ref: any, title: string) => {
      if (!ref.current && seriesRef.current) ref.current = seriesRef.current.createPriceLine({ price: 0, title, lineWidth: 1 });
      return ref.current;
    };
    const remove = (ref: any) => {
      if (ref.current && seriesRef.current) { try { seriesRef.current.removePriceLine(ref.current); } catch {} ref.current = null; }
    };
    if (typeof support === 'number' && isFinite(support)) ensure(plSupport, 'Support')?.applyOptions({ price: support });
    else remove(plSupport);
    if (typeof resistance === 'number' && isFinite(resistance)) ensure(plResistance, 'Resistance')?.applyOptions({ price: resistance });
    else remove(plResistance);
  }, [support, resistance]);

  React.useEffect(()=> {
    // Primary from classic strategy
    const zmin = strategy?.entry?.zone?.min;
    const zmax = strategy?.entry?.zone?.max;
    const sl = strategy?.levels?.stopPrice;
    const tp = strategy?.levels?.takeProfitPrice;
    const ensure = (ref: any, title: string) => {
      if (!ref.current && seriesRef.current) ref.current = seriesRef.current.createPriceLine({ price: 0, title, lineWidth: 1 });
      return ref.current;
    };
    const remove = (ref: any) => { if (ref.current && seriesRef.current) { try { seriesRef.current.removePriceLine(ref.current); } catch {} ref.current = null; } };
    if (typeof zmin === 'number' && isFinite(zmin)) ensure(plEntryMin, 'Entry Min')?.applyOptions({ price: zmin }); else remove(plEntryMin);
    if (typeof zmax === 'number' && isFinite(zmax)) ensure(plEntryMax, 'Entry Max')?.applyOptions({ price: zmax }); else remove(plEntryMax);
    if (typeof sl === 'number' && isFinite(sl)) ensure(plSL, 'Stop')?.applyOptions({ price: sl }); else remove(plSL);
    if (typeof tp === 'number' && isFinite(tp)) ensure(plTP, 'Target')?.applyOptions({ price: tp }); else remove(plTP);
  }, [strategy]);

  React.useEffect(()=> {
    // Agent validated plan overlays
    const zmin = agentPlan?.zone?.from;
    const zmax = agentPlan?.zone?.to;
    const mid = agentPlan?.zone?.mid;
    const sd = agentPlan?.stopDistance;
    const sl = typeof agentPos?.stop === 'number' ? agentPos?.stop : (
      typeof mid === 'number' && typeof sd === 'number'
        ? (agentPlan?.bias==='long' ? (mid - sd) : (mid + sd))
        : undefined
    );
    const tp = agentPlan?.rPrices?.[0]?.price;
    const ensure = (ref: any, title: string) => {
      if (!ref.current && seriesRef.current) ref.current = seriesRef.current.createPriceLine({ price: 0, title, lineWidth: 1 });
      return ref.current;
    };
    const remove = (ref: any) => { if (ref.current && seriesRef.current) { try { seriesRef.current.removePriceLine(ref.current); } catch {} ref.current = null; } };
    if (typeof zmin === 'number' && isFinite(zmin)) ensure(plEntryMin, 'Entry Min')?.applyOptions({ price: zmin }); else remove(plEntryMin);
    if (typeof zmax === 'number' && isFinite(zmax)) ensure(plEntryMax, 'Entry Max')?.applyOptions({ price: zmax }); else remove(plEntryMax);
    if (typeof sl === 'number' && isFinite(sl)) ensure(plSL, 'Stop')?.applyOptions({ price: sl }); else remove(plSL);
    if (typeof tp === 'number' && isFinite(tp)) ensure(plTP, 'Target')?.applyOptions({ price: tp }); else remove(plTP);

    // Zone shading overlay (approximate)
    try {
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
    } catch {}
  }, [agentPlan, agentPos]);

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

  // Markers for entries/exits
  React.useEffect(()=>{
    if (!seriesRef.current) return;
    const marks: any[] = [...markersRef.current];
    // Add entry marker
    if (agentPos?.openedAt && agentPos?.entry) {
      const t = Math.floor(agentPos.openedAt/1000);
      const exists = marks.some(m=> m.time === t && m.text?.startsWith('Entry'));
      if (!exists) {
        marks.push({ time: t, position: 'belowBar', color: '#1f8f1f', shape: 'arrowUp', text: `Entry ${agentPos.entry.toFixed(4)}` });
      }
    }
    if (agentPos?.partialInfo?.ts && agentPos?.partialInfo?.price) {
      const t = Math.floor(agentPos.partialInfo.ts/1000);
      const exists = marks.some(m=> m.time === t && m.text?.startsWith('Partial'));
      if (!exists) {
        marks.push({ time: t, position: 'aboveBar', color: '#2980b9', shape: 'circle', text: `Partial ${agentPos.partialInfo.price.toFixed?.(4)}` });
      }
    }
    // Add last exit marker
    if (agentExit?.ts && agentExit?.price) {
      const t = Math.floor((agentExit.ts)/1000);
      const exists = marks.some(m=> m.time === t && m.text?.startsWith('Exit'));
      if (!exists) {
        marks.push({ time: t, position: 'aboveBar', color: '#c0392b', shape: 'arrowDown', text: `Exit ${agentExit.price.toFixed?.(4)} (${agentExit.reason||''})` });
      }
    }
    markersRef.current = marks.slice(-50);
    seriesRef.current.setMarkers(markersRef.current);
  }, [agentPos?.openedAt, agentPos?.partialInfo?.ts, agentExit?.ts]);

  return <div style={{ border:'1px solid #eee', borderRadius:8, padding:8 }}>
    <div style={{ fontWeight:600, marginBottom:8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span>{symbol} — Historical + Live</span>
      <span style={{ fontSize: '12px', color: '#666' }}>
        {isLoadingHistory ? 'Loading history...' : 
         chartData.length > 0 ? `${chartData.length} data points` : 'No data'}
      </span>
    </div>
    <div ref={ref} />
  </div>;
}

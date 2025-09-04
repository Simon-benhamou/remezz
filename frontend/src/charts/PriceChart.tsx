import React from 'react';
import { createChart, ColorType, IChartApi } from 'lightweight-charts';

type Props = { symbol?: string; price?: number; support?: number; resistance?: number; strategy?: any };

export default function PriceChart({ symbol, price, support, resistance, strategy }: Props){
  const ref = React.useRef<HTMLDivElement>(null);
  const seriesRef = React.useRef<any>(null);
  const chartRef = React.useRef<IChartApi|null>(null);
  const plSupport = React.useRef<any>(null);
  const plResistance = React.useRef<any>(null);
  const plEntryMin = React.useRef<any>(null);
  const plEntryMax = React.useRef<any>(null);
  const plSL = React.useRef<any>(null);
  const plTP = React.useRef<any>(null);
  const plP = React.useRef<any>(null);
  const plS1 = React.useRef<any>(null);
  const plR1 = React.useRef<any>(null);
  React.useEffect(()=> {
    if (!chartRef.current || !seriesRef.current) return;
    plP.current  = seriesRef.current.createPriceLine({ price: 0, title: 'Pivot P', lineWidth: 1 });
    plS1.current = seriesRef.current.createPriceLine({ price: 0, title: 'S1', lineWidth: 1 });
    plR1.current = seriesRef.current.createPriceLine({ price: 0, title: 'R1', lineWidth: 1 });
  }, []);
  React.useEffect(()=> {
    const piv = (strategy as any)?.pivots || (status as any)?.pivots;
    if (!piv) return;
    plP.current?.applyOptions({ price: piv.P });
    plS1.current?.applyOptions({ price: piv.S1 });
    plR1.current?.applyOptions({ price: piv.R1 });
  }, [strategy /* ou status */]);
  React.useEffect(()=> {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      height: 360, layout:{ textColor:'#222', background:{ type: ColorType.Solid, color: 'white' } }
    });
    const line = chart.addLineSeries();
    seriesRef.current = line; chartRef.current = chart;

    // price lines
    plSupport.current = line.createPriceLine({ price: 0, title: 'Support', lineWidth: 1 });
    plResistance.current = line.createPriceLine({ price: 0, title: 'Resistance', lineWidth: 1 });
    plEntryMin.current = line.createPriceLine({ price: 0, title: 'Entry Min', lineWidth: 1 });
    plEntryMax.current = line.createPriceLine({ price: 0, title: 'Entry Max', lineWidth: 1 });
    plSL.current = line.createPriceLine({ price: 0, title: 'Stop', lineWidth: 1 });
    plTP.current = line.createPriceLine({ price: 0, title: 'Target', lineWidth: 1 });

    return ()=> { chart.remove(); chartRef.current = null; };
  }, []);

  React.useEffect(()=> {
    if (price && seriesRef.current) {
      seriesRef.current.update({ time: Math.floor(Date.now()/1000), value: price });
    }
  }, [price]);

  React.useEffect(()=> {
    if (support && plSupport.current) plSupport.current.applyOptions({ price: support });
    if (resistance && plResistance.current) plResistance.current.applyOptions({ price: resistance });
  }, [support, resistance]);

  React.useEffect(()=> {
    // zone d’entrée et SL/TP depuis la stratégie + levels
    const zmin = strategy?.entry?.zone?.min;
    const zmax = strategy?.entry?.zone?.max;
    const sl = strategy?.levels?.stopPrice;
    const tp = strategy?.levels?.takeProfitPrice;

    if (zmin && plEntryMin.current) plEntryMin.current.applyOptions({ price: zmin });
    if (zmax && plEntryMax.current) plEntryMax.current.applyOptions({ price: zmax });
    if (sl && plSL.current) plSL.current.applyOptions({ price: sl });
    if (tp && plTP.current) plTP.current.applyOptions({ price: tp });
  }, [strategy]);

  return <div style={{ border:'1px solid #eee', borderRadius:8, padding:8 }}>
    <div style={{ fontWeight:600, marginBottom:8 }}>{symbol} — Live</div>
    <div ref={ref} />
  </div>;
}

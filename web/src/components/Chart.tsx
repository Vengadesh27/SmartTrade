import { useEffect, useRef, useState } from 'react';
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { barTime, INTERVALS, RANGES, type CandlesResponse } from '../lib/candles';
import { fmt } from '../lib/format';
import type { Instrument, Quote } from '../lib/types';
import { keyOf } from '../lib/types';
import { useDrawingTools } from '../lib/useDrawingTools';
import { DrawingRail, DrawingCanvas } from './DrawingLayer';

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

type ChartMode = 'indicators' | 'price_action' | 'smc' | 'order_flow';
const MODES: { id: ChartMode; label: string; disabled?: boolean }[] = [
  { id: 'indicators', label: 'Indicators' },
  { id: 'price_action', label: 'Price Action' },
  { id: 'smc', label: 'Smart Money Concepts' },
  { id: 'order_flow', label: 'Order Flow / ICR', disabled: true },
];

export function Chart({ active, tick }: { active: Instrument | null; tick: Quote | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const smaRef = useRef<ISeriesApi<'Line'> | null>(null);
  const vwapRef = useRef<ISeriesApi<'Line'> | null>(null);
  const levelLinesRef = useRef<IPriceLine[]>([]);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const [interval, setInterval_] = useState('FIFTEEN_MINUTE');
  const [days, setDays] = useState(1);
  const [mode, setMode] = useState<ChartMode>('indicators');
  const [chartApi, setChartApi] = useState<IChartApi | null>(null);
  const [priceApi, setPriceApi] = useState<ISeriesApi<'Candlestick'> | null>(null);
  const [paneEl, setPaneEl] = useState<HTMLDivElement | null>(null);
  const drawing = useDrawingTools(chartApi, priceApi, paneEl, active ? { exch: active.exch, sym: active.sym } : null);

  const { data, refetch } = useQuery({
    queryKey: ['candles', active ? keyOf(active) : null, interval, days],
    queryFn: () =>
      api.get<CandlesResponse>(
        `/candles?symbol=${encodeURIComponent(active!.sym)}&exchange=${active!.exch}&interval=${interval}&days=${days}`
      ),
    enabled: !!active,
    refetchInterval: 60_000,
  });

  // ---- chart setup (once) ----
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: cssVar('--panel') }, textColor: cssVar('--muted'), fontSize: 11 },
      grid: { vertLines: { color: cssVar('--border') }, horzLines: { color: cssVar('--border') } },
      rightPriceScale: { borderColor: cssVar('--border') },
      timeScale: { borderColor: cssVar('--border'), timeVisible: true, secondsVisible: false, rightOffset: 6 },
      crosshair: { mode: 1 },
    });
    const price = chart.addSeries(CandlestickSeries, {
      upColor: cssVar('--up'),
      downColor: cssVar('--down'),
      borderUpColor: cssVar('--up'),
      borderDownColor: cssVar('--down'),
      wickUpColor: cssVar('--up'),
      wickDownColor: cssVar('--down'),
    });
    const sma = chart.addSeries(LineSeries, {
      color: '#2563eb',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const vwap = chart.addSeries(LineSeries, {
      color: '#7c3aed',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    chartRef.current = chart;
    priceRef.current = price;
    smaRef.current = sma;
    vwapRef.current = vwap;
    markersRef.current = createSeriesMarkers(price, []);
    setChartApi(chart);
    setPriceApi(price);

    const ro = new ResizeObserver(() => chart.applyOptions({}));
    ro.observe(containerRef.current);

    const retheme = () => {
      chart.applyOptions({
        layout: { background: { color: cssVar('--panel') }, textColor: cssVar('--muted') },
        grid: { vertLines: { color: cssVar('--border') }, horzLines: { color: cssVar('--border') } },
        rightPriceScale: { borderColor: cssVar('--border') },
        timeScale: { borderColor: cssVar('--border') },
      });
      price.applyOptions({
        upColor: cssVar('--up'),
        downColor: cssVar('--down'),
        borderUpColor: cssVar('--up'),
        borderDownColor: cssVar('--down'),
        wickUpColor: cssVar('--up'),
        wickDownColor: cssVar('--down'),
      });
    };
    window.addEventListener('themechange', retheme);

    return () => {
      ro.disconnect();
      window.removeEventListener('themechange', retheme);
      chart.remove();
      setChartApi(null);
      setPriceApi(null);
    };
  }, []);

  // ---- paint candles + overlays + level lines on new data or mode change ----
  useEffect(() => {
    if (!data || !priceRef.current || !smaRef.current || !vwapRef.current || !chartRef.current) return;
    const rows = data.candles;
    priceRef.current.setData(
      rows.map((c) => ({ time: barTime(c.time) as never, open: c.open, high: c.high, low: c.low, close: c.close }))
    );

    // Indicators mode overlays SMA/VWAP; Price Action and SMC keep the chart
    // clean (candles + structure only) so their own signals aren't cluttered.
    const showIndicators = mode === 'indicators';
    smaRef.current.applyOptions({ visible: showIndicators });
    vwapRef.current.applyOptions({ visible: showIndicators });
    smaRef.current.setData(
      showIndicators
        ? rows.filter((c) => c.sma_20 != null).map((c) => ({ time: barTime(c.time) as never, value: c.sma_20! }))
        : []
    );
    vwapRef.current.setData(
      showIndicators
        ? rows.filter((c) => c.vwap != null).map((c) => ({ time: barTime(c.time) as never, value: c.vwap! }))
        : []
    );

    for (const line of levelLinesRef.current) priceRef.current.removePriceLine(line);
    levelLinesRef.current = [];
    const addLine = (value: number, color: string, title: string) =>
      levelLinesRef.current.push(
        priceRef.current!.createPriceLine({ price: value, color, lineWidth: 1, lineStyle: 3, title })
      );
    const s = data.summary;
    if (s) {
      if (s.prev_high != null) addLine(s.prev_high, '#f59e0b', 'PDH');
      if (s.prev_low != null) addLine(s.prev_low, '#f59e0b', 'PDL');
      for (const p of s.resistance) addLine(p, cssVar('--down'), 'R');
      for (const p of s.support) addLine(p, cssVar('--up'), 'S');
    }

    // SMC mode: BOS/CHoCH as arrow markers; zones/liquidity/range as price
    // lines (top+bottom per zone) rather than shaded boxes — a lighter-weight
    // stand-in for the full drawing-layer box rendering the old Electron app
    // had, since lightweight-charts has no built-in box primitive.
    if (mode === 'smc' && data.smc) {
      const { zones, liquidity, equal, range } = data.smc;
      const active = zones.filter((z) => !z.mitigated).slice(-6);
      for (const z of active) {
        const color = z.side === 'bull' ? cssVar('--up') : cssVar('--down');
        addLine(z.top, color, z.label);
        addLine(z.bottom, color, z.label);
      }
      for (const l of liquidity.slice(-6)) {
        addLine(l.price, l.side === 'BSL' ? cssVar('--down') : cssVar('--up'), l.side);
      }
      for (const e of equal.slice(-4)) {
        addLine(e.price, '#a855f7', e.side);
      }
      if (range) {
        addLine(range.top, '#a855f7', 'Premium');
        addLine(range.bottom, '#a855f7', 'Discount');
        addLine(range.equilibrium, cssVar('--muted'), 'EQ');
      }

      const markers: SeriesMarker<Time>[] = data.smc.structure
        .filter((e) => e.index < rows.length)
        .map((e) => ({
          time: barTime(rows[e.index].time) as unknown as Time,
          position: e.side === 'bull' ? 'belowBar' : 'aboveBar',
          color: e.side === 'bull' ? cssVar('--up') : cssVar('--down'),
          shape: e.side === 'bull' ? 'arrowUp' : 'arrowDown',
          text: e.type,
        }));
      markersRef.current?.setMarkers(markers);
    } else {
      markersRef.current?.setMarkers([]);
    }

    chartRef.current.timeScale().fitContent();
  }, [data, mode]);

  // ---- live tick updates ----
  useEffect(() => {
    if (!tick || !priceRef.current || !data?.candles.length) return;
    const last = data.candles[data.candles.length - 1];
    if (String(tick.token) !== String(data.token)) return;
    priceRef.current.update({
      time: barTime(last.time) as never,
      open: last.open,
      high: Math.max(last.high, tick.ltp),
      low: Math.min(last.low, tick.ltp),
      close: tick.ltp,
    });
  }, [tick, data]);

  const s = data?.summary;

  return (
    <section className="panel chart-col">
      <div className="tv-toolbar">
        <button className="tv-btn strong">{active ? active.sym : '—'}</button>
        <span className="tv-sep" />
        <select className="tv-select" value={mode} onChange={(e) => setMode(e.target.value as ChartMode)}>
          {MODES.map((m) => (
            <option key={m.id} value={m.id} disabled={m.disabled}>
              {m.label}
              {m.disabled ? ' (no data source yet)' : ''}
            </option>
          ))}
        </select>
        <span className="tv-sep" />
        <div className="tv-intervals">
          {INTERVALS.map((iv) => (
            <button
              key={iv.id}
              className={`tv-int${interval === iv.id ? ' on' : ''}`}
              onClick={() => setInterval_(iv.id)}
            >
              {iv.label}
            </button>
          ))}
        </div>
        <span className="tv-sep" />
        <div className="tv-intervals">
          {RANGES.map((r) => (
            <button
              key={r.days}
              className={`tv-int${days === r.days ? ' on' : ''}`}
              onClick={() => setDays(r.days)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <span className="tv-spacer" />
        <span className="muted">{data ? `${data.session}${data.market_open ? '' : ' · market closed'}` : ''}</span>
        <button className="tv-btn" onClick={() => refetch()}>
          Refresh
        </button>
      </div>
      <div className="tv-body">
        <DrawingRail tool={drawing.tool} setTool={drawing.setTool} clearAll={drawing.clearAll} />
        <div className="tv-panes" style={{ flex: 1 }}>
          <div className="tv-pane" id="price-pane" ref={setPaneEl}>
            <div ref={containerRef} className="chart" />
            <DrawingCanvas {...drawing} />
          </div>
        </div>
      </div>
      <div className="levels">
        {s && (
          <>
            <span>
              <b className="muted">Support</b> {s.support.map((x) => fmt(x)).join(' · ') || '—'}
            </span>
            <span>
              <b className="muted">Resistance</b> {s.resistance.map((x) => fmt(x)).join(' · ') || '—'}
            </span>
          </>
        )}
        {mode === 'smc' && data?.smc && (
          <span>
            <b className="muted">SMC</b>{' '}
            {Object.entries(data.smc.counts)
              .map(([k, v]) => `${k} ${v}`)
              .join(' · ')}
          </span>
        )}
      </div>
    </section>
  );
}

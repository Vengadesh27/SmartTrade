import { useEffect, useRef, useState } from 'react';
import {
  createChart,
  createSeriesMarkers,
  AreaSeries,
  BarSeries,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
} from 'lightweight-charts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { barTime, INTERVALS, RANGES, type Candle, type CandlesResponse } from '../lib/candles';
import {
  CHART_TYPES,
  OSCILLATORS,
  OVERLAYS,
  heikinAshi,
  loadOverlayPrefs,
  saveOverlayPrefs,
  valueAt,
  type ChartType,
} from '../lib/indicators';
import { buildSnapshot, setChartSnapshot } from '../lib/chartContext';
import {
  DEFAULT_SMC_LAYERS,
  SMC_LAYER_LABELS,
  useSmcOverlay,
  type SmcLayers,
} from '../lib/useSmcOverlay';
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

type AnyPriceSeries = ISeriesApi<'Candlestick' | 'Bar' | 'Line' | 'Area'>;

export function Chart({
  active,
  tick,
  defaultInterval = 'FIFTEEN_MINUTE',
}: {
  active: Instrument | null;
  tick: Quote | null;
  defaultInterval?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceRef = useRef<AnyPriceSeries | null>(null);
  /** overlay column -> line series on the price pane */
  const overlayRef = useRef<Record<string, ISeriesApi<'Line'>>>({});
  /** series currently living in the lower oscillator pane */
  const oscRef = useRef<ISeriesApi<'Line' | 'Histogram'>[]>([]);
  const oscLinesRef = useRef<IPriceLine[]>([]);
  const levelLinesRef = useRef<IPriceLine[]>([]);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  const [interval, setInterval_] = useState(defaultInterval);
  const [days, setDays] = useState(1);
  const [mode, setMode] = useState<ChartMode>('indicators');
  const [chartType, setChartType] = useState<ChartType>(
    () => (localStorage.getItem('chartType') as ChartType) || 'candles'
  );
  const [osc, setOsc] = useState(() => localStorage.getItem('osc') || 'rsi');
  const [overlayOn, setOverlayOn] = useState<Record<string, boolean>>(loadOverlayPrefs);
  const [showPanel, setShowPanel] = useState(false);
  const [smcLayers, setSmcLayers] = useState<SmcLayers>(() => {
    try {
      return { ...DEFAULT_SMC_LAYERS, ...(JSON.parse(localStorage.getItem('smcLayers') || 'null') || {}) };
    } catch {
      return DEFAULT_SMC_LAYERS;
    }
  });
  const [logScale, setLogScale] = useState(false);
  const [hover, setHover] = useState<Candle | null>(null);

  const [chartApi, setChartApi] = useState<IChartApi | null>(null);
  const [priceApi, setPriceApi] = useState<AnyPriceSeries | null>(null);
  const [paneEl, setPaneEl] = useState<HTMLDivElement | null>(null);
  const drawing = useDrawingTools(
    chartApi,
    priceApi as ISeriesApi<'Candlestick'> | null,
    paneEl,
    active ? { exch: active.exch, sym: active.sym } : null
  );

  const { data, refetch, error, isFetching } = useQuery({
    queryKey: ['candles', active ? keyOf(active) : null, interval, days],
    queryFn: () =>
      api.get<CandlesResponse>(
        `/candles?symbol=${encodeURIComponent(active!.sym)}&exchange=${active!.exch}&interval=${interval}&days=${days}`
      ),
    enabled: !!active,
    refetchInterval: 60_000,
    // Switching timeframes used to refetch every time, even straight back to
    // one just viewed. Treating data as fresh for 30s makes those instant,
    // and keeping the previous result on screen avoids a blank chart while a
    // genuinely new timeframe loads.
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    // The global default is retry:false, but AngelOne throttles in bursts —
    // without a retry one blip leaves the chart empty until a manual reload.
    retry: 3,
    retryDelay: (attempt) => Math.min(2000 * 2 ** attempt, 15_000),
  });

  const smcCanvasRef = useSmcOverlay(chartApi, priceApi, paneEl, data, smcLayers, mode === 'smc');

  // ---- chart + overlay series (once) ----
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: cssVar('--panel') }, textColor: cssVar('--muted'), fontSize: 11 },
      grid: { vertLines: { color: cssVar('--border') }, horzLines: { color: cssVar('--border') } },
      rightPriceScale: { borderColor: cssVar('--border') },
      timeScale: { borderColor: cssVar('--border'), timeVisible: true, secondsVisible: false, rightOffset: 6 },
      crosshair: { mode: 1 },
    });

    for (const ov of OVERLAYS) {
      for (const col of ov.cols) {
        overlayRef.current[col] = chart.addSeries(LineSeries, {
          color: ov.color,
          lineWidth: 1,
          lineStyle: ov.dashed?.includes(col) ? LineStyle.Dashed : LineStyle.Solid,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
      }
    }

    chartRef.current = chart;
    setChartApi(chart);

    const ro = new ResizeObserver(() => chart.applyOptions({}));
    ro.observe(containerRef.current);

    const retheme = () => {
      chart.applyOptions({
        layout: { background: { color: cssVar('--panel') }, textColor: cssVar('--muted') },
        grid: { vertLines: { color: cssVar('--border') }, horzLines: { color: cssVar('--border') } },
        rightPriceScale: { borderColor: cssVar('--border') },
        timeScale: { borderColor: cssVar('--border') },
      });
      priceRef.current?.applyOptions(priceColors(chartType));
    };
    window.addEventListener('themechange', retheme);

    return () => {
      ro.disconnect();
      window.removeEventListener('themechange', retheme);
      // chart.remove() destroys every series with it, so drop all handles.
      // Anything left pointing at the old chart would be used against the new
      // one on React's StrictMode remount, which throws inside the library.
      chart.remove();
      chartRef.current = null;
      priceRef.current = null;
      markersRef.current = null;
      overlayRef.current = {};
      oscRef.current = [];
      oscLinesRef.current = [];
      levelLinesRef.current = [];
      setChartApi(null);
      setPriceApi(null);
    };
  }, []);

  // ---- price series, rebuilt when the chart type changes ----
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (priceRef.current) chart.removeSeries(priceRef.current);
    // Price lines belonged to the series just removed; the next paint must not
    // try to remove them from the replacement series.
    levelLinesRef.current = [];

    let series: AnyPriceSeries;
    if (chartType === 'line') series = chart.addSeries(LineSeries, { color: cssVar('--accent'), lineWidth: 2 });
    else if (chartType === 'area')
      series = chart.addSeries(AreaSeries, { lineColor: cssVar('--accent'), lineWidth: 2 });
    else if (chartType === 'bars') series = chart.addSeries(BarSeries, priceColors(chartType));
    else series = chart.addSeries(CandlestickSeries, priceColors(chartType));

    priceRef.current = series;
    markersRef.current = createSeriesMarkers(series, []);
    setPriceApi(series);
    localStorage.setItem('chartType', chartType);
  }, [chartType]);

  // ---- oscillator pane, rebuilt when the study changes ----
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const s of oscRef.current) chart.removeSeries(s);
    oscRef.current = [];
    oscLinesRef.current = [];

    const def = OSCILLATORS.find((o) => o.id === osc);
    localStorage.setItem('osc', osc);
    if (!def || !def.series.length) {
      if (chart.panes().length > 1) chart.removePane(1);
      return;
    }

    // paneIndex 1 creates the lower pane on first use (lightweight-charts v5)
    for (const sd of def.series) {
      const s =
        sd.type === 'hist'
          ? chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, 1)
          : chart.addSeries(
              LineSeries,
              {
                color: sd.color,
                lineWidth: 1,
                priceLineVisible: false,
                lastValueVisible: false,
                crosshairMarkerVisible: false,
              },
              1
            );
      oscRef.current.push(s as ISeriesApi<'Line' | 'Histogram'>);
    }

    const first = oscRef.current[0];
    for (const level of def.bands || []) {
      oscLinesRef.current.push(
        first.createPriceLine({
          price: level,
          color: cssVar('--border-strong'),
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: false,
          title: '',
        })
      );
    }
    if (def.range) {
      first.applyOptions({
        autoscaleInfoProvider: () => ({ priceRange: { minValue: def.range![0], maxValue: def.range![1] } }),
      });
    }
    chart.panes()[1]?.setHeight(120);
  }, [osc]);

  // ---- paint everything on new data / mode / type / toggle changes ----
  useEffect(() => {
    const chart = chartRef.current;
    const price = priceRef.current;
    if (!data || !price || !chart) return;
    const rows = data.candles;

    if (chartType === 'line' || chartType === 'area') {
      price.setData(rows.map((c) => ({ time: barTime(c.time) as never, value: c.close })));
    } else {
      const src = chartType === 'heikin' ? heikinAshi(rows) : rows;
      price.setData(
        src.map((c) => ({
          time: barTime(c.time) as never,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }))
      );
    }

    // Overlays follow their own toggles so any study can sit alongside the
    // Price Action / SMC annotation layers.
    for (const ov of OVERLAYS) {
      for (const col of ov.cols) {
        const s = overlayRef.current[col];
        if (!s) continue;
        const on = !!overlayOn[ov.id];
        s.applyOptions({ visible: on });
        s.setData(
          on
            ? rows
                .filter((c) => valueAt(c, col) !== null)
                .map((c) => ({ time: barTime(c.time) as never, value: valueAt(c, col)! }))
            : []
        );
      }
    }

    const def = OSCILLATORS.find((o) => o.id === osc);
    if (def) {
      def.series.forEach((sd, i) => {
        const s = oscRef.current[i];
        if (!s) return;
        const pts = rows
          .filter((c) => valueAt(c, sd.col) !== null)
          .map((c) => {
            const v = valueAt(c, sd.col)!;
            return sd.type === 'hist'
              ? {
                  time: barTime(c.time) as never,
                  value: v,
                  color:
                    sd.col === 'volume'
                      ? c.close >= c.open
                        ? 'rgba(14,159,110,.45)'
                        : 'rgba(224,36,36,.45)'
                      : v >= 0
                        ? 'rgba(14,159,110,.45)'
                        : 'rgba(224,36,36,.45)',
                }
              : { time: barTime(c.time) as never, value: v };
          });
        s.setData(pts);
      });
    }

    for (const line of levelLinesRef.current) price.removePriceLine(line);
    levelLinesRef.current = [];
    const addLine = (value: number, color: string, title: string) =>
      levelLinesRef.current.push(
        price.createPriceLine({ price: value, color, lineWidth: 1, lineStyle: LineStyle.Dotted, title })
      );
    const s = data.summary;
    if (s) {
      if (s.prev_high != null) addLine(s.prev_high, '#f59e0b', 'PDH');
      if (s.prev_low != null) addLine(s.prev_low, '#f59e0b', 'PDL');

      // Number the levels outward from price, so R1/S1 are the ones price has
      // to deal with first. Levels on the wrong side of price are ranked after
      // the correctly-sided ones rather than dropped.
      const last = rows[rows.length - 1].close;
      const rank = (levels: number[], above: boolean) =>
        [...new Set(levels)]
          .sort((a, b) => {
            const aSide = above ? a >= last : a <= last;
            const bSide = above ? b >= last : b <= last;
            if (aSide !== bSide) return aSide ? -1 : 1;
            return Math.abs(a - last) - Math.abs(b - last);
          })
          .slice(0, 3);

      rank(s.resistance, true).forEach((p, i) => addLine(p, cssVar('--down'), `R${i + 1}`));
      rank(s.support, false).forEach((p, i) => addLine(p, cssVar('--up'), `S${i + 1}`));
    }

    // SMC zones/structure/sweeps are painted on the canvas overlay (boxes and
    // labels), not as price lines — see useSmcOverlay.
    markersRef.current?.setMarkers([]);

    chart.timeScale().fitContent();
  }, [data, mode, chartType, osc, overlayOn]);

  // ---- publish what's on screen for the assistant ----
  useEffect(() => {
    if (!data) return setChartSnapshot(null);
    setChartSnapshot(
      buildSnapshot({ data, interval, days, chartType, osc, overlayOn, ltp: tick?.ltp ?? null })
    );
  }, [data, interval, days, chartType, osc, overlayOn, tick]);

  // ---- crosshair legend ----
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !data) return;
    const byTime = new Map(data.candles.map((c) => [barTime(c.time), c]));
    const handler = (param: { time?: Time }) => {
      setHover(param.time ? byTime.get(param.time as unknown as number) || null : null);
    };
    chart.subscribeCrosshairMove(handler);
    return () => chart.unsubscribeCrosshairMove(handler);
  }, [data]);

  useEffect(() => {
    chartRef.current?.priceScale('right').applyOptions({ mode: logScale ? 1 : 0 });
  }, [logScale]);

  // ---- live tick updates ----
  useEffect(() => {
    if (!tick || !priceRef.current || !data?.candles.length) return;
    if (String(tick.token) !== String(data.token)) return;
    const last = data.candles[data.candles.length - 1];
    const t = barTime(last.time) as never;
    if (chartType === 'line' || chartType === 'area') {
      priceRef.current.update({ time: t, value: tick.ltp });
    } else if (chartType !== 'heikin') {
      priceRef.current.update({
        time: t,
        open: last.open,
        high: Math.max(last.high, tick.ltp),
        low: Math.min(last.low, tick.ltp),
        close: tick.ltp,
      });
    }
  }, [tick, data, chartType]);

  const summary = data?.summary;
  const bar = hover || data?.candles[data.candles.length - 1] || null;
  const activeOverlays = OVERLAYS.filter((o) => overlayOn[o.id]);

  function toggleOverlay(id: string) {
    setOverlayOn((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      saveOverlayPrefs(next);
      return next;
    });
  }

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
              className={`tv-int${interval === iv.id ? ' on' : ''}${
                isFetching && interval === iv.id ? ' loading' : ''
              }`}
              onClick={() => setInterval_(iv.id)}
            >
              {iv.label}
            </button>
          ))}
        </div>
        <span className="tv-sep" />
        <div className="tv-intervals">
          {RANGES.map((r) => (
            <button key={r.days} className={`tv-int${days === r.days ? ' on' : ''}`} onClick={() => setDays(r.days)}>
              {r.label}
            </button>
          ))}
        </div>
        <span className="tv-sep" />
        <select
          className="tv-select"
          value={chartType}
          onChange={(e) => setChartType(e.target.value as ChartType)}
        >
          {CHART_TYPES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <select className="tv-select" value={osc} onChange={(e) => setOsc(e.target.value)}>
          {OSCILLATORS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <button className="tv-btn" onClick={() => setShowPanel((v) => !v)}>
          Indicators
        </button>
        <span className="tv-sep" />
        <button className={`tv-btn${logScale ? ' on' : ''}`} onClick={() => setLogScale((v) => !v)}>
          Log
        </button>
        <button className="tv-btn" onClick={() => chartRef.current?.timeScale().fitContent()}>
          Fit
        </button>
        <span className="tv-spacer" />
        {data?.stale && (
          <span className="tv-stale" title={data.stale_reason}>
            stale — broker throttled
          </span>
        )}
        <span className="muted">{data ? `${data.session}${data.market_open ? '' : ' · market closed'}` : ''}</span>
        <button className="tv-btn" onClick={() => refetch()}>
          Refresh
        </button>

        {showPanel && (
          <div className="ind-panel">
            <div className="ind-group">Overlays</div>
            {OVERLAYS.map((o) => (
              <label key={o.id} className="ind-row">
                <input type="checkbox" checked={!!overlayOn[o.id]} onChange={() => toggleOverlay(o.id)} />
                <span>{o.label}</span>
              </label>
            ))}
            <div className="ind-group">Lower pane</div>
            {OSCILLATORS.map((o) => (
              <label key={o.id} className="ind-row">
                <input type="radio" name="osc" checked={osc === o.id} onChange={() => setOsc(o.id)} />
                <span>{o.label}</span>
              </label>
            ))}
            <div className="ind-group">
              Smart money {mode !== 'smc' && <span className="muted">— switch mode to show</span>}
            </div>
            {SMC_LAYER_LABELS.map((s) => (
              <label key={s.id} className="ind-row">
                <input
                  type="checkbox"
                  checked={smcLayers[s.id]}
                  onChange={() =>
                    setSmcLayers((prev) => {
                      const next = { ...prev, [s.id]: !prev[s.id] };
                      localStorage.setItem('smcLayers', JSON.stringify(next));
                      return next;
                    })
                  }
                />
                <span>{s.label}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="tv-body">
        <DrawingRail tool={drawing.tool} setTool={drawing.setTool} clearAll={drawing.clearAll} />
        <div className="tv-panes" style={{ flex: 1 }}>
          <div className="tv-pane" id="price-pane" ref={setPaneEl}>
            <div ref={containerRef} className="chart" />
            {/* SMC annotations sit under the user's own drawings */}
            <canvas ref={smcCanvasRef} className="smc-layer" />
            <DrawingCanvas {...drawing} />
            {/* An empty chart is ambiguous — say why there is nothing to draw.
                AngelOne rate-limits candles, and that used to fail silently. */}
            {(error || (data && !data.candles.length)) && (
              <div className="chart-status">
                <b>{error ? 'Could not load candles' : 'No candles for this session yet'}</b>
                {error && <span>{error instanceof Error ? error.message : String(error)}</span>}
                <button className="tv-btn" onClick={() => refetch()} disabled={isFetching}>
                  {isFetching ? 'Retrying…' : 'Retry'}
                </button>
              </div>
            )}
            {bar && (
              <div className="tv-legend">
                <div className="lg-title">
                  {data?.symbol}
                  <span className="lg-sub">
                    {data?.exchange} · {INTERVALS.find((i) => i.id === interval)?.label}
                  </span>
                </div>
                <div className="lg-ohlc">
                  <span>
                    O<b>{fmt(bar.open)}</b>
                  </span>
                  <span>
                    H<b>{fmt(bar.high)}</b>
                  </span>
                  <span>
                    L<b>{fmt(bar.low)}</b>
                  </span>
                  <span>
                    C<b>{fmt(bar.close)}</b>
                  </span>
                  <span className={bar.close >= bar.open ? 'up' : 'down'}>
                    {bar.close - bar.open >= 0 ? '+' : ''}
                    {fmt(bar.close - bar.open)}
                  </span>
                </div>
                {activeOverlays.length > 0 && (
                  <div className="lg-ind">
                    {activeOverlays
                      .filter((o) => valueAt(bar, o.cols[0]) !== null)
                      .map((o) => (
                        <span key={o.id}>
                          <i style={{ background: o.color }} />
                          {o.label} <b>{fmt(valueAt(bar, o.cols[0])!)}</b>
                        </span>
                      ))}
                  </div>
                )}
                {osc !== 'none' && (
                  <div className="lg-read">
                    {OSCILLATORS.find((o) => o.id === osc)
                      ?.series.filter((sd) => valueAt(bar, sd.col) !== null)
                      .map((sd) => `${sd.col} ${fmt(valueAt(bar, sd.col)!)}`)
                      .join(' · ')}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="levels">
        {summary && (
          <>
            <span>
              <b className="muted">Support</b> {summary.support.map((x) => fmt(x)).join(' · ') || '—'}
            </span>
            <span>
              <b className="muted">Resistance</b> {summary.resistance.map((x) => fmt(x)).join(' · ') || '—'}
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

function priceColors(type: ChartType) {
  const up = cssVar('--up');
  const down = cssVar('--down');
  return {
    upColor: type === 'hollow' ? 'rgba(0,0,0,0)' : up,
    downColor: down,
    borderUpColor: up,
    borderDownColor: down,
    wickUpColor: up,
    wickDownColor: down,
  };
}

import { useEffect, useRef } from 'react';
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts';
import { barTime, type CandlesResponse } from './candles';

export type SmcLayers = {
  fvg: boolean;
  ob: boolean;
  structure: boolean;
  sweeps: boolean;
  liquidity: boolean;
  equal: boolean;
  range: boolean;
  hideMitigated: boolean;
};

export const SMC_LAYER_LABELS: { id: keyof SmcLayers; label: string }[] = [
  { id: 'fvg', label: 'Fair value gaps' },
  { id: 'ob', label: 'Order & breaker blocks' },
  { id: 'structure', label: 'BOS / CHoCH' },
  { id: 'sweeps', label: 'Liquidity sweeps' },
  { id: 'liquidity', label: 'Resting liquidity (BSL/SSL)' },
  { id: 'equal', label: 'Equal highs / lows' },
  { id: 'range', label: 'Premium / discount' },
  { id: 'hideMitigated', label: 'Hide mitigated zones' },
];

export const DEFAULT_SMC_LAYERS: SmcLayers = {
  fvg: true,
  ob: true,
  structure: true,
  sweeps: true,
  liquidity: false,
  equal: false,
  range: false,
  hideMitigated: true,
};

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * Paints smart-money annotations onto their own canvas above the chart.
 *
 * lightweight-charts has no box primitive, so zones are drawn here rather than
 * approximated with pairs of price lines. Everything is positioned from bar
 * index + price, so it tracks pan and zoom.
 */
export function useSmcOverlay(
  chart: IChartApi | null,
  series: ISeriesApi<'Candlestick' | 'Bar' | 'Line' | 'Area'> | null,
  container: HTMLDivElement | null,
  data: CandlesResponse | undefined,
  layers: SmcLayers,
  active: boolean
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef({ data, layers, active });
  stateRef.current = { data, layers, active };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !container || !chart || !series) return;

    const draw = () => {
      const { data: d, layers: L, active: on } = stateRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!on || !d?.smc || !d.candles.length) return;

      const bars = d.candles;
      const ts = chart.timeScale();
      const xAt = (i: number) => {
        const bar = bars[Math.max(0, Math.min(bars.length - 1, i))];
        return bar ? ts.timeToCoordinate(barTime(bar.time) as unknown as Time) : null;
      };
      const yAt = (p: number) => series.priceToCoordinate(p);

      const up = css('--up') || '#0e9f6e';
      const down = css('--down') || '#e02424';
      const rgba = (side: string, a: number) =>
        side === 'bull' ? `rgba(14,159,110,${a})` : `rgba(224,36,36,${a})`;

      ctx.font = '10px Inter, system-ui, sans-serif';
      ctx.lineWidth = 1;

      const tag = (x: number, y: number, text: string, color: string) => {
        const tw = ctx.measureText(text).width + 7;
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.9;
        ctx.fillRect(x, y - 8, tw, 13);
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#fff';
        ctx.fillText(text, x + 3.5, y + 2);
      };

      // premium / discount split of the dealing range
      if (L.range && d.smc.range) {
        const r = d.smc.range;
        const x0 = xAt(r.start) ?? 0;
        const yTop = yAt(r.top);
        const yMid = yAt(r.equilibrium);
        const yBot = yAt(r.bottom);
        if (yTop != null && yMid != null && yBot != null) {
          ctx.fillStyle = 'rgba(224,36,36,0.05)';
          ctx.fillRect(x0, yTop, w - x0, yMid - yTop);
          ctx.fillStyle = 'rgba(14,159,110,0.05)';
          ctx.fillRect(x0, yMid, w - x0, yBot - yMid);
          ctx.strokeStyle = css('--muted') || '#888';
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.moveTo(x0, yMid);
          ctx.lineTo(w, yMid);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = css('--muted');
          ctx.fillText('equilibrium', x0 + 4, yMid - 3);
        }
      }

      // FVG / IFVG / order blocks / breakers as shaded boxes
      for (const z of d.smc.zones) {
        const isBlock = z.kind === 'ob' || z.kind === 'breaker';
        if (!L[isBlock ? 'ob' : 'fvg']) continue;
        if (L.hideMitigated && z.mitigated) continue;

        const x0 = xAt(z.start);
        const x1 = xAt(z.end);
        const yTop = yAt(z.top);
        const yBot = yAt(z.bottom);
        if (x0 == null || x1 == null || yTop == null || yBot == null) continue;

        const width = Math.max(x1 - x0, 2);
        const height = Math.max(yBot - yTop, 1);
        ctx.fillStyle = rgba(z.side, z.mitigated ? 0.05 : isBlock ? 0.15 : 0.1);
        ctx.fillRect(x0, yTop, width, height);
        ctx.strokeStyle = rgba(z.side, z.mitigated ? 0.3 : 0.8);
        ctx.setLineDash(z.kind === 'breaker' || z.kind === 'ifvg' ? [4, 3] : []);
        ctx.strokeRect(x0, yTop, width, height);
        ctx.setLineDash([]);
        ctx.fillStyle = z.side === 'bull' ? up : down;
        ctx.fillText(z.label, x0 + 3, yTop - 2);
      }

      // BOS / CHoCH — the broken level, from its swing to the breaking bar
      if (L.structure) {
        for (const e of d.smc.structure) {
          const x0 = xAt(e.from);
          const x1 = xAt(e.index);
          const y = yAt(e.price);
          if (x0 == null || x1 == null || y == null) continue;
          ctx.strokeStyle = e.side === 'bull' ? up : down;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(x0, y);
          ctx.lineTo(x1, y);
          ctx.stroke();
          ctx.setLineDash([]);
          tag(Math.max(x0, (x0 + x1) / 2 - 14), y, e.type, e.type === 'CHoCH' ? '#b45309' : ctx.strokeStyle);
        }
      }

      // liquidity sweeps — arrow at the wick that took the level
      if (L.sweeps) {
        for (const s of d.smc.sweeps || []) {
          const x = xAt(s.index);
          const y = yAt(s.price);
          if (x == null || y == null) continue;
          const bear = s.side === 'bear';
          const dir = bear ? -1 : 1;
          ctx.strokeStyle = bear ? down : up;
          ctx.fillStyle = ctx.strokeStyle;
          ctx.beginPath();
          ctx.moveTo(x, y - dir * 4);
          ctx.lineTo(x - 4, y - dir * 12);
          ctx.lineTo(x + 4, y - dir * 12);
          ctx.closePath();
          ctx.fill();
          tag(x - 14, y - dir * 18, 'SWEEP', ctx.strokeStyle);
        }
      }

      // untapped liquidity, extended to the right edge
      if (L.liquidity) {
        for (const l of d.smc.liquidity || []) {
          const x = xAt(l.index);
          const y = yAt(l.price);
          if (x == null || y == null) continue;
          ctx.strokeStyle = l.side === 'BSL' ? down : up;
          ctx.setLineDash([2, 3]);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(w, y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = ctx.strokeStyle;
          ctx.fillText(l.side, w - 24, y - 3);
        }
      }

      // equal highs / lows
      if (L.equal) {
        for (const e of d.smc.equal || []) {
          const x0 = xAt(e.start);
          const x1 = xAt(e.end);
          const y = yAt(e.price);
          if (x0 == null || x1 == null || y == null) continue;
          ctx.strokeStyle = '#a855f7';
          ctx.setLineDash([1, 2]);
          ctx.beginPath();
          ctx.moveTo(x0, y);
          ctx.lineTo(x1, y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = '#a855f7';
          ctx.fillText(e.side, x1 + 3, y + 3);
        }
      }
    };

    draw();
    const ts = chart.timeScale();
    ts.subscribeVisibleLogicalRangeChange(draw);
    const ro = new ResizeObserver(draw);
    ro.observe(container);
    window.addEventListener('themechange', draw);
    return () => {
      ts.unsubscribeVisibleLogicalRangeChange(draw);
      ro.disconnect();
      window.removeEventListener('themechange', draw);
    };
  }, [chart, series, container, data, layers, active]);

  return canvasRef;
}

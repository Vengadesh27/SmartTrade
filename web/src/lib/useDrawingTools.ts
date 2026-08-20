import { useEffect, useRef, useState } from 'react';
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts';
import { loadDrawings, saveDrawings, type DrawTool, type Point, type Shape } from './drawings';

export function useDrawingTools(
  chart: IChartApi | null,
  series: ISeriesApi<'Candlestick'> | null,
  container: HTMLDivElement | null,
  symbolKey: { exch: string; sym: string } | null
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<DrawTool>('none');
  const [shapes, setShapes] = useState<Shape[]>([]);
  const draftRef = useRef<{ start: Point } | null>(null);
  const shapesRef = useRef<Shape[]>([]);
  shapesRef.current = shapes;

  useEffect(() => {
    if (!symbolKey) return;
    setShapes(loadDrawings(symbolKey.exch, symbolKey.sym));
  }, [symbolKey?.exch, symbolKey?.sym]);

  useEffect(() => {
    if (!symbolKey) return;
    saveDrawings(symbolKey.exch, symbolKey.sym, shapes);
  }, [shapes, symbolKey?.exch, symbolKey?.sym]);

  const toPixel = (p: Point): [number, number] | null => {
    if (!chart || !series) return null;
    const x = chart.timeScale().timeToCoordinate(p.time as unknown as Time);
    const y = series.priceToCoordinate(p.price);
    if (x == null || y == null) return null;
    return [x, y];
  };
  const toPoint = (x: number, y: number): Point | null => {
    if (!chart || !series) return null;
    const time = chart.timeScale().coordinateToTime(x);
    const price = series.coordinateToPrice(y);
    if (time == null || price == null) return null;
    return { time: time as unknown as number, price };
  };

  const redraw = () => {
    const canvas = canvasRef.current;
    if (!canvas || !container) return;
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
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2962ff';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 1.5;
    ctx.font = '12px Inter, sans-serif';

    for (const s of shapesRef.current) {
      if (s.kind === 'hline') {
        const y = series?.priceToCoordinate(s.price);
        if (y == null) continue;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      } else if (s.kind === 'trendline') {
        const a = toPixel(s.a);
        const b = toPixel(s.b);
        if (!a || !b) continue;
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      } else if (s.kind === 'rect') {
        const a = toPixel(s.a);
        const b = toPixel(s.b);
        if (!a || !b) continue;
        ctx.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      } else if (s.kind === 'text') {
        const a = toPixel(s.a);
        if (!a) continue;
        ctx.fillText(s.text, a[0] + 4, a[1] - 4);
      }
    }
  };

  useEffect(() => {
    redraw();
  });

  useEffect(() => {
    if (!chart) return;
    const handler = () => redraw();
    chart.timeScale().subscribeVisibleLogicalRangeChange(handler);
    return () => chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart]);

  useEffect(() => {
    if (!container) return;
    const ro = new ResizeObserver(() => redraw());
    ro.observe(container);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container]);

  function addShape(s: Shape) {
    setShapes((prev) => [...prev, s]);
  }

  function handleMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    if (tool === 'none') return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const pt = toPoint(x, y);
    if (!pt) return;

    if (tool === 'hline') {
      addShape({ id: crypto.randomUUID(), kind: 'hline', price: pt.price });
      return;
    }
    if (tool === 'text') {
      const text = window.prompt('Label text');
      if (text) addShape({ id: crypto.randomUUID(), kind: 'text', a: pt, text });
      return;
    }
    draftRef.current = { start: pt };
  }

  function handleMouseUp(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!draftRef.current) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const end = toPoint(x, y);
    const start = draftRef.current.start;
    draftRef.current = null;
    if (!end) return;
    if (tool === 'trendline') addShape({ id: crypto.randomUUID(), kind: 'trendline', a: start, b: end });
    else if (tool === 'rect') addShape({ id: crypto.randomUUID(), kind: 'rect', a: start, b: end });
  }

  function clearAll() {
    if (window.confirm('Clear all drawings on this chart?')) setShapes([]);
  }

  return { canvasRef, tool, setTool, handleMouseDown, handleMouseUp, clearAll };
}

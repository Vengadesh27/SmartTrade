export type DrawTool = 'none' | 'trendline' | 'hline' | 'rect' | 'text';

export type Point = { time: number; price: number };

export type Shape =
  | { id: string; kind: 'trendline'; a: Point; b: Point }
  | { id: string; kind: 'hline'; price: number }
  | { id: string; kind: 'rect'; a: Point; b: Point }
  | { id: string; kind: 'text'; a: Point; text: string };

const KEY = (exch: string, sym: string) => `drawings:${exch}:${sym}`;

export function loadDrawings(exch: string, sym: string): Shape[] {
  try {
    const raw = localStorage.getItem(KEY(exch, sym));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveDrawings(exch: string, sym: string, shapes: Shape[]) {
  localStorage.setItem(KEY(exch, sym), JSON.stringify(shapes));
}

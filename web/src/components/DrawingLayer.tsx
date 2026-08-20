import type { DrawTool } from '../lib/drawings';
import type { useDrawingTools } from '../lib/useDrawingTools';

const TOOLS: { id: DrawTool; title: string; icon: string }[] = [
  { id: 'none', title: 'Cursor', icon: '↖' },
  { id: 'trendline', title: 'Trend line', icon: '╱' },
  { id: 'hline', title: 'Horizontal line', icon: '—' },
  { id: 'rect', title: 'Rectangle', icon: '▭' },
  { id: 'text', title: 'Text', icon: 'T' },
];

type Tools = ReturnType<typeof useDrawingTools>;

export function DrawingRail({ tool, setTool, clearAll }: Pick<Tools, 'tool' | 'setTool' | 'clearAll'>) {
  return (
    <div className="tv-rail">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          className={`rail-btn${tool === t.id ? ' on' : ''}`}
          title={t.title}
          onClick={() => setTool(t.id)}
        >
          {t.icon}
        </button>
      ))}
      <button className="rail-btn" title="Clear all" onClick={clearAll}>
        🗑
      </button>
    </div>
  );
}

export function DrawingCanvas({ canvasRef, tool, handleMouseDown, handleMouseUp }: Tools) {
  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 5,
        pointerEvents: tool === 'none' ? 'none' : 'auto',
        cursor: tool === 'none' ? 'default' : 'crosshair',
      }}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
    />
  );
}

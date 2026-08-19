# AngelOne Desk

Electron trading desk on top of the existing `angelone_agent` Python code.

## Run

```bash
cd desktop && npm start
```

Electron starts the Python sidecar itself — no separate server to launch. Your
`.env` at the project root supplies the AngelOne credentials.

First-time setup:

```bash
.venv/bin/pip install -r requirements.txt && cd desktop && npm install
```

## How it fits together

```
Electron main  ──spawn──►  Python sidecar (FastAPI, 127.0.0.1, random port)
     │                          │
     │ IPC (token stays here)   ├── SmartConnect REST  → quotes, candles, orders, books
     │                          └── SmartWebSocketV2   → live ticks
     ▼
  Renderer (no node, no token)
```

- The sidecar binds to loopback on a random port and rejects any request without
  the token Electron generates at launch, so nothing else on the machine can
  drive your trading session.
- The renderer never sees the token or your credentials. It talks to the main
  process over IPC, which proxies to the sidecar.
- Live prices and bot events are **pushed** over a WebSocket, not polled. REST
  calls remain as slow backstops in case the socket drops.

## Files

| Path | Purpose |
| --- | --- |
| `main.js` | Spawns/supervises the sidecar, proxies IPC, relays the feed, native confirm dialogs |
| `preload.js` | The only bridge exposed to the renderer (`window.api`) |
| `renderer/app.js` | Data, watchlist, orders, account, bot wiring |
| `renderer/chart.js` | Chart surface — toolbar, panes, legend, indicator manager |
| `renderer/drawings.js` | Drawing tools and the SMC painting layer |
| `../angelone_agent/smc.py` | Smart money concepts detection |
| `../angelone_agent/sidecar.py` | HTTP + WebSocket API |
| `../angelone_agent/feed.py` | SmartWebSocketV2 wrapper and fan-out bus |
| `../angelone_agent/bot.py` | Strategy runner (PAPER/LIVE) |
| `../angelone_agent/markets.py` | Per-exchange sessions, expiry parsing |
| `../angelone_agent/analysis.py` | Indicator maths |

## Instruments

Type a short name and the sidecar resolves what you meant:

- `RELIANCE` → `RELIANCE-EQ` (cash)
- `NIFTY` → the tradable index row `Nifty 50` / token `99926000`. A bare `NIFTY`
  row also exists (token `26000`) but carries no OHLC or candle history, so it is
  deliberately outranked.
- `CRUDEOILM` on MCX → the **front-month** contract, e.g. `CRUDEOILM19AUG26FUT`.
  Expired contracts are skipped, so this keeps working after a roll.

Sessions follow the exchange: NSE 09:15–15:30, MCX 09:00–23:30. Charts and the
bot both use the correct window, and the bot's square-off default follows suit.

## Chart

TradingView's own `lightweight-charts` does the rendering; the surrounding UX is
built here. (TradingView's full *Advanced Charts* library is licence-gated —
you have to apply to them for repo access — so it is not used.)

- **Types**: candles, hollow candles, Heikin Ashi, bars, line, area
- **Intervals**: 1m / 3m / 5m / 15m / 30m / 1h, plus log scale and fit
- **Legend** (top-left, follows the crosshair): symbol, OHLC, every active
  indicator's value at that bar, the trend read, and SMC counts
- **Drawing tools** (left rail): trend line, ray, extended line, horizontal and
  vertical line, rectangle, Fibonacci retracement, brush, text, and a measure
  tool showing Δprice, Δ% and bar count. Click to select, drag to move, drag a
  handle to reshape, `Delete` to remove, `Esc` to cancel. The magnet snaps to
  the nearest OHLC. Drawings are anchored to bar index and price, so they hold
  through pan, zoom and new candles, and are saved per symbol.

## Indicators

Overlays: SMA 20/50, EMA 9/21, Bollinger (20, 2), VWAP, Supertrend (10, 3).
Lower pane: RSI 14, MACD 12/26/9, Stochastic 14/3, ATR 14, Volume.

VWAP needs traded volume, so it stays blank on indices — that is correct, not a bug.

## Smart money concepts

Toggled from the same Indicators panel; all off by default because they stack
up quickly. Everything is computed from the session's candles in `smc.py`.

| Layer | What it draws |
| --- | --- |
| Fair value gaps | Three-bar imbalances; a gap that price closes through and then trades away from is re-labelled **IFVG** (inversion) |
| Order blocks | Last opposing candle before a displacement move; once price breaks it, it becomes a **Breaker** |
| Structure | **BOS** continues the trend, **CHoCH** is the first break against it |
| Swings | HH / HL / LH / LL on each confirmed pivot |
| Resting liquidity | Untapped swing highs and lows as **BSL** / **SSL** |
| Equal highs / lows | **EQH** / **EQL** pairs within a fraction of ATR |
| Premium / discount | Current dealing range split at equilibrium |
| Liquidity sweeps | Arrow markers where a wick took a prior swing but closed back inside |

"Hide mitigated zones" keeps only levels price has not yet resolved.

## Orders

Every order opens a native confirm dialog showing side, quantity, type, LTP and
approximate value before anything is sent. Nothing is placed automatically from
the order ticket.

## Bot

Strategies: SMA crossover, RSI mean reversion, opening-range breakout,
Supertrend, MACD crossover, VWAP trend.

- **PAPER** (default) simulates fills locally. It only reads candles; your
  account is untouched.
- **LIVE** sends real market orders and requires a typed confirmation — the
  sidecar rejects a LIVE start that does not carry `confirm_live`.

Risk caps apply in both modes: max trades, max daily loss, and a square-off time
that flattens any open position and stops the run. The bot never starts on its own.

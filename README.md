# SmartTrade

An intraday trading desk for [AngelOne SmartAPI](https://smartapi.angelone.in/) —
a React web frontend over a Python backend, built for NSE and MCX.

## What it does

- **Live data** — quotes and ticks stream over AngelOne's SmartWebSocketV2, not polling
- **Chart** — candles, session support/resistance, previous-day high/low, with a
  mode selector (Indicators, Price Action, Smart Money Concepts) and a basic
  drawing toolset (trend line, horizontal line, rectangle, text)
- **Smart money concepts** — fair value gaps, order blocks, breakers, BOS/CHoCH,
  liquidity pools, equal highs/lows, premium/discount — computed server-side,
  shown as price-line annotations and structure markers on the chart
- **Trading** — order ticket with a confirmation modal on every order, plus
  positions, holdings and an order book
- **Strategy bot** — six strategies, paper by default, with risk caps

Instruments resolve by short name: `NIFTY` finds the tradable index, `CRUDEOILM`
finds the current front-month contract and rolls itself as expiries pass.
Session hours follow the exchange — NSE 09:15–15:30, MCX 09:00–23:30.

## Setup

Requires Python 3.10+ and Node 18+.

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cd web && npm install
```

Copy `.env.example` to `.env` and fill in your AngelOne API credentials:

```
ANGELONE_API_KEY=...
ANGELONE_CLIENT_ID=...
ANGELONE_MPIN=...
ANGELONE_TOTP_SECRET=...
```

Set your web app login (separate from your broker credentials):

```bash
python scripts/set_password.py
```

This writes `APP_USERNAME`, `APP_PASSWORD_HASH` and `SESSION_SECRET` into `.env`.
`.env` is gitignored — keep it that way.

## Run

Two processes, both local for now:

```bash
# backend — binds to 127.0.0.1:8787
python -m angelone_agent.sidecar

# frontend — Vite dev server on :5173
cd web && npm run dev
```

Open `http://localhost:5173` and sign in with the username/password you set above.

## Layout

```
angelone_agent/     Python — broker client, indicators, SMC, strategy bot, HTTP/WS API
  client.py           SmartConnect wrapper
  auth.py              Password hashing + signed session cookies for the web login
  sidecar.py           FastAPI HTTP + WebSocket server
  feed.py              SmartWebSocketV2 live feed and fan-out bus
  analysis.py          Indicator maths
  smc.py                Smart money concepts
  markets.py           Exchange sessions and expiries
  bot.py                Strategy runner
web/                React + Vite frontend
  src/lib/              API client, live-feed hook, formatting, chart/drawing helpers
  src/components/       Login, TickerStrip, Chart, RightPanel, BotPanel, SettingsModal
scripts/            Standalone CLI scripts (analysis, connection check, set_password)
```

Auth is a signed session cookie (see `auth.py`), issued by `POST /auth/login` and
checked on every route and the WebSocket handshake. Broker credentials are
edited from the Settings modal, which writes to `.env` server-side — the browser
never holds them directly.

## Safety

- Orders are never placed automatically from the ticket; each one opens a
  confirmation modal first.
- The bot defaults to **PAPER** mode, which simulates fills locally and only
  reads candles. **LIVE** mode is refused by the backend unless the request
  carries an explicit confirmation flag, which the UI sets only after a typed
  confirmation.
- Risk caps — max trades, max daily loss, and a square-off time that flattens
  any open position — apply in both modes.

This is personal trading software, not investment advice. Use at your own risk.

## Hosting

Not deployed anywhere yet — both processes are meant to run locally for now.
The backend needs a host that supports long-running processes and WebSockets
(a small VPS, Railway, Fly.io — not Vercel/Netlify-style serverless, since it
holds a persistent broker session and feed connection). The frontend is a
static Vite build and can go anywhere static, including Vercel/Netlify, once
`VITE_API_BASE` points at wherever the backend ends up.

## Licence

Unlicensed / all rights reserved.

'use strict';

/** Data, account and bot wiring. The chart surface lives in chart.js. */

const DEFAULT_WATCHLIST = [
  { sym: 'NIFTY', exch: 'NSE' },
  { sym: 'CRUDEOILM', exch: 'MCX' },
];

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 2) =>
  n === null || n === undefined || Number.isNaN(Number(n))
    ? '—'
    : Number(n).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (n, d = 2) => (Number(n) > 0 ? '+' : '') + fmt(n, d);
const cls = (n) => (Number(n) > 0 ? 'up' : Number(n) < 0 ? 'down' : '');
const keyOf = (item) => `${item.exch}:${item.sym}`;

function loadWatchlist() {
  try {
    const saved = JSON.parse(localStorage.getItem('watchlist_v2') || 'null');
    if (Array.isArray(saved) && saved.length) return saved;
  } catch {
    /* fall through to defaults */
  }
  return DEFAULT_WATCHLIST.slice();
}

const state = {
  watchlist: loadWatchlist(),
  active: null, // {sym, exch}
  activeToken: null,
  marketOpen: false,
  quotes: {}, // "EXCH:SYM" -> quote
  tokenToKey: {}, // feed token -> watchlist key
  logSeq: 0,
  botRunning: false,
  strategies: [],
};

// ---------------------------------------------------------------- chart data
async function loadChart(item) {
  if (!item) return;
  const res = await window.api.get(
    `/candles?symbol=${encodeURIComponent(item.sym)}&exchange=${item.exch}&interval=${TVChart.interval}`
  );
  if (!res.ok) {
    $('chart-session').textContent = res.error;
    return;
  }
  const d = res.data;
  state.activeToken = d.token;
  state.marketOpen = !!d.market_open;
  $('tv-symbol').textContent = d.symbol;

  TVChart.setData(d);

  if (!d.candles.length) {
    $('chart-session').textContent = 'no candles for this session yet';
    $('levels').innerHTML = '';
    return;
  }

  const s = d.summary;
  $('chart-session').textContent = `${d.session}${d.market_open ? '' : ' · market closed'}`;

  // Indicator readings live in the chart legend; this row is levels only.
  $('levels').innerHTML =
    `<span><b class="muted">Support</b> ${s.support.map((x) => fmt(x)).join(' · ') || '—'}</span>` +
    `<span><b class="muted">Resistance</b> ${s.resistance.map((x) => fmt(x)).join(' · ') || '—'}</span>`;
}

// ---------------------------------------------------------------- quotes
/** One REST read to seed prices; after this the socket keeps them current. */
async function seedQuotes() {
  for (const item of state.watchlist) {
    const res = await window.api.get(
      `/quote?symbol=${encodeURIComponent(item.sym)}&exchange=${item.exch}`
    );
    if (res.ok) {
      state.quotes[keyOf(item)] = res.data;
      state.tokenToKey[res.data.token] = keyOf(item);
    }
  }
  renderWatchlist();
  updateOrderLtp();
}

function orderKey() {
  return `${$('o-exchange').value}:${$('o-symbol').value.trim().toUpperCase()}`;
}

function updateOrderLtp() {
  const q = state.quotes[orderKey()];
  $('o-ltp').textContent = q ? `LTP ${fmt(q.ltp)}  (${signed(q.change_pct)}%)` : '—';
}

async function updateLotHint() {
  const sym = $('o-symbol').value.trim().toUpperCase();
  if (!sym) return ($('o-lot').textContent = '');
  const res = await window.api.get(
    `/instrument?symbol=${encodeURIComponent(sym)}&exchange=${$('o-exchange').value}`
  );
  if (!res.ok) return ($('o-lot').textContent = '');
  const i = res.data;
  $('o-lot').textContent = `${i.symbol} · lot ${i.lotsize}` + (i.expiry ? ` · expires ${i.expiry}` : '');
}

function renderWatchlist() {
  const ul = $('wl-list');
  ul.innerHTML = '';
  for (const item of state.watchlist) {
    const k = keyOf(item);
    const q = state.quotes[k];
    const li = document.createElement('li');
    li.dataset.key = k;
    if (state.active && k === keyOf(state.active)) li.className = 'active';
    li.innerHTML =
      `<span class="wl-left"><span class="wl-sym">${item.sym}</span>` +
      `<span class="wl-exch">${item.exch}</span></span>` +
      `<span class="wl-right"><div class="wl-ltp">${q ? fmt(q.ltp) : '—'}</div>` +
      `<div class="wl-chg ${q ? cls(q.change) : ''}">${q && q.change_pct != null ? signed(q.change_pct) + '%' : ''}</div></span>` +
      `<span class="wl-del" title="Remove">✕</span>`;
    li.onclick = (e) => {
      if (e.target.classList.contains('wl-del')) removeSymbol(item);
      else selectSymbol(item);
    };
    ul.appendChild(li);
  }
}

/** Repaint one row in place — cheaper than rebuilding the list on every tick. */
function paintRow(key) {
  const li = $('wl-list').querySelector(`li[data-key="${CSS.escape(key)}"]`);
  const q = state.quotes[key];
  if (!li || !q) return;
  li.querySelector('.wl-ltp').textContent = fmt(q.ltp);
  const chg = li.querySelector('.wl-chg');
  chg.textContent = q.change_pct != null ? signed(q.change_pct) + '%' : '';
  chg.className = 'wl-chg ' + cls(q.change);
}

function saveWatchlist() {
  localStorage.setItem('watchlist_v2', JSON.stringify(state.watchlist));
}

function removeSymbol(item) {
  state.watchlist = state.watchlist.filter((w) => keyOf(w) !== keyOf(item));
  saveWatchlist();
  window.api.unsubscribe([{ symbol: item.sym, exchange: item.exch }]);
  renderWatchlist();
}

function selectSymbol(item) {
  state.active = item;
  $('o-exchange').value = item.exch;
  $('o-symbol').value = item.sym;
  updateOrderLtp();
  updateLotHint();
  renderWatchlist();
  loadChart(item);
}

// ---------------------------------------------------------------- live feed
function handleFeed(msg) {
  switch (msg.type) {
    case 'snapshot':
      setFeedStatus(msg.feed);
      (msg.ticks || []).forEach(applyTick);
      break;
    case 'tick':
      applyTick(msg);
      break;
    case 'feed':
      setFeedStatus({ connected: msg.status === 'connected', error: msg.detail });
      if (msg.status === 'error') log('warn', `feed: ${msg.detail}`);
      break;
    case 'socket':
      if (msg.status === 'closed') setFeedStatus({ connected: false });
      break;
    case 'bot_log':
      if (msg.seq > state.logSeq) {
        state.logSeq = msg.seq;
        log(msg.level, msg.msg, msg.ts);
      }
      break;
    case 'bot_status':
      renderBotStatus(msg);
      break;
  }
}

function applyTick(tick) {
  const key = state.tokenToKey[tick.token];
  if (!key) return;
  state.quotes[key] = { ...(state.quotes[key] || {}), ...tick };
  paintRow(key);
  if (key === orderKey()) updateOrderLtp();
  if (tick.token === state.activeToken) TVChart.applyTick(tick, state.marketOpen);
}

function setFeedStatus(st) {
  if (!st) return;
  const el = $('stat-feed');
  el.textContent = st.connected ? 'live' : st.error ? 'error' : 'off';
  el.className = st.connected ? 'up' : 'muted';
}

function subscribeAll() {
  if (state.watchlist.length) {
    window.api.subscribe(state.watchlist.map((w) => ({ symbol: w.sym, exchange: w.exch })));
  }
}

// ---------------------------------------------------------------- books
async function refreshBooks() {
  const [pos, hold, ord, fund] = await Promise.all([
    window.api.get('/positions'),
    window.api.get('/holdings'),
    window.api.get('/orders'),
    window.api.get('/funds'),
  ]);

  if (pos.ok) {
    const rows = pos.data.positions;
    $('stat-pnl').textContent = signed(pos.data.total_pnl);
    $('stat-pnl').className = cls(pos.data.total_pnl);
    $('tab-positions').innerHTML = rows.length
      ? table(
          ['Symbol', 'Qty', 'Avg', 'LTP', 'P&L'],
          rows.map((r) => [
            r.tradingsymbol,
            numCell(r.netqty),
            numCell(r.avgnetprice ?? r.netprice),
            numCell(r.ltp),
            pnlCell(r.pnl),
          ])
        )
      : '<div class="empty">No open positions.</div>';
  }

  if (hold.ok) {
    const rows = hold.data.holdings;
    $('tab-holdings').innerHTML = rows.length
      ? table(
          ['Symbol', 'Qty', 'Avg', 'LTP', 'P&L'],
          rows.map((r) => [
            r.tradingsymbol,
            numCell(r.quantity),
            numCell(r.averageprice),
            numCell(r.ltp),
            pnlCell(r.profitandloss),
          ])
        )
      : '<div class="empty">No holdings.</div>';
  }

  if (ord.ok) {
    const rows = ord.data.orders;
    $('tab-orders').innerHTML = rows.length
      ? table(
          ['Symbol', 'Side', 'Qty', 'Status', ''],
          rows.map((r) => [
            r.tradingsymbol,
            `<span class="${r.transactiontype === 'BUY' ? 'up' : 'down'}">${r.transactiontype}</span>`,
            numCell(r.quantity),
            r.status,
            ['open', 'trigger pending', 'open pending', 'modified'].includes(String(r.status).toLowerCase())
              ? `<button class="mini" data-cancel="${r.orderid}" data-variety="${r.variety || 'NORMAL'}">Cancel</button>`
              : '',
          ])
        )
      : '<div class="empty">No orders today.</div>';
    $('tab-orders')
      .querySelectorAll('[data-cancel]')
      .forEach((b) => (b.onclick = () => cancelOrder(b.dataset.cancel, b.dataset.variety)));
  }

  if (fund.ok) {
    const f = fund.data;
    $('stat-funds').textContent = '₹' + fmt(f.availablecash ?? f.net ?? 0, 0);
  }
}

const numCell = (v) => `<span class="num">${fmt(v)}</span>`;
const pnlCell = (v) => `<span class="${cls(Number(v))}">${signed(Number(v) || 0)}</span>`;

function table(headers, rows) {
  return (
    '<table><thead><tr>' +
    headers.map((h, i) => `<th class="${i ? 'num' : ''}">${h}</th>`).join('') +
    '</tr></thead><tbody>' +
    rows
      .map((r) => '<tr>' + r.map((c, i) => `<td class="${i ? 'num' : ''}">${c}</td>`).join('') + '</tr>')
      .join('') +
    '</tbody></table>'
  );
}

// ---------------------------------------------------------------- orders
async function submitOrder(side) {
  const body = {
    symbol: $('o-symbol').value.trim().toUpperCase(),
    exchange: $('o-exchange').value,
    side,
    quantity: Number($('o-qty').value),
    order_type: $('o-type').value,
    product: $('o-product').value,
    price: Number($('o-price').value) || 0,
    trigger_price: Number($('o-trigger').value) || 0,
  };
  if (!body.symbol || !body.quantity) return;

  const q = state.quotes[orderKey()];
  const est = q ? `\nLast traded price: ₹${fmt(q.ltp)}\nApprox value: ₹${fmt(q.ltp * body.quantity, 0)}` : '';
  const ok = await window.api.confirm({
    title: 'Send this order?',
    message: `${side} ${body.quantity} × ${body.symbol} on ${body.exchange}`,
    detail:
      `${body.order_type} · ${body.product}` +
      (body.price ? ` · limit ₹${fmt(body.price)}` : '') +
      (body.trigger_price ? ` · trigger ₹${fmt(body.trigger_price)}` : '') +
      est +
      '\n\nThis places a real order on your AngelOne account.',
  });
  if (!ok) return log('info', 'order cancelled at confirmation');

  const res = await window.api.post('/order', body);
  if (res.ok) {
    const r = res.data.response || {};
    log('trade', `${side} ${body.quantity} ${body.symbol} sent — ${JSON.stringify(r.data || r)}`);
    refreshBooks();
  } else {
    log('error', `order failed: ${res.error}`);
  }
}

async function cancelOrder(orderId, variety) {
  const ok = await window.api.confirm({
    title: 'Cancel order?',
    message: `Cancel order ${orderId}`,
    detail: 'This withdraws the order from the exchange.',
  });
  if (!ok) return;
  const res = await window.api.post('/order/cancel', { order_id: orderId, variety });
  log(res.ok ? 'info' : 'error', res.ok ? `cancelled ${orderId}` : `cancel failed: ${res.error}`);
  refreshBooks();
}

// ---------------------------------------------------------------- bot
function log(level, msg, ts) {
  const el = document.createElement('div');
  el.innerHTML = `<span class="ts">${ts || new Date().toTimeString().slice(0, 8)}</span>`;
  const span = document.createElement('span');
  span.className = level;
  span.textContent = msg;
  el.appendChild(span);
  $('log').appendChild(el);
  $('log').scrollTop = $('log').scrollHeight;
}

async function loadStrategies() {
  const res = await window.api.get('/bot/strategies');
  if (!res.ok) return;
  state.strategies = res.data.strategies;
  $('b-strategy').innerHTML = state.strategies
    .map((s) => `<option value="${s.id}">${s.name}</option>`)
    .join('');
  showStrategyDesc();
}

function showStrategyDesc() {
  const s = state.strategies.find((x) => x.id === $('b-strategy').value);
  $('b-desc').textContent = s ? s.desc : '';
}

async function startBot() {
  const cfg = {
    strategy: $('b-strategy').value,
    symbol: $('b-symbol').value.trim().toUpperCase(),
    exchange: $('b-exchange').value,
    interval: $('b-interval').value,
    quantity: Number($('b-qty').value),
    mode: $('b-mode').value,
    poll_seconds: Number($('b-poll').value),
    max_trades: Number($('b-maxtrades').value),
    max_daily_loss: Number($('b-maxloss').value),
    square_off: $('b-squareoff').value,
    allow_short: $('b-short').checked,
    confirm_live: false,
  };
  if (!cfg.symbol) return;

  if (cfg.mode === 'LIVE') {
    const ok = await window.api.confirm({
      title: 'Run the bot with real money?',
      message: `LIVE trading: ${cfg.strategy} on ${cfg.symbol} (${cfg.exchange})`,
      detail:
        `The bot will place real orders of ${cfg.quantity} qty without asking again.\n\n` +
        `Caps: max ${cfg.max_trades} trades, stops at -₹${cfg.max_daily_loss}, squares off at ${cfg.square_off}.\n\n` +
        `Only continue if you want live orders sent automatically.`,
    });
    if (!ok) return log('info', 'live bot start cancelled');
    cfg.confirm_live = true;
  }

  state.logSeq = 0;
  $('log').innerHTML = '';
  const res = await window.api.post('/bot/start', cfg);
  if (!res.ok || res.data.ok === false) {
    log('error', `bot failed to start: ${res.error || res.data.error}`);
    return;
  }
  setBotUi(true, cfg.mode);
}

async function stopBot() {
  const res = await window.api.post('/bot/stop', {});
  if (!res.ok) log('error', res.error);
  setBotUi(false);
}

function setBotUi(running, mode) {
  state.botRunning = running;
  $('bot-start').disabled = running;
  $('bot-stop').disabled = !running;
  const badge = $('bot-state');
  badge.textContent = running ? (mode === 'LIVE' ? 'live' : 'paper') : 'idle';
  badge.className = 'badge ' + (running ? (mode === 'LIVE' ? 'live' : 'paper') : 'idle');
}

function renderBotStatus(s) {
  if (state.botRunning && !s.running) setBotUi(false);
  if (!state.botRunning && s.running) setBotUi(true, s.config && s.config.mode);
  $('bot-stats').innerHTML = s.config
    ? `<span><b>Position</b><span class="${cls(s.position)}">${s.position > 0 ? 'LONG' : s.position < 0 ? 'SHORT' : 'flat'}</span></span>` +
      `<span><b>Entry</b>${s.entry_price ? fmt(s.entry_price) : '—'}</span>` +
      `<span><b>Last</b>${s.last_price ? fmt(s.last_price) : '—'}</span>` +
      `<span><b>Realized</b><span class="${cls(s.realized_pnl)}">${signed(s.realized_pnl)}</span></span>` +
      `<span><b>Open</b><span class="${cls(s.unrealized_pnl)}">${signed(s.unrealized_pnl)}</span></span>` +
      `<span><b>Trades</b>${s.trades}</span>`
    : '';
}

/** Safety net: if the socket dropped and reconnected, pull anything we missed. */
async function reconcileBot() {
  const [logs, st] = await Promise.all([
    window.api.get(`/bot/logs?since=${state.logSeq}`),
    window.api.get('/bot/status'),
  ]);
  if (logs.ok) {
    for (const e of logs.data.logs) {
      if (e.seq > state.logSeq) {
        state.logSeq = e.seq;
        log(e.level, e.msg, e.ts);
      }
    }
  }
  if (st.ok) renderBotStatus(st.data);
}

// ---------------------------------------------------------------- wiring
function wire() {
  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      document.querySelectorAll('.tab-body').forEach((x) => x.classList.add('hidden'));
      t.classList.add('active');
      $('tab-' + t.dataset.tab).classList.remove('hidden');
    };
  });

  $('btn-refresh').onclick = () => {
    seedQuotes();
    refreshBooks();
    loadChart(state.active);
  };

  $('wl-add').onclick = addFromInput;
  $('wl-input').onkeydown = (e) => {
    if (e.key === 'Enter') addFromInput();
  };

  let searchTimer;
  $('wl-input').oninput = () => {
    clearTimeout(searchTimer);
    const q = $('wl-input').value.trim();
    if (q.length < 2) return $('wl-suggest').classList.add('hidden');
    searchTimer = setTimeout(async () => {
      const res = await window.api.get(
        `/search?q=${encodeURIComponent(q)}&exchange=${$('wl-exch').value}&limit=12`
      );
      if (!res.ok) return;
      const box = $('wl-suggest');
      box.innerHTML = res.data.results
        .map(
          (r) =>
            `<div data-sym="${r.symbol}">${r.symbol}` +
            `<span class="muted"> ${r.expiry || r.name || ''}</span></div>`
        )
        .join('');
      box.classList.toggle('hidden', !res.data.results.length);
      box.querySelectorAll('[data-sym]').forEach((d) => {
        d.onclick = () => {
          $('wl-input').value = d.dataset.sym;
          box.classList.add('hidden');
          addFromInput();
        };
      });
    }, 300);
  };

  $('o-symbol').oninput = () => {
    updateOrderLtp();
    updateLotHint();
  };
  $('o-exchange').onchange = () => {
    updateOrderLtp();
    updateLotHint();
  };
  $('o-type').onchange = () => {
    $('trigger-wrap').classList.toggle('hidden', !$('o-type').value.startsWith('STOPLOSS'));
  };
  $('btn-buy').onclick = () => submitOrder('BUY');
  $('btn-sell').onclick = () => submitOrder('SELL');

  $('b-strategy').onchange = showStrategyDesc;
  // MCX runs to 23:30, so the default flat-by time follows the exchange.
  $('b-exchange').onchange = () => {
    $('b-squareoff').value = $('b-exchange').value === 'MCX' ? '23:15' : '15:15';
  };
  $('bot-start').onclick = startBot;
  $('bot-stop').onclick = stopBot;
  $('log-clear').onclick = () => ($('log').innerHTML = '');

  setInterval(() => {
    $('stat-clock').textContent = new Date().toLocaleTimeString('en-IN', { hour12: false });
  }, 1000);
}

async function addFromInput() {
  const sym = $('wl-input').value.trim().toUpperCase();
  if (!sym) return;
  const item = { sym, exch: $('wl-exch').value };
  if (!state.watchlist.some((w) => keyOf(w) === keyOf(item))) state.watchlist.push(item);
  saveWatchlist();
  $('wl-input').value = '';
  $('wl-suggest').classList.add('hidden');
  selectSymbol(item);

  const res = await window.api.get(`/quote?symbol=${encodeURIComponent(sym)}&exchange=${item.exch}`);
  if (res.ok) {
    state.quotes[keyOf(item)] = res.data;
    state.tokenToKey[res.data.token] = keyOf(item);
    renderWatchlist();
  }
  window.api.subscribe([{ symbol: item.sym, exchange: item.exch }]);
}

async function boot() {
  TVChart.init({
    onInterval: () => loadChart(state.active),
    onSymbolClick: () => $('wl-input').focus(),
  });
  wire();
  renderWatchlist();
  log('info', 'starting Python sidecar…');

  window.api.onFeed(handleFeed);
  window.api.onSidecarLog(({ level, text }) => log(level, text.trim()));

  const { healthy } = await window.api.ready();
  if (!healthy) {
    $('status-dot').className = 'dot err';
    $('status-text').textContent = 'sidecar did not start';
    return log('error', 'Python sidecar failed to start — check the terminal output.');
  }
  log('info', 'sidecar up, logging in to AngelOne…');
  const res = await window.api.post('/login', {});
  if (!res.ok) {
    $('status-dot').className = 'dot err';
    $('status-text').textContent = 'login failed';
    return log('error', res.error);
  }
  $('status-dot').className = 'dot ok';
  $('status-text').textContent = 'connected';
  $('stat-client').textContent = res.data.client_id;
  log('info', `logged in as ${res.data.client_id}`);

  await loadStrategies();
  selectSymbol(state.watchlist[0]);
  await seedQuotes();
  subscribeAll();
  refreshBooks();

  // Prices and bot events arrive over the socket; these are slow backstops.
  setInterval(refreshBooks, 15000);
  setInterval(() => loadChart(state.active), 60000);
  setInterval(reconcileBot, 20000);
}

boot();

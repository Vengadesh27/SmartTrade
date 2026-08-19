const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const TOKEN = crypto.randomBytes(32).toString('hex');

let sidecar = null;
let sidecarPort = null;
let win = null;
let shuttingDown = false;
// Readiness is pulled, not pushed: the renderer may finish loading (or reload)
// after the sidecar is already up, and a one-shot event would be missed.
let readyPromise = null;

function pythonExe() {
  const candidates = [
    path.join(PROJECT_ROOT, '.venv', 'bin', 'python'),
    path.join(PROJECT_ROOT, '.venv', 'Scripts', 'python.exe'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return 'python3';
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function startSidecar(port) {
  sidecar = spawn(pythonExe(), ['-m', 'angelone_agent.sidecar'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      SIDECAR_TOKEN: TOKEN,
      SIDECAR_PORT: String(port),
      PYTHONUNBUFFERED: '1',
      PYTHONPATH: PROJECT_ROOT,
    },
  });

  const relay = (stream, level) => {
    stream.on('data', (buf) => {
      const text = buf.toString();
      process.stdout.write(`[sidecar] ${text}`);
      if (win && !win.isDestroyed()) win.webContents.send('sidecar:log', { level, text });
    });
  };
  relay(sidecar.stdout, 'info');
  relay(sidecar.stderr, 'error');

  sidecar.on('exit', (code) => {
    sidecar = null;
    if (shuttingDown) return;
    if (win && !win.isDestroyed()) {
      win.webContents.send('sidecar:log', {
        level: 'error',
        text: `Python sidecar exited with code ${code}. Restart the app.`,
      });
    }
  });
}

async function waitForHealth(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// Single funnel for renderer -> sidecar. The token never reaches the renderer.
ipcMain.handle('api', async (_evt, { method, path: route, body }) => {
  if (!sidecarPort) return { ok: false, error: 'sidecar not started' };
  try {
    const res = await fetch(`http://127.0.0.1:${sidecarPort}${route}`, {
      method: method || 'GET',
      headers: { 'X-Auth-Token': TOKEN, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { detail: text };
    }
    if (!res.ok) return { ok: false, error: data.detail || `HTTP ${res.status}`, status: res.status };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// ---------------------------------------------------------------- live feed
// The renderer never gets the auth token, so the socket lives here and its
// messages are relayed over IPC.
let feedSocket = null;
let feedRetry = null;

function connectFeed() {
  if (!sidecarPort || shuttingDown) return;
  try {
    feedSocket = new WebSocket(`ws://127.0.0.1:${sidecarPort}/ws?token=${TOKEN}`);
  } catch (err) {
    return scheduleFeedRetry();
  }

  feedSocket.onopen = () => {
    if (win && !win.isDestroyed()) win.webContents.send('feed', { type: 'socket', status: 'open' });
  };
  feedSocket.onmessage = (evt) => {
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send('feed', JSON.parse(evt.data));
    } catch {
      /* ignore malformed frames */
    }
  };
  feedSocket.onclose = () => {
    feedSocket = null;
    if (win && !win.isDestroyed()) win.webContents.send('feed', { type: 'socket', status: 'closed' });
    scheduleFeedRetry();
  };
  feedSocket.onerror = () => {
    try {
      feedSocket && feedSocket.close();
    } catch {
      /* already gone */
    }
  };
}

function scheduleFeedRetry() {
  if (shuttingDown || feedRetry) return;
  feedRetry = setTimeout(() => {
    feedRetry = null;
    connectFeed();
  }, 3000);
}

ipcMain.handle('feed:send', (_evt, message) => {
  if (feedSocket && feedSocket.readyState === 1) {
    feedSocket.send(JSON.stringify(message));
    return true;
  }
  return false;
});

// Native modal for anything that spends real money.
ipcMain.handle('confirm', async (_evt, { title, message, detail }) => {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Cancel', 'Confirm'],
    defaultId: 0,
    cancelId: 0,
    title: title || 'Confirm',
    message: message || '',
    detail: detail || '',
    noLink: true,
  });
  return response === 1;
});

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0d1117',
    title: 'AngelOne Desk',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  // Nothing in this app should open external pages.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

app.whenReady().then(async () => {
  sidecarPort = await freePort();
  startSidecar(sidecarPort);
  createWindow();
  readyPromise = waitForHealth(sidecarPort);
  const healthy = await readyPromise;
  if (win && !win.isDestroyed()) {
    win.webContents.send('sidecar:ready', { healthy });
  }
  if (healthy) connectFeed();
});

ipcMain.handle('app:ready', async () => {
  if (!readyPromise) return { healthy: false };
  return { healthy: await readyPromise };
});

function shutdown() {
  shuttingDown = true;
  if (feedRetry) clearTimeout(feedRetry);
  if (feedSocket) {
    try {
      feedSocket.close();
    } catch {
      /* already gone */
    }
  }
  if (sidecar) {
    sidecar.kill('SIGTERM');
    setTimeout(() => sidecar && sidecar.kill('SIGKILL'), 3000);
  }
}

app.on('before-quit', shutdown);
app.on('window-all-closed', () => {
  shutdown();
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

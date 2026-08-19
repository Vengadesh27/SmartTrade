const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  get: (path) => ipcRenderer.invoke('api', { method: 'GET', path }),
  post: (path, body) => ipcRenderer.invoke('api', { method: 'POST', path, body }),
  confirm: (opts) => ipcRenderer.invoke('confirm', opts),
  // live feed: ticks + bot events pushed from the sidecar via the main process
  onFeed: (cb) => ipcRenderer.on('feed', (_e, msg) => cb(msg)),
  subscribe: (symbols) => ipcRenderer.invoke('feed:send', { action: 'subscribe', symbols }),
  unsubscribe: (symbols) => ipcRenderer.invoke('feed:send', { action: 'unsubscribe', symbols }),
  onSidecarLog: (cb) => ipcRenderer.on('sidecar:log', (_e, payload) => cb(payload)),
  // resolves once the sidecar answers /health — safe to call at any time,
  // including after a renderer reload
  ready: () => ipcRenderer.invoke('app:ready'),
});

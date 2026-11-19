// Main-world script, runs before any page script. In a container tab it scopes every
// same-origin shared surface it can reach (storage, IndexedDB, Cache Storage, BroadcastChannel,
// Web Locks, storage events, cookies) under "__mac:<id>:" names; in normal tabs it hides those
// names. Also exposes window.__containers for AI agents.
(() => {
  const TAG = Symbol.for('tab-containers');
  // The background adds a Server-Timing header to container tabs, readable synchronously here.
  const timing = performance.getEntriesByType('navigation')[0]?.serverTiming ?? [];
  let cid = timing.find(e => e.name === 'tab-containers')?.description;
  if (!cid && /^about:/.test(location.href)) try { cid = parent[TAG]; } catch {} // about:blank/srcdoc frames inherit
  Object.defineProperty(window, TAG, { value: cid || null });

  const MAC = '__mac:', P = cid ? `${MAC}${cid}:` : '';
  const mine = n => (P ? n.startsWith(P) : !n.startsWith(MAC));
  const wrap = n => P + n, strip = n => n.slice(P.length);
  const patch = (obj, key, fn) => {
    const orig = obj?.[key];
    if (typeof orig === 'function') obj[key] = function (...a) { return fn.call(this, orig, ...a); };
  };

  // ---------- workers: their requests carry no tab id, so container rules can't reach them ----------
  const controlled = !!navigator.serviceWorker?.controller;
  if (P) { delete Navigator.prototype.serviceWorker; delete window.SharedWorker; }

  // ---------- localStorage / sessionStorage ----------
  // ponytail: keys() is O(n) per call, so key(i) loops are O(n^2); cache it if a site has thousands of keys.
  function scope(name, real) {
    const keys = () => {
      const out = [];
      for (let i = 0; i < real.length; i++) { const k = real.key(i); if (mine(k)) out.push(strip(k)); }
      return out;
    };
    const api = {
      getItem: k => real.getItem(wrap(String(k))),
      setItem: (k, v) => real.setItem(wrap(String(k)), v),
      removeItem: k => real.removeItem(wrap(String(k))),
      clear: () => keys().forEach(k => real.removeItem(wrap(k))),
      key: i => keys()[i] ?? null,
    };
    const store = new Proxy(Object.create(Storage.prototype), {
      get(t, k) {
        if (k === 'length') return keys().length;
        if (Object.hasOwn(api, k)) return api[k];
        if (typeof k === 'symbol' || k in Object.prototype) return Reflect.get(t, k);
        return real.getItem(wrap(k)) ?? undefined;
      },
      set(t, k, v) { if (typeof k === 'symbol') return false; real.setItem(wrap(k), v); return true; },
      deleteProperty(t, k) { real.removeItem(wrap(String(k))); return true; },
      has: (t, k) => k === 'length' || Object.hasOwn(api, k) || (typeof k === 'string' && real.getItem(wrap(k)) !== null),
      ownKeys: () => keys(),
      getOwnPropertyDescriptor(t, k) {
        const v = typeof k === 'string' ? real.getItem(wrap(k)) : null;
        return v === null ? undefined : { value: v, writable: true, enumerable: true, configurable: true };
      },
    });
    Object.defineProperty(window, name, { get: () => store, configurable: true, enumerable: true });
  }
  const realStores = new Map();
  for (const name of ['localStorage', 'sessionStorage']) {
    let real;
    try { real = window[name]; } catch { continue; } // storage blocked (sandboxed frame)
    realStores.set(real, name);
    // Normal tabs only pay for the proxy when container keys exist in this origin.
    if (P || Array.from({ length: real.length }, (_, i) => real.key(i)).some(k => k.startsWith(MAC))) scope(name, real);
  }
  // A normal tab's clear() must not wipe container data.
  const { key: nKey, removeItem: nRemove } = Storage.prototype;
  Storage.prototype.clear = function () {
    for (let i = this.length; i--;) { const k = nKey.call(this, i); if (k !== null && mine(k)) nRemove.call(this, k); }
  };
  // Cross-tab storage events: drop other containers' keys; re-key ours.
  addEventListener('storage', e => {
    if (!e.isTrusted) return;
    if (!P) { if (e.key?.startsWith(MAC)) e.stopImmediatePropagation(); return; }
    e.stopImmediatePropagation();
    if (e.key !== null && mine(e.key) && realStores.has(e.storageArea))
      dispatchEvent(new StorageEvent('storage', { key: strip(e.key), oldValue: e.oldValue, newValue: e.newValue, url: e.url }));
  }, true);

  // ---------- IndexedDB ----------
  if (self.IDBFactory) {
    patch(IDBFactory.prototype, 'open', function (o, name, ...r) { return o.call(this, wrap(String(name)), ...r); });
    patch(IDBFactory.prototype, 'deleteDatabase', function (o, name) { return o.call(this, wrap(String(name))); });
    patch(IDBFactory.prototype, 'databases', async function (o) {
      return (await o.call(this)).filter(d => mine(d.name)).map(d => ({ ...d, name: strip(d.name) }));
    });
    const nd = Object.getOwnPropertyDescriptor(IDBDatabase.prototype, 'name');
    Object.defineProperty(IDBDatabase.prototype, 'name', { ...nd, get() { return strip(nd.get.call(this)); } });
  }

  // ---------- Cache Storage ----------
  if (self.CacheStorage) {
    const C = CacheStorage.prototype;
    for (const m of ['open', 'has', 'delete']) patch(C, m, function (o, name) { return o.call(this, wrap(String(name))); });
    patch(C, 'keys', async function (o) { return (await o.call(this)).filter(mine).map(strip); });
    patch(C, 'match', async function (o, req, opts = {}) {
      if (opts.cacheName != null) return o.call(this, req, { ...opts, cacheName: wrap(String(opts.cacheName)) });
      for (const n of await C.keys.call(this)) { const r = await (await C.open.call(this, n)).match(req, opts); if (r) return r; }
    });
  }

  // ---------- Web Locks + BroadcastChannel (cross-tab coordination, e.g. token refresh / logout sync) ----------
  if (self.LockManager) {
    patch(LockManager.prototype, 'request', function (o, name, ...r) { return o.call(this, wrap(String(name)), ...r); });
    patch(LockManager.prototype, 'query', async function (o) {
      const s = await o.call(this), f = l => l.filter(x => mine(x.name)).map(x => ({ ...x, name: strip(x.name) }));
      return { held: f(s.held), pending: f(s.pending) };
    });
  }
  if (P && self.BroadcastChannel) {
    const BC = BroadcastChannel;
    window.BroadcastChannel = class BroadcastChannel extends BC {
      constructor(name) { super(wrap(String(name))); }
      get name() { return strip(super.name); }
    };
  }

  // ---------- document.cookie + cookieStore ----------
  const native = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  const toJar = s => new Map(s ? s.split('; ').map(p => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]) : []);
  // Seed from the most specific "host|cookies" header entry for this host; content.js refreshes it (path-filtered) later.
  const host = location.hostname, seed = timing.filter(e => e.name === 'tab-containers-cookies')
    .map(e => [e.description.slice(0, e.description.indexOf('|')), e.description.slice(e.description.indexOf('|') + 1)])
    .filter(([h]) => host === h || host.endsWith('.' + h)).sort((a, b) => b[0].length - a[0].length)[0]?.[1];
  let jar = P ? toJar(seed) : null; // Map(name -> value) in a container, null otherwise
  Object.defineProperty(Document.prototype, 'cookie', {
    configurable: true, enumerable: true,
    get() { return jar && this === document ? [...jar].map(([k, v]) => `${k}=${v}`).join('; ') : native.get.call(this); },
    set(s) {
      if (!jar || this !== document) return native.set.call(this, s);
      s = String(s);
      const pair = s.split(';')[0], i = pair.indexOf('=');
      if (i < 1) return;
      const exp = /;\s*expires=([^;]+)/i.exec(s);
      const gone = /;\s*max-age\s*=\s*(-\d+|0+)\s*(;|$)/i.test(s) || (exp && Date.parse(exp[1]) <= Date.now());
      gone ? jar.delete(pair.slice(0, i).trim()) : jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      window.postMessage({ __mac: 'set', cookie: s }, '*');
    },
  });
  if (P && 'cookieStore' in window) {
    const cs = new EventTarget(), all = () => [...jar].map(([name, value]) => ({ name, value }));
    const q = a => (typeof a === 'string' ? { name: a } : a || {});
    const attrs = o => `; path=${o.path || '/'}` + (o.domain ? `; domain=${o.domain}` : '');
    cs.get = async a => all().find(c => !q(a).name || c.name === q(a).name) ?? null;
    cs.getAll = async a => all().filter(c => !q(a).name || c.name === q(a).name);
    cs.set = async (a, v) => {
      const o = typeof a === 'string' ? { name: a, value: v } : a;
      document.cookie = `${o.name}=${o.value}${attrs(o)}` + (o.expires ? `; expires=${new Date(o.expires).toUTCString()}` : '');
    };
    cs.delete = async a => { const o = q(a); document.cookie = `${o.name}=${attrs(o)}; max-age=0`; };
    Object.defineProperty(window, 'cookieStore', { get: () => cs, configurable: true, enumerable: true });
  }

  // ---------- AI / page API ----------
  let seq = 0;
  const waiting = new Map();
  const call = (cmd, args) => new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, r => (r?.error ? reject(new Error(r.error)) : resolve(r)));
    window.postMessage({ __mac: 'req', id, cmd, args }, '*');
  });

  window.addEventListener('message', e => {
    const d = e.data;
    if (e.source !== window || !d || typeof d !== 'object') return;
    if (d.__mac === 'cookies') {
      jar = d.container ? toJar(d.cookie) : null;
      // A container tab that loaded unscoped (no marker header) or under a service worker: the
      // background removes the origin's service workers and reloads the tab.
      if (d.container && (!cid || controlled)) window.postMessage({ __mac: 'unscoped' }, '*');
    }
    else if (d.__mac === 'res' && waiting.has(d.id)) { waiting.get(d.id)(d.result); waiting.delete(d.id); }
  });

  window.__containers = Object.freeze({
    list: () => call('list'),                                  // all containers (+ open tab counts)
    current: () => call('current'),                            // container of this tab, or null
    open: (name, url) => call('open', { name, url }),          // move THIS tab into a container (created if missing; 'none' to leave) and load url
    create: (name, color, icon) => call('create', { name, color, icon }),
  });
})();

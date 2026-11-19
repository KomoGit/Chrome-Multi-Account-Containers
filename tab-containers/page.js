// Main-world script: container-scoped localStorage/sessionStorage and document.cookie,
// plus window.__containers for AI agents.
(() => {
  // The background adds a Server-Timing header to container tabs, readable before any page script runs.
  const cid = performance.getEntriesByType('navigation')[0]?.serverTiming?.find(e => e.name === 'tab-containers')?.description;

  // ---------- storage: container keys live in the real store under "__mac:<id>:" ----------
  function scope(name, p) {
    let real;
    try { real = window[name]; } catch { return; } // storage blocked (sandboxed frame)
    const keys = () => {
      const out = [];
      for (let i = 0; i < real.length; i++) { const k = real.key(i); if (k.startsWith(p)) out.push(k.slice(p.length)); }
      return out;
    };
    const api = {
      getItem: k => real.getItem(p + k),
      setItem: (k, v) => real.setItem(p + k, v),
      removeItem: k => real.removeItem(p + k),
      clear: () => keys().forEach(k => real.removeItem(p + k)),
      key: i => keys()[i] ?? null,
    };
    const store = new Proxy(Object.create(Storage.prototype), {
      get(t, k) {
        if (k === 'length') return keys().length;
        if (Object.hasOwn(api, k)) return api[k];
        if (typeof k === 'symbol' || k in Object.prototype) return Reflect.get(t, k);
        return real.getItem(p + k) ?? undefined;
      },
      set(t, k, v) { if (typeof k === 'symbol') return false; real.setItem(p + k, v); return true; },
      deleteProperty(t, k) { real.removeItem(p + String(k)); return true; },
      has: (t, k) => k === 'length' || Object.hasOwn(api, k) || (typeof k === 'string' && real.getItem(p + k) !== null),
      ownKeys: () => keys(),
      getOwnPropertyDescriptor(t, k) {
        const v = typeof k === 'string' ? real.getItem(p + k) : null;
        return v === null ? undefined : { value: v, writable: true, enumerable: true, configurable: true };
      },
    });
    Object.defineProperty(window, name, { get: () => store, configurable: true, enumerable: true });
  }
  // ponytail: IndexedDB, Cache Storage and service workers stay shared; scope them the same way if a site needs it.
  if (cid) for (const name of ['localStorage', 'sessionStorage']) scope(name, `__mac:${cid}:`);

  // ---------- document.cookie ----------
  const native = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  let jar = cid ? new Map() : null; // Map(name -> value) in a container (filled by content.js), null otherwise
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
    if (d.__mac === 'cookies') jar = d.container ? new Map(d.cookie ? d.cookie.split('; ').map(p => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]) : []) : null;
    else if (d.__mac === 'res' && waiting.has(d.id)) { waiting.get(d.id)(d.result); waiting.delete(d.id); }
  });

  window.__containers = Object.freeze({
    list: () => call('list'),                                  // all containers (+ open tab counts)
    current: () => call('current'),                            // container of this tab, or null
    open: (name, url) => call('open', { name, url }),          // move THIS tab into a container (created if missing; 'none' to leave) and load url
    create: (name, color, icon) => call('create', { name, color, icon }),
  });
})();

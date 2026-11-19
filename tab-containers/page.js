// Main-world script: container-aware document.cookie, plus window.__containers for AI agents.
(() => {
  const native = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  let jar = null; // Map(name -> value) while this tab is in a container, null otherwise
  // ponytail: until content.js answers (a few ms after document_start) scripts see the real jar.
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

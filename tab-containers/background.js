// Chrome has no per-tab cookie stores, so each container keeps its own cookie jar here and
// declarativeNetRequest session rules (scoped by tabIds) swap the Cookie header on every
// request from a container tab and strip Set-Cookie so nothing reaches Chrome's real jar.
importScripts('common.js');

const local = chrome.storage.local;
const TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other'];
const BRIDGE = ['list', 'current', 'open', 'create']; // what web pages / AI agents may call
const INTERNAL = ['getCookies', 'setCookie'];        // our own content script

// ---------- state ----------
const tabsP = chrome.storage.session.get('tabs').then(r => r.tabs || {}); // tabId -> containerId
const jarsP = {};                                                          // containerId -> Promise<{key: cookie}>
const jar = cid => (jarsP[cid] ??= local.get('jar:' + cid).then(r => r['jar:' + cid] || {}));

async function containers() {
  const { containers } = await local.get('containers');
  if (containers) return containers;
  await local.set({ containers: DEFAULT_CONTAINERS });
  return DEFAULT_CONTAINERS;
}
const find = (list, key) => list.find(c => c.id === key || c.name.toLowerCase() === String(key).toLowerCase());

async function create(list, { name, color, icon }) {
  name = String(name || 'Container').trim().slice(0, 40);
  const existing = find(list, name);
  if (existing) return existing;
  const c = { id: crypto.randomUUID().slice(0, 8), name, color: COLORS[color] ? color : 'grey', icon: ICONS[icon] ? icon : 'circle' };
  await local.set({ containers: [...list, c] });
  return c;
}

// ---------- tabs ----------
async function assign(tabId, cid) {
  const tabs = await tabsP;
  if (cid) tabs[tabId] = cid; else delete tabs[tabId];
  await chrome.storage.session.set({ tabs });
  await sync();
  await decorate(tabId, cid, true).catch(() => {});
}

// Move a tab into a container (by id or name; created if missing; "none" = no container), then load url.
async function openTab(tabId, name, url) {
  const list = await containers();
  const c = !name || /^none$/i.test(name) ? null : find(list, name) ?? await create(list, { name });
  await assign(tabId, c?.id);
  // Navigate after a beat so a page that asked (the JS bridge) still gets its reply.
  if (/^(https?:|about:blank$)/i.test(url)) setTimeout(() => chrome.tabs.update(tabId, { url }), 50);
  return c;
}

// Badge letter on the toolbar icon + a colored tab group named after the container.
async function decorate(tabId, cid, group) {
  const list = await containers(), c = list.find(c => c.id === cid);
  await chrome.action.setBadgeText({ tabId, text: c ? c.name[0].toUpperCase() : '' });
  if (c) await chrome.action.setBadgeBackgroundColor({ tabId, color: COLORS[c.color] });
  if (!group) return;
  const tab = await chrome.tabs.get(tabId);
  if (tab.groupId !== -1) {
    const g = await chrome.tabGroups.get(tab.groupId);
    // Already in the right group, or in someone else's group (e.g. the Claude MCP group): leave it.
    if (g.title === c?.name || !list.some(x => x.name === g.title)) return;
    await chrome.tabs.ungroup(tabId);
  }
  if (!c) return;
  const [g] = await chrome.tabGroups.query({ windowId: tab.windowId, title: c.name });
  const groupId = await chrome.tabs.group(g ? { tabIds: tabId, groupId: g.id } : { tabIds: tabId, createProperties: { windowId: tab.windowId } });
  if (!g) await chrome.tabGroups.update(groupId, { title: c.name, color: c.color });
}

// ---------- cookies ----------
const expired = (k, now) => k.expires !== null && k.expires <= now;
const applies = (k, host) => k.hostOnly ? host === k.domain : host === k.domain || host.endsWith('.' + k.domain);
const pathMatch = (p, kp) => p === kp || p.startsWith(kp.endsWith('/') ? kp : kp + '/');
const cookieString = (cookies, host, ok = () => true) =>
  cookies.filter(k => applies(k, host) && ok(k)).map(k => `${k.name}=${k.value}`).join('; ');

function parseCookie(str, url) {
  const u = new URL(url), host = u.hostname;
  const [pair, ...attrs] = str.split(';');
  const eq = pair.indexOf('=');
  if (eq < 1) return null;
  const k = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), domain: host, hostOnly: true,
    path: u.pathname.slice(0, u.pathname.lastIndexOf('/')) || '/', expires: null, httpOnly: false, secure: false };
  let maxAge = null;
  for (const a of attrs) {
    const i = a.indexOf('='), key = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase(), val = i < 0 ? '' : a.slice(i + 1).trim();
    if (key === 'expires') { const t = Date.parse(val); if (!isNaN(t)) k.expires = t; }
    else if (key === 'max-age' && /^-?\d+$/.test(val)) maxAge = Date.now() + val * 1000;
    else if (key === 'domain' && val) {
      const d = val.replace(/^\./, '').toLowerCase();
      // ponytail: no public-suffix check, so Domain=com is accepted (only inside that container's jar).
      if (host !== d && !host.endsWith('.' + d)) return null;
      k.domain = d; k.hostOnly = false;
    }
    else if (key === 'path' && val.startsWith('/')) k.path = val;
    else if (key === 'secure') k.secure = true;
    else if (key === 'httponly') k.httpOnly = true;
  }
  if (maxAge !== null) k.expires = maxAge;
  return k;
}

async function saveCookies(cid, lines, url, fromJs) {
  const j = await jar(cid), now = Date.now();
  for (const line of lines) {
    const k = parseCookie(line, url);
    if (!k) continue;
    const key = `${k.domain}|${k.path}|${k.name}`;
    if (fromJs && (k.httpOnly || j[key]?.httpOnly)) continue; // JS can't touch HttpOnly cookies
    if (expired(k, now)) delete j[key]; else j[key] = k;
  }
  await local.set({ ['jar:' + cid]: j });
  await sync();
  for (const [t, c] of Object.entries(await tabsP)) if (c === cid) chrome.tabs.sendMessage(+t, { type: 'refresh' }).catch(() => {});
}

// ---------- request rules ----------
// Full rebuild of all session rules; calls made while one is queued share it.
let running = Promise.resolve(), pending = null;
const sync = () => (pending ??= running.then(() => { pending = null; return (running = rebuild().catch(console.error)); }));

async function rebuild() {
  const byC = {}, rules = [], now = Date.now();
  for (const [t, c] of Object.entries(await tabsP)) (byC[c] ??= []).push(+t);
  let id = 1;
  for (const [cid, tabIds] of Object.entries(byC)) {
    const condition = { tabIds, resourceTypes: TYPES };
    rules.push({ id: id++, priority: 1, condition, action: { type: 'modifyHeaders',
      requestHeaders: [{ header: 'cookie', operation: 'remove' }],
      responseHeaders: [{ header: 'set-cookie', operation: 'remove' }] } });
    const cookies = Object.values(await jar(cid)).filter(k => !expired(k, now));
    // ponytail: one rule per cookie domain, path ignored; host-only cookies also reach that host's subdomains.
    for (const host of new Set(cookies.map(k => k.domain))) {
      const value = cookieString(cookies, host);
      if (value) rules.push({ id: id++, priority: 2 + host.split('.').length, condition: { ...condition, requestDomains: [host] },
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'cookie', operation: 'set', value }] } });
    }
  }
  const old = await chrome.declarativeNetRequest.getSessionRules();
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: old.map(r => r.id), addRules: rules });
}

// Capture Set-Cookie from container tabs into the container's jar.
// Rules update async, so a redirect that follows a login's Set-Cookie can leave without the
// new cookie; that main-frame GET is re-issued once the rules are in place.
const raced = new Map(); // tabId -> URL of a main-frame GET that raced a cookie update
chrome.webRequest.onHeadersReceived.addListener(d => {
  const lines = (d.responseHeaders || []).filter(h => h.name.toLowerCase() === 'set-cookie').flatMap(h => h.value.split('\n'));
  if (!lines.length) return;
  tabsP.then(async tabs => {
    const cid = tabs[d.tabId];
    if (!cid) return;
    if (!raced.has(d.tabId)) raced.set(d.tabId, null);
    await saveCookies(cid, lines, d.url);
    const url = raced.get(d.tabId);
    raced.delete(d.tabId);
    if (url) chrome.tabs.update(d.tabId, { url });
  });
}, { urls: ['<all_urls>'] }, ['responseHeaders', 'extraHeaders']);

chrome.webRequest.onBeforeRequest.addListener(d => {
  if (raced.has(d.tabId) && d.method === 'GET') raced.set(d.tabId, d.url);
}, { urls: ['<all_urls>'], types: ['main_frame'] });

// ---------- navigation: AI URL handler + "always open in" ----------
chrome.webNavigation.onBeforeNavigate.addListener(async d => {
  if (d.frameId !== 0) return;
  const u = new URL(d.url);
  if (u.hostname === 'container.invalid') {
    // https://container.invalid/?name=Work&url=https://example.com/a?b=c   (url last; encoding optional)
    const raw = d.url.match(/[?&]url=(.*)$/)?.[1];
    return openTab(d.tabId, u.searchParams.get('name'), raw ? (/^https?:/i.test(raw) ? raw : decodeURIComponent(raw)) : 'about:blank');
  }
  if ((await tabsP)[d.tabId]) return;
  const { assignments = {} } = await local.get('assignments');
  for (let h = u.hostname; h; h = h.includes('.') ? h.slice(h.indexOf('.') + 1) : '')
    if (assignments[h]) return openTab(d.tabId, assignments[h], d.url);
}, { url: [{ schemes: ['http', 'https'] }] });

// ---------- tab lifecycle ----------
chrome.webNavigation.onCreatedNavigationTarget.addListener(async d => { // links/popups from a container tab stay in it
  const cid = (await tabsP)[d.sourceTabId];
  if (cid) openTab(d.tabId, cid, d.url);
});
chrome.tabs.onRemoved.addListener(async id => { if ((await tabsP)[id]) assign(id, null); });
chrome.tabs.onReplaced.addListener(async (added, removed) => {
  const cid = (await tabsP)[removed];
  if (cid) { await assign(removed, null); await assign(added, cid); }
});
chrome.tabs.onUpdated.addListener(async (id, info) => {
  if (info.status === 'loading') { const cid = (await tabsP)[id]; if (cid) decorate(id, cid).catch(() => {}); }
});

// Tab ids change across browser restarts; the container tab groups survive, so re-attach by group title.
async function restore() {
  const list = await containers();
  for (const g of await chrome.tabGroups.query({})) {
    const c = list.find(c => c.name === g.title);
    if (c) for (const t of await chrome.tabs.query({ groupId: g.id })) openTab(t.id, c.id, t.url);
  }
}
chrome.runtime.onStartup.addListener(restore);
chrome.runtime.onInstalled.addListener(restore);

// ---------- messages (popup, content script, AI bridge) ----------
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  handle(msg, sender).then(r => reply(r ?? {}), e => reply({ error: e.message }));
  return true;
});

async function handle({ cmd, args = {} }, sender) {
  const fromPage = !!sender.tab, tabId = fromPage ? sender.tab.id : args.tabId;
  if (fromPage && !INTERNAL.includes(cmd)) {
    if (!BRIDGE.includes(cmd)) throw Error(`"${cmd}" is not available to web pages`);
    if ((await local.get('bridge')).bridge === false) throw Error('The container API is turned off in the Tab Containers popup');
  }
  const list = await containers(), tabs = await tabsP;
  switch (cmd) {
    case 'getCookies': {
      const cid = tabs[tabId];
      if (!cid) return {};
      const u = new URL(sender.url), now = Date.now();
      return { container: cid, cookie: cookieString(Object.values(await jar(cid)), u.hostname,
        k => !k.httpOnly && !expired(k, now) && (!k.secure || u.protocol === 'https:') && pathMatch(u.pathname, k.path)) };
    }
    case 'setCookie': if (tabs[tabId]) await saveCookies(tabs[tabId], [String(args.cookie)], sender.url, true); return;
    case 'list': return list.map(c => ({ ...c, tabs: Object.values(tabs).filter(x => x === c.id).length }));
    case 'current': return list.find(c => c.id === tabs[tabId]) ?? null;
    case 'create': return create(list, args);
    case 'open': return (await openTab(tabId, args.name, args.url ?? sender.url)) ?? null;
    case 'newTab': { const t = await chrome.tabs.create({}); await assign(t.id, args.id); return; }
    case 'update': {
      const c = find(list, args.id), oldName = c.name;
      c.name = String(args.name || c.name).trim().slice(0, 40);
      if (COLORS[args.color]) c.color = args.color;
      if (ICONS[args.icon]) c.icon = args.icon;
      await local.set({ containers: list });
      for (const g of await chrome.tabGroups.query({ title: oldName })) await chrome.tabGroups.update(g.id, { title: c.name, color: c.color });
      for (const [t, x] of Object.entries(tabs)) if (x === c.id) decorate(+t, c.id).catch(() => {});
      return c;
    }
    case 'remove': { // like Firefox minus closing the tabs: they just leave the container
      for (const [t, x] of Object.entries(tabs)) if (x === args.id) await assign(+t, null);
      const { assignments = {} } = await local.get('assignments');
      for (const h in assignments) if (assignments[h] === args.id) delete assignments[h];
      delete jarsP[args.id];
      await local.remove('jar:' + args.id);
      await local.set({ containers: list.filter(c => c.id !== args.id), assignments });
      return;
    }
    case 'clear': { const j = await jar(args.id); for (const k in j) delete j[k]; await local.set({ ['jar:' + args.id]: j }); await sync(); return; }
    case 'assignSite': {
      const { assignments = {} } = await local.get('assignments');
      if (args.id) assignments[args.host] = args.id; else delete assignments[args.host];
      await local.set({ assignments });
      return;
    }
    case 'setBridge': await local.set({ bridge: !!args.on }); return;
    default: throw Error(`unknown command "${cmd}"`);
  }
}

import http from 'node:http';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { globSync } from 'node:fs';

const EXT = process.argv[2];
const PORT = 8765, B = `http://site.localhost:${PORT}`;
http.createServer((req, res) => {
  const u = new URL(req.url, B), v = u.searchParams.get('v');
  if (u.pathname === '/set') res.writeHead(200, { 'set-cookie': [`sid=${v}; HttpOnly; Path=/`, `js=${v}; Path=/`], 'content-type': 'text/html' }).end('set');
  else if (u.pathname === '/cached') res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'max-age=3600' }).end('<pre id=c>cached</pre>');
  else if (u.pathname === '/private') res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'private, max-age=3600' }).end(`<pre id=c>${req.headers.cookie || ''}</pre>`);
  else if (u.pathname === '/sw.js') res.writeHead(200, { 'content-type': 'text/javascript' }).end(
    "self.oninstall = () => skipWaiting(); self.onactivate = e => e.waitUntil(clients.claim()); self.onfetch = e => e.respondWith(fetch(e.request));");
  else if (u.pathname === '/login') res.writeHead(302, { 'set-cookie': 'sid=redir; HttpOnly; Path=/', location: '/echo' }).end();
  else res.writeHead(200, { 'content-type': 'text/html' }).end(`<pre id=c>${req.headers.cookie || ''}</pre>`);
}).listen(PORT);

const exe = globSync('browsers/chrome/*/chrome-mac-arm64/*.app/Contents/MacOS/Google Chrome for Testing')[0];
const browser = await puppeteer.launch({ executablePath: exe, headless: true, pipe: true,
  enableExtensions: [EXT], args: ['--no-first-run'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cookieOf = async p => p.$eval('#c', e => e.textContent);
const until = async (p, path) => { for (let i = 0; i < 50 && !p.url().includes(path); i++) await sleep(100); await p.waitForSelector('#c'); };
let ok = 0; const check = (name, a, b) => { assert.deepEqual(a, b, name); console.log('ok -', name); ok++; };

try {
  const sw = await browser.waitForTarget(t => t.type() === 'service_worker');
  const a = await browser.newPage();
  await a.goto(`${B}/set?v=default`); await a.goto(`${B}/echo`);
  check('default tab gets real cookies', await cookieOf(a), 'sid=default; js=default');

  const b = await browser.newPage();
  await b.goto(`https://container.invalid/?name=Work&url=${B}/echo`).catch(() => {});
  await until(b, '/echo');
  check('URL handler: container tab starts with no cookies', await cookieOf(b), '');

  await b.goto(`${B}/set?v=work`); await sleep(200); await b.goto(`${B}/echo`);
  check('container tab sees its own cookies', await cookieOf(b), 'sid=work; js=work');
  await a.reload();
  check('default tab untouched', await cookieOf(a), 'sid=default; js=default');

  await sleep(200);
  check('document.cookie shows container jar (no HttpOnly)', await b.evaluate(() => document.cookie), 'js=work');
  await b.evaluate(() => { document.cookie = 'x=1; path=/'; });
  await sleep(300);
  check('document.cookie writes reach requests', await b.evaluate(u => fetch(u).then(r => r.text()), `${B}/echo`), '<pre id=c>sid=work; js=work; x=1</pre>');
  check('default document.cookie untouched', await a.evaluate(() => document.cookie), 'js=default');

  await b.goto(`${B}/login`).catch(() => {}); await sleep(800); await b.waitForSelector('#c');
  check('login redirect carries new cookie', (await cookieOf(b)).includes('sid=redir'), true);

  check('JS API current()', (await b.evaluate(() => __containers.current())).name, 'Work');
  const list = await b.evaluate(() => __containers.list());
  check('JS API list()', list.map(c => c.name).sort(), ['Banking', 'Personal', 'Shopping', 'Work']);
  check('JS API blocks admin cmds', await b.evaluate(() => new Promise(r => {
    addEventListener('message', e => e.data?.__mac === 'res' && e.data.id === 999 && r(e.data.result.error));
    postMessage({ __mac: 'req', id: 999, cmd: 'remove', args: { id: 'work' } }, '*');
  })), '"remove" is not available to web pages');

  const c = await browser.newPage();
  await c.goto(`${B}/echo`);
  check('fresh tab is default', await cookieOf(c), 'sid=default; js=default');
  await c.evaluate(u => __containers.open('Shopping', u), `${B}/echo?s`);
  await until(c, '/echo?s');
  check('JS API open() switches container', await cookieOf(c), '');
  check('JS API current() after open', (await c.evaluate(() => __containers.current())).name, 'Shopping');

  const popupP = new Promise(r => browser.once('targetcreated', t => r(t.page())));
  await b.evaluate(u => window.open(u), `${B}/echo?child`);
  const child = await popupP; await until(child, 'child'); await sleep(500); await child.waitForSelector('#c');
  check('tabs opened from a container tab inherit it', await cookieOf(child), 'sid=redir; js=work; x=1');

  const n = await browser.newPage();
  await n.goto(`https://container.invalid/?name=AI%20Research&url=${encodeURIComponent(B + '/echo?q=1&r=2')}`).catch(() => {});
  await until(n, 'r=2');
  check('URL handler creates container + keeps encoded query', [n.url(), (await n.evaluate(() => __containers.current())).name], [`${B}/echo?q=1&r=2`, 'AI Research']);
  // localStorage (JWT-in-localStorage logins). /cached comes from HTTP cache the 2nd time, so the
  // container marker header must survive caching.
  const d = await browser.newPage();
  await d.goto(`${B}/cached`);
  await d.evaluate(() => { localStorage.tok = 'default'; });
  const w = await browser.newPage();
  await w.goto(`https://container.invalid/?name=Work&url=${B}/cached`).catch(() => {});
  await until(w, '/cached');
  check('container localStorage starts empty (page from HTTP cache)', await w.evaluate(() => [localStorage.getItem('tok'), localStorage.length]), [null, 0]);
  await w.evaluate(() => { localStorage.setItem('tok', 'work'); localStorage.other = '1'; });
  await w.reload();
  check('container localStorage persists, Storage API intact', await w.evaluate(() => [localStorage.tok, Object.keys(localStorage).sort(),
    localStorage.key(0) !== null, localStorage instanceof Storage, JSON.parse(JSON.stringify(localStorage)).tok]), ['work', ['other', 'tok'], true, true, 'work']);
  await d.reload();
  check('default localStorage untouched', await d.evaluate(() => [localStorage.tok, localStorage.getItem('other')]), ['default', null]);
  await w.evaluate(() => localStorage.clear());
  await d.reload();
  check('container clear() leaves default alone', [await w.evaluate(() => localStorage.length), await d.evaluate(() => localStorage.tok)], [0, 'default']);
  check('JS API current() is null outside containers', await d.evaluate(() => __containers.current()), null);

  // Every other same-origin surface. d = normal tab, w = Work tab, both on site.localhost.
  await w.evaluate(() => { localStorage.keep = 'work'; });
  await d.evaluate(() => localStorage.clear());
  await w.reload(); await d.reload();
  check("normal tab's clear() keeps container data; __mac keys hidden",
    [await w.evaluate(() => localStorage.keep), await d.evaluate(() => Object.keys(localStorage).some(k => k.startsWith('__mac')))], ['work', false]);

  await d.evaluate(() => new Promise(r => { const q = indexedDB.open('app'); q.onupgradeneeded = () => q.result.createObjectStore('s'); q.onsuccess = () => r(); }));
  check('IndexedDB isolated', await w.evaluate(() => new Promise(async r => {
    const listed = (await indexedDB.databases()).map(x => x.name);
    const q = indexedDB.open('app'); let fresh = false;
    q.onupgradeneeded = () => { fresh = true; }; q.onsuccess = () => r([listed, fresh, q.result.name]);
  })), [[], true, 'app']);
  check('normal tab does not list container DBs', await d.evaluate(async () => (await indexedDB.databases()).map(x => x.name)), ['app']);

  await d.evaluate(async () => (await caches.open('c')).put('/x', new Response('default')));
  check('Cache Storage isolated', await w.evaluate(async () => [await caches.keys(), await caches.has('c'), !!(await caches.match('/x'))]), [[], false, false]);

  await d.evaluate(() => { window.got = []; new BroadcastChannel('auth').onmessage = e => got.push(e.data); });
  await w.evaluate(() => new BroadcastChannel('auth').postMessage('logout'));
  await sleep(300);
  check('BroadcastChannel isolated', await d.evaluate(() => got), []);

  await d.evaluate(() => { navigator.locks.request('refresh', () => new Promise(() => {})); });
  check('Web Locks isolated', await w.evaluate(() => navigator.locks.request('refresh', { ifAvailable: true }, l => l !== null)), true);

  await d.evaluate(() => { window.ev = []; addEventListener('storage', e => ev.push(e.key)); });
  await w.evaluate(() => { window.ev = []; addEventListener('storage', e => ev.push(e.key)); localStorage.ping = '1'; });
  await d.evaluate(() => { localStorage.pong = '1'; });
  await sleep(300);
  check('storage events stay in their container', [await d.evaluate(() => ev), await w.evaluate(() => ev)], [[], []]);

  check('workers hidden in containers', [await w.evaluate(() => ['serviceWorker' in navigator, typeof SharedWorker]),
    await d.evaluate(() => ['serviceWorker' in navigator, typeof SharedWorker])], [[false, 'undefined'], [true, 'function']]);

  await w.goto(`${B}/set?v=work2`); await sleep(200); await w.goto(`${B}/cached`);
  check('cookieStore shows container cookies', await w.evaluate(async () => (await cookieStore.getAll()).map(c => c.name + '=' + c.value).sort()), ['js=work2', 'x=1']);

  await d.goto(`${B}/private`);
  await w.goto(`${B}/private`);
  check("HTTP cache doesn't replay a normal tab's private response", await cookieOf(w), 'sid=work2; js=work2; x=1');

  // A service worker registered from a normal tab must not serve container tabs.
  await d.goto(`${B}/echo`);
  await d.evaluate(() => navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready));
  await d.reload();
  check('normal tab is SW-controlled', await d.evaluate(() => !!navigator.serviceWorker.controller), true);
  await w.goto(`${B}/echo?sw`).catch(() => {});
  for (let i = 0; i < 30 && !(await w.evaluate(() => !!window[Symbol.for('tab-containers')]).catch(() => false)); i++) await sleep(200);
  await w.waitForSelector('#c');
  check('container tab under a normal-tab SW recovers its isolation', [await cookieOf(w), await w.evaluate(() => !!window[Symbol.for('tab-containers')])], ['sid=work2; js=work2; x=1', true]);

  // "Always open this site in", chosen from the popup while on the site.
  const inC = async p => { for (let i = 0; i < 30 && !(await p.evaluate(() => !!window[Symbol.for('tab-containers')]).catch(() => false)); i++) await sleep(200); return (await p.evaluate(() => __containers.current()))?.name; };
  const e = await browser.newPage();
  await e.goto(`${B}/echo?assign`);
  const pop = await browser.newPage();
  await pop.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
  check('popup opened as a tab is trusted', await pop.evaluate(async u => {
    const t = (await chrome.tabs.query({})).find(t => t.url === u);
    return chrome.runtime.sendMessage({ cmd: 'assignSite', args: { host: 'site.localhost', id: 'banking', tabId: t.id } });
  }, `${B}/echo?assign`), {});
  await pop.close();
  check('always-open-in applies to the current tab at once', await inC(e), 'Banking');
  const f = await browser.newPage();
  await f.goto(`${B}/echo?f`).catch(() => {});
  check('always-open-in applies to new visits', await inC(f), 'Banking');
  console.log(`\n${ok} checks passed`);
} catch (e) { console.error('FAIL:', e.message); process.exitCode = 1; }
finally { await browser.close(); process.exit(); }

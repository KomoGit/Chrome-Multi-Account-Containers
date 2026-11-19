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
  console.log(`\n${ok} checks passed`);
} catch (e) { console.error('FAIL:', e.message); process.exitCode = 1; }
finally { await browser.close(); process.exit(); }

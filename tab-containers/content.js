// Isolated-world relay between the page (page.js / AI agents) and the background worker.
const send = (cmd, args) => chrome.runtime.sendMessage({ cmd, args }).catch(e => ({ error: e.message }));

async function refresh() { // tell page.js which cookies document.cookie should show in this container
  window.postMessage({ __mac: 'cookies', ...(await send('getCookies')) }, '*');
}
refresh();
chrome.runtime.onMessage.addListener(m => { if (m.type === 'refresh') refresh(); });

window.addEventListener('message', async e => {
  const d = e.data;
  if (e.source !== window || !d || typeof d !== 'object') return;
  if (d.__mac === 'req') window.postMessage({ __mac: 'res', id: d.id, result: await send(String(d.cmd), d.args) }, '*');
  else if (d.__mac === 'set') send('setCookie', { cookie: String(d.cookie) });
  else if (d.__mac === 'unscoped') send('unscoped');
});

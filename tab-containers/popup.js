const send = (cmd, args) => chrome.runtime.sendMessage({ cmd, args });
const $ = id => document.getElementById(id);
const form = $('form');
let tab;

for (const c in COLORS) form.color.add(new Option(c, c));
for (const i in ICONS) form.icon.add(new Option(ICONS[i], i));

function row(c) {
  const el = document.createElement('div');
  el.className = 'row';
  el.innerHTML = '<span class="dot"></span><span class="name"></span><span class="n"></span>' +
    '<button data-a="edit" title="Edit">✎</button><button data-a="clear" title="Clear cookies">🧹</button><button data-a="remove" title="Delete">🗑</button>';
  el.querySelector('.dot').style.background = COLORS[c.color];
  el.querySelector('.name').textContent = `${ICONS[c.icon]} ${c.name}`;
  el.querySelector('.n').textContent = c.tabs || '';
  el.onclick = async e => {
    const a = e.target.dataset.a;
    if (!a) { await send('newTab', { id: c.id }); return window.close(); }
    if (a === 'edit') {
      form.name.value = c.name; form.color.value = c.color; form.icon.value = c.icon;
      form.dataset.id = c.id; $('save').textContent = 'Save';
      return form.name.focus();
    }
    if (!e.target.classList.contains('armed')) { e.target.classList.add('armed'); e.target.textContent = 'Sure?'; return; }
    await send(a, { id: c.id });
    render();
  };
  return el;
}

async function render() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const list = await send('list');
  const { assignments = {}, bridge = true } = await chrome.storage.local.get(['assignments', 'bridge']);
  const { tabs = {} } = await chrome.storage.session.get('tabs');
  const host = /^https?:/.test(tab?.url) ? new URL(tab.url).hostname : '';
  const options = () => [new Option('No container', ''), ...list.map(c => new Option(`${ICONS[c.icon]} ${c.name}`, c.id))];
  $('list').replaceChildren(...list.map(row));
  $('move').replaceChildren(...options());
  $('move').value = tabs[tab?.id] || '';
  $('assign').replaceChildren(...options());
  $('assign').value = assignments[host] || '';
  $('assign').disabled = !host;
  $('host').textContent = host || 'this site';
  $('bridge').checked = bridge;
}

$('move').onchange = e => send('open', { tabId: tab.id, name: e.target.value || 'none', url: tab.url }).then(render);
$('assign').onchange = e => send('assignSite', { host: new URL(tab.url).hostname, id: e.target.value }).then(render);
$('bridge').onchange = e => send('setBridge', { on: e.target.checked });
form.onsubmit = async e => {
  e.preventDefault();
  await send(form.dataset.id ? 'update' : 'create', { ...Object.fromEntries(new FormData(form)), id: form.dataset.id });
  form.reset(); delete form.dataset.id; $('save').textContent = 'Add';
  render();
};
render();

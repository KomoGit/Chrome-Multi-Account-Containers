const send = (cmd, args) => chrome.runtime.sendMessage({ cmd, args });
const $ = id => document.getElementById(id);
const form = $('form');
let tab;

for (const c in COLORS) form.color.add(new Option(c, c));

function row(c) {
  const el = document.createElement('div');
  el.className = 'row';
  el.innerHTML = '<span class="dot"></span><span class="name"></span><span class="n"></span>' +
    '<button data-a="edit">Edit</button><button data-a="clear" title="Clear this container\'s cookies">Clear</button><button data-a="remove">Delete</button>';
  el.querySelector('.dot').style.background = COLORS[c.color];
  el.querySelector('.name').textContent = c.name;
  el.querySelector('.n').textContent = c.tabs || '';
  el.onclick = async e => {
    const a = e.target.dataset.a;
    if (!a) { await send('newTab', { id: c.id }); return window.close(); }
    if (a === 'edit') {
      form.name.value = c.name; form.color.value = c.color;
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
  const { assignments = {} } = await chrome.storage.local.get('assignments');
  const host = /^https?:/.test(tab?.url) ? new URL(tab.url).hostname : '';
  const options = () => [new Option('No container', ''), ...list.map(c => new Option(c.name, c.id))];
  $('list').replaceChildren(...list.map(row));
  $('assign').replaceChildren(...options());
  $('assign').value = assignments[host] || '';
  $('assign').disabled = !host;
  $('host').textContent = host || 'this site';
}

$('assign').onchange = e => send('assignSite', { host: new URL(tab.url).hostname, id: e.target.value, tabId: tab.id }).then(render);
form.onsubmit = async e => {
  e.preventDefault();
  await send(form.dataset.id ? 'update' : 'create', { ...Object.fromEntries(new FormData(form)), id: form.dataset.id });
  form.reset(); delete form.dataset.id; $('save').textContent = 'Add';
  render();
};
render();

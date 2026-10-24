// Remote page: pick a box, press keys. Relative URLs, so it works under Home Assistant ingress.
const $ = (id) => document.getElementById(id);
const tabsEl = $('box-tabs');
const addPanel = $('add-panel');
const addOpen = $('add-open');
const remoteEl = $('remote');
const managePanel = $('manage-panel');
const manageOpen = $('manage-open');

let boxes = [];
let selectedId = load('tvbox.selected');
let toastTimer = null;

// The selected box is remembered per phone/browser; storage can be unavailable (private mode)
function load(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not remembered; still works for this visit
  }
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const selected = () => boxes.find((b) => b.id === selectedId);
// A box linked to Android TV Remote is usable through it even while adb is down
const viaAtv = (box) => box.entity && box.route === 'atv';
const stateOf = (box) => (box.connected || viaAtv(box) ? 'on' : box.awaitingApproval ? 'wait' : '');
const stateText = (box) => {
  const adb = box.connected ? `Connected${box.via ? ` via ${box.via}` : ''}`
    : box.awaitingApproval ? 'Waiting for approval on the TV' : 'adb not connected';
  return viaAtv(box) ? `Keys via Android TV Remote · ${adb}` : adb;
};

function select(id) {
  selectedId = id;
  store('tvbox.selected', id);
  setPanel(managePanel, manageOpen, false);
  render();
}

/** Shows or hides a panel and keeps its toggle button's aria-expanded in step. */
function setPanel(panel, toggle, open) {
  panel.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
}

function render() {
  if (!selected() && boxes.length) selectedId = boxes[0].id;

  tabsEl.replaceChildren(...boxes.map((box) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'chip';
    tab.role = 'tab';
    tab.dataset.id = box.id;
    tab.setAttribute('aria-selected', String(box.id === selectedId));
    tab.tabIndex = box.id === selectedId ? 0 : -1;
    tab.title = `${box.name}: ${stateText(box)}`;
    const dot = Object.assign(document.createElement('span'), { className: `dot ${stateOf(box)}` });
    dot.setAttribute('aria-hidden', 'true');
    tab.append(dot, Object.assign(document.createElement('span'), { className: 'label', textContent: box.name }));
    tab.addEventListener('click', () => select(box.id));
    return tab;
  }));

  const box = selected();
  remoteEl.hidden = !box;
  $('add-empty').hidden = boxes.length > 0;
  if (!boxes.length) setPanel(addPanel, addOpen, true);
  if (!box) return;

  $('box-title').textContent = box.name;
  const state = $('box-state');
  state.textContent = `${stateText(box)}${box.model && box.model !== box.name ? ` · ${box.model}` : ''}`;
  state.className = `state ${stateOf(box)}`;
  $('approval').hidden = !box.awaitingApproval;
  // each link with its last known address; the one in use first
  const port = box.port === 5555 ? '' : `:${box.port}`;
  const links = box.links.filter((l) => l.ip)
    .sort((a, b) => Number(b.ip === box.host) - Number(a.ip === box.host))
    .map((l) => `${l.type ?? 'Address'} ${l.ip}${port}${box.connected && l.ip === box.host ? ' (in use)' : ''}`);
  $('box-address').textContent = links.join(' · ') || `Address ${box.host}${port}`;
  if (document.activeElement !== $('rename-name')) $('rename-name').value = box.name;
}

async function refresh() {
  try {
    ({ boxes } = await api('GET', 'api/boxes'));
    render();
  } catch {
    toast('The add-on is not reachable');
  }
  // faster while a TV is waiting for approval, so the page updates as soon as it's accepted
  clearTimeout(refresh.timer);
  refresh.timer = setTimeout(refresh, boxes.some((b) => b.awaitingApproval) ? 1500 : 5000);
}

// Arrow keys move between box tabs (tablist pattern)
tabsEl.addEventListener('keydown', (event) => {
  const index = boxes.findIndex((b) => b.id === selectedId);
  const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
  if (!step || index < 0) return;
  event.preventDefault();
  const next = boxes[(index + step + boxes.length) % boxes.length];
  select(next.id);
  tabsEl.querySelector(`[data-id="${next.id}"]`)?.focus();
});

// --- adding a box ---
addOpen.addEventListener('click', () => setPanel(addPanel, addOpen, addPanel.hidden));
$('add-close').addEventListener('click', () => setPanel(addPanel, addOpen, false));

async function addBox(host, port, name) {
  const box = await api('POST', 'api/boxes', { host, port, name });
  await refresh();
  select(box.id);
  if (boxes.length) setPanel(addPanel, addOpen, false);
}

const ADB_NOTE = { auth: 'Asks for approval on the TV', open: 'No approval needed', no: 'Not an adb device' };

$('scan').addEventListener('click', async () => {
  const button = $('scan');
  const list = $('found');
  button.disabled = true;
  $('scan-state').textContent = 'Searching the network…';
  list.replaceChildren();
  try {
    const { found } = await api('GET', 'api/scan');
    const usable = found.filter((d) => d.adb !== 'no');
    $('scan-state').textContent = usable.length ? '' : 'No box found. Is adb over the network on? You can also type the address below.';
    for (const device of usable) {
      const li = document.createElement('li');
      const what = Object.assign(document.createElement('span'), { className: 'what' });
      what.append(device.model ? `${device.model} · ${device.host}` : device.host,
        Object.assign(document.createElement('span'), { className: 'note', textContent: ADB_NOTE[device.adb] }));
      const action = Object.assign(document.createElement('button'), { type: 'button' });
      if (device.added) {
        action.textContent = 'Open';
        action.addEventListener('click', () => { select(device.added); setPanel(addPanel, addOpen, false); });
      } else {
        action.textContent = 'Add';
        action.setAttribute('aria-label', `Add ${device.model || device.host}`);
        action.addEventListener('click', () => addBox(device.host, device.port, device.model).catch((err) => toast(err.message)));
      }
      li.append(what, action);
      list.append(li);
    }
  } catch (err) {
    $('scan-state').textContent = `Search failed: ${err.message}`;
  } finally {
    button.disabled = false;
  }
});

$('manual').addEventListener('submit', async (event) => {
  event.preventDefault();
  const [host, port] = $('manual-host').value.trim().split(':');
  try {
    await addBox(host, port ? Number(port) : 5555);
    $('manual-host').value = '';
  } catch (err) {
    toast(err.message === 'invalid host' ? 'That address doesn\'t look right' : err.message);
  }
});

// --- managing the selected box ---
manageOpen.addEventListener('click', () => {
  const open = managePanel.hidden;
  setPanel(managePanel, manageOpen, open);
  if (open) loadRemotes();
});

/** Fills the Android TV Remote choice with Home Assistant's remote entities. */
async function loadRemotes() {
  const selectEl = $('atv-entity');
  const box = selected();
  if (!box) return;
  try {
    const { enabled, remotes } = await api('GET', 'api/remotes');
    $('atv-row').hidden = !enabled;
    const options = [{ entity: '', name: 'Not used (adb only)' }, ...remotes];
    // keep a linked entity listed even if Home Assistant doesn't report it right now
    if (box.entity && !remotes.some((r) => r.entity === box.entity)) options.push({ entity: box.entity, name: `${box.entity} (not found)` });
    selectEl.replaceChildren(...options.map((r) => Object.assign(document.createElement('option'), {
      value: r.entity, textContent: r.state === 'unavailable' ? `${r.name} (unavailable)` : r.name,
    })));
    selectEl.value = box.entity ?? '';
  } catch (err) {
    $('atv-row').hidden = true;
    toast(`Android TV Remote list: ${err.message}`);
  }
}

$('atv-entity').addEventListener('change', async (event) => {
  try {
    await api('PATCH', `api/boxes/${selectedId}`, { entity: event.target.value || null });
    refresh();
  } catch (err) {
    toast(err.message);
  }
});

$('rename').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('PATCH', `api/boxes/${selectedId}`, { name: $('rename-name').value });
    setPanel(managePanel, manageOpen, false);
    $('rename-name').blur();
    refresh();
  } catch (err) {
    toast(err.message);
  }
});

$('remove').addEventListener('click', async () => {
  const box = selected();
  if (!box || !confirm(`Remove “${box.name}” from this remote? Its TV keeps trusting the remote until you revoke it there.`)) return;
  try {
    await api('DELETE', `api/boxes/${box.id}`);
    setPanel(managePanel, manageOpen, false);
    selectedId = null;
    refresh();
  } catch (err) {
    toast(err.message);
  }
});

// --- keys ---
async function press(button) {
  const box = selected();
  if (!box) return;
  button.classList.add('pressed');
  button.classList.remove('failed');
  try {
    await api('POST', `api/boxes/${box.id}/key/${button.dataset.key}`);
  } catch (err) {
    button.classList.add('failed');
    toast(`${box.name}: ${err.message}`);
  } finally {
    button.classList.remove('pressed');
  }
}

// Held D-pad and volume keys repeat, like a real remote
const REPEAT = new Set(['up', 'down', 'left', 'right', 'volume_up', 'volume_down']);
let repeatTimer = null;
const stopRepeat = () => clearTimeout(repeatTimer);

document.querySelectorAll('button[data-key]').forEach((button) => {
  button.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    press(button);
    if (REPEAT.has(button.dataset.key)) {
      repeatTimer = setTimeout(function again() {
        press(button);
        repeatTimer = setTimeout(again, 150);
      }, 450);
    }
  });
  // keyboard users: Enter/Space activate the button once
  button.addEventListener('click', (event) => { if (event.detail === 0) press(button); });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) button.addEventListener(type, stopRepeat);
});

$('type').addEventListener('submit', async (event) => {
  event.preventDefault();
  const box = selected();
  const input = $('text');
  if (!box || !input.value) return;
  try {
    await api('POST', `api/boxes/${box.id}/text`, { text: input.value });
    input.value = '';
  } catch (err) {
    toast(`${box.name}: ${err.message}`);
  }
});

// "Install as an app": Chrome installs only from the https address with Home Assistant's certificate
async function showInstallLink() {
  const standalone = matchMedia('(display-mode: standalone)').matches;
  try {
    const { installUrl } = await api('GET', 'api/status');
    if (!installUrl || standalone || location.href.startsWith(installUrl)) return;
    const link = $('install');
    link.href = installUrl;
    link.hidden = false;
  } catch {
    // no link; the remote itself still works
  }
}

refresh();
showInstallLink();

// App shell: session list, SSE live updates, tabs, replay, inspector.
import { el, fmt, debounce } from './util.js';
import { TABS, renderLoop, renderTrace, renderContext, renderTokens, renderHooks, renderLearn, renderInspector, renderRequestBody, badge } from './views.js';

const $ = (id) => document.getElementById(id);
const state = {
  sessions: [], live: [], claudeDir: '', filter: '',
  current: null,        // {id, slug, path, live, snapshot}
  scope: null,          // agentId when viewing a subagent
  tab: 'loop', cursor: 0, follow: true, playing: false, speed: 5, traceLimit: 40, reqIndex: null,
  hooks: [], hookConfig: null, sse: null, inspector: null,
  search: { q: '', results: null, index: -1, loading: false, focused: false, seq: 0, all: false },
};

// ---- theme (light / system / dark, like the audit console) --------------------
function applyTheme() {
  const t = localStorage.getItem('xray-theme') || 'system';
  if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  for (const b of document.querySelectorAll('#theme button')) b.classList.toggle('active', b.dataset.theme === t);
}
for (const b of document.querySelectorAll('#theme button')) b.addEventListener('click', () => { localStorage.setItem('xray-theme', b.dataset.theme); applyTheme(); });
applyTheme();
$('sidebar-toggle').addEventListener('click', () => $('shell').classList.toggle('no-sidebar'));

// ---- data -------------------------------------------------------------------
async function api(path) { const r = await fetch(path); if (!r.ok) throw new Error(`${r.status} ${path}`); return r.json(); }

function liveFor(id) { return state.live.find((l) => l.sessionId === id && l.alive) || null; }

async function loadSessions() {
  const d = await api('/api/sessions');
  state.sessions = d.sessions; state.live = d.live; state.claudeDir = d.claudeDir;
  renderSidebar();
  if (!state.current) {
    const fromHash = new URLSearchParams(location.hash.slice(1)).get('session');
    const pick = fromHash || (state.live.find((l) => l.alive && state.sessions.some((s) => s.id === l.sessionId)) || {}).sessionId || (state.sessions[0] || {}).id;
    if (pick) openSession(pick);
  } else { state.current.live = liveFor(state.current.id); renderHeader(); }
}

async function openSession(id) {
  if (state.current && state.current.id === id) return;
  state.current = { id, loading: true }; state.scope = null; state.cursor = 0; state.follow = true; state.playing = false; state.reqIndex = null; state.traceLimit = 40;
  state.hooks = []; resetSearch();
  renderSidebar(); renderHeader();
  $('view').innerHTML = '<div class="empty">Loading session…</div>';
  try {
    const [d, hooks, cfg] = await Promise.all([api('/api/session/' + id), api('/api/hooks?session=' + id), api('/api/hook-config')]);
    if (!state.current || state.current.id !== id) return;
    state.current = { ...d, live: liveFor(id) };
    state.hooks = hooks; state.hookConfig = cfg;
    state.cursor = Math.max(0, d.snapshot.records.length - 1);
    const p = new URLSearchParams(location.hash.slice(1)); p.set('session', id); p.set('tab', state.tab); location.hash = p.toString();
    connectSSE(id);
    renderAll();
  } catch (e) { $('view').innerHTML = `<div class="empty">Could not load session: ${e.message}</div>`; }
}

function connectSSE(id) {
  if (state.sse) state.sse.close();
  const es = new EventSource('/api/events?session=' + id);
  state.sse = es;
  es.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'sessions') { state.sessions = msg.sessions; state.live = msg.live; if (state.current) state.current.live = liveFor(state.current.id); renderSidebar(); renderHeader(); return; }
    if (msg.type === 'hook') { state.hooks.push(msg.hook); if (state.hooks.length > 3000) state.hooks.shift(); if (state.tab === 'hooks' || state.tab === 'loop') scheduleRender(); if (state.hookConfig) state.hookConfig.received++; return; }
    if (!state.current || msg.sessionId !== state.current.id) return;
    if (msg.type === 'delta') {
      const snap = msg.agentId ? state.current.snapshot.subagents.find((a) => a.meta.agentId === msg.agentId) : state.current.snapshot;
      if (!snap) return;
      applyDelta(snap, msg.delta);
      if (!msg.agentId && state.follow) state.cursor = Math.max(0, snap.records.length - 1);
      if (msg.agentId) { const parent = state.current.snapshot; parent.totals = parent.totals; } // parent totals exclude subagents by design
      scheduleRender();
    } else if (msg.type === 'agent') {
      const list = state.current.snapshot.subagents;
      if (!list.some((a) => a.meta.agentId === msg.agentId)) list.push(msg.snapshot);
      scheduleRender();
    }
  };
}

function applyDelta(snap, d) {
  if (d.entry) snap.records[d.entry.n] = d.entry;
  for (const k of ['turns', 'calls', 'tools', 'attachments', 'events', 'apiRequests', 'compactions']) for (const [i, v] of Object.entries(d[k] || {})) snap[k][Number(i)] = v;
  if (d.cost) snap.cost = d.cost;
  if (d.shapes) for (const s of d.shapes) { const i = snap.shapes.findIndex((x) => x.hash === s.hash); if (i >= 0) snap.shapes[i] = s; else snap.shapes.push(s); }
  if (d.toolMix) snap.toolMix = d.toolMix;
  snap.totals = d.totals; snap.phase = d.phase; snap.info = d.info; snap.n = snap.records.length;
}

// ---- rendering ----------------------------------------------------------------
const scheduleRender = debounce(() => renderView(), 120);

function renderSidebar() {
  const sb = $('sidebar'); sb.innerHTML = '';
  sb.append(el('div', { class: 'search' }, el('input', { type: 'search', placeholder: 'Filter sessions…', value: state.filter, onInput: (e) => { state.filter = e.target.value.toLowerCase(); renderSidebar(); } })));
  const f = state.filter;
  const match = (s) => !f || [s.title, s.agentName, s.firstPrompt, s.project, s.id, s.model].some((x) => x && String(x).toLowerCase().includes(f));
  const liveIds = new Set(state.live.filter((l) => l.alive).map((l) => l.sessionId));
  const item = (s, live) => el('div', { class: 'sess' + (state.current && state.current.id === s.id ? ' active' : ''), onClick: () => openSession(s.id) },
    el('div', { class: 't' }, live ? el('span', { class: 'live-dot' + (live.status === 'busy' ? ' busy' : '') }) : null, s.title || s.agentName || s.firstPrompt || s.id.slice(0, 8)),
    el('div', { class: 'p' }, s.project), el('div', { class: 'm' }, fmt.ago(s.mtime)),
    el('div', { class: 'p' }, `${s.model ? s.model.replace('claude-', '') : '?'} · v${s.version || '?'}${s.subagents ? ' · ' + s.subagents + ' agents' : ''}`), el('div', { class: 'm' }, fmt.bytes(s.size)));
  const liveList = state.sessions.filter((s) => liveIds.has(s.id) && match(s));
  const pad = (n) => String(n).padStart(2, '0');
  if (liveList.length) { sb.append(el('h3', {}, 'Live now', el('span', { class: 'num' }, '// ' + pad(liveList.length)))); for (const s of liveList) sb.append(item(s, state.live.find((l) => l.sessionId === s.id))); }
  const rest = state.sessions.filter((s) => !liveIds.has(s.id) && match(s));
  sb.append(el('h3', {}, 'Recent', el('span', { class: 'num' }, '// ' + pad(rest.length))));
  for (const s of rest.slice(0, 300)) sb.append(item(s, null));
  if (!state.sessions.length) sb.append(el('div', { class: 'empty' }, 'No sessions found under ' + state.claudeDir));
}

function currentSnap() {
  if (!state.current || !state.current.snapshot) return null;
  if (state.scope) return state.current.snapshot.subagents.find((a) => a.meta.agentId === state.scope) || state.current.snapshot;
  return state.current.snapshot;
}

function renderHeader() {
  const h = $('session-head'); h.innerHTML = '';
  const c = state.current; if (!c || !c.snapshot) { if (c && c.loading) h.append(el('span', { class: 'muted' }, 'loading…')); return; }
  const snap = currentSnap(); const info = snap.info; const t = snap.totals;
  const meta = state.sessions.find((s) => s.id === c.id) || {};
  if (state.scope) h.append(el('button', { class: 'small', onClick: () => setScope(null) }, '← main session'), el('span', { class: 'chip' }, 'subagent ', el('b', {}, (snap.meta.agentType || '') + ' · ' + (snap.meta.description || state.scope))));
  else h.append(el('b', { class: 'title', title: c.path }, meta.title || meta.agentName || meta.firstPrompt || c.id), el('span', { class: 'chip' }, meta.project || ''));
  if (c.live) h.append(el('span', { class: 'chip' }, el('span', { class: 'live-dot' + (c.live.status === 'busy' ? ' busy' : '') }), `live · ${c.live.status || '?'} · pid ${c.live.pid}`));
  h.append(el('span', { class: 'chip' }, 'model ', el('b', {}, (info.model || '?').replace('claude-', ''))), el('span', { class: 'chip opt' }, 'v', el('b', {}, info.version || '?')), el('span', { class: 'chip' }, el('b', {}, fmt.int(t.turns)), ' turns'), el('span', { class: 'chip' }, el('b', {}, fmt.int(t.calls)), ' calls'), el('span', { class: 'chip opt' }, el('b', {}, fmt.int(t.tools)), ' tools'), el('span', { class: 'chip' }, 'ctx ', el('b', {}, fmt.tokens(t.contextNow))), el('span', { class: 'chip' }, 'out ', el('b', {}, fmt.tokens(t.output))), el('span', { class: 'chip opt', title: 'permission mode' }, info.permissionMode || 'mode ?'));
  if (snap.cost && snap.cost.totalCostUSD != null) h.append(el('span', { class: 'chip', title: 'cost as recorded by Claude Code' }, el('b', {}, fmt.usd(snap.cost.totalCostUSD))));
}

function renderTabs() {
  const n = $('tabs'); n.innerHTML = '';
  for (const [id, label] of TABS) n.append(el('div', { class: 'tab' + (state.tab === id ? ' active' : ''), onClick: () => setTab(id) }, label));
}

function ctx() {
  const snap = currentSnap();
  return {
    snap, session: state.current, agentId: state.scope, live: state.scope ? null : state.current.live, hooks: state.hooks.filter((h) => !h.sessionId || h.sessionId === state.current.id), hookConfig: state.hookConfig,
    cursor: Math.min(state.cursor, Math.max(0, snap.records.length - 1)), follow: state.follow, playing: state.playing, speed: state.speed, traceLimit: state.traceLimit, reqIndex: state.reqIndex,
    setCursor, setFollow, togglePlay, setSpeed: (s) => { state.speed = s; }, setTraceLimit: (l) => { state.traceLimit = l; renderView(); }, setReqIndex: (i) => { state.reqIndex = i; renderView(); },
    setTab, setScope, openInspector, openShape, openRequest,
    search: state.search, setSearch, searchStep, searchJump, setSearchAll: (v) => { state.search.all = v; if (state.search.q) fetchSearch(); else renderView(); },
  };
}

async function renderView() {
  renderHeader(); renderTabs();
  const v = $('view');
  const snap = currentSnap();
  if (!snap) return;
  if (snap.summaryOnly) {
    v.innerHTML = '<div class="empty">Loading subagent…</div>';
    try { const full = await api(`/api/session/${state.current.id}/agent/${state.scope}`); const i = state.current.snapshot.subagents.findIndex((a) => a.meta.agentId === state.scope); if (i >= 0) state.current.snapshot.subagents[i] = full; } catch (e) { v.innerHTML = `<div class="empty">${e.message}</div>`; return; }
  }
  const c = ctx();
  const sameTab = renderView.lastTab === state.tab && renderView.lastScope === state.scope;
  renderView.lastTab = state.tab; renderView.lastScope = state.scope;
  const scrollTop = sameTab ? v.scrollTop : 0;
  let node;
  try {
    node = { loop: renderLoop, trace: renderTrace, context: renderContext, tokens: renderTokens, hooks: renderHooks, learn: renderLearn }[state.tab](c);
  } catch (e) { console.error(e); node = el('div', { class: 'empty' }, 'Render error: ' + e.message); }
  v.innerHTML = ''; v.append(node);
  if (state.tab !== 'loop') v.scrollTop = scrollTop;
}
function renderAll() { renderSidebar(); renderView(); }

// ---- transcript search -----------------------------------------------------------
function resetSearch() { const all = state.search ? state.search.all : false; state.search = { q: '', results: null, index: -1, loading: false, focused: false, seq: 0, all }; }
const fetchSearch = debounce(async () => {
  const S = state.search; const seq = ++S.seq; const q = S.q;
  if (q.length < 2 || !state.current) { S.results = null; S.index = -1; S.loading = false; renderView(); return; }
  S.loading = true; renderView();
  try {
    const r = await api(`/api/session/${state.current.id}/search?q=${encodeURIComponent(q)}${state.scope ? '&agent=' + state.scope : ''}${S.all ? '&all=1' : ''}`);
    if (seq !== S.seq) return; // a newer query is in flight
    S.results = r; S.index = r.hits.length ? 0 : -1; S.loading = false;
    if (r.hits.length) { state.cursor = r.hits[0].n; state.follow = false; }
  } catch (e) { S.results = { q, total: 0, hits: [], error: e.message }; S.loading = false; }
  renderView();
}, 250);
function setSearch(q) { state.search.q = q; state.search.focused = true; if (!q) { state.search.results = null; state.search.index = -1; state.search.loading = false; renderView(); return; } fetchSearch(); }
function searchJump(idx) { const S = state.search; if (!S.results || !S.results.hits[idx]) return; S.index = idx; state.cursor = S.results.hits[idx].n; state.follow = false; state.playing = false; renderView(); }
function searchStep(dir) { const S = state.search; if (!S.results || !S.results.hits.length) return; searchJump((S.index + dir + S.results.hits.length) % S.results.hits.length); }

// ---- interactions --------------------------------------------------------------
function setTab(id) { state.tab = id; const p = new URLSearchParams(location.hash.slice(1)); p.set('tab', id); location.hash = p.toString(); renderView(); }
function setScope(agentId) { resetSearch(); state.scope = agentId; state.cursor = 0; state.follow = !agentId; state.playing = false; state.traceLimit = 40; state.reqIndex = null; closeInspector(); renderView(); }
function setCursor(n) { state.cursor = n; state.follow = false; if (state.tab === 'loop') renderView(); }
function setFollow(on) { state.follow = on; if (on) { state.playing = false; const s = currentSnap(); state.cursor = Math.max(0, s.records.length - 1); } renderView(); }
let playTimer = null;
function togglePlay() {
  state.playing = !state.playing; state.follow = false;
  clearInterval(playTimer);
  if (state.playing) {
    const s = currentSnap(); if (state.cursor >= s.records.length - 1) state.cursor = 0;
    playTimer = setInterval(() => { const snap = currentSnap(); if (!snap || state.cursor >= snap.records.length - 1) { state.playing = false; clearInterval(playTimer); renderView(); return; } state.cursor++; renderView(); }, Math.max(40, 400 / state.speed));
  }
  renderView();
}

async function openInspector(n, agentId) {
  const insp = $('inspector'); $('shell').classList.add('with-inspector');
  const snap = agentId ? state.current.snapshot.subagents.find((a) => a.meta.agentId === agentId) : state.current.snapshot;
  const entry = snap ? snap.records[n] : null;
  renderInspector(insp, { entry, loading: true, onClose: closeInspector });
  try {
    const raw = await api(`/api/session/${state.current.id}/record/${n}${agentId ? '?agent=' + agentId : ''}`);
    renderInspector(insp, { entry, raw, onClose: closeInspector, onReconstruct: (n) => openRequest(n, agentId) });
  } catch (e) { renderInspector(insp, { entry, error: e.message, onClose: closeInspector }); }
}
async function openShape(hash, blockIndex) {
  const insp = $('inspector'); $('shell').classList.add('with-inspector');
  renderInspector(insp, { title: 'system prompt block ' + blockIndex, loading: true, onClose: closeInspector });
  try {
    const shape = await api(`/api/session/${state.current.id}/shape/${hash}`);
    const block = (shape.system || [])[blockIndex] || {};
    insp.innerHTML = '';
    insp.append(el('div', { class: 'head row' }, el('div', { class: 'grow' }, el('b', {}, `system[${blockIndex}]`), el('span', { class: 'muted', style: { marginLeft: '8px' } }, `${fmt.int((block.text || '').length)} chars`)), el('button', { class: 'small ghost', onClick: closeInspector }, '✕')),
      el('div', { class: 'body' }, el('p', { class: 'muted', style: { fontSize: '12px' } }, 'This is the exact text sent as a system block on every API call of this shape.' + (block.cache_control ? ' It carries a cache_control breakpoint.' : '')), el('pre', { class: 'mono', style: { maxHeight: '80vh' } }, block.text || JSON.stringify(block, null, 2))));
  } catch (e) { renderInspector(insp, { title: 'shape', error: e.message, onClose: closeInspector }); }
}
async function openRequest(n, agentId = state.scope) {
  closeModal();
  const back = el('div', { class: 'modal-backdrop', onClick: (e) => { if (e.target === back) closeModal(); } }, el('div', { class: 'modal' }, el('div', { class: 'empty' }, 'rebuilding request body…')));
  back.id = 'modal'; document.body.append(back);
  try {
    const data = await api(`/api/session/${state.current.id}/request/${n}${agentId ? '?agent=' + agentId : ''}`);
    back.innerHTML = ''; back.append(renderRequestBody(data, { sessionId: state.current.id, agentId, onClose: closeModal }));
  } catch (e) { back.innerHTML = ''; back.append(el('div', { class: 'modal' }, el('div', { class: 'empty' }, 'could not rebuild: ' + e.message))); }
}
function closeModal() { const m = document.getElementById('modal'); if (m) m.remove(); }
function closeInspector() { $('inspector').hidden = true; $('shell').classList.remove('with-inspector'); }

window.addEventListener('hashchange', () => { const p = new URLSearchParams(location.hash.slice(1)); const id = p.get('session'); const tab = p.get('tab'); if (tab && tab !== state.tab && TABS.some((t) => t[0] === tab)) { state.tab = tab; renderView(); } if (id && (!state.current || state.current.id !== id)) openSession(id); });
document.addEventListener('keydown', (e) => { if (e.target.tagName === 'INPUT') return; if (e.key === 'Escape') { if (document.getElementById('modal')) closeModal(); else closeInspector(); } if (state.tab === 'loop' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { const s = currentSnap(); if (!s) return; setCursor(Math.max(0, Math.min(s.records.length - 1, state.cursor + (e.key === 'ArrowRight' ? 1 : -1)))); } if (e.key === ' ' && state.tab === 'loop') { e.preventDefault(); togglePlay(); } });

const p0 = new URLSearchParams(location.hash.slice(1)); if (p0.get('tab') && TABS.some((t) => t[0] === p0.get('tab'))) state.tab = p0.get('tab');
window.__xray = state; // debugging handle
renderTabs();
loadSessions().catch((e) => { $('view').innerHTML = `<div class="empty">Could not reach the server: ${e.message}</div>`; });

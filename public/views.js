// View renderers. Each takes a ctx object built by app.js and returns a DOM node.
import { el, svg, fmt, highlightJson, copyText } from './util.js';
import { stackedBars, legend, hBars, waterfall, showTip, hideTip } from './charts.js';
import { RECORD_KINDS, ATTACHMENT_KINDS, HOOK_EVENT_DOCS, phaseAt } from '/lib/parser.mjs';

export const TABS = [['loop', 'Loop'], ['trace', 'Trace'], ['context', 'Context'], ['tokens', 'Tokens'], ['hooks', 'Hooks'], ['learn', 'Learn']];

const KIND_BADGE = { prompt: 'prompt', meta: 'meta', assistant: 'assistant', tool_result: 'tool_result', attachment: 'attachment', system: 'system', 'api-request': 'api-request', blob: 'blob', shape: 'shape', sidechain: 'sidechain', compaction: 'compaction' };
export function badge(kind) { return el('span', { class: 'badge ' + (KIND_BADGE[kind] || 'other') }, kind); }

function card(title, explain, ...body) { return el('div', { class: 'card' }, title ? el('h2', {}, title) : null, explain ? el('p', { class: 'explain' }, explain) : null, ...body); }
function tile(k, v, s) { return el('div', { class: 'tile' }, el('div', { class: 'k' }, k), el('div', { class: 'v' }, v), s ? el('div', { class: 's' }, s) : null); }
function table(headers, rows) {
  return el('table', {}, el('thead', {}, el('tr', {}, headers.map((h) => el('th', { class: typeof h === 'object' ? h.class : '' }, typeof h === 'object' ? h.label : h)))), el('tbody', {}, rows));
}
const tdn = (v) => el('td', { class: 'num' }, v);

// Tool names as chips grouped by origin (built-in vs each MCP server). Long MCP
// names never wrap mid-word; the full name is in the title attribute.
export function toolChips(names, onClick) {
  const groups = new Map();
  for (const name of names) {
    const m = /^mcp__(.+?)__(.+)$/.exec(name);
    const g = m ? 'mcp · ' + m[1] : 'built-in';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ name, short: m ? m[2] : name });
  }
  const order = [...groups.keys()].sort((a, b) => (a === 'built-in' ? -1 : b === 'built-in' ? 1 : a.localeCompare(b)));
  return el('div', { class: 'toolgroups' }, order.map((g) => el('div', { class: 'toolgroup' },
    el('div', { class: 'label' }, g, el('span', { class: 'num' }, ' // ' + String(groups.get(g).length).padStart(2, '0'))),
    el('div', { class: 'chips' }, groups.get(g).map((t) => el('span', { class: 'chip' + (onClick ? ' clickable' : ''), title: t.name, onClick: onClick ? () => onClick(t.name) : null }, t.short))))));
}
// Precise picker for long ranges: first/prev/next/last, a typeable number, and a range.
export function stepper({ value, max, onChange, title }) {
  const clamp = (v) => Math.max(0, Math.min(max, Number.isFinite(v) ? v : 0));
  const num = el('input', { type: 'number', class: 'stepnum', min: 1, max: max + 1, value: value + 1, title: title || 'type a number and press Enter',
    onChange: (e) => onChange(clamp(Number(e.target.value) - 1)), onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); onChange(clamp(Number(e.target.value) - 1)); } } });
  return el('div', { class: 'stepper' },
    el('button', { class: 'small ghost', title: 'first', disabled: value <= 0, onClick: () => onChange(0) }, '«'),
    el('button', { class: 'small ghost', title: 'previous (←)', disabled: value <= 0, onClick: () => onChange(clamp(value - 1)) }, '‹'),
    num, el('span', { class: 'mono muted', style: { whiteSpace: 'nowrap' } }, `/ ${max + 1}`),
    el('button', { class: 'small ghost', title: 'next (→)', disabled: value >= max, onClick: () => onChange(clamp(value + 1)) }, '›'),
    el('button', { class: 'small ghost', title: 'last', disabled: value >= max, onClick: () => onChange(max) }, '»'),
    el('input', { type: 'range', min: 0, max, value, onInput: (e) => onChange(Number(e.target.value)) }));
}
export function chips(items) { return el('div', { class: 'chips' }, items.map((x) => el('span', { class: 'chip', title: x }, x))); }

// ---------------------------------------------------------------- Loop ----
// Five columns on a 1110-wide canvas; row 1 flows right, row 2 flows left back to the loop.
const COL = [20, 240, 460, 680, 900], NW = 190, NH = 60, ROW1 = 40, ROW2 = 200;
const NODES = [
  { id: 'user', col: 0, row: 1, label: 'User prompt', sub: 'typed · queued · hook', color: 'var(--c-user)' },
  { id: 'assemble', col: 1, row: 1, label: 'Assemble context', sub: 'system · tools · history', color: 'var(--c-harness)' },
  { id: 'api', col: 2, row: 1, label: 'API request', sub: 'cached prefix + new tail', color: 'var(--c-model)' },
  { id: 'model', col: 3, row: 1, label: 'Model streams', sub: 'thinking · text · tool_use', color: 'var(--c-model)' },
  { id: 'decide', col: 4, row: 1, label: 'stop_reason?', diamond: true },
  { id: 'idle', col: 4, row: 2, label: 'Stop hook → idle', sub: 'end_turn · waiting for you', color: 'var(--c-user)' },
  { id: 'permission', col: 3, row: 2, label: 'Permission + hooks', sub: 'rules · mode · PreToolUse', color: 'var(--c-harness)' },
  { id: 'exec', col: 2, row: 2, label: 'Execute tool', sub: 'Bash · Edit · MCP · Agent', color: 'var(--c-tool)' },
  { id: 'result', col: 1, row: 2, label: 'tool_result', sub: 'appended as user message', color: 'var(--c-tool)' },
].map((n) => ({ ...n, x: COL[n.col], y: n.row === 1 ? ROW1 : ROW2, w: NW }));
const PHASE_NODE = { prompt: 'user', assemble: 'assemble', compacting: 'assemble', api: 'api', streaming: 'model', tool: 'exec', permission: 'permission', idle: 'idle', ended: 'idle' };

export function loopDiagram(phase, live) {
  const active = PHASE_NODE[phase] || null;
  const root = svg('svg', { viewBox: '0 0 1110 280', class: 'loop-svg' });
  const marker = (id, fill) => svg('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, svg('path', { d: 'M0 0 L10 5 L0 10 z', fill }));
  root.append(svg('defs', {}, marker('arr', 'var(--hairline-strong)'), marker('arr-active', 'var(--ink)')));
  const N = Object.fromEntries(NODES.map((n) => [n.id, n]));
  const cx = (n) => n.x + n.w / 2, cy = (n) => n.y + NH / 2;
  const right = (a, b) => `M${a.x + a.w} ${cy(a)} H${b.x}`;
  const left = (a, b) => `M${a.x} ${cy(a)} H${b.x + b.w}`;
  const forkY = ROW1 + NH + 48;                 // where tool_use branches off the trunk below the diamond
  const EDGES = [
    { to: 'assemble', d: right(N.user, N.assemble) },
    { to: 'api', d: right(N.assemble, N.api) },
    { to: 'model', d: right(N.api, N.model) },
    { to: 'decide', d: right(N.model, N.decide) },
    { to: 'idle', d: `M${cx(N.decide)} ${N.decide.y + NH + 6} V${N.idle.y}`, label: 'end_turn', lx: cx(N.decide) + 10, ly: forkY + 30 },
    { to: 'permission', d: `M${cx(N.decide)} ${N.decide.y + NH + 6} V${forkY} H${cx(N.permission)} V${N.permission.y}`, label: 'tool_use', lx: (cx(N.permission) + cx(N.decide)) / 2, ly: forkY - 8, anchor: 'middle' },
    { to: 'exec', d: left(N.permission, N.exec) },
    { to: 'result', d: left(N.exec, N.result) },
    { to: 'assemble', loop: true, d: `M${cx(N.result)} ${N.result.y} V${N.assemble.y + NH}`, label: 'next call', lx: cx(N.result) + 10, ly: (N.assemble.y + NH + N.result.y) / 2 + 4 },
  ];
  for (const e of EDGES) {
    const isActive = active === e.to && (!e.loop || phase === 'assemble');
    root.append(svg('path', { d: e.d, class: 'edge' + (isActive ? ' active' : ''), 'marker-end': isActive ? 'url(#arr-active)' : 'url(#arr)' }));
    if (e.label) root.append(svg('text', { x: e.lx, y: e.ly, class: 'edge-label', 'text-anchor': e.anchor || 'start' }, e.label));
  }
  for (const n of NODES) {
    const isActive = active === n.id;
    if (n.diamond) {
      const g = svg('g', { class: 'node' });
      g.append(svg('path', { d: `M${cx(n)} ${n.y - 8} L${n.x + n.w} ${cy(n)} L${cx(n)} ${n.y + NH + 8} L${n.x} ${cy(n)} z`, class: 'decision' + (isActive ? ' active' : '') }));
      g.append(svg('text', { x: cx(n), y: cy(n) + 4, 'text-anchor': 'middle' }, n.label));
      root.append(g);
      continue;
    }
    const g = svg('g', { class: 'node' + (isActive ? ' active' : '') + (isActive && live ? ' pulse' : ''), style: `--node-color:${n.color}` });
    g.append(svg('rect', { x: n.x, y: n.y, width: n.w, height: NH, rx: 3, stroke: n.color }));
    g.append(svg('text', { x: cx(n), y: n.y + 26, 'text-anchor': 'middle' }, n.label));
    g.append(svg('text', { x: cx(n), y: n.y + 45, 'text-anchor': 'middle', class: 'sub' }, n.sub));
    root.append(g);
  }
  return root;
}

function atCursor(snap, n) {
  const turn = [...snap.turns].reverse().find((t) => t.n <= n) || null;
  const callsInTurn = turn ? turn.calls.map((i) => snap.calls[i]).filter((c) => c && c.n <= n) : [];
  const toolsInTurn = turn ? snap.tools.filter((t) => t.turnIndex === turn.index && t.n <= n) : [];
  const lastCall = [...snap.calls].reverse().find((c) => c.n <= n) || null;
  const lastTool = [...snap.tools].reverse().find((t) => t.n <= n) || null;
  return { turn, callsInTurn, toolsInTurn, lastCall, lastTool };
}

export function renderLoop(ctx) {
  const { snap, cursor, live, hooks } = ctx;
  const n = cursor;
  const ph = ctx.follow ? snap.phase : phaseAt(snap, n);
  // hooks refine the live phase
  let phase = ph.phase, detail = ph.detail;
  const lastHook = ctx.follow && hooks.length ? hooks[hooks.length - 1] : null;
  if (lastHook && Date.now() - lastHook.receivedAt < 20000) {
    if (lastHook.event === 'PermissionRequest' && phase === 'tool') { phase = 'permission'; detail = `waiting for permission: ${lastHook.toolName}`; }
    if (lastHook.event === 'PreCompact') { phase = 'compacting'; detail = 'compacting context (' + (lastHook.detail.trigger || '') + ')'; }
    if (lastHook.event === 'SessionEnd') { phase = 'ended'; detail = 'session ended (' + (lastHook.detail.reason || '') + ')'; }
  }
  const c = atCursor(snap, n);
  const isLive = !!(live && live.alive);
  const nowPanel = el('div', { class: 'now' },
    el('div', { class: 'tile' }, el('div', { class: 'k' }, 'Loop phase'), el('div', { class: 'big' }, phase), el('div', { class: 's' }, detail)),
    tile('Turn', c.turn ? `${c.turn.index + 1} / ${snap.turns.length}` : '–', c.turn ? c.turn.origin : ''),
    tile('API calls this turn', String(c.callsInTurn.length), c.callsInTurn.length ? 'last stop: ' + (c.callsInTurn[c.callsInTurn.length - 1].stopReason || '…') : ''),
    tile('Tools this turn', String(c.toolsInTurn.length), c.lastTool ? `${c.lastTool.name} ${c.lastTool.durationMs != null ? fmt.ms(c.lastTool.durationMs) : '(running)'}` : ''),
    tile('Context now', c.lastCall ? fmt.tokens(c.lastCall.contextTokens) : '–', c.lastCall ? `${fmt.pct(c.lastCall.contextTokens ? c.lastCall.usage.cacheRead / c.lastCall.contextTokens : 0)} from cache` : ''),
  );
  const replay = el('div', { class: 'replay' },
    el('button', { class: 'small primary', onClick: ctx.togglePlay }, ctx.playing ? '❚❚ Pause' : '▶ Play'),
    stepper({ value: n, max: Math.max(0, snap.records.length - 1), onChange: (v) => ctx.setCursor(v), title: 'record number' }),
    el('select', { onChange: (e) => ctx.setSpeed(Number(e.target.value)) }, [1, 2, 5, 10, 25].map((s) => el('option', { value: s, selected: s === ctx.speed }, s + '×'))),
    el('label', { class: 'muted' }, el('input', { type: 'checkbox', checked: ctx.follow, onChange: (e) => ctx.setFollow(e.target.checked) }), ' follow latest'),
  );
  // Search: full-text over the transcript file (server side), results replace the window.
  const S = ctx.search;
  const searching = S.q.length >= 2 && S.results;
  const searchRow = el('div', { class: 'replay search-row' },
    el('input', { type: 'search', id: 'replay-search', placeholder: 'Search transcript text… (Enter: next, Shift+Enter: previous)', value: S.q, autocomplete: 'off',
      onInput: (e) => ctx.setSearch(e.target.value), onFocus: () => { S.focused = true; }, onBlur: () => { S.focused = false; },
      onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); ctx.searchStep(e.shiftKey ? -1 : 1); } else if (e.key === 'Escape') { ctx.setSearch(''); } } }),
    el('span', { class: 'mono muted', style: { whiteSpace: 'nowrap' } }, S.loading ? 'searching…' : searching ? `${S.index + 1 > 0 ? S.index + 1 + ' / ' : ''}${S.results.total} match${S.results.total === 1 ? '' : 'es'}${S.results.total > S.results.hits.length ? ' (first ' + S.results.hits.length + ' shown)' : ''}` : ''),
    searching ? el('button', { class: 'small ghost', title: 'previous match', onClick: () => ctx.searchStep(-1) }, '↑') : null,
    searching ? el('button', { class: 'small ghost', title: 'next match', onClick: () => ctx.searchStep(1) }, '↓') : null,
    S.q ? el('button', { class: 'small ghost', title: 'clear', onClick: () => ctx.setSearch('') }, '✕') : null,
    el('label', { title: 'also match agent-name, last-prompt, custom-title, cache blobs and other bookkeeping records' }, el('input', { type: 'checkbox', checked: S.all, onChange: (e) => ctx.setSearchAll(e.target.checked) }), ' include bookkeeping'),
  );
  const stream = el('div', { class: 'stream' });
  const highlight = (text, q) => {
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return [text];
    return [text.slice(0, i), el('mark', {}, text.slice(i, i + q.length)), text.slice(i + q.length)];
  };
  if (searching) {
    if (!S.results.hits.length) stream.append(el('div', { class: 'empty', style: { padding: '24px' } }, 'no records contain that text'));
    S.results.hits.forEach((h, idx) => {
      const r = snap.records[h.n] || { kind: 'other', ts: null, label: '' };
      stream.append(el('div', { class: 'r' + (idx === S.index ? ' cur' : ''), onClick: () => { ctx.searchJump(idx); ctx.openInspector(h.n, ctx.agentId); } },
        el('span', { class: 'n' }, '#' + h.n), el('span', { class: 't' }, fmt.time(r.ts)), badge(r.kind), el('span', { class: 'l', title: r.label }, ...highlight(h.snippet, S.q))));
    });
  } else {
    const lo = Math.max(0, n - 30), hi = Math.min(snap.records.length, n + 31);
    for (let i = lo; i < hi; i++) {
      const r = snap.records[i];
      if (!r) continue;
      stream.append(el('div', { class: 'r' + (i === n ? ' cur' : ''), onClick: () => { ctx.setCursor(i); ctx.openInspector(i, ctx.agentId); } },
        el('span', { class: 'n' }, '#' + i), el('span', { class: 't' }, fmt.time(r.ts)), badge(r.kind), el('span', { class: 'l', title: r.label }, r.label)));
    }
  }
  if (S.focused) setTimeout(() => { const i = document.getElementById('replay-search'); if (i) { i.focus(); const v = i.value; i.setSelectionRange(v.length, v.length); } }, 0);
  setTimeout(() => { const cur = stream.querySelector('.cur'); if (cur) stream.scrollTop = Math.max(0, cur.offsetTop - stream.clientHeight / 2 + 10); }, 0);
  return el('div', {},
    card('The agentic loop', 'Claude Code is a loop: your prompt and the whole conversation are sent to the model; the model answers with text or with tool_use blocks; each tool runs locally and its result is appended as a user message; the loop repeats until the model stops with end_turn. The highlighted node is where this session is' + (ctx.follow ? ' right now' : ' at the selected record') + '.',
      loopDiagram(phase, isLive && ctx.follow)),
    nowPanel,
    card('Replay the transcript', 'Scrub through every record Claude Code wrote for this session, or search the full text of every record (prompts, tool input and output, thinking, attachments). Click a record to inspect the raw JSON on the right.', replay, searchRow, stream),
  );
}

// --------------------------------------------------------------- Trace ----
export function renderTrace(ctx) {
  const { snap } = ctx;
  if (!snap.turns.length) return el('div', { class: 'empty' }, 'No turns in this transcript yet.');
  const agentsByTool = new Map(snap.subagents.map((a) => [a.meta && a.meta.toolUseId, a]));
  const wrap = el('div', {});
  wrap.append(card('Trace: turns, API calls and tools', 'Each turn starts with a prompt and contains one or more API calls (blue). Tools the model called are shown under the call that requested them (orange, red on error, violet for subagents). Bars are time; hover for tokens and durations. Thinking time is the lighter segment at the start of a call.'));
  const limit = ctx.traceLimit || 40;
  const start = Math.max(0, snap.turns.length - limit);
  if (start > 0) wrap.append(el('button', { class: 'small', onClick: () => ctx.setTraceLimit(limit + 60) }, `Show ${Math.min(60, start)} earlier turns (${start} hidden)`));
  for (let ti = start; ti < snap.turns.length; ti++) {
    const turn = snap.turns[ti];
    const calls = turn.calls.map((i) => snap.calls[i]).filter(Boolean);
    const tools = snap.tools.filter((t) => t.turnIndex === turn.index);
    let t0 = turn.startedAt, t1 = turn.endedAt || turn.startedAt;
    for (const t of tools) if (t.resultAt) t1 = Math.max(t1, t.resultAt);
    const now = Date.now();
    for (const t of tools) if (!t.resultAt && ctx.live) t1 = Math.max(t1, Math.min(now, t.startedAt + 600000));
    const rows = [];
    for (const call of calls) {
      const dur = call.endedAt - call.startedAt;
      const u = call.usage;
      rows.push({
        label: `call ${call.index + 1} · ${call.stopReason || '…'}`, start: call.startedAt, end: call.endedAt, color: 'var(--c-model)', kind: 'call',
        segments: call.thinkingMs ? [{ start: call.startedAt, end: Math.min(call.endedAt, call.startedAt + call.thinkingMs), color: 'var(--seq-250)' }] : [],
        sub: `${fmt.ms(dur)} · out ${fmt.tokens(u.output)}`,
        tip: `<b>API call ${call.index + 1}</b> (${call.model || ''})<br>latency ${fmt.ms(dur)} · thinking ${fmt.ms(call.thinkingMs)}<br>context ${fmt.tokens(call.contextTokens)} = input ${fmt.tokens(u.input)} + cache read ${fmt.tokens(u.cacheRead)} + cache write ${fmt.tokens(u.cacheCreate)}<br>output ${fmt.tokens(u.output)} · stop_reason ${call.stopReason || '–'}<br>blocks: ${call.blocks.map((b) => b.type).join(', ')}`,
        onClick: () => ctx.openInspector(call.n, ctx.agentId),
      });
      for (const id of call.toolUses) {
        const t = snap.tools.find((x) => x.id === id); if (!t) continue;
        const agent = agentsByTool.get(t.id);
        const end = t.resultAt || t1;
        rows.push({
          label: agent ? `Agent → ${agent.meta.agentType || ''}: ${agent.meta.description || ''}` : `${t.name} ${t.inputPreview.slice(0, 40)}`,
          start: t.startedAt, end, depth: 1, open: !t.resultAt, kind: agent ? 'agent' : 'tool',
          color: t.isError ? 'var(--c-error)' : agent ? 'var(--c-agent)' : 'var(--c-tool)',
          sub: t.durationMs != null ? fmt.ms(t.durationMs) + (agent ? ` · ${agent.totals.calls} calls, ${agent.totals.tools} tools` : '') : 'running',
          tip: `<b>${t.name}</b> ${t.isError ? '(error)' : ''}<br>${t.inputPreview}<br>duration ${t.durationMs != null ? fmt.ms(t.durationMs) : 'running'} · result ${fmt.int(t.resultChars)} chars<br>permission: ${t.permission ? (t.permission.decision + ' via ' + t.permission.source + (t.permission.reasonType ? ' (' + t.permission.reasonType + ')' : '')) : 'n/a'}${agent ? '<br><i>click to open the subagent</i>' : ''}`,
          onClick: () => (agent ? ctx.setScope(agent.meta.agentId) : ctx.openInspector(t.n, ctx.agentId)),
        });
      }
    }
    const collapsed = ti < snap.turns.length - 6;
    const turnCard = el('div', { class: 'card turn' + (collapsed ? ' collapsed' : '') });
    const hd = el('div', { class: 'hd', onClick: () => turnCard.classList.toggle('collapsed') },
      el('span', { class: 'idx' }, '#' + (turn.index + 1)), badge(turn.origin === 'compaction' ? 'compaction' : turn.isMeta ? 'meta' : 'prompt'),
      el('span', { class: 'pr', title: turn.prompt }, turn.promptPreview || '(empty prompt)'),
      el('span', { class: 'stats' }, `${fmt.date(turn.startedAt)} · ${fmt.ms((turn.endedAt || turn.startedAt) - turn.startedAt)} · ${calls.length} calls · ${tools.length} tools · out ${fmt.tokens(turn.outputTokens)}`));
    turnCard.append(hd);
    const body = el('div', { class: 'body' });
    body.append(el('p', { class: 'muted', style: { margin: '6px 0' } }, el('a', { href: '#', onClick: (e) => { e.preventDefault(); ctx.openInspector(turn.n, ctx.agentId); } }, 'inspect prompt record'), turn.prompt ? ' · ' + turn.prompt.replace(/\s+/g, ' ').slice(0, 400) : ''));
    if (rows.length) body.append(waterfall({ rows: rows.slice(0, 400), t0, t1: Math.max(t1, t0 + 1000) }));
    else body.append(el('p', { class: 'muted' }, 'No API calls recorded in this turn.'));
    turnCard.append(body);
    wrap.append(turnCard);
  }
  return wrap;
}

// ------------------------------------------------------------- Context ----
export function renderContext(ctx) {
  const { snap } = ctx;
  const wrap = el('div', {});
  const series = [
    { key: 'cacheRead', label: 'cache read (prefix reused)', color: 'var(--seq-250)' },
    { key: 'cacheCreate', label: 'cache write (new prefix)', color: 'var(--seq-450)' },
    { key: 'input', label: 'uncached input', color: 'var(--seq-650)' },
  ];
  const calls = snap.calls;
  const step = Math.max(1, Math.ceil(calls.length / 500));
  const data = [];
  for (let i = 0; i < calls.length; i += step) {
    const c = calls[i];
    data.push({ x: String(c.index + 1), values: { cacheRead: c.usage.cacheRead, cacheCreate: c.usage.cacheCreate, input: c.usage.input }, n: c.n,
      tip: `<b>call ${c.index + 1}</b> turn ${c.turnIndex + 1}<br>context ${fmt.tokens(c.contextTokens)}<br>cache read ${fmt.tokens(c.usage.cacheRead)} · cache write ${fmt.tokens(c.usage.cacheCreate)} · uncached ${fmt.tokens(c.usage.input)}<br>output ${fmt.tokens(c.usage.output)}` });
  }
  const markers = snap.compactions.map((cp) => { const idx = calls.findIndex((c) => c.n > cp.n); return idx >= 0 ? { index: Math.floor(idx / step), label: 'compaction' } : null; }).filter(Boolean);
  wrap.append(card('Context window per API call', 'Every API call re-sends the whole conversation. The bar is the total input context of that call. Most of it is served from the prompt cache (light blue) because Claude Code places cache breakpoints on the system prompt and on the conversation prefix; only the new tail is written to cache (medium) or sent uncached (dark). A drop after a dashed marker is compaction.',
    legend(series), calls.length ? stackedBars({ data, series, markers, yLabel: 'tokens', onClick: (d) => ctx.openInspector(d.n, ctx.agentId) }) : el('p', { class: 'muted' }, 'No API calls yet.')));
  const outData = data.map((d, i) => { const c = calls[i * step]; return { x: d.x, values: { output: c.usage.output }, n: c.n, tip: `<b>call ${c.index + 1}</b><br>output ${fmt.tokens(c.usage.output)} tokens<br>thinking ${fmt.ms(c.thinkingMs)}` }; });
  wrap.append(card('Output tokens per API call', 'Output is what the model generated: thinking, text and tool_use JSON. It is small compared with the context, which is why caching matters so much.', calls.length ? stackedBars({ data: outData, series: [{ key: 'output', label: 'output', color: 'var(--c-model)' }], height: 150 }) : null));

  // anatomy of a request
  const reqs = snap.apiRequests;
  if (reqs.length) {
    const sel = ctx.reqIndex != null && reqs[ctx.reqIndex] ? ctx.reqIndex : reqs.length - 1;
    const r = reqs[sel];
    const shape = snap.shapes.find((s) => s.hash === r.shapeHash) || null;
    // first request of each turn, for the jump-to-turn select
    const turnOfReq = (req) => { let t = null; for (const tn of snap.turns) { if (tn.n <= req.n) t = tn; else break; } return t; };
    const firstReqByTurn = new Map();
    reqs.forEach((q, i) => { const t = turnOfReq(q); if (t && !firstReqByTurn.has(t.index)) firstReqByTurn.set(t.index, i); });
    const curTurn = turnOfReq(r);
    const picker = el('div', { class: 'picker' },
      el('div', { class: 'row', style: { gap: '8px' } }, el('span', { class: 'label' }, 'request'),
        stepper({ value: sel, max: reqs.length - 1, onChange: (i) => ctx.setReqIndex(i), title: 'request number' })),
      el('div', { class: 'row', style: { gap: '8px', marginTop: '6px' } },
        el('span', { class: 'label' }, 'jump to turn'),
        el('select', { onChange: (e) => ctx.setReqIndex(Number(e.target.value)) }, [...firstReqByTurn.entries()].map(([ti, ri]) => el('option', { value: ri, selected: curTurn && curTurn.index === ti }, `#${ti + 1} · ${snap.turns[ti].promptPreview.slice(0, 48) || snap.turns[ti].origin}`))),
        el('span', { class: 'chip' }, 'turn ', el('b', {}, curTurn ? String(curTurn.index + 1) : '–')), el('span', { class: 'chip' }, 'record ', el('b', {}, '#' + r.n)), el('span', { class: 'chip' }, fmt.date(r.ts)),
        el('span', { class: 'grow' }),
        el('button', { class: 'small ghost', onClick: () => ctx.openInspector(r.n, ctx.agentId) }, 'raw record'), el('button', { class: 'small primary', onClick: () => ctx.openRequest(r.n) }, 'reconstruct full request body')));
    const sysChars = shape && shape.stats ? shape.stats.systemChars : 0, toolsChars = shape && shape.stats ? shape.stats.toolsChars : 0;
    const tailChars = r.tailBlobs.reduce((a, b) => a + (b.size || 0), 0);
    const left = el('div', {},
      el('h3', {}, 'Request parameters'),
      el('div', { class: 'row', style: { margin: '6px 0' } }, el('span', { class: 'chip' }, 'model ', el('b', {}, r.model || '–')), el('span', { class: 'chip' }, 'max_tokens ', el('b', {}, fmt.int(r.maxTokens))), el('span', { class: 'chip' }, 'thinking ', el('b', {}, r.thinking ? JSON.stringify(r.thinking) : 'off')), el('span', { class: 'chip' }, 'source ', el('b', {}, r.querySource || '–'))),
      el('details', {}, el('summary', {}, `${r.betas.length} beta features enabled`), chips(r.betas)),
      r.contextManagement ? el('details', {}, el('summary', {}, 'context_management (server-side context editing)'), el('pre', {}, JSON.stringify(r.contextManagement, null, 1))) : null,
      el('h3', { style: { marginTop: '12px' } }, 'Messages array'),
      el('p', {}, el('b', {}, fmt.int(r.messages)), ' messages: ', el('b', {}, fmt.int(r.keep)), ' reused from the cached prefix (keep) + ', el('b', {}, fmt.int(r.tailLen)), ' new (tail). ', r.base ? 'The base hash identifies the shared prefix.' : ''),
      r.tailBlobs.length ? table(['role', 'blocks', { label: 'chars', class: 'num' }], r.tailBlobs.map((b) => { const missing = b.role === '?' || !b.size; return el('tr', {}, el('td', { class: missing ? 'faint' : '' }, missing ? 'body not logged' : b.role), el('td', { class: 'mono' }, missing ? '–' : (b.kinds || []).join('+')), tdn(missing ? '–' : fmt.int(b.size))); })) : null,
      el('h3', { style: { marginTop: '12px' } }, 'Cache breakpoints'),
      r.cacheBreakpoints.length ? el('ul', { class: 'mono muted', style: { margin: '4px 0', paddingLeft: '18px' } }, r.cacheBreakpoints.map((b) => el('li', {}, (b.path || []).join('.') + ' → ' + JSON.stringify(b.value || b)))) : el('p', { class: 'muted' }, 'none recorded'),
    );
    const right = el('div', {},
      el('h3', {}, 'Shape: system prompt + tool schemas'),
      shape && shape.stats ? el('div', {},
        el('div', { class: 'bar-stack', title: 'relative size in characters' },
          ...shape.stats.systemBlocks.map((b, i) => el('div', { style: { flex: String(Math.max(1, b.chars)), background: 'var(--c-harness)' }, title: `system block ${i + 1}: ${fmt.int(b.chars)} chars` })),
          el('div', { style: { flex: String(Math.max(1, toolsChars)), background: 'var(--c-tool)' }, title: `tool schemas: ${fmt.int(toolsChars)} chars` }),
          el('div', { style: { flex: String(Math.max(1, tailChars)), background: 'var(--c-user)' }, title: `new tail messages: ${fmt.int(tailChars)} chars` })),
        el('div', { class: 'legend' }, el('span', {}, el('i', { class: 'swatch', style: { background: 'var(--c-harness)' } }), `system prompt ${fmt.int(sysChars)} chars`), el('span', {}, el('i', { class: 'swatch', style: { background: 'var(--c-tool)' } }), `${shape.stats.toolCount} tool schemas ${fmt.int(toolsChars)} chars`), el('span', {}, el('i', { class: 'swatch', style: { background: 'var(--c-user)' } }), `tail ${fmt.int(tailChars)} chars`)),
        ...shape.stats.systemBlocks.map((b, i) => el('div', { class: 'sys-block', onClick: () => ctx.openShape(r.shapeHash, i) }, el('b', {}, `system[${i}] `), el('span', { class: 'muted' }, `${fmt.int(b.chars)} chars${b.cache ? ' · cache_control' : ''}`), el('div', { class: 'faint' }, b.preview + '…'))),
        el('details', {}, el('summary', {}, `${shape.stats.toolCount} tools sent with the request (click to list)`), toolChips(shape.stats.toolNames)),
        el('p', { class: 'faint', style: { marginTop: '6px' } }, 'Tools not listed here are deferred: the model sees their names only and loads a schema with ToolSearch when needed.'),
      ) : el('p', { class: 'muted' }, 'No shape record for this request (older Claude Code versions do not log it).'),
    );
    wrap.append(card('Anatomy of one API request', 'What Claude Code actually sends to the Messages API. The transcript stores this content-addressed: api-request lists message hashes, api-request-blob holds each body once, api-request-shape holds the system prompt and tool schemas once per distinct shape.', picker, el('div', { class: 'anatomy' }, left, right)));
  } else {
    wrap.append(card('Anatomy of one API request', 'This transcript has no api-request records (logged by Claude Code 2.1.29x and later). Token usage above still comes from the assistant records.'));
  }

  // attachments
  const byType = new Map();
  for (const a of snap.attachments) { const e = byType.get(a.type) || { type: a.type, count: 0, chars: 0, last: a }; e.count++; e.chars += a.chars; e.last = a; byType.set(a.type, e); }
  const attRows = [...byType.values()].sort((a, b) => b.count - a.count).map((e) => el('tr', { class: 'clickable', onClick: () => ctx.openInspector(e.last.n, ctx.agentId) }, el('td', { class: 'mono' }, e.type), tdn(fmt.int(e.count)), tdn(fmt.int(e.chars)), el('td', { class: 'muted' }, ATTACHMENT_KINDS[e.type] || '')));
  wrap.append(card('What the harness injects (attachments)', 'Besides your prompts, Claude Code adds its own context: hook output, system reminders, tool and skill listings, token budget reminders. These are "attachment" records. Click a row to see the latest example.', attRows.length ? table(['type', { label: 'count', class: 'num' }, { label: 'chars', class: 'num' }, 'meaning'], attRows) : el('p', { class: 'muted' }, 'none')));
  if (snap.compactions.length) wrap.append(card('Compactions', 'When the context nears its limit Claude Code asks the model to summarize the conversation and restarts from that summary.', table(['when', 'kind', 'summary'], snap.compactions.map((c) => el('tr', { class: 'clickable', onClick: () => ctx.openInspector(c.n, ctx.agentId) }, el('td', {}, fmt.date(c.ts)), el('td', {}, c.kind), el('td', { class: 'muted' }, c.text))))));
  return wrap;
}

// -------------------------------------------------------------- Tokens ----
export function renderTokens(ctx) {
  const { snap } = ctx;
  const t = snap.totals;
  const ctxTotal = t.input + t.cacheRead + t.cacheCreate;
  const wrap = el('div', {});
  wrap.append(el('div', { class: 'tiles' },
    tile('Output tokens', fmt.tokens(t.output), 'thinking + text + tool_use'),
    tile('Cache read', fmt.tokens(t.cacheRead), `${fmt.pct(ctxTotal ? t.cacheRead / ctxTotal : 0)} of all input`),
    tile('Cache write', fmt.tokens(t.cacheCreate), 'new prefix written'),
    tile('Uncached input', fmt.tokens(t.input), 'full price tokens'),
    tile('Peak context', fmt.tokens(t.peakContext), `now ${fmt.tokens(t.contextNow)}`),
    tile('API calls', fmt.int(t.calls), `${fmt.int(t.turns)} turns`),
    tile('Tool calls', fmt.int(t.tools), `${fmt.int(t.errors)} errors`),
    tile('Time in API', fmt.ms(t.apiMs), `thinking ${fmt.ms(t.thinkingMs)}`),
    tile('Time in tools', fmt.ms(t.toolMs), 'observed from timestamps'),
    tile('Cost', snap.cost ? fmt.usd(snap.cost.totalCostUSD) : 'n/a', snap.cost ? 'as recorded by Claude Code' : 'no cost-state record'),
  ));
  if (snap.cost && snap.cost.modelUsage) {
    const rows = Object.entries(snap.cost.modelUsage).map(([m, u]) => el('tr', {}, el('td', { class: 'mono' }, m), tdn(fmt.tokens(u.inputTokens)), tdn(fmt.tokens(u.cacheReadInputTokens)), tdn(fmt.tokens(u.cacheCreationInputTokens)), tdn(fmt.tokens(u.outputTokens)), tdn(fmt.usd(u.costUSD))));
    wrap.append(card('Usage per model (from cost-state)', 'Claude Code keeps its own running totals in the transcript. Subagents may use a different model than the main loop.', table(['model', { label: 'input', class: 'num' }, { label: 'cache read', class: 'num' }, { label: 'cache write', class: 'num' }, { label: 'output', class: 'num' }, { label: 'cost', class: 'num' }], rows)));
  }
  const mix = snap.toolMix || [];
  wrap.append(card('Tool mix', 'Which tools the model chose, how often, and how long they took. MCP tools are prefixed mcp__server__tool.',
    mix.length ? hBars({ data: mix.map((m) => ({ label: m.name, value: m.count, sub: m.timed ? `· avg ${fmt.ms(m.totalMs / m.timed)}` : '', color: m.errors ? 'var(--c-error)' : 'var(--c-tool)', tip: `<b>${m.name}</b><br>${m.count} calls · ${m.errors} errors<br>avg ${m.timed ? fmt.ms(m.totalMs / m.timed) : '–'} · total ${fmt.ms(m.totalMs)}` })), maxBars: 25 }) : el('p', { class: 'muted' }, 'no tool calls')));
  const stops = new Map(); for (const c of snap.calls) stops.set(c.stopReason || 'none', (stops.get(c.stopReason || 'none') || 0) + 1);
  const origins = new Map(); for (const tn of snap.turns) origins.set(tn.origin, (origins.get(tn.origin) || 0) + 1);
  wrap.append(el('div', { class: 'anatomy' },
    card('stop_reason per API call', 'tool_use means the model wants to run a tool and the loop continues; end_turn means it is done and control returns to you.', table(['stop_reason', { label: 'calls', class: 'num' }], [...stops.entries()].map(([k, v]) => el('tr', {}, el('td', { class: 'mono' }, k), tdn(fmt.int(v)))))),
    card('Turn origins', 'Where each turn came from: a human prompt, a queued message, a task notification, a compaction summary, or the harness (meta).', table(['origin', { label: 'turns', class: 'num' }], [...origins.entries()].map(([k, v]) => el('tr', {}, el('td', { class: 'mono' }, k), tdn(fmt.int(v)))))),
  ));
  if (snap.subagents.length) {
    const rows = snap.subagents.map((a) => el('tr', { class: 'clickable', onClick: () => ctx.setScope(a.meta.agentId) }, el('td', { class: 'mono' }, a.meta.agentType || '?'), el('td', {}, a.meta.description || ''), el('td', { class: 'mono' }, a.meta.model || ''), tdn(fmt.int(a.totals.calls)), tdn(fmt.int(a.totals.tools)), tdn(fmt.tokens(a.totals.output)), tdn(fmt.tokens(a.totals.peakContext)), el('td', {}, fmt.ms((a.info.endedAt || 0) - (a.info.startedAt || 0)))));
    wrap.append(card(`Subagents (${snap.subagents.length})`, 'Each Agent tool call spawns a subagent with its own context window and its own transcript file (isSidechain=true). Only its final report comes back to the parent. Click to open one.', table(['type', 'description', 'model', { label: 'calls', class: 'num' }, { label: 'tools', class: 'num' }, { label: 'output', class: 'num' }, { label: 'peak ctx', class: 'num' }, 'duration'], rows)));
  }
  return wrap;
}

// --------------------------------------------------------------- Hooks ----
export function renderHooks(ctx) {
  const { hooks, hookConfig, snap } = ctx;
  const wrap = el('div', {});
  const cfg = hookConfig;
  const installed = cfg && cfg.installed && cfg.installed.length;
  wrap.append(card('Live hook events', `Claude Code can call an HTTP URL on every lifecycle event. X-Ray listens on ${cfg ? cfg.url : '/hook'} and shows the events here in real time. ${installed ? `Installed for ${cfg.installed.length} events in ${cfg.file}; restart Claude Code sessions to activate.` : 'Not installed yet.'}`,
    el('div', { class: 'row' },
      el('span', { class: 'chip' }, installed ? '● installed' : '○ not installed'), el('span', { class: 'chip' }, 'received ', el('b', {}, String(cfg ? cfg.received : 0))),
      el('span', { class: 'muted' }, 'Install from a terminal:'), el('code', { class: 'kbd' }, 'node server.mjs --install-hooks'), el('span', { class: 'muted' }, 'remove:'), el('code', { class: 'kbd' }, 'node server.mjs --uninstall-hooks'),
      el('button', { class: 'small ghost', onClick: () => copyText(JSON.stringify(cfg ? cfg.config : {}, null, 2)) }, 'copy settings.json snippet')),
    el('details', { style: { marginTop: '8px' } }, el('summary', {}, 'what the snippet adds to ~/.claude/settings.json'), el('pre', { class: 'mono', style: { maxHeight: '220px', overflow: 'auto' } }, JSON.stringify(cfg ? cfg.config : {}, null, 2))),
  ));
  const feed = el('div', {});
  const list = hooks.slice(-300).reverse();
  if (!list.length) feed.append(el('p', { class: 'muted' }, 'No hook events received for this session yet.'));
  for (const h of list) {
    const d = h.detail || {};
    const what = h.toolName ? `${h.toolName}${d.duration_ms != null ? ' · ' + fmt.ms(d.duration_ms) : ''}` : d.prompt ? d.prompt.slice(0, 120) : d.message || d.trigger || d.reason || d.source || h.agentType || '';
    feed.append(el('div', { class: 'hookrow' }, el('span', { class: 'mono faint' }, fmt.time(h.receivedAt)), el('span', { class: 'ev' }, h.event), el('details', {}, el('summary', {}, what || '(no detail)'), el('pre', { class: 'mono' }, JSON.stringify(h, null, 1)))));
  }
  wrap.append(card('Event feed (this session)', null, feed));
  const seen = snap.events.filter((e) => e.kind === 'hook' || e.kind === 'system');
  wrap.append(card('Hooks recorded in the transcript', 'Even without X-Ray hooks installed, the transcript records hook outcomes: hook_success attachments (with duration and exit code) and stop_hook_summary system records.',
    seen.length ? table(['when', 'record', 'hook', { label: 'duration', class: 'num' }, 'exit', { label: 'chars', class: 'num' }], seen.slice(-200).reverse().map((e) => el('tr', { class: 'clickable', onClick: () => ctx.openInspector(e.n, ctx.agentId) }, el('td', {}, fmt.time(e.ts)), el('td', { class: 'mono' }, e.kind === 'hook' ? 'attachment' : 'system'), el('td', {}, e.hookName || e.label), tdn(e.durationMs != null ? fmt.ms(e.durationMs) : '–'), el('td', {}, e.exitCode != null ? String(e.exitCode) : '–'), tdn(e.chars != null ? fmt.int(e.chars) : '–')))) : el('p', { class: 'muted' }, 'none in this transcript')));
  wrap.append(card('Hook events reference', 'The lifecycle events Claude Code exposes. Each receives JSON with session_id, cwd, transcript_path, permission_mode and event-specific fields; a hook can block, rewrite, or add context.', table(['event', 'when it fires'], Object.entries(HOOK_EVENT_DOCS).map(([k, v]) => el('tr', {}, el('td', { class: 'mono' }, k), el('td', { class: 'muted' }, v))))));
  return wrap;
}

// --------------------------------------------------------------- Learn ----
const LESSONS = [
  ['The loop', 'Claude Code is not a chat window; it is a while-loop. Build the messages array, call the Messages API, read the stop_reason. If it is tool_use, run the tools, append the results as a user message, and call again. If it is end_turn, stop and wait for you. Everything else (hooks, permissions, caching, subagents) hangs off that loop.', 'loop'],
  ['The transcript is the state', 'There is no database. Each session is one JSONL file under ~/.claude/projects, one record per line. Messages form a tree through uuid and parentUuid, which is how /rewind and branching work. The file is append-only, which is why X-Ray can tail it live.', 'loop'],
  ['One API response, many records', 'The model streams content blocks: thinking, text, tool_use. Claude Code writes one assistant record per block, all sharing a requestId and the same usage numbers. Group by requestId to get one API call.', 'trace'],
  ['tool_use and tool_result are a pair', 'A tool_use block carries an id, a name and JSON input that must match the tool schema. The result goes back in a user message as a tool_result block with the same tool_use_id. Claude Code also stores a structured toolUseResult (stdout, stderr, diffs) for its own UI.', 'trace'],
  ['The system prompt and tool schemas are big', 'Every call carries the system prompt (tens of thousands of characters) and the schemas for dozens of tools. Rarely used tools are deferred: only their names are listed, and the model fetches a schema with ToolSearch when it needs one.', 'context'],
  ['Prompt caching is the whole economics', 'The context is re-sent on every call, so Claude Code sets cache_control breakpoints on the system prompt and on the conversation prefix. Later calls read the prefix from cache (cache_read_input_tokens) at a fraction of the price and write only the new tail (cache_creation_input_tokens).', 'context'],
  ['Context grows until compaction', 'Each tool result makes the next call bigger. When the window nears its limit, Claude Code asks the model to summarize and starts a new conversation from the summary (isCompactSummary). You see it as a cliff in the context chart.', 'context'],
  ['Attachments: the harness talks too', 'Besides your prompt, Claude Code injects its own messages: system reminders, hook output, skill and tool listings, token budget reminders. They are user-role content the model sees but you normally do not.', 'context'],
  ['Permissions sit between tool_use and execution', 'Before a tool runs, the permission system decides: allow by rule, by mode (plan, acceptEdits, bypass), by a hook, or by asking you. The decision is recorded on the tool_result record as permissionDecision.', 'trace'],
  ['Hooks are the extension points', 'Shell commands or HTTP endpoints that run at lifecycle events: before and after tools, on prompt submit, on stop, on compaction, on subagent start and stop. They can block, rewrite, or add context. X-Ray itself is an HTTP hook consumer.', 'hooks'],
  ['Subagents are sessions inside sessions', 'The Agent tool starts a fresh loop with its own system prompt, context window and transcript file (isSidechain=true, under <session>/subagents/). The parent only receives the final report as the tool_result. That isolation is what keeps the parent context small.', 'tokens'],
  ['Thinking is output you pay for', 'With adaptive thinking the model reasons before answering. Thinking blocks are output tokens; thinkingDurationMs on the record tells you how long they took. Claude Code shows a summary, not the full reasoning.', 'tokens'],
];
export function renderLearn(ctx) {
  const { snap } = ctx;
  const counts = new Map(); for (const r of snap.records) counts.set(r.type, (counts.get(r.type) || 0) + 1);
  return el('div', {},
    el('div', { class: 'learn' }, LESSONS.map(([t, body, tab]) => el('div', { class: 'card' }, el('h2', {}, t), el('p', {}, body), el('a', { href: '#', onClick: (e) => { e.preventDefault(); ctx.setTab(tab); } }, 'see it in ' + tab + ' →')))),
    card('Record types in this transcript', 'Every line in the JSONL has a type. These are the ones in the selected session, with what they mean.', table(['type', { label: 'count', class: 'num' }, 'meaning'],
      [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => el('tr', {}, el('td', { class: 'mono' }, k), tdn(fmt.int(v)), el('td', { class: 'muted' }, RECORD_KINDS[k] || 'not documented yet'))))),
  );
}

// ----------------------------------------------------------- Inspector ----
const FIELD_DOCS = {
  uuid: 'Identity of this record in the message tree.', parentUuid: 'The record this one follows. Together with uuid this forms the conversation tree (rewind, branches).',
  isSidechain: 'true when this record belongs to a subagent, not the main conversation.', agentId: 'The subagent this record belongs to.',
  sessionId: 'The session this record belongs to; subagent files point at the parent session.', timestamp: 'When Claude Code wrote the record (not when the API answered).',
  requestId: 'Anthropic request id; all blocks of one API response share it.', apiBlockIndex: 'Index of this content block within the API response.',
  'message.usage': 'Token accounting for the whole API call: input (uncached), output, cache_read_input_tokens, cache_creation_input_tokens.',
  'message.stop_reason': 'tool_use: the loop continues with tool execution; end_turn: the turn is over.', 'message.model': 'The model that served this call.',
  toolUseResult: 'Structured tool output kept for the UI (stdout, stderr, diffs, file info).', permissionDecision: 'How the tool call was allowed: by rule, mode, hook or user.',
  promptId: 'Groups everything that happened because of one user prompt.', turnOrigin: 'Who started the turn: human, task_notification, queue.', promptSource: 'Interface the prompt came from (sdk, cli, system).',
  isMeta: 'A harness-generated user message, not typed by you.', isCompactSummary: 'This user message is a compaction summary that replaced earlier context.',
  attachment: 'Context injected by the harness (see Context tab for the catalogue).', hookInfos: 'Hooks that ran for this event.', hookErrors: 'Hook failures, if any.',
  params: 'API parameters (model, max_tokens, betas, thinking, context_management).', keep: 'How many messages were reused from the cached prefix.', tail: 'Hashes of the new messages; bodies are in api-request-blob records.', base: 'Hash of the shared prefix.', cacheControl: 'Where cache breakpoints were placed in this request.', shapeHash: 'Points at the api-request-shape record with the system prompt and tool schemas.',
  entrypoint: 'How Claude Code was launched (cli, claude-desktop, sdk).', userType: 'external = a normal user session.', effort: 'Reasoning effort requested for this call.', thinkingDurationMs: 'Wall-clock time the model spent in thinking blocks.',
  cwd: 'Working directory of the session.', gitBranch: 'Branch at the time of the record.', version: 'Claude Code version that wrote the record.',
};
export function renderInspector(container, { entry, raw, loading, error, onClose, title, onReconstruct }) {
  container.innerHTML = '';
  container.hidden = false;
  const head = el('div', { class: 'head row' }, el('div', { class: 'grow' }, el('b', {}, title || (entry ? `#${entry.n} ` : '')), entry ? badge(entry.kind) : null, entry ? el('span', { class: 'muted', style: { marginLeft: '6px' } }, fmt.time(entry.ts)) : null), raw && raw.type === 'api-request' && onReconstruct ? el('button', { class: 'small primary', onClick: () => onReconstruct(entry.n) }, 'reconstruct request') : null, raw ? el('button', { class: 'small ghost', onClick: () => copyText(JSON.stringify(raw, null, 2)) }, 'copy') : null, el('button', { class: 'small ghost', onClick: onClose }, '✕'));
  container.append(head);
  const body = el('div', { class: 'body' });
  if (entry) body.append(el('p', { class: 'muted', style: { fontSize: '12px' } }, entry.label));
  if (loading) body.append(el('p', { class: 'muted' }, 'loading raw record…'));
  if (error) body.append(el('p', { class: 'muted' }, 'error: ' + error));
  if (raw) {
    const keys = new Set(Object.keys(raw));
    if (raw.message) for (const k of Object.keys(raw.message)) keys.add('message.' + k);
    const annots = [...keys].filter((k) => FIELD_DOCS[k]).map((k) => [el('b', {}, k), el('span', { class: 'muted' }, FIELD_DOCS[k])]);
    if (RECORD_KINDS[raw.type]) body.append(el('p', { style: { fontSize: '12px' } }, el('b', { class: 'mono' }, raw.type + ': '), RECORD_KINDS[raw.type]));
    if (raw.attachment && ATTACHMENT_KINDS[raw.attachment.type]) body.append(el('p', { style: { fontSize: '12px' } }, el('b', { class: 'mono' }, raw.attachment.type + ': '), ATTACHMENT_KINDS[raw.attachment.type]));
    if (annots.length) body.append(el('div', { class: 'annot' }, annots.flat()));
    const pre = el('pre', { class: 'mono' }); pre.innerHTML = highlightJson(raw); body.append(pre);
  }
  container.append(body);
}
export { showTip, hideTip };

// ------------------------------------------------------- Request body ----
// Full Messages API body for one api-request record, rebuilt by the server.
function blockView(b) {
  if (!b || typeof b !== 'object') return el('pre', { class: 'mono' }, String(b));
  const head = (label, extra) => el('div', { class: 'label', style: { margin: '8px 0 4px' } }, label, extra ? el('span', { class: 'num' }, ' ' + extra) : null);
  switch (b.type) {
    case 'text': return el('div', {}, head('text', (b.text || '').length + ' chars' + (b.cache_control ? ' · cache_control' : '')), el('pre', { class: 'mono' }, b.text || ''));
    case 'thinking': return el('div', {}, head('thinking', (b.thinking || '').length + ' chars'), el('pre', { class: 'mono muted' }, b.thinking || '[redacted]'));
    case 'tool_use': return el('div', {}, head('tool_use', b.name + ' · ' + b.id), el('pre', { class: 'mono' }, JSON.stringify(b.input, null, 2)));
    case 'tool_result': { const t = typeof b.content === 'string' ? b.content : (b.content || []).map((x) => x && x.type === 'text' ? x.text : x && x.type === 'image' ? x.source && x.source.data || '[image]' : JSON.stringify(x)).join('\n'); return el('div', {}, head('tool_result', b.tool_use_id + (b.is_error ? ' · is_error' : '')), el('pre', { class: 'mono' }, t)); }
    case 'image': return el('div', {}, head('image', b.source && b.source.media_type), el('pre', { class: 'mono muted' }, b.source && b.source.data));
    default: return el('div', {}, head(b.type || 'block'), el('pre', { class: 'mono' }, JSON.stringify(b, null, 2)));
  }
}
export function renderRequestBody(data, { sessionId, agentId, onClose }) {
  const { body, stats, cachePoints } = data;
  const params = Object.fromEntries(Object.entries(body).filter(([k]) => !['system', 'tools', 'messages'].includes(k)));
  const rawUrl = `/api/session/${sessionId}/request/${data.n}?raw=1${agentId ? '&agent=' + agentId : ''}`;
  const chip = (k, v) => el('span', { class: 'chip' }, k + ' ', el('b', {}, v));
  const head = el('div', { class: 'head row' },
    el('div', { class: 'grow row' }, el('b', {}, `API request · record #${data.n}`), el('span', { class: 'muted mono' }, fmt.date(Date.parse(data.timestamp))),
      chip('model', body.model || '?'), chip('messages', `${stats.messages} = ${stats.keep} kept + ${stats.tail} new`), chip('system', fmt.int(stats.systemChars) + ' chars'), chip('tools', `${body.tools.length} · ${fmt.int(stats.toolsChars)} chars`),
      chip('messages', fmt.int(stats.messagesChars) + ' chars'), stats.images ? chip('images', `${stats.images} · ${fmt.int(stats.imageChars)} chars`) : null, chip('total', fmt.int(stats.totalChars) + ' chars'),
      stats.unresolved ? el('span', { class: 'chip', style: { borderColor: 'var(--block)', color: 'var(--block)' } }, `${stats.unresolved} bodies not in this file`) : null),
    el('a', { href: rawUrl, target: '_blank', class: 'chip' }, 'open raw JSON ↗'), el('button', { class: 'small ghost', onClick: onClose }, '✕ close'));
  const explain = el('p', { class: 'explain', style: { padding: '12px 16px 0' } },
    `This is the body Claude Code sent to POST /v1/messages, rebuilt from the transcript: the api-request record names the previous request (base) and how many of its messages to reuse (keep), lists the new messages by hash (tail), and points at the shape record holding the system prompt and tool schemas. Hashes were resolved to api-request-blob records; image data is replaced by a placeholder. Everything below went on the wire in full.`);
  const section = (title, ...kids) => el('div', { class: 'card', style: { margin: '12px 16px' } }, el('h2', {}, title), ...kids);
  // 01 params
  const sParams = section('Parameters', el('pre', { class: 'mono' }, JSON.stringify(params, null, 2)));
  // 02 system
  const sSystem = section('System prompt', el('p', { class: 'explain' }, `${body.system.length} text blocks sent as the "system" field. Click a block to read it.`),
    ...body.system.map((b, i) => { const pre = el('pre', { class: 'mono', hidden: true }, b.text || ''); return el('div', {}, el('div', { class: 'sys-block', onClick: () => { pre.hidden = !pre.hidden; } }, el('b', {}, `system[${i}] `), el('span', { class: 'muted' }, `${fmt.int((b.text || '').length)} chars${b.cache_control ? ' · cache_control ' + JSON.stringify(b.cache_control) : ''}`), el('div', { class: 'faint' }, (b.text || '').replace(/\s+/g, ' ').slice(0, 140) + '…')), pre); }));
  // 03 tools
  const toolPre = el('pre', { class: 'mono', hidden: true });
  const sTools = section('Tools', el('p', { class: 'explain' }, `${body.tools.length} tool definitions (name, description, input_schema), ${fmt.int(stats.toolsChars)} chars of JSON. Click a name to see its schema. Tools absent from this list were deferred and only reachable through ToolSearch.`),
    toolChips(body.tools.map((t) => t.name), (name) => { const t = body.tools.find((x) => x.name === name); toolPre.hidden = false; toolPre.textContent = JSON.stringify(t, null, 2); toolPre.scrollIntoView({ block: 'nearest' }); }), toolPre);
  // 04 messages
  const tailStart = stats.messages - stats.tail;
  const ccSet = new Set(cachePoints.filter((c) => c.path.startsWith('messages.')).map((c) => Number(c.path.split('.')[1])));
  const rows = [];
  body.messages.forEach((m, i) => {
    const kinds = Array.isArray(m.content) ? m.content.map((b) => b && b.type).filter(Boolean) : ['text'];
    const chars = JSON.stringify(m.content || '').length;
    const isTail = i >= tailStart;
    const detail = el('tr', { hidden: true }, el('td', { colspan: 6, style: { background: 'var(--paper)' } }, el('div', { style: { maxHeight: '420px', overflow: 'auto', padding: '4px 0' } }, ...(Array.isArray(m.content) ? m.content.map(blockView) : [blockView({ type: 'text', text: String(m.content) })]))));
    const flags = [isTail ? el('span', { class: 'badge', style: { '--bc': 'var(--signal)' } }, 'new') : el('span', { class: 'badge other' }, 'kept'), ccSet.has(i) ? el('span', { class: 'badge', style: { '--bc': 'var(--sugg)', marginLeft: '4px' } }, 'cache_control') : null, m.role === 'system' ? el('span', { class: 'badge attachment', style: { marginLeft: '4px' } }, 'harness') : null, m._unresolved ? el('span', { class: 'badge compaction', style: { marginLeft: '4px' } }, 'missing') : null];
    const row = el('tr', { class: 'clickable', style: isTail ? { background: 'color-mix(in srgb, var(--signal) 8%, transparent)' } : null, onClick: () => { detail.hidden = !detail.hidden; } },
      el('td', { class: 'mono num' }, String(i)), el('td', { class: 'mono' }, m.role), el('td', { class: 'mono muted' }, [...new Set(kinds)].join('+')), el('td', { class: 'num' }, fmt.int(chars)), el('td', {}, ...flags), el('td', { class: 'muted' }, kinds.includes('text') || typeof m.content === 'string' ? preview(typeof m.content === 'string' ? m.content : (m.content.find((b) => b.type === 'text') || {}).text, 80) : kinds.includes('tool_use') ? m.content.filter((b) => b.type === 'tool_use').map((b) => b.name).join(', ') : kinds.includes('tool_result') ? preview((m.content[0].content && (typeof m.content[0].content === 'string' ? m.content[0].content : (m.content[0].content[0] || {}).text)) || '', 80) : ''));
    rows.push(row, detail);
  });
  const sMessages = section('Messages', el('p', { class: 'explain' }, `${stats.messages} messages in order: the first ${stats.keep} are identical to the previous request (served from the prompt cache if unchanged), the last ${stats.tail} are new. "harness" marks role=system messages Claude Code injects (reminders, hook output). Click a row to read the message.`),
    el('div', { style: { marginBottom: '8px' } }, el('button', { class: 'small ghost', onClick: () => { const first = rows.find((r, i) => i % 2 === 0 && Number(r.firstChild.textContent) >= tailStart); if (first) first.scrollIntoView({ block: 'center' }); } }, '↓ jump to new messages')),
    table(['#', 'role', 'blocks', { label: 'chars', class: 'num' }, 'flags', 'preview'], rows));
  return el('div', { class: 'modal' }, head, explain, sParams, sSystem, sTools, sMessages);
}
function preview(s, n) { if (!s) return ''; const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; }

#!/usr/bin/env node
// Claude Code X-Ray: local visualizer for Claude Code sessions.
// Zero dependencies. Binds to 127.0.0.1 only. Read-only on transcripts.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionState } from './lib/parser.mjs';
import { slimRecord } from './lib/slim.mjs';
import { Tailer } from './lib/tail.mjs';
import { reconstruct } from './lib/reconstruct.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };

// --demo: serve a synthetic session from demo/claude-home instead of ~/.claude.
if (args.includes('--demo')) {
  const { ensureDemo } = await import('./demo/make-demo.mjs');
  process.env.CLAUDE_CONFIG_DIR = await ensureDemo(path.join(__dirname, 'demo', 'claude-home'));
}
const { CLAUDE_DIR, listSessions, liveSessions, findSessionFile, listSubagents, listTasks, readShape } = await import('./lib/discovery.mjs');
const { normalizeHook, hookConfig, hookInstallStatus, installHooks, HOOK_EVENTS } = await import('./lib/hooks.mjs');
const PORT = Number(process.env.PORT || argv('--port', 4545));
const HOST = argv('--host', '127.0.0.1');
const HOOK_URL = `http://${HOST}:${PORT}/hook`;

if (args.includes('--install-hooks')) {
  const r = await installHooks(HOOK_URL, false);
  console.log(`Installed ${HOOK_EVENTS.length} http hooks into ${r.file} (backup: ${r.backup}). Restart Claude Code sessions to pick them up.`);
  process.exit(0);
}
if (args.includes('--uninstall-hooks')) {
  const r = await installHooks(HOOK_URL, true);
  console.log(`Removed X-Ray hooks from ${r.file} (backup: ${r.backup}).`);
  process.exit(0);
}

// ---- state -----------------------------------------------------------------
const tailer = new Tailer({ intervalMs: 750 });
const loaded = new Map();   // sessionId -> LoadedSession
const clients = new Set();  // SSE clients {res, sessionId}
const hookLog = [];         // normalized hook events (ring)
const HOOK_RING = 3000;
let lastList = null;

class LoadedSession {
  constructor(id, file, slug) {
    this.id = id; this.file = file; this.slug = slug;
    this.offsets = [];          // [byteStart, byteLength] per record line
    this.state = new SessionState({ id, slug, path: file });
    this.agents = new Map();    // agentId -> {file, meta, state, offsets}
    this.lastUsed = Date.now();
  }
  ingest(rec, start, len) {
    this.offsets.push([start, len]);
    const entry = this.state.ingest(slimRecord(rec));
    return entry;
  }
}

// Case-insensitive substring search over every transcript line. Returns record
// indices with a short decoded snippet around the first match.
const BOOKKEEPING = new Set(['agent-name', 'custom-title', 'last-prompt', 'atis-latch', 'api-request-blob', 'file-history-snapshot', 'file-history-delta', 'queue-operation', 'mode', 'pr-link', 'cost-state']);
async function searchFile(file, q, limit = 300, includeAll = false) {
  const needle = q.toLowerCase();
  const fh = await fsp.open(file, 'r');
  const hits = []; let n = 0, total = 0, buf = '';
  const snippetOf = (line, i) => {
    const a = Math.max(0, i - 90), b = Math.min(line.length, i + needle.length + 110);
    return (a > 0 ? '…' : '') + line.slice(a, b).replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\t/g, ' ') + (b < line.length ? '…' : '');
  };
  try {
    const stream = fh.createReadStream({ encoding: 'utf8', highWaterMark: 1 << 20 });
    for await (const chunk of stream) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.trim()) {
          const at = line.toLowerCase().indexOf(needle);
          if (at >= 0) {
            let skip = false;
            if (!includeAll) { try { skip = BOOKKEEPING.has(JSON.parse(line).type); } catch { /* keep */ } }
            if (!skip) { total++; if (hits.length < limit) hits.push({ n, snippet: snippetOf(line, at) }); }
          }
          n++;
        }
      }
    }
  } finally { await fh.close(); }
  return { q, total, hits, scanned: n };
}

async function readLine(file, start, len) {
  const fh = await fsp.open(file, 'r');
  try { const buf = Buffer.alloc(len); const { bytesRead } = await fh.read(buf, 0, len, start); return JSON.parse(buf.subarray(0, bytesRead).toString('utf8')); } finally { await fh.close(); }
}

async function load(id) {
  let L = loaded.get(id);
  if (L) { L.lastUsed = Date.now(); return L; }
  const found = await findSessionFile(id);
  if (!found) return null;
  L = new LoadedSession(id, found.path, found.slug);
  const st = await tailer.readAll(found.path, (rec, start, len) => L.ingest(rec, start, len));
  tailer.watch(found.path, st, (rec, start, len) => {
    const entry = L.ingest(rec, start, len);
    broadcast({ type: 'delta', sessionId: id, delta: L.state.delta(entry) }, id);
  });
  loaded.set(id, L);
  await scanAgents(L);
  evict();
  return L;
}

async function scanAgents(L) {
  const list = await listSubagents(L.file);
  for (const a of list) {
    if (L.agents.has(a.agentId)) continue;
    const entry = { file: a.path, meta: a.meta, offsets: [], state: new SessionState({ id: a.agentId, isSidechain: true, agentId: a.agentId, ...a.meta }) };
    L.agents.set(a.agentId, entry);
    L.state.subagents.set(a.agentId, entry.state);
    const st = await tailer.readAll(a.path, (rec, start, len) => { entry.offsets.push([start, len]); entry.state.ingest(slimRecord(rec)); });
    tailer.watch(a.path, st, (rec, start, len) => {
      entry.offsets.push([start, len]);
      const e = entry.state.ingest(slimRecord(rec));
      broadcast({ type: 'delta', sessionId: L.id, agentId: a.agentId, delta: entry.state.delta(e) }, L.id);
    });
    broadcast({ type: 'agent', sessionId: L.id, agentId: a.agentId, snapshot: entry.state.snapshot() }, L.id);
  }
}

function evict() {
  const MAX = 4;
  if (loaded.size <= MAX) return;
  const subscribed = new Set([...clients].map((c) => c.sessionId));
  const victims = [...loaded.values()].filter((L) => !subscribed.has(L.id)).sort((a, b) => a.lastUsed - b.lastUsed);
  while (loaded.size > MAX && victims.length) {
    const L = victims.shift();
    tailer.unwatch(L.file);
    for (const a of L.agents.values()) tailer.unwatch(a.file);
    loaded.delete(L.id);
  }
}

function broadcast(msg, sessionId = null) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const c of clients) {
    if (sessionId && c.sessionId !== sessionId) continue;
    try { c.res.write(data); } catch { clients.delete(c); }
  }
}

// Session list refresh: every 3 s, diff and broadcast.
async function refreshList() {
  try {
    const [sessions, live] = await Promise.all([listSessions(), liveSessions()]);
    const payload = { sessions, live, claudeDir: CLAUDE_DIR, now: Date.now() };
    const key = JSON.stringify(sessions.map((s) => [s.id, s.size, s.mtime])) + JSON.stringify(live.map((l) => [l.sessionId, l.status, l.alive]));
    if (key !== lastList) { lastList = key; broadcast({ type: 'sessions', ...payload }); }
    // keep subagent dirs of subscribed sessions fresh
    for (const c of clients) { const L = c.sessionId && loaded.get(c.sessionId); if (L) await scanAgents(L); }
    return payload;
  } catch (e) { console.error('refreshList', e.message); return { sessions: [], live: [], claudeDir: CLAUDE_DIR, now: Date.now() }; }
}
setInterval(refreshList, 3000);

// ---- http -----------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png' };

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function serveStatic(res, root, rel) {
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  try {
    if (req.method === 'POST' && p === '/hook') {
      const body = await readBody(req);
      let parsed = {}; try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
      const ev = normalizeHook(parsed);
      hookLog.push(ev); if (hookLog.length > HOOK_RING) hookLog.splice(0, hookLog.length - HOOK_RING);
      broadcast({ type: 'hook', hook: ev });
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{}');
    }
    if (p === '/api/sessions') return json(res, 200, await refreshList());
    if (p === '/api/tasks') return json(res, 200, await listTasks());
    if (p === '/api/hooks') {
      const sid = url.searchParams.get('session');
      const since = Number(url.searchParams.get('since') || 0);
      return json(res, 200, hookLog.filter((h) => (!sid || h.sessionId === sid) && h.receivedAt > since).slice(-500));
    }
    if (p === '/api/hook-config') {
      const status = await hookInstallStatus(HOOK_URL);
      return json(res, 200, { url: HOOK_URL, config: hookConfig(HOOK_URL), events: HOOK_EVENTS, ...status, received: hookLog.length });
    }
    let m;
    if ((m = p.match(/^\/api\/session\/([\w-]+)$/))) {
      const L = await load(m[1]);
      if (!L) return json(res, 404, { error: 'session not found' });
      const live = (await liveSessions()).find((l) => l.sessionId === L.id && l.alive) || null;
      return json(res, 200, { id: L.id, slug: L.slug, path: L.file, live, snapshot: L.state.snapshot() });
    }
    if ((m = p.match(/^\/api\/session\/([\w-]+)\/search$/))) {
      const L = await load(m[1]); if (!L) return json(res, 404, { error: 'not found' });
      const q = (url.searchParams.get('q') || '').trim();
      if (q.length < 2) return json(res, 200, { q, total: 0, hits: [] });
      const agentId = url.searchParams.get('agent');
      const src = agentId ? L.agents.get(agentId) : L;
      if (!src) return json(res, 404, { error: 'agent not found' });
      return json(res, 200, await searchFile(src.file, q, Number(url.searchParams.get('limit') || 300), url.searchParams.get('all') === '1'));
    }
    if ((m = p.match(/^\/api\/session\/([\w-]+)\/request\/(\d+)$/))) {
      const L = await load(m[1]); if (!L) return json(res, 404, { error: 'not found' });
      const agentId = url.searchParams.get('agent');
      const src = agentId ? L.agents.get(agentId) : L;
      if (!src) return json(res, 404, { error: 'agent not found' });
      const raw = url.searchParams.get('raw') === '1';
      const r = await reconstruct(src.file, Number(m[2]), { raw });
      if (!r) return json(res, 404, { error: 'record is not an api-request' });
      if (raw) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': `inline; filename="request-${m[2]}.json"` }); return res.end(JSON.stringify(r.body, null, 2)); }
      return json(res, 200, r);
    }
    if ((m = p.match(/^\/api\/session\/([\w-]+)\/agent\/([\w-]+)$/))) {
      const L = await load(m[1]); if (!L) return json(res, 404, { error: 'not found' });
      const a = L.agents.get(m[2]) || (L.state.subagents.has(m[2]) ? { state: L.state.subagents.get(m[2]) } : null);
      return a ? json(res, 200, a.state.snapshot()) : json(res, 404, { error: 'agent not found' });
    }
    if ((m = p.match(/^\/api\/session\/([\w-]+)\/record\/(\d+)$/))) {
      const L = await load(m[1]); if (!L) return json(res, 404, { error: 'not found' });
      const agentId = url.searchParams.get('agent');
      const src = agentId ? L.agents.get(agentId) : L;
      const off = src && src.offsets[Number(m[2])];
      if (!off) return json(res, 404, { error: 'no such record' });
      try { return json(res, 200, await readLine(src.file, off[0], off[1])); } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if ((m = p.match(/^\/api\/session\/([\w-]+)\/shape\/([0-9a-f]{8,})$/))) {
      const L = await load(m[1]); if (!L) return json(res, 404, { error: 'not found' });
      const shape = await readShape(L.file, m[2]);
      return shape ? json(res, 200, shape) : json(res, 404, { error: 'shape not found' });
    }
    if (p === '/api/events') {
      const sessionId = url.searchParams.get('session');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'hello', now: Date.now(), sessionId })}\n\n`);
      const client = { res, sessionId };
      clients.add(client);
      if (sessionId) load(sessionId).catch(() => {});
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* closed */ } }, 15000);
      req.on('close', () => { clearInterval(hb); clients.delete(client); });
      return;
    }
    if (p === '/' || p === '/index.html') return serveStatic(res, path.join(__dirname, 'public'), 'index.html');
    if (p.startsWith('/lib/')) return serveStatic(res, path.join(__dirname, 'lib'), p.slice(5));
    if (p.startsWith('/docs/')) return serveStatic(res, path.join(__dirname, 'docs'), p.slice(6));
    return serveStatic(res, path.join(__dirname, 'public'), p.slice(1));
  } catch (e) {
    console.error(req.method, p, e);
    if (!res.headersSent) json(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Claude Code X-Ray  →  http://${HOST}:${PORT}`);
  console.log(`reading ${CLAUDE_DIR}`);
  console.log(`hooks endpoint ${HOOK_URL}  (install with: node server.mjs --install-hooks)`);
});

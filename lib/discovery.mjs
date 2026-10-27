import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROJECTS = path.join(CLAUDE_DIR, 'projects');
const SESSIONS = path.join(CLAUDE_DIR, 'sessions');
const TASKS = path.join(CLAUDE_DIR, 'tasks');

const headCache = new Map(); // path -> {key, summary}

async function readRange(file, start, length) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally { await fh.close(); }
}

function linesOf(text, dropFirst, dropLast) {
  const lines = text.split('\n');
  if (dropFirst) lines.shift();
  if (dropLast) lines.pop();
  const out = [];
  for (const l of lines) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* partial */ } }
  return out;
}

export function projectLabel(cwd, slug) {
  const p = cwd || slug || '';
  if (/scratch-workspaces/.test(p)) return 'scratch (' + path.basename(p).replace(/^scratch-/, '') + ')';
  const parts = p.split(path.sep).filter(Boolean);
  if (/\.claude-worktrees|claude-worktrees/.test(p)) {
    const i = parts.findIndex((x) => /worktrees/.test(x));
    return parts.slice(Math.max(0, i - 1), i).join('/') + ' ⎇ ' + parts.slice(i + 1).join('/');
  }
  return parts.slice(-2).join('/') || p;
}

async function summarize(file, slug) {
  const st = await fsp.stat(file);
  const key = `${st.size}:${st.mtimeMs}`;
  const cached = headCache.get(file);
  if (cached && cached.key === key) return cached.summary;
  const HEAD = Math.min(st.size, 96 * 1024);
  const head = linesOf(await readRange(file, 0, HEAD), false, st.size > HEAD);
  let tail = [];
  if (st.size > HEAD) {
    const TAIL = Math.min(st.size - HEAD, 96 * 1024);
    tail = linesOf(await readRange(file, st.size - TAIL, TAIL), true, false);
  }
  const all = head.concat(tail);
  const id = path.basename(file, '.jsonl');
  const summary = {
    id, slug, path: file, size: st.size, mtime: st.mtimeMs, cwd: null, version: null, model: null, firstPrompt: '', title: null, agentName: null,
    startedAt: null, endedAt: null, cost: null, isSidechain: false, entrypoint: null, gitBranch: null,
  };
  for (const r of all) {
    if (r.cwd && !summary.cwd) summary.cwd = r.cwd;
    if (r.version && !summary.version) summary.version = r.version;
    if (r.entrypoint && !summary.entrypoint) summary.entrypoint = r.entrypoint;
    if (r.gitBranch && !summary.gitBranch) summary.gitBranch = r.gitBranch;
    if (r.timestamp) { const t = Date.parse(r.timestamp); if (Number.isFinite(t)) { if (summary.startedAt == null || t < summary.startedAt) summary.startedAt = t; if (summary.endedAt == null || t > summary.endedAt) summary.endedAt = t; } }
    if (r.type === 'user' && !summary.firstPrompt && !r.isMeta && !r.isCompactSummary && r.message) {
      const c = r.message.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ') : '';
      if (text) summary.firstPrompt = text.replace(/\s+/g, ' ').slice(0, 140);
    }
    if (r.type === 'assistant' && r.message && r.message.model) summary.model = r.message.model;
    if (r.type === 'custom-title') summary.title = r.customTitle;
    if (r.type === 'agent-name') summary.agentName = r.agentName;
    if (r.type === 'cost-state') summary.cost = { totalCostUSD: r.totalCostUSD, totalDuration: r.totalDuration, totalLinesAdded: r.totalLinesAdded, totalLinesRemoved: r.totalLinesRemoved };
    if (r.isSidechain) summary.isSidechain = true;
  }
  summary.project = projectLabel(summary.cwd, slug);
  const agentsDir = path.join(path.dirname(file), id, 'subagents');
  try { summary.subagents = (await fsp.readdir(agentsDir)).filter((f) => f.endsWith('.jsonl')).length; } catch { summary.subagents = 0; }
  headCache.set(file, { key, summary });
  return summary;
}

export async function listSessions() {
  let slugs = [];
  try { slugs = await fsp.readdir(PROJECTS); } catch { return []; }
  const out = [];
  await Promise.all(slugs.map(async (slug) => {
    const dir = path.join(PROJECTS, slug);
    let files = [];
    try { files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jsonl')); } catch { return; }
    for (const f of files) {
      try { out.push(await summarize(path.join(dir, f), slug)); } catch { /* unreadable */ }
    }
  }));
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

export async function liveSessions() {
  let files = [];
  try { files = (await fsp.readdir(SESSIONS)).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const d = JSON.parse(await fsp.readFile(path.join(SESSIONS, f), 'utf8'));
      if (!d.pid || !d.sessionId) continue;
      const alive = pidAlive(d.pid);
      out.push({ pid: d.pid, sessionId: d.sessionId, cwd: d.cwd, status: d.status || null, name: d.name || null, kind: d.kind || null, entrypoint: d.entrypoint || null, version: d.version || null, startedAt: d.startedAt || null, updatedAt: d.updatedAt || null, alive });
    } catch { /* skip */ }
  }
  return out;
}

export async function findSessionFile(id) {
  if (!/^[\w-]+$/.test(id)) return null;
  let slugs = [];
  try { slugs = await fsp.readdir(PROJECTS); } catch { return null; }
  for (const slug of slugs) {
    const p = path.join(PROJECTS, slug, id + '.jsonl');
    if (fs.existsSync(p)) return { path: p, slug };
  }
  return null;
}

export async function listSubagents(sessionFile) {
  const id = path.basename(sessionFile, '.jsonl');
  const dir = path.join(path.dirname(sessionFile), id, 'subagents');
  let files = [];
  try { files = await fsp.readdir(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const agentId = f.replace(/^agent-/, '').replace(/\.jsonl$/, '');
    let meta = {};
    try { meta = JSON.parse(await fsp.readFile(path.join(dir, f.replace(/\.jsonl$/, '.meta.json')), 'utf8')); } catch { /* none */ }
    out.push({ agentId, path: path.join(dir, f), meta });
  }
  return out;
}

export async function listTasks() {
  let groups = [];
  try { groups = await fsp.readdir(TASKS); } catch { return {}; }
  const out = {};
  for (const g of groups) {
    const dir = path.join(TASKS, g);
    let files = [];
    try { files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json')); } catch { continue; }
    const items = [];
    for (const f of files) { try { items.push(JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'))); } catch { /* skip */ } }
    items.sort((a, b) => Number(a.id) - Number(b.id));
    if (items.length) out[g] = items;
  }
  return out;
}

export async function readShape(sessionFile, hash) {
  // Scan the file for the api-request-shape record with this hash. Shapes are rare, so a linear scan is fine.
  const fh = await fsp.open(sessionFile, 'r');
  try {
    const stream = fh.createReadStream({ encoding: 'utf8' });
    let buf = '';
    for await (const chunk of stream) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.includes('"api-request-shape"') && line.includes(hash)) {
          try { const r = JSON.parse(line); if (r.type === 'api-request-shape' && r.shapeHash === hash) { let s = r.shape; if (typeof s === 'string') s = JSON.parse(s); return s; } } catch { /* continue */ }
        }
      }
    }
  } finally { await fh.close(); }
  return null;
}

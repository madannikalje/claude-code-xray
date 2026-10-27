// Rebuild the exact Messages API body for an api-request record.
//
// The transcript stores requests content-addressed: `base` names the previous
// api-request, `keep` says how many of its messages are reused, `tail` lists the
// hashes of the new messages (bodies in api-request-blob records), and
// `shapeHash` points at the api-request-shape record with system + tools.
import fsp from 'node:fs/promises';

const indexCache = new Map(); // file -> {size, reqs: Map(id -> {n, off}), reqByN: Map(n -> id), blobs: Map(hash -> off), shapes: Map(hash -> off)}

async function readAt(file, off) {
  const fh = await fsp.open(file, 'r');
  try { const buf = Buffer.alloc(off[1]); const { bytesRead } = await fh.read(buf, 0, off[1], off[0]); return JSON.parse(buf.subarray(0, bytesRead).toString('utf8')); } finally { await fh.close(); }
}

// One streaming pass that records byte offsets of every request, blob and shape line.
export async function buildIndex(file) {
  const st = await fsp.stat(file);
  const cached = indexCache.get(file);
  if (cached && cached.size === st.size) return cached;
  const idx = { size: st.size, reqs: new Map(), reqByN: new Map(), blobs: new Map(), shapes: new Map() };
  const fh = await fsp.open(file, 'r');
  let pos = 0, n = 0, partial = '';
  try {
    const stream = fh.createReadStream({ encoding: 'utf8', highWaterMark: 1 << 20 });
    for await (const chunk of stream) {
      partial += chunk;
      let i;
      while ((i = partial.indexOf('\n')) >= 0) {
        const line = partial.slice(0, i); partial = partial.slice(i + 1);
        const len = Buffer.byteLength(line, 'utf8');
        if (line.trim()) {
          if (line.includes('"api-request')) {
            try {
              const r = JSON.parse(line);
              if (r.type === 'api-request') { idx.reqs.set(r.id, { n, off: [pos, len] }); idx.reqByN.set(n, r.id); }
              else if (r.type === 'api-request-blob') idx.blobs.set(r.hash, [pos, len]);
              else if (r.type === 'api-request-shape') idx.shapes.set(r.shapeHash, [pos, len]);
            } catch { /* skip */ }
          }
          n++;
        }
        pos += len + 1;
      }
    }
  } finally { await fh.close(); }
  indexCache.set(file, idx);
  return idx;
}

const parse = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };

// Replace base64 image data with a placeholder so the body stays readable; sizes are kept in stats.
function stripImages(content, stats) {
  if (!Array.isArray(content)) return content;
  return content.map((b) => {
    if (b && b.type === 'image' && b.source && typeof b.source.data === 'string') {
      stats.imageChars += b.source.data.length; stats.images++;
      return { ...b, source: { ...b.source, data: `[base64 image, ${b.source.data.length.toLocaleString('en-US')} chars omitted]` } };
    }
    if (b && b.type === 'tool_result' && Array.isArray(b.content)) return { ...b, content: stripImages(b.content, stats) };
    return b;
  });
}

export async function reconstruct(file, n, { raw = false } = {}) {
  const idx = await buildIndex(file);
  const id = idx.reqByN.get(n);
  if (!id) return null;
  // Walk the base chain back to the root, then replay forward: msgs = prev[:keep] + tail.
  const chain = [];
  let cur = id; const seen = new Set();
  while (cur && idx.reqs.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    const r = await readAt(file, idx.reqs.get(cur).off);
    chain.unshift(r);
    cur = r.base || null;
  }
  const brokenChain = !!cur && !idx.reqs.has(cur);
  let hashes = [];
  for (const r of chain) {
    const tail = parse(r.tail) || [];
    hashes = (r.base ? hashes.slice(0, Number(r.keep) || 0) : []).concat(Array.isArray(tail) ? tail : []);
  }
  const target = chain[chain.length - 1];
  const keep = target.base ? Number(target.keep) || 0 : 0;
  const stats = { keep, tail: hashes.length - keep, messages: hashes.length, resolved: 0, unresolved: 0, images: 0, imageChars: 0, systemChars: 0, toolsChars: 0, messagesChars: 0, brokenChain };
  const messages = [];
  for (const h of hashes) {
    const off = idx.blobs.get(h);
    if (!off) { stats.unresolved++; messages.push({ role: 'unknown', content: [{ type: 'text', text: `[body ${h.slice(0, 12)}… not found in this transcript]` }], _unresolved: true, _hash: h }); continue; }
    const blob = await readAt(file, off);
    const m = blob.message || {};
    const msg = { role: m.role, content: raw ? m.content : stripImages(m.content, stats) };
    if (m.output_config) msg.output_config = m.output_config;
    if (m.clear_at) msg.clear_at = m.clear_at;
    stats.resolved++;
    stats.messagesChars += JSON.stringify(m.content || '').length;
    messages.push(msg);
  }
  let system = [], tools = [];
  const shapeOff = idx.shapes.get(target.shapeHash);
  if (shapeOff) { const sh = parse((await readAt(file, shapeOff)).shape) || {}; system = (sh.system || []).map((b) => ({ ...b })); tools = sh.tools || []; }
  stats.systemChars = system.reduce((a, b) => a + (b.text || '').length, 0);
  stats.toolsChars = JSON.stringify(tools).length;
  stats.totalChars = stats.systemChars + stats.toolsChars + stats.messagesChars;
  // Apply cache_control markers at the recorded paths.
  const cc = parse(target.cacheControl) || [];
  const body = { ...(parse(target.params) || {}), system, tools, messages };
  const cachePoints = [];
  for (const c of Array.isArray(cc) ? cc : []) {
    const p = c.path || [];
    try {
      let node = body; for (let i = 0; i < p.length - 1; i++) node = node[p[i]];
      const leaf = node[p[p.length - 1]];
      if (leaf && typeof leaf === 'object') leaf.cache_control = c.value;
      cachePoints.push({ path: p.join('.'), value: c.value });
    } catch { cachePoints.push({ path: p.join('.'), value: c.value, missing: true }); }
  }
  return { n, id, timestamp: target.timestamp, shapeHash: target.shapeHash, base: target.base || null, requestDigest: target.requestDigest || null, betas: body.betas || [], stats, cachePoints, body };
}

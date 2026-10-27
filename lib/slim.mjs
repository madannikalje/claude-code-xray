// Reduce a raw transcript record to what the browser needs for parsing and
// display. Heavy payloads (tool output, thinking, blobs, snapshots) are
// truncated and tagged with their original size. The inspector fetches the
// full record from the server on demand.

const MARK = (s, max) => (s.length > max ? s.slice(0, max) + `…[+${s.length - max} chars]` : s);

function truncDeep(v, max, depth = 0) {
  if (typeof v === 'string') return MARK(v, max);
  if (Array.isArray(v)) {
    if (depth > 6) return `[array ${v.length}]`;
    const out = v.slice(0, 200).map((x) => truncDeep(x, max, depth + 1));
    if (v.length > 200) out.push(`…[+${v.length - 200} items]`);
    return out;
  }
  if (v && typeof v === 'object') {
    if (depth > 6) return '[object]';
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = truncDeep(val, max, depth + 1);
    return o;
  }
  return v;
}

function slimBlocks(content, limits) {
  if (!Array.isArray(content)) return typeof content === 'string' ? MARK(content, limits.text) : content;
  return content.map((b) => {
    if (!b || typeof b !== 'object') return b;
    switch (b.type) {
      case 'thinking': return { type: 'thinking', originalLength: (b.thinking || '').length, thinking: MARK(b.thinking || '', limits.thinking) };
      case 'text': return { type: 'text', originalLength: (b.text || '').length, text: MARK(b.text || '', limits.text) };
      case 'tool_use': return { ...b, input: truncDeep(b.input, limits.input) };
      case 'tool_result': {
        const c = b.content;
        const originalLength = typeof c === 'string' ? c.length : JSON.stringify(c || '').length;
        let content;
        if (typeof c === 'string') content = MARK(c, limits.result);
        else if (Array.isArray(c)) content = c.map((x) => (x && x.type === 'text' ? { type: 'text', text: MARK(x.text || '', limits.result) } : x && x.type === 'image' ? { type: 'image' } : truncDeep(x, 500)));
        else content = truncDeep(c, limits.result);
        return { ...b, content, originalLength };
      }
      case 'image': return { type: 'image' };
      default: return truncDeep(b, 500);
    }
  });
}

export function slimRecord(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  const limits = { thinking: 500, text: 3000, input: 1500, result: 1200 };
  switch (rec.type) {
    case 'assistant': {
      const m = rec.message || {};
      return { ...rec, message: { ...m, content: slimBlocks(m.content, limits) } };
    }
    case 'user': {
      const m = rec.message || {};
      const out = { ...rec, message: { ...m, content: slimBlocks(m.content, { ...limits, text: 6000 }) } };
      if (rec.toolUseResult !== undefined) {
        const tr = rec.toolUseResult;
        if (Array.isArray(tr)) out.toolUseResult = { _type: 'array', length: tr.length, sample: truncDeep(tr.slice(0, 3), 300) };
        else if (tr && typeof tr === 'object') out.toolUseResult = truncDeep(tr, 500);
        else if (typeof tr === 'string') out.toolUseResult = MARK(tr, 500);
      }
      return out;
    }
    case 'attachment': return { ...rec, attachment: truncDeep(rec.attachment, 1500) };
    case 'api-request-blob': {
      const m = rec.message || {};
      const c = m.content;
      const kinds = Array.isArray(c) ? [...new Set(c.map((b) => b && b.type).filter(Boolean))] : (typeof c === 'string' ? ['text'] : []);
      const size = typeof c === 'string' ? c.length : JSON.stringify(c || '').length;
      let previewText = '';
      if (typeof c === 'string') previewText = c.slice(0, 160);
      else if (Array.isArray(c)) { const t = c.find((b) => b && (b.type === 'text' || b.type === 'tool_result')); previewText = t ? (typeof t.text === 'string' ? t.text : JSON.stringify(t.content || '')).slice(0, 160) : ''; }
      return { type: rec.type, sessionId: rec.sessionId, hash: rec.hash, message: { role: m.role }, size, kinds, preview: previewText };
    }
    case 'api-request-shape': {
      let shape = rec.shape; if (typeof shape === 'string') { try { shape = JSON.parse(shape); } catch { shape = null; } }
      const system = shape && Array.isArray(shape.system) ? shape.system : [];
      const tools = shape && Array.isArray(shape.tools) ? shape.tools : [];
      const shapeStats = {
        systemBlocks: system.map((b) => ({ chars: (b && b.text ? b.text.length : 0), preview: (b && b.text ? b.text.replace(/\s+/g, ' ').slice(0, 90) : ''), cache: !!(b && b.cache_control) })),
        systemChars: system.reduce((a, b) => a + (b && b.text ? b.text.length : 0), 0),
        toolCount: tools.length, toolNames: tools.map((t) => t && t.name).filter(Boolean), toolsChars: JSON.stringify(tools).length,
      };
      const { shape: _drop, ...rest } = rec;
      return { ...rest, shapeStats };
    }
    case 'api-request': {
      let params = rec.params; if (typeof params === 'string') { try { params = JSON.parse(params); } catch { /* keep */ } }
      if (params && typeof params === 'object' && Array.isArray(params.tools)) params = { ...params, tools: `[${params.tools.length} tools]` };
      return { ...rec, params, tail: rec.tail, cacheControl: rec.cacheControl };
    }
    case 'file-history-snapshot': {
      const snap = rec.snapshot;
      const files = snap && typeof snap === 'object' ? (snap.trackedFileBackups ? Object.keys(snap.trackedFileBackups).length : Object.keys(snap).length) : 0;
      return { type: rec.type, messageId: rec.messageId, isSnapshotUpdate: rec.isSnapshotUpdate, snapshotFiles: files };
    }
    case 'queue-operation': return { ...rec, content: typeof rec.content === 'string' ? MARK(rec.content, 500) : rec.content };
    default: return truncDeep(rec, 4000);
  }
}

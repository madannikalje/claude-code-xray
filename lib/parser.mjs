// Shared transcript parser. Runs in Node (server) and in the browser (client).
// Input: one JSON record per transcript line. Output: a session model that the
// views render. Keep this file dependency-free.

export const RECORD_KINDS = {
  user: 'A user-role message: either a human prompt (string content) or the carrier for tool_result blocks that feed tool output back to the model.',
  assistant: 'One content block streamed from the model (thinking, text or tool_use). Blocks of the same API response share a requestId.',
  attachment: 'Context the harness injects into the conversation on its own: hook output, system reminders, tool listings, token reminders.',
  system: 'Harness bookkeeping shown to the user, such as a summary of what Stop hooks did.',
  'api-request': 'The real API call Claude Code made: model params, cache breakpoints and a content-addressed message list (keep = cached prefix, tail = new messages).',
  'api-request-blob': 'A content-addressed message body referenced by hash from api-request. This is how the transcript avoids writing the whole context on every call.',
  'api-request-shape': 'The system prompt blocks and tool schemas for a request, stored once per distinct shape (shapeHash).',
  'cost-state': 'Running totals Claude Code keeps for the session: cost, token usage per model, API and tool durations, lines changed.',
  'queue-operation': 'The user-message queue: prompts typed while the model is busy are enqueued, then dequeued at the next turn boundary.',
  'file-history-snapshot': 'A checkpoint of files touched so far, used by /rewind.',
  'file-history-delta': 'A file backup recorded before an edit, used by /rewind.',
  mode: 'The permission mode in effect (normal, plan, acceptEdits, bypassPermissions).',
  'pr-link': 'A pull request associated with this session.',
  'custom-title': 'A title set for the session.',
  'agent-name': 'A display name assigned to the session.',
  'last-prompt': 'Bookkeeping: the last prompt and the leaf uuid of the message tree.',
  'atis-latch': 'Internal latch flag kept by the harness.',
  summary: 'A compaction summary (older transcript format): the conversation so far, condensed by the model.',
};

export const ATTACHMENT_KINDS = {
  hook_success: 'A hook ran and succeeded; its stdout may have been added to context.',
  hook_additional_context: 'Text a hook asked to add to the model context.',
  total_tokens_reminder: 'A reminder to the model of how many tokens remain in the context window.',
  deferred_tools_delta: 'Tool schemas that were deferred (not sent) and the names added or removed; the model loads them with ToolSearch.',
  deferred_tools_record: 'Record of which deferred tools were in effect for a call.',
  skill_listing: 'The list of available skills injected into context.',
  agent_listing_delta: 'Changes in the list of available subagent types.',
  mcp_instructions_delta: 'Instructions from MCP servers added or removed from context.',
  instructions: 'CLAUDE.md or rules files loaded into context.',
  environment: 'Environment snapshot (cwd, platform, shell) given to the model.',
  model: 'The model identity text injected into context.',
  date: 'The current date injected into context.',
  session_context: 'Session-specific context given to the model.',
  batching_reminder_sent: 'A reminder nudging the model to batch independent tool calls.',
  command_permissions: 'Permission rules the model was told about for a command.',
  edited_text_file: 'Notice that a file the model read was edited outside the session.',
  queued_command: 'A queued user command delivered to the model mid-turn.',
  prompt_snapshot: 'Snapshot of the prompt as sent.',
  silent_turn_reminder: 'A reminder when a turn produced no visible output.',
  auto_mode: 'Auto-mode (permission) settings in effect.',
  credential_org: 'Organization credential context.',
  remote_session_change: 'Notice that a remote/linked session changed.',
  mcp_dropped_tools_delta: 'MCP tools dropped from the tool list.',
};

export const HOOK_EVENT_DOCS = {
  SessionStart: 'Fires when a session starts or resumes. Hooks can inject context (what the superpowers hook does).',
  UserPromptSubmit: 'Fires when you submit a prompt, before the model sees it. Can block or add context.',
  PreToolUse: 'Fires before a tool runs. Can allow, deny, or rewrite the input.',
  PermissionRequest: 'Fires when a tool call needs a permission decision from you.',
  PermissionDenied: 'Fires when auto mode denies a tool call.',
  PostToolUse: 'Fires after a tool succeeds, with its response.',
  PostToolUseFailure: 'Fires after a tool fails.',
  PostToolBatch: 'Fires after a batch of parallel tool calls resolves.',
  Notification: 'Fires when Claude Code shows a notification (for example, waiting for input).',
  SubagentStart: 'Fires when a subagent is spawned (Agent tool).',
  SubagentStop: 'Fires when a subagent finishes.',
  PreCompact: 'Fires before context compaction (manual or auto).',
  PostCompact: 'Fires after compaction, with the generated summary.',
  Stop: 'Fires when the main agent finishes its turn. Can force it to continue.',
  StopFailure: 'Fires when a turn ends on an API error.',
  SessionEnd: 'Fires when the session terminates.',
  TaskCreated: 'Fires when a task list item is created.',
  TaskCompleted: 'Fires when a task list item is completed.',
  InstructionsLoaded: 'Fires when CLAUDE.md or rules files are loaded.',
  PreModelSwitch: 'Fires before the model changes.',
  PostModelSwitch: 'Fires after the model changes.',
  MessageDisplay: 'Fires as assistant text is displayed.',
};

export function textOf(content, limit = Infinity) {
  if (content == null) return '';
  if (typeof content === 'string') return content.slice(0, limit);
  if (Array.isArray(content)) {
    const parts = [];
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      else if (b.type === 'tool_result') parts.push(textOf(b.content));
      else if (b.type === 'image') parts.push('[image]');
    }
    return parts.join('\n').slice(0, limit);
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text.slice(0, limit);
  return '';
}

export function preview(str, n = 200) {
  if (!str) return '';
  const s = String(str).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function ts(rec) {
  const t = rec && rec.timestamp ? Date.parse(rec.timestamp) : NaN;
  return Number.isFinite(t) ? t : null;
}

function safeJson(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

export class SessionState {
  constructor(meta = {}) {
    this.meta = meta;
    this.n = 0;
    this.records = [];       // slim stream entries, in file order
    this.turns = [];
    this.calls = [];
    this.tools = [];
    this.attachments = [];
    this.events = [];        // system, queue, mode, pr, hooks summaries
    this.apiRequests = [];
    this.compactions = [];
    this.subagents = new Map();
    this.cost = null;
    this.shapes = new Map();  // shapeHash -> stats
    this.blobs = new Map();   // hash -> {role, size, kinds}
    this.info = {
      id: meta.id || null, version: null, model: null, cwd: meta.cwd || null, gitBranch: null,
      startedAt: null, endedAt: null, title: null, agentName: null, lastPrompt: null,
      permissionMode: null, entrypoint: null, isSidechain: !!meta.isSidechain, agentId: meta.agentId || null,
    };
    this._callsByReq = new Map();
    this._toolsById = new Map();
    this._pendingApiRequests = [];
    this._currentTurn = null;
    this._lastContext = 0;
    this._touched = null;
  }

  _mark(kind, idx) { if (this._touched) (this._touched[kind] || (this._touched[kind] = new Set())).add(idx); }

  // ---- ingestion -------------------------------------------------------
  ingest(rec) {
    if (!rec || typeof rec !== 'object') return null;
    this._touched = {};
    const n = this.n++;
    const t = ts(rec);
    if (t != null) {
      if (this.info.startedAt == null || t < this.info.startedAt) this.info.startedAt = t;
      if (this.info.endedAt == null || t > this.info.endedAt) this.info.endedAt = t;
    }
    if (rec.version && !this.info.version) this.info.version = rec.version;
    if (rec.cwd && !this.info.cwd) this.info.cwd = rec.cwd;
    if (rec.gitBranch && !this.info.gitBranch) this.info.gitBranch = rec.gitBranch;
    if (rec.entrypoint && !this.info.entrypoint) this.info.entrypoint = rec.entrypoint;
    if (rec.sessionId && !this.info.id) this.info.id = rec.sessionId;

    // Inline sidechain records (older format): route to a child state.
    if (rec.isSidechain && rec.agentId && !this.info.isSidechain) {
      const child = this.subagent(rec.agentId, {});
      child.ingest(rec);
      const e = { n, type: rec.type, ts: t, uuid: rec.uuid, kind: 'sidechain', label: `subagent ${rec.agentId}: ${rec.type}`, agentId: rec.agentId };
      this.records.push(e);
      return e;
    }

    const entry = { n, type: rec.type, ts: t, uuid: rec.uuid || null, parentUuid: rec.parentUuid || null, kind: rec.type, label: '' };
    switch (rec.type) {
      case 'user': this._user(rec, entry, n); break;
      case 'assistant': this._assistant(rec, entry, n); break;
      case 'attachment': this._attachment(rec, entry, n); break;
      case 'system': this._system(rec, entry, n); break;
      case 'api-request': this._apiRequest(rec, entry, n); break;
      case 'api-request-blob': this._blob(rec, entry); break;
      case 'api-request-shape': this._shape(rec, entry); break;
      case 'cost-state': this.cost = rec; this._mark('cost', 0); entry.label = `cost-state: $${(rec.totalCostUSD || 0).toFixed(2)}`; break;
      case 'queue-operation':
        entry.label = `queue ${rec.operation}${rec.reason ? ' (' + rec.reason + ')' : ''}${rec.content ? ': ' + preview(rec.content, 60) : ''}`;
        this.events.push({ n, ts: t, kind: 'queue', label: entry.label }); this._mark('events', this.events.length - 1);
        break;
      case 'mode':
        this.info.permissionMode = rec.mode; entry.label = `permission mode: ${rec.mode}`;
        this.events.push({ n, ts: t, kind: 'mode', label: entry.label }); this._mark('events', this.events.length - 1);
        break;
      case 'pr-link': entry.label = `PR linked: ${rec.prUrl || rec.prNumber}`; this.events.push({ n, ts: t, kind: 'pr', label: entry.label }); this._mark('events', this.events.length - 1); break;
      case 'custom-title': this.info.title = rec.customTitle; entry.label = `title: ${rec.customTitle}`; break;
      case 'agent-name': this.info.agentName = rec.agentName; entry.label = `agent name: ${rec.agentName}`; break;
      case 'last-prompt': this.info.lastPrompt = rec.lastPrompt; entry.label = 'last-prompt bookkeeping'; break;
      case 'summary':
        this.compactions.push({ n, ts: t, kind: 'summary', leafUuid: rec.leafUuid, text: preview(rec.summary, 300) }); this._mark('compactions', this.compactions.length - 1);
        entry.label = 'compaction summary'; entry.kind = 'compaction';
        break;
      case 'file-history-snapshot': entry.label = 'file checkpoint snapshot'; break;
      case 'file-history-delta': entry.label = `file backup: ${rec.trackingPath || ''}`; break;
      default: entry.label = rec.type || 'unknown';
    }
    this.records.push(entry);
    return entry;
  }

  // What changed in the model because of the last ingest(). Used for live deltas.
  delta(entry) {
    const t = this._touched || {};
    const pick = (arr, set) => { const o = {}; if (set) for (const i of set) o[i] = arr[i]; return o; };
    const d = {
      entry, info: this.info, totals: this.totals(), phase: this.phase(),
      turns: pick(this.turns, t.turns), calls: pick(this.calls, t.calls), tools: pick(this.tools, t.tools),
      attachments: pick(this.attachments, t.attachments), events: pick(this.events, t.events),
      apiRequests: pick(this.apiRequests, t.apiRequests), compactions: pick(this.compactions, t.compactions),
    };
    if (t.cost) d.cost = this.cost;
    if (t.shapes) d.shapes = [...t.shapes].map((h) => this.shapes.get(h));
    if (t.tools) d.toolMix = this.toolMix();
    return d;
  }

  subagent(id, meta) {
    let s = this.subagents.get(id);
    if (!s) {
      s = new SessionState({ id, isSidechain: true, agentId: id, ...meta });
      s.meta = { id, isSidechain: true, agentId: id, ...meta };
      this.subagents.set(id, s);
    } else if (meta && Object.keys(meta).length) {
      Object.assign(s.meta, meta);
    }
    return s;
  }

  _startTurn(rec, entry, n, text, origin) {
    const t = ts(rec);
    const turn = {
      index: this.turns.length, n, promptUuid: rec.uuid || null, prompt: text, promptPreview: preview(text, 160),
      origin, startedAt: t, endedAt: t, calls: [], toolCount: 0, outputTokens: 0, isMeta: !!rec.isMeta,
    };
    this.turns.push(turn);
    this._mark('turns', turn.index);
    this._currentTurn = turn;
    return turn;
  }

  _user(rec, entry, n) {
    const m = rec.message || {};
    const content = m.content;
    const t = ts(rec);
    if (rec.isCompactSummary) {
      const text = textOf(content);
      this.compactions.push({ n, ts: t, kind: 'compact', text: preview(text, 300), length: text.length }); this._mark('compactions', this.compactions.length - 1);
      entry.kind = 'compaction'; entry.label = `compaction summary (${text.length} chars)`;
      this._startTurn(rec, entry, n, text, 'compaction');
      return;
    }
    const results = Array.isArray(content) ? content.filter((b) => b && b.type === 'tool_result') : [];
    if (results.length) {
      entry.kind = 'tool_result';
      const names = [];
      for (const r of results) {
        const tool = this._toolsById.get(r.tool_use_id);
        const text = textOf(r.content);
        if (tool) {
          this._mark('tools', tool.index);
          tool.resultAt = t;
          tool.durationMs = tool.startedAt != null && t != null ? Math.max(0, t - tool.startedAt) : null;
          tool.isError = !!r.is_error;
          tool.resultPreview = preview(text, 240);
          tool.resultChars = text.length;
          tool.resultN = n;
          if (rec.permissionDecision) tool.permission = safeJson(rec.permissionDecision);
          if (rec.toolUseResult && typeof rec.toolUseResult === 'object' && !Array.isArray(rec.toolUseResult)) {
            const tr = rec.toolUseResult;
            tool.resultMeta = {
              interrupted: tr.interrupted, stdoutChars: typeof tr.stdout === 'string' ? tr.stdout.length : undefined,
              stderrChars: typeof tr.stderr === 'string' ? tr.stderr.length : undefined, filePath: tr.filePath,
              type: tr.type, keys: Object.keys(tr).slice(0, 12),
            };
          }
          names.push(tool.name);
        } else {
          names.push(r.tool_use_id);
        }
      }
      entry.label = `tool_result → ${names.join(', ')}${results.some((r) => r.is_error) ? ' (error)' : ''}`;
      entry.toolIds = results.map((r) => r.tool_use_id);
      if (this._currentTurn && t != null) { this._currentTurn.endedAt = Math.max(this._currentTurn.endedAt || 0, t); this._mark('turns', this._currentTurn.index); }
      return;
    }
    const text = textOf(content);
    const origin = rec.turnOrigin || rec.promptSource || (rec.isMeta ? 'meta' : 'human');
    entry.kind = rec.isMeta ? 'meta' : 'prompt';
    entry.label = (rec.isMeta ? 'meta: ' : 'prompt: ') + preview(text, 100);
    this._startTurn(rec, entry, n, text, origin);
  }

  _assistant(rec, entry, n) {
    const m = rec.message || {};
    const t = ts(rec);
    const reqId = rec.requestId || m.id || rec.uuid || `anon-${n}`;
    let call = this._callsByReq.get(reqId);
    if (!call) {
      let api = null;
      while (this._pendingApiRequests.length) {
        const cand = this._pendingApiRequests.shift();
        if (t == null || cand.ts == null || (t - cand.ts >= 0 && t - cand.ts < 15 * 60 * 1000)) api = cand;
      }
      call = {
        index: this.calls.length, requestId: reqId, messageId: m.id || null, turnIndex: this._currentTurn ? this._currentTurn.index : -1,
        n, startedAt: api && api.ts != null ? api.ts : t, firstBlockAt: t, endedAt: t, model: m.model || null,
        requestedModel: rec.requestedModel || null, effort: rec.effort || null, stopReason: null,
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, contextTokens: 0, blocks: [], toolUses: [],
        thinkingMs: 0, thinkingChars: 0, textChars: 0, apiRequestIndex: api ? api.index : null,
      };
      this._callsByReq.set(reqId, call);
      this.calls.push(call);
      if (this._currentTurn) this._currentTurn.calls.push(call.index);
      if (api) this._mark('apiRequests', api.index);
      if (m.model && !this.info.model) this.info.model = m.model;
    }
    this._mark('calls', call.index);
    if (this._currentTurn) this._mark('turns', this._currentTurn.index);
    if (t != null) {
      call.endedAt = t;
      if (this._currentTurn) this._currentTurn.endedAt = Math.max(this._currentTurn.endedAt || 0, t);
    }
    if (m.stop_reason) call.stopReason = m.stop_reason;
    if (m.usage) {
      const u = m.usage;
      call.usage = {
        input: u.input_tokens || 0, output: u.output_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0, cacheCreate: u.cache_creation_input_tokens || 0,
      };
      call.contextTokens = call.usage.input + call.usage.cacheRead + call.usage.cacheCreate;
      this._lastContext = call.contextTokens;
    }
    if (rec.thinkingDurationMs) call.thinkingMs = Math.max(call.thinkingMs, rec.thinkingDurationMs);
    const blocks = Array.isArray(m.content) ? m.content : (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : []);
    const labels = [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'thinking') {
        const txt = b.thinking || '';
        call.thinkingChars += (b.originalLength || txt.length);
        call.blocks.push({ type: 'thinking', n, chars: b.originalLength || txt.length, preview: preview(txt, 300) });
        labels.push('thinking');
      } else if (b.type === 'text') {
        call.textChars += (b.text || '').length;
        call.blocks.push({ type: 'text', n, chars: (b.originalLength || (b.text || '').length), preview: preview(b.text, 400) });
        labels.push('text');
      } else if (b.type === 'tool_use') {
        const inputJson = JSON.stringify(b.input || {});
        const tool = {
          index: this.tools.length, id: b.id, name: b.name, input: inputJson.length <= 900 ? b.input : { _truncated: true, _chars: inputJson.length, preview: inputJson.slice(0, 900) },
          inputChars: inputJson.length, inputPreview: preview(inputJson, 160),
          callIndex: call.index, turnIndex: call.turnIndex, n, startedAt: t, resultAt: null, durationMs: null,
          isError: false, permission: null, resultPreview: '', resultChars: 0, resultMeta: null, subagentId: null,
          caller: b.caller || null,
        };
        this.tools.push(tool);
        this._mark('tools', tool.index);
        this._toolsById.set(b.id, tool);
        call.toolUses.push(tool.id);
        call.blocks.push({ type: 'tool_use', n, name: b.name, toolId: b.id, preview: tool.inputPreview });
        if (this._currentTurn) this._currentTurn.toolCount++;
        labels.push(`tool_use ${b.name}`);
      } else {
        call.blocks.push({ type: b.type, n });
        labels.push(b.type);
      }
    }
    if (this._currentTurn) this._currentTurn.outputTokens = this._currentTurn.calls.reduce((a, i) => a + (this.calls[i].usage.output || 0), 0);
    entry.kind = 'assistant';
    entry.label = `${labels.join(' + ') || 'assistant'}${m.stop_reason ? ' · stop=' + m.stop_reason : ''}`;
    entry.requestId = reqId;
  }

  _attachment(rec, entry, n) {
    const a = rec.attachment || {};
    const t = ts(rec);
    let summary = '';
    switch (a.type) {
      case 'hook_success': case 'hook_additional_context':
        summary = `${a.hookName || a.hookEvent || 'hook'}${a.durationMs != null ? ' ' + a.durationMs + 'ms' : ''}${a.exitCode != null ? ' exit ' + a.exitCode : ''}`;
        this.events.push({ n, ts: t, kind: 'hook', label: `${a.type}: ${summary}`, hookEvent: a.hookEvent, hookName: a.hookName, durationMs: a.durationMs, exitCode: a.exitCode, chars: (a.stdout || a.content || '').length }); this._mark('events', this.events.length - 1);
        break;
      case 'total_tokens_reminder': summary = preview(a.text, 80); break;
      case 'deferred_tools_delta': summary = `+${(a.addedNames || []).length} −${(a.removedNames || []).length} tools`; break;
      case 'skill_listing': summary = `${a.skillCount || (a.names || []).length} skills`; break;
      case 'instructions': summary = `${(a.files || []).length} files (${a.reason || ''})`; break;
      case 'mcp_instructions_delta': summary = `+${(a.addedNames || []).length} −${(a.removedNames || []).length} MCP servers`; break;
      case 'edited_text_file': summary = a.filename || a.path || ''; break;
      default: summary = preview(a.text || a.content || '', 80);
    }
    const chars = JSON.stringify(a).length;
    this.attachments.push({ n, ts: t, type: a.type || 'unknown', summary, chars, parentUuid: rec.parentUuid || null }); this._mark('attachments', this.attachments.length - 1);
    entry.kind = 'attachment';
    entry.label = `attachment ${a.type}${summary ? ': ' + summary : ''}`;
  }

  _system(rec, entry, n) {
    const t = ts(rec);
    const label = `${rec.subtype || 'system'}${rec.hookCount != null ? ' (' + rec.hookCount + ' hooks)' : ''}${rec.preventedContinuation ? ' · blocked stop' : ''}`;
    this.events.push({ n, ts: t, kind: 'system', subtype: rec.subtype, level: rec.level, label, hookInfos: rec.hookInfos || null, hookErrors: rec.hookErrors || null }); this._mark('events', this.events.length - 1);
    entry.kind = 'system'; entry.label = label;
  }

  _apiRequest(rec, entry, n) {
    const t = ts(rec);
    const params = safeJson(rec.params) || {};
    const tail = safeJson(rec.tail);
    const cacheControl = safeJson(rec.cacheControl);
    const keep = Number(rec.keep) || 0;
    const tailLen = Array.isArray(tail) ? tail.length : 0;
    const tailBlobs = Array.isArray(tail) ? tail.map((h) => {
      const b = this.blobs.get(h);
      return b ? { hash: h, role: b.role, size: b.size, kinds: b.kinds } : { hash: h, role: '?', size: 0, kinds: [] };
    }) : [];
    const req = {
      index: this.apiRequests.length, n, ts: t, id: rec.id, model: params.model || null, maxTokens: params.max_tokens || null,
      betas: params.betas || [], thinking: params.thinking || null, contextManagement: params.context_management || null,
      outputConfig: params.output_config || null, shapeHash: rec.shapeHash || null, keep, tailLen, messages: keep + tailLen,
      base: rec.base || null, cacheBreakpoints: Array.isArray(cacheControl) ? cacheControl : [], tailBlobs, querySource: rec.querySource || null,
      toolsInParams: Array.isArray(params.tools) ? params.tools.length : null,
    };
    this.apiRequests.push(req);
    this._mark('apiRequests', req.index);
    this._pendingApiRequests.push(req);
    if (this._pendingApiRequests.length > 4) this._pendingApiRequests.shift();
    entry.kind = 'api-request';
    entry.label = `api-request → ${req.model || ''}: ${req.messages} msgs (${keep} cached prefix + ${tailLen} new), ${req.cacheBreakpoints.length} cache breakpoints`;
  }

  _blob(rec, entry) {
    const m = rec.message || {};
    const content = m.content;
    const kinds = Array.isArray(rec.kinds) ? rec.kinds : (Array.isArray(content) ? [...new Set(content.map((b) => b && b.type).filter(Boolean))] : (typeof content === 'string' ? ['text'] : []));
    const size = rec.size != null ? rec.size : JSON.stringify(content || '').length;
    this.blobs.set(rec.hash, { role: m.role, size, kinds });
    entry.kind = 'blob';
    entry.label = `api-request-blob ${m.role} ${kinds.join('+') || ''} (${size} chars) ${String(rec.hash || '').slice(0, 8)}`;
  }

  _shape(rec, entry) {
    const shape = safeJson(rec.shape);
    let stats = rec.shapeStats || null;
    if (!stats && shape && typeof shape === 'object') {
      const system = Array.isArray(shape.system) ? shape.system : [];
      const tools = Array.isArray(shape.tools) ? shape.tools : [];
      stats = {
        systemBlocks: system.map((b) => ({ chars: (b && b.text ? b.text.length : 0), preview: preview(b && b.text, 90), cache: !!(b && b.cache_control) })),
        systemChars: system.reduce((a, b) => a + (b && b.text ? b.text.length : 0), 0),
        toolCount: tools.length, toolNames: tools.map((t) => t && t.name).filter(Boolean),
        toolsChars: JSON.stringify(tools).length,
      };
    }
    this.shapes.set(rec.shapeHash, { hash: rec.shapeHash, n: entry.n, ts: entry.ts, stats }); this._mark('shapes', rec.shapeHash);
    entry.kind = 'shape';
    entry.label = `api-request-shape ${String(rec.shapeHash || '').slice(0, 8)}: ${stats ? stats.systemBlocks.length + ' system blocks, ' + stats.toolCount + ' tools' : ''}`;
  }

  // ---- derived ---------------------------------------------------------
  phase() {
    // Walk back from the newest record to decide what the loop is doing now.
    const recs = this.records;
    const openTools = this.tools.filter((t) => t.resultAt == null);
    for (let i = recs.length - 1; i >= 0 && i >= recs.length - 50; i--) {
      const r = recs[i];
      if (r.kind === 'sidechain') continue;
      if (r.kind === 'prompt') return { phase: 'prompt', detail: 'user prompt received, building the API request' };
      if (r.kind === 'compaction') return { phase: 'compacting', detail: 'context compacted; new turn starts from the summary' };
      if (r.kind === 'api-request') return { phase: 'api', detail: 'request sent, waiting for the model' };
      if (r.kind === 'tool_result') return { phase: 'assemble', detail: 'tool_result appended; next API call will be built' };
      if (r.kind === 'assistant') {
        const call = this._callsByReq.get(r.requestId);
        if (openTools.length) return { phase: 'tool', detail: `running ${openTools.map((t) => t.name).join(', ')}`, tools: openTools.map((t) => t.name) };
        if (call && call.stopReason === 'end_turn') return { phase: 'idle', detail: 'turn finished (stop_reason=end_turn); waiting for the user' };
        if (call && call.stopReason === 'tool_use') return { phase: 'tool', detail: 'tool_use emitted, about to execute' };
        return { phase: 'streaming', detail: 'model is streaming blocks' };
      }
      if (r.kind === 'attachment' || r.kind === 'system' || r.kind === 'blob' || r.kind === 'shape') continue;
    }
    return { phase: recs.length ? 'idle' : 'empty', detail: recs.length ? 'no activity' : 'no records yet' };
  }

  totals() {
    const tot = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, calls: this.calls.length, tools: this.tools.length, turns: this.turns.length, thinkingMs: 0, apiMs: 0, toolMs: 0, errors: 0 };
    for (const c of this.calls) {
      tot.input += c.usage.input; tot.output += c.usage.output; tot.cacheRead += c.usage.cacheRead; tot.cacheCreate += c.usage.cacheCreate;
      tot.thinkingMs += c.thinkingMs || 0;
      if (c.startedAt != null && c.endedAt != null) { const d = c.endedAt - c.startedAt; if (d >= 0 && d < 3600000) tot.apiMs += d; }
    }
    for (const t of this.tools) { if (t.durationMs != null) tot.toolMs += t.durationMs; if (t.isError) tot.errors++; }
    tot.contextNow = this._lastContext;
    tot.peakContext = this.calls.reduce((a, c) => Math.max(a, c.contextTokens), 0);
    return tot;
  }

  toolMix() {
    const m = new Map();
    for (const t of this.tools) {
      const e = m.get(t.name) || { name: t.name, count: 0, errors: 0, totalMs: 0, timed: 0 };
      e.count++; if (t.isError) e.errors++;
      if (t.durationMs != null) { e.totalMs += t.durationMs; e.timed++; }
      m.set(t.name, e);
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  }

  summary() {
    return { meta: this.meta, info: this.info, n: this.n, totals: this.totals(), phase: this.phase(), summaryOnly: true, records: [], turns: [], calls: [], tools: [], attachments: [], events: [], apiRequests: [], compactions: [], cost: this.cost, shapes: [], toolMix: this.toolMix(), subagents: [] };
  }

  // light: subagents are summarized (fetch each on demand) when the session is very large.
  snapshot({ light = false } = {}) {
    const agents = [...this.subagents.values()];
    const totalAgentRecords = agents.reduce((a, s) => a + s.n, 0);
    const summarize = light || agents.length > 40 || this.n + totalAgentRecords > 25000;
    return {
      meta: this.meta, info: this.info, n: this.n, records: this.records, turns: this.turns, calls: this.calls, tools: this.tools,
      attachments: this.attachments, events: this.events, apiRequests: this.apiRequests, compactions: this.compactions, cost: this.cost,
      shapes: [...this.shapes.values()], totals: this.totals(), toolMix: this.toolMix(), phase: this.phase(), light: summarize,
      subagents: agents.map((s) => (summarize ? s.summary() : s.snapshot())),
    };
  }
}

// Parse a whole JSONL text in one go (used by tests and the client).
export function parseJsonl(text, meta) {
  const st = new SessionState(meta);
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    st.ingest(rec);
  }
  return st;
}


// Phase of the loop at record cursor `n`, computed from a snapshot (client-side replay).
export function phaseAt(snap, n) {
  const recs = snap.records;
  const openTools = snap.tools.filter((t) => t.n <= n && (t.resultN == null || t.resultN > n));
  const callByReq = new Map(snap.calls.map((c) => [c.requestId, c]));
  for (let i = Math.min(n, recs.length - 1); i >= 0 && i >= n - 60; i--) {
    const r = recs[i];
    if (!r || r.kind === 'sidechain' || r.kind === 'attachment' || r.kind === 'system' || r.kind === 'blob' || r.kind === 'shape') continue;
    if (r.kind === 'prompt' || r.kind === 'meta') return { phase: 'prompt', detail: 'prompt received: the harness builds the next API request' };
    if (r.kind === 'compaction') return { phase: 'compacting', detail: 'context compacted: the conversation restarts from a summary' };
    if (r.kind === 'api-request') return { phase: 'api', detail: 'request sent, waiting for the model' };
    if (r.kind === 'tool_result') return { phase: 'assemble', detail: 'tool_result appended to the conversation; next API call is being built' };
    if (r.kind === 'assistant') {
      if (openTools.length) return { phase: 'tool', detail: `executing ${openTools.map((t) => t.name).join(', ')}`, tools: openTools.map((t) => t.name) };
      const call = callByReq.get(r.requestId);
      if (call && call.stopReason === 'end_turn' && call.n <= n) {
        const lastBlockOfCall = Math.max(...call.blocks.map((b) => b.n));
        if (n >= lastBlockOfCall) return { phase: 'idle', detail: 'stop_reason=end_turn: the turn is over, waiting for the user' };
      }
      return { phase: 'streaming', detail: 'the model is streaming blocks (thinking, text, tool_use)' };
    }
  }
  return { phase: recs.length ? 'idle' : 'empty', detail: recs.length ? 'no activity' : 'no records yet' };
}

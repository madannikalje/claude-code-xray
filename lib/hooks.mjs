import fsp from 'node:fs/promises';
import path from 'node:path';
import { CLAUDE_DIR } from './discovery.mjs';

export const HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure',
  'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'Notification', 'Stop', 'StopFailure', 'SessionEnd',
];

const cut = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + `…[+${s.length - n}]` : s);

export function normalizeHook(body, receivedAt = Date.now()) {
  const b = body && typeof body === 'object' ? body : {};
  const ev = {
    receivedAt, event: b.hook_event_name || 'unknown', sessionId: b.session_id || null, cwd: b.cwd || null,
    permissionMode: b.permission_mode || null, agentId: b.agent_id || null, agentType: b.agent_type || null,
    toolName: b.tool_name || null, toolUseId: b.tool_use_id || null, promptId: b.prompt_id || null,
    detail: {},
  };
  const d = ev.detail;
  if (b.tool_input !== undefined) d.tool_input = typeof b.tool_input === 'string' ? cut(b.tool_input, 1500) : JSON.parse(cut(JSON.stringify(b.tool_input), 1500).replace(/…\[\+\d+\]$/, '') || '{}');
  if (b.tool_response !== undefined) d.tool_response = cut(typeof b.tool_response === 'string' ? b.tool_response : JSON.stringify(b.tool_response), 1500);
  if (b.duration_ms !== undefined) d.duration_ms = b.duration_ms;
  if (b.error !== undefined) d.error = cut(String(b.error), 800);
  if (b.prompt !== undefined) d.prompt = cut(b.prompt, 2000);
  if (b.message !== undefined) d.message = cut(String(b.message), 800);
  if (b.notification_type !== undefined) d.notification_type = b.notification_type;
  if (b.trigger !== undefined) d.trigger = b.trigger;
  if (b.custom_instructions) d.custom_instructions = cut(b.custom_instructions, 500);
  if (b.compact_summary) d.compact_summary = cut(b.compact_summary, 1500);
  if (b.reason !== undefined) d.reason = b.reason;
  if (b.source !== undefined) d.source = b.source;
  if (b.stop_hook_active !== undefined) d.stop_hook_active = b.stop_hook_active;
  if (b.last_assistant_message) d.last_assistant_message = cut(b.last_assistant_message, 1000);
  if (b.agent_transcript_path) d.agent_transcript_path = b.agent_transcript_path;
  if (b.permission_suggestions) d.permission_suggestions = b.permission_suggestions;
  if (b.transcript_path) d.transcript_path = b.transcript_path;
  return ev;
}

export function hookConfig(url) {
  const hooks = {};
  for (const e of HOOK_EVENTS) hooks[e] = [{ hooks: [{ type: 'http', url, timeout: 5 }] }];
  return { hooks };
}

export async function hookInstallStatus(url) {
  const file = path.join(CLAUDE_DIR, 'settings.json');
  try {
    const s = JSON.parse(await fsp.readFile(file, 'utf8'));
    const installed = Object.entries(s.hooks || {}).filter(([, groups]) => Array.isArray(groups) && groups.some((g) => Array.isArray(g.hooks) && g.hooks.some((h) => h && h.type === 'http' && h.url === url))).map(([k]) => k);
    return { file, installed };
  } catch { return { file, installed: [] }; }
}

export async function installHooks(url, remove = false) {
  const file = path.join(CLAUDE_DIR, 'settings.json');
  let s = {};
  try { s = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { s = {}; }
  const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try { await fsp.copyFile(file, backup); } catch { /* no existing file */ }
  s.hooks = s.hooks || {};
  const isOurs = (h) => h && h.type === 'http' && h.url === url;
  for (const e of Object.keys(s.hooks)) {
    if (!Array.isArray(s.hooks[e])) continue;
    s.hooks[e] = s.hooks[e].map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) })).filter((g) => g.hooks.length);
    if (!s.hooks[e].length) delete s.hooks[e];
  }
  if (!remove) for (const e of HOOK_EVENTS) { s.hooks[e] = s.hooks[e] || []; s.hooks[e].push({ hooks: [{ type: 'http', url, timeout: 5 }] }); }
  if (!Object.keys(s.hooks).length) delete s.hooks;
  await fsp.writeFile(file, JSON.stringify(s, null, 2) + '\n');
  return { file, backup };
}

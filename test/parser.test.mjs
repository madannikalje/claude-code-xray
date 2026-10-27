import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionState, parseJsonl, textOf } from '../lib/parser.mjs';

const T0 = Date.parse('2026-10-27T10:00:00.000Z');
const iso = (ms) => new Date(T0 + ms).toISOString();
const base = (o) => ({ cwd: '/tmp/p', version: '2.1.308', isSidechain: false, sessionId: 'S1', ...o });

function fixture() {
  return [
    base({ type: 'user', uuid: 'u1', parentUuid: null, timestamp: iso(0), message: { role: 'user', content: 'list files' }, turnOrigin: 'human' }),
    { type: 'api-request-shape', sessionId: 'S1', shapeHash: 'shape1', timestamp: iso(10), shape: JSON.stringify({ system: [{ type: 'text', text: 'You are Claude Code' }, { type: 'text', text: 'x'.repeat(100) }], tools: [{ name: 'Bash' }, { name: 'Read' }] }) },
    { type: 'api-request-blob', sessionId: 'S1', hash: 'h1', message: { role: 'user', content: [{ type: 'text', text: 'list files' }] } },
    { type: 'api-request', sessionId: 'S1', id: 'r1', timestamp: iso(20), params: JSON.stringify({ model: 'claude-fable-5-1', max_tokens: 64000, betas: ['b1'] }), keep: '0', tail: JSON.stringify(['h1']), cacheControl: JSON.stringify([{ path: ['system', 1] }]), shapeHash: 'shape1' },
    base({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: iso(1500), requestId: 'req1', apiBlockIndex: 0, thinkingDurationMs: 800,
      message: { id: 'msg1', role: 'assistant', model: 'claude-fable-5-1', stop_reason: null, content: [{ type: 'thinking', thinking: 'let me look' }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 } } }),
    base({ type: 'assistant', uuid: 'a2', parentUuid: 'a1', timestamp: iso(2000), requestId: 'req1', apiBlockIndex: 1,
      message: { id: 'msg1', role: 'assistant', model: 'claude-fable-5-1', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }], usage: { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 } } }),
    base({ type: 'user', uuid: 'u2', parentUuid: 'a2', timestamp: iso(2600), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'a.txt\nb.txt', is_error: false }] }, toolUseResult: { stdout: 'a.txt\nb.txt', stderr: '', interrupted: false }, permissionDecision: JSON.stringify({ decision: 'accept', source: 'config' }) }),
    base({ type: 'attachment', uuid: 'at1', parentUuid: 'u2', timestamp: iso(2610), attachment: { type: 'total_tokens_reminder', text: 'Tokens left: 900000' } }),
    { type: 'api-request', sessionId: 'S1', id: 'r2', timestamp: iso(2700), params: JSON.stringify({ model: 'claude-fable-5-1' }), keep: '3', tail: JSON.stringify(['h2']), cacheControl: JSON.stringify([]), shapeHash: 'shape1' },
    base({ type: 'assistant', uuid: 'a3', parentUuid: 'u2', timestamp: iso(4000), requestId: 'req2', apiBlockIndex: 0,
      message: { id: 'msg2', role: 'assistant', model: 'claude-fable-5-1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Two files.' }], usage: { input_tokens: 5, output_tokens: 12, cache_read_input_tokens: 1210, cache_creation_input_tokens: 30 } } }),
    { type: 'system', sessionId: 'S1', uuid: 's1', timestamp: iso(4100), subtype: 'stop_hook_summary', level: 'suggestion', hookCount: 1, hookInfos: [{ command: 'echo' }] },
    { type: 'cost-state', sessionId: 'S1', totalCostUSD: 0.42, modelUsage: {} },
  ];
}

test('groups assistant blocks into one call per requestId and pairs tools with results', () => {
  const st = new SessionState({ id: 'S1' });
  for (const r of fixture()) st.ingest(r);
  assert.equal(st.turns.length, 1);
  assert.equal(st.calls.length, 2);
  const c1 = st.calls[0];
  assert.equal(c1.requestId, 'req1');
  assert.equal(c1.stopReason, 'tool_use');
  assert.equal(c1.blocks.map((b) => b.type).join(','), 'thinking,tool_use');
  assert.equal(c1.usage.output, 40, 'usage comes from the latest block');
  assert.equal(c1.contextTokens, 1210);
  assert.equal(c1.thinkingMs, 800);
  assert.equal(c1.startedAt, T0 + 20, 'call start is the api-request timestamp');
  assert.equal(c1.endedAt, T0 + 2000);
  assert.equal(c1.apiRequestIndex, 0);
  const tool = st.tools[0];
  assert.equal(tool.name, 'Bash');
  assert.equal(tool.durationMs, 600);
  assert.equal(tool.isError, false);
  assert.equal(tool.permission.decision, 'accept');
  assert.equal(tool.resultMeta.stdoutChars, 11);
  assert.equal(st.calls[1].stopReason, 'end_turn');
  assert.equal(st.calls[1].apiRequestIndex, 1);
});

test('api-request resolves tail hashes to blobs and records shape stats', () => {
  const st = parseJsonl(fixture().map((r) => JSON.stringify(r)).join('\n'), { id: 'S1' });
  assert.equal(st.apiRequests.length, 2);
  assert.equal(st.apiRequests[0].messages, 1);
  assert.equal(st.apiRequests[0].tailBlobs[0].role, 'user');
  assert.equal(st.apiRequests[0].cacheBreakpoints.length, 1);
  assert.equal(st.apiRequests[1].keep, 3);
  const shape = st.shapes.get('shape1');
  assert.equal(shape.stats.toolCount, 2);
  assert.equal(shape.stats.systemBlocks.length, 2);
  assert.equal(shape.stats.systemChars, 19 + 100);
});

test('totals, tool mix, phase and cost', () => {
  const st = parseJsonl(fixture().map((r) => JSON.stringify(r)).join('\n'), { id: 'S1' });
  const tot = st.totals();
  assert.equal(tot.output, 52);
  assert.equal(tot.cacheRead, 2210);
  assert.equal(tot.calls, 2);
  assert.equal(tot.tools, 1);
  assert.equal(tot.contextNow, 1245);
  assert.equal(st.toolMix()[0].name, 'Bash');
  assert.equal(st.phase().phase, 'idle');
  assert.equal(st.cost.totalCostUSD, 0.42);
  assert.equal(st.attachments[0].type, 'total_tokens_reminder');
  assert.equal(st.events.find((e) => e.kind === 'system').subtype, 'stop_hook_summary');
});

test('phase tracks the loop while a tool is running', () => {
  const st = new SessionState({ id: 'S1' });
  const recs = fixture();
  for (const r of recs.slice(0, 6)) st.ingest(r); // up to the tool_use block
  assert.equal(st.phase().phase, 'tool');
  st.ingest(recs[6]); // tool_result
  assert.equal(st.phase().phase, 'assemble');
  st.ingest(recs[8]); // api-request
  assert.equal(st.phase().phase, 'api');
});

test('compaction summary starts a new turn and is recorded', () => {
  const st = new SessionState({ id: 'S1' });
  for (const r of fixture()) st.ingest(r);
  st.ingest(base({ type: 'user', uuid: 'u9', timestamp: iso(9000), isCompactSummary: true, message: { role: 'user', content: 'Summary of the conversation so far' } }));
  assert.equal(st.compactions.length, 1);
  assert.equal(st.turns.length, 2);
  assert.equal(st.turns[1].origin, 'compaction');
});

test('inline sidechain records are routed to a subagent state', () => {
  const st = new SessionState({ id: 'S1' });
  st.ingest(base({ type: 'user', uuid: 'x1', timestamp: iso(0), isSidechain: true, agentId: 'ag1', message: { role: 'user', content: 'do research' } }));
  st.ingest(base({ type: 'assistant', uuid: 'x2', timestamp: iso(100), isSidechain: true, agentId: 'ag1', requestId: 'rq', message: { role: 'assistant', model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } } }));
  assert.equal(st.turns.length, 0);
  assert.equal(st.subagents.size, 1);
  assert.equal(st.subagents.get('ag1').calls.length, 1);
  assert.equal(st.snapshot().subagents[0].info.isSidechain, true);
});

test('textOf handles strings, text blocks and tool_result blocks', () => {
  assert.equal(textOf('hi'), 'hi');
  assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'image' }]), 'a\n[image]');
  assert.equal(textOf([{ type: 'tool_result', content: [{ type: 'text', text: 'out' }] }]), 'out');
});

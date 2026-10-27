// Generates a synthetic Claude Code session (no real data) so anyone can try
// X-Ray without transcripts of their own: `node server.mjs --demo`.
// The records follow the shapes Claude Code 2.1.30x writes, with invented content.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

let seed = 42;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[ri(0, 15)]).join('');
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${hex(4)}-${hex(12)}`;
const sha = (s) => createHash('sha256').update(s).digest('hex');

export async function ensureDemo(home) {
  const marker = path.join(home, '.demo-v1');
  try { await fsp.access(marker); return home; } catch { /* generate */ }
  await generate(home);
  await fsp.writeFile(marker, 'generated\n');
  return home;
}

async function generate(home) {
  const cwd = '/Users/demo/code/acme-api';
  const slug = cwd.replace(/\//g, '-');
  const sessionId = uuid();
  const dir = path.join(home, 'projects', slug);
  await fsp.mkdir(path.join(dir, sessionId, 'subagents'), { recursive: true });
  await fsp.mkdir(path.join(home, 'sessions'), { recursive: true });
  const lines = [];
  let t = Date.parse('2026-10-20T09:12:00.000Z');
  let parent = null;
  const ts = () => new Date(t).toISOString();
  const base = (o) => ({ parentUuid: parent, isSidechain: false, userType: 'external', cwd, sessionId, version: '2.1.308', gitBranch: 'feat/rate-limit', entrypoint: 'cli', ...o });
  const push = (o) => { lines.push(JSON.stringify(o)); if (o.uuid) parent = o.uuid; };

  // ---- shape: system prompt + tools -------------------------------------------
  const system = [
    { type: 'text', text: 'You are Claude Code, an agentic coding assistant running in the user\'s terminal.' },
    { type: 'text', text: 'You are an agent working with the user toward their goals. Use tools to read and change the project, run commands to verify, and report what you did. ' + 'Prefer small verified steps. '.repeat(40), cache_control: { type: 'ephemeral', ttl: '1h' } },
    { type: 'text', text: '# Environment\nWorking directory: /Users/demo/code/acme-api\nPlatform: darwin\nShell: zsh\n\n# Project instructions (CLAUDE.md)\nThis is a Node/Express API. Run tests with `npm test`. Keep handlers in src/routes, middleware in src/middleware. ' + 'Lint before committing. '.repeat(60), cache_control: { type: 'ephemeral', ttl: '1h' } },
  ];
  const toolNames = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'Agent', 'AskUserQuestion', 'ToolSearch', 'WebFetch', 'mcp__github__get_issue', 'mcp__github__create_pull_request'];
  const tools = toolNames.map((n) => ({ name: n, description: `${n} tool. ` + 'Describes what the tool does and when to use it. '.repeat(8), input_schema: { type: 'object', properties: { input: { type: 'string', description: 'primary input' }, options: { type: 'object' } }, required: ['input'] } }));
  const shapeHash = sha(JSON.stringify({ system, tools }));
  push({ type: 'api-request-shape', sessionId, shapeHash, timestamp: ts(), version: '2.1.308', shape: JSON.stringify({ system, tools }) });

  // ---- helpers ---------------------------------------------------------------------
  const msgs = []; // api message bodies so far (for keep/tail)
  let lastReqId = null, sentCount = 0;
  let ctx = 17800; // tokens in context
  const blobs = new Set();
  const apiRequest = () => {
    const tailMsgs = msgs.slice(sentCount);
    const tailHashes = [];
    for (const m of tailMsgs) { const h = sha(JSON.stringify(m)); tailHashes.push(h); if (!blobs.has(h)) { blobs.add(h); push({ type: 'api-request-blob', sessionId, hash: h, message: m }); } }
    const id = uuid();
    push({ type: 'api-request', sessionId, id, timestamp: ts(), version: '2.1.308', querySource: 'cli', shapeHash,
      params: JSON.stringify({ model: 'claude-fable-5-1', betas: ['claude-code-20250219', 'interleaved-thinking-2025-05-14', 'context-management-2025-06-27', 'extended-cache-ttl-2025-04-11'], max_tokens: 32000, thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }),
      base: lastReqId, keep: String(sentCount), tail: JSON.stringify(tailHashes),
      cacheControl: JSON.stringify([{ path: ['system', 1], value: { type: 'ephemeral', ttl: '1h' } }, { path: ['system', 2], value: { type: 'ephemeral', ttl: '1h' } }, { path: ['messages', msgs.length - 1, 'content', 0], value: { type: 'ephemeral', ttl: '1h' } }]) });
    lastReqId = id; sentCount = msgs.length;
  };
  const userPrompt = (text, extra = {}) => {
    push({ type: 'queue-operation', operation: 'enqueue', timestamp: ts(), sessionId, content: text });
    push({ type: 'queue-operation', operation: 'dequeue', timestamp: ts(), sessionId });
    push(base({ type: 'user', uuid: uuid(), timestamp: ts(), message: { role: 'user', content: text }, promptId: uuid(), turnOrigin: 'human', promptSource: 'cli', ...extra }));
    msgs.push({ role: 'user', content: [{ type: 'text', text }] });
    push(base({ type: 'attachment', uuid: uuid(), timestamp: ts(), attachment: { type: 'total_tokens_reminder', text: `<total_tokens>${1000000 - ctx} tokens left</total_tokens>` } }));
    msgs.push({ role: 'system', content: [{ type: 'text', text: `<total_tokens>${1000000 - ctx} tokens left</total_tokens>` }] });
    push({ type: 'last-prompt', lastPrompt: text, leafUuid: parent, sessionId });
    t += ri(400, 1200);
  };
  let toolN = 0;
  const assistant = ({ thinking, text, toolUses = [], stop, outTokens }) => {
    apiRequest();
    const reqId = 'req_' + hex(22);
    const latency = ri(1800, 9000) + (thinking ? ri(1500, 6000) : 0);
    const cacheRead = Math.round(ctx * (0.93 + rnd() * 0.06)), cacheCreate = ctx - cacheRead, input = ri(3, 40);
    const usage = { input_tokens: input, output_tokens: outTokens, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate };
    const content = [];
    if (thinking) content.push({ type: 'thinking', thinking, signature: hex(40) });
    if (text) content.push({ type: 'text', text });
    const tus = toolUses.map((tu) => ({ type: 'tool_use', id: 'toolu_' + hex(20), name: tu.name, input: tu.input }));
    content.push(...tus);
    t += thinking ? ri(1500, 6000) : ri(300, 900);
    content.forEach((b, i) => {
      t += ri(200, 1500);
      push(base({ type: 'assistant', uuid: uuid(), timestamp: ts(), requestId: reqId, apiBlockIndex: i, thinkingDurationMs: thinking ? latency / 2 : undefined,
        message: { id: 'msg_' + hex(22), type: 'message', role: 'assistant', model: 'claude-fable-5-1', content: [b], stop_reason: i === content.length - 1 ? stop : null, stop_sequence: null, usage } }));
    });
    msgs.push({ role: 'assistant', content });
    ctx += outTokens + ri(50, 200);
    return tus.map((b, i) => ({ ...b, result: toolUses[i].result, error: toolUses[i].error, ms: toolUses[i].ms }));
  };
  const toolResults = (tus) => {
    for (const tu of tus) {
      t += tu.ms;
      const block = { type: 'tool_result', tool_use_id: tu.id, content: tu.result, is_error: !!tu.error };
      push(base({ type: 'user', uuid: uuid(), timestamp: ts(), message: { role: 'user', content: [block] }, toolUseResult: tu.name === 'Bash' ? { stdout: tu.result, stderr: '', interrupted: false } : { content: tu.result }, permissionDecision: JSON.stringify({ decision: 'accept', source: 'config', reasonType: 'rule' }), sourceToolUseID: tu.id }));
      msgs.push({ role: 'user', content: [block] });
      ctx += Math.round(tu.result.length / 3.6);
      toolN++;
      if (toolN % 3 === 0) { push(base({ type: 'attachment', uuid: uuid(), timestamp: ts(), attachment: { type: 'batching_reminder_sent', text: 'Request every independent item in one response.' } })); }
    }
  };
  const stopHook = () => push(base({ type: 'system', uuid: uuid(), timestamp: ts(), subtype: 'stop_hook_summary', level: 'suggestion', hookCount: 1, hookInfos: [{ command: 'npm run lint --silent' }], hookErrors: [], preventedContinuation: false, hasOutput: false }));

  // ---- session start ---------------------------------------------------------------
  push(base({ type: 'attachment', uuid: uuid(), timestamp: ts(), attachment: { type: 'hook_success', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', command: '.claude/hooks/load-context.sh', durationMs: 38, exitCode: 0, stdout: '{"hookSpecificOutput":{"additionalContext":"Team conventions loaded."}}', stderr: '' } }));
  push(base({ type: 'attachment', uuid: uuid(), timestamp: ts(), attachment: { type: 'skill_listing', isInitial: true, skillCount: 4, names: ['commit', 'review', 'deploy', 'docs'], content: 'Available skills: commit, review, deploy, docs' } }));
  push(base({ type: 'attachment', uuid: uuid(), timestamp: ts(), attachment: { type: 'deferred_tools_delta', addedNames: ['mcp__github__get_issue', 'mcp__github__create_pull_request', 'WebFetch'], removedNames: [], addedLines: ['…'] } }));
  push({ type: 'mode', mode: 'normal', sessionId });
  push({ type: 'custom-title', customTitle: 'Rate limiting for the public API', sessionId });

  // ---- turn 1 -------------------------------------------------------------------------
  userPrompt('Add rate limiting to the public API. Token bucket, 100 requests per minute per API key, return 429 with a Retry-After header.');
  let tus = assistant({ thinking: 'The user wants per-key rate limiting. I should look at how routes are registered and whether there is an existing middleware folder before writing anything.', toolUses: [
    { name: 'Grep', input: { pattern: 'app.use\\(', path: 'src' }, result: 'src/app.js:12:app.use(express.json());\nsrc/app.js:13:app.use(requestLogger);\nsrc/app.js:19:app.use(\'/v1\', publicRouter);', ms: 180 },
    { name: 'Glob', input: { pattern: 'src/middleware/*.js' }, result: 'src/middleware/requestLogger.js\nsrc/middleware/auth.js', ms: 90 },
  ], stop: 'tool_use', outTokens: 410 });
  toolResults(tus);
  tus = assistant({ thinking: 'auth.js probably attaches the api key to req. Read both files.', toolUses: [
    { name: 'Read', input: { file_path: 'src/middleware/auth.js' }, result: '     1\tmodule.exports = function auth(req, res, next) {\n     2\t  const key = req.get(\'x-api-key\');\n     3\t  if (!key) return res.status(401).json({ error: \'missing api key\' });\n     4\t  req.apiKey = key;\n     5\t  next();\n     6\t};\n', ms: 60 },
    { name: 'Read', input: { file_path: 'src/app.js' }, result: '     1\tconst express = require(\'express\');\n' + Array.from({ length: 30 }, (_, i) => `    ${String(i + 2).padStart(2)}\t// line ${i + 2} of app.js`).join('\n'), ms: 70 },
  ], stop: 'tool_use', outTokens: 260 });
  toolResults(tus);
  tus = assistant({ thinking: 'Write a token bucket keyed by apiKey with a Map, refill on access. Then register it after auth on /v1.', text: 'Adding a token bucket middleware and wiring it after auth.', toolUses: [
    { name: 'Write', input: { file_path: 'src/middleware/rateLimit.js', content: 'const buckets = new Map();\nconst CAPACITY = 100, REFILL_PER_MS = 100 / 60000;\n\nmodule.exports = function rateLimit(req, res, next) {\n  const now = Date.now();\n  let b = buckets.get(req.apiKey);\n  if (!b) { b = { tokens: CAPACITY, at: now }; buckets.set(req.apiKey, b); }\n  b.tokens = Math.min(CAPACITY, b.tokens + (now - b.at) * REFILL_PER_MS); b.at = now;\n  if (b.tokens < 1) { res.set(\'Retry-After\', String(Math.ceil((1 - b.tokens) / REFILL_PER_MS / 1000))); return res.status(429).json({ error: \'rate limited\' }); }\n  b.tokens -= 1; next();\n};\n' }, result: 'File created successfully at: src/middleware/rateLimit.js', ms: 40 },
    { name: 'Edit', input: { file_path: 'src/app.js', old_string: "app.use('/v1', publicRouter);", new_string: "app.use('/v1', auth, rateLimit, publicRouter);" }, result: 'The file src/app.js has been updated.', ms: 55 },
  ], stop: 'tool_use', outTokens: 1480 });
  toolResults(tus);
  tus = assistant({ toolUses: [{ name: 'Bash', input: { command: 'npm test --silent' }, result: '> acme-api@1.4.0 test\n\n  public routes\n    ✓ lists products\n    ✗ rejects missing api key\n\n  1 failing\n\n  ReferenceError: rateLimit is not defined\n      at Object.<anonymous> (src/app.js:19:17)', error: true, ms: 4200 }], stop: 'tool_use', outTokens: 90 });
  toolResults(tus);
  tus = assistant({ thinking: 'Forgot the require. Add it next to the auth import.', toolUses: [
    { name: 'Edit', input: { file_path: 'src/app.js', old_string: "const auth = require('./middleware/auth');", new_string: "const auth = require('./middleware/auth');\nconst rateLimit = require('./middleware/rateLimit');" }, result: 'The file src/app.js has been updated.', ms: 50 },
    { name: 'Bash', input: { command: 'npm test --silent' }, result: '> acme-api@1.4.0 test\n\n  public routes\n    ✓ lists products\n    ✓ rejects missing api key\n\n  2 passing (310ms)', ms: 3900 },
  ], stop: 'tool_use', outTokens: 240 });
  toolResults(tus);
  assistant({ text: 'Rate limiting is in place: `src/middleware/rateLimit.js` implements a token bucket (100 capacity, refilled at 100 per minute) keyed by API key, and `src/app.js` applies it to `/v1` after auth. Over-limit requests get 429 with a Retry-After header. Tests pass.', stop: 'end_turn', outTokens: 120 });
  stopHook();
  push({ type: 'cost-state', sessionId, totalCostUSD: 0.61, totalAPIDuration: 48000, totalAPIDurationWithoutRetries: 48000, totalToolDuration: 8600, totalLinesAdded: 14, totalLinesRemoved: 1, totalDuration: 95000, startTime: Date.parse('2026-10-20T09:12:00.000Z'), modelUsage: { 'claude-fable-5-1': { inputTokens: 120, outputTokens: 2600, thinkingTokens: 900, cacheReadInputTokens: 110000, cacheCreationInputTokens: 9000, webSearchRequests: 0, costUSD: 0.61 } }, hasUnknownModelCost: false });

  // ---- turn 2: subagent ---------------------------------------------------------------
  t += 60000;
  userPrompt('Also add tests for the burst case: 100 requests at once should pass and the 101st should get a 429.');
  const agentId = hex(17);
  tus = assistant({ thinking: 'Writing a test suite is self-contained; delegate it to a subagent so this context stays small, then run the suite here.', toolUses: [{ name: 'Agent', input: { description: 'Write burst tests for rateLimit', prompt: 'Add a test file test/rateLimit.test.js covering: 100 requests with one key pass, the 101st gets 429 with Retry-After, a second key is independent. Use supertest. Run npm test and fix until green. Report the file and result.', subagent_type: 'general-purpose' }, result: 'Added test/rateLimit.test.js with three cases (burst passes, 101st is 429 with Retry-After, keys are independent). npm test: 5 passing.', ms: 61000 }], stop: 'tool_use', outTokens: 310 });
  const agentToolUseId = tus[0].id;
  toolResults(tus);
  tus = assistant({ toolUses: [{ name: 'Bash', input: { command: 'npm test --silent' }, result: '  5 passing (540ms)', ms: 4100 }], stop: 'tool_use', outTokens: 80 });
  toolResults(tus);
  assistant({ text: 'Burst tests added in `test/rateLimit.test.js`; the whole suite is green (5 passing).', stop: 'end_turn', outTokens: 60 });
  stopHook();

  // ---- turn 3: explanation only ------------------------------------------------------
  t += 120000;
  userPrompt('Why a token bucket instead of a sliding window?');
  assistant({ thinking: 'Short conceptual answer, no tools needed.', text: 'A token bucket allows short bursts up to the capacity while enforcing the average rate, which suits API clients that batch requests. A sliding window gives a smoother ceiling but needs a timestamp log per key, so memory grows with traffic. For 100 per minute per key the bucket is two numbers per key and O(1) per request.', stop: 'end_turn', outTokens: 190 });
  stopHook();

  // ---- compaction, then turn 4 ---------------------------------------------------------
  t += 300000;
  push(base({ type: 'user', uuid: uuid(), timestamp: ts(), isCompactSummary: true, message: { role: 'user', content: 'Summary of the conversation so far: the user asked for per-API-key rate limiting on /v1. A token bucket middleware was added in src/middleware/rateLimit.js and wired in src/app.js after auth; burst tests were written by a subagent in test/rateLimit.test.js; all 5 tests pass. The user also asked why a token bucket was chosen over a sliding window (answered: bursts allowed, O(1) memory).' } }));
  msgs.length = 0; sentCount = 0; lastReqId = null; ctx = 9200;
  msgs.push({ role: 'user', content: [{ type: 'text', text: 'Summary of the conversation so far: rate limiting added and tested.' }] });
  userPrompt('Update the README to document the rate limit and the Retry-After header.');
  tus = assistant({ toolUses: [{ name: 'Read', input: { file_path: 'README.md' }, result: '     1\t# acme-api\n     2\t\n     3\t## Authentication\n     4\tSend your key in the x-api-key header.\n', ms: 50 }], stop: 'tool_use', outTokens: 70 });
  toolResults(tus);
  tus = assistant({ toolUses: [{ name: 'Edit', input: { file_path: 'README.md', old_string: 'Send your key in the x-api-key header.', new_string: 'Send your key in the x-api-key header.\n\n## Rate limits\nEach API key may make 100 requests per minute (token bucket, bursts allowed). Over the limit the API returns 429 with a Retry-After header in seconds.' }, result: 'The file README.md has been updated.', ms: 45 }], stop: 'tool_use', outTokens: 210 });
  toolResults(tus);
  assistant({ text: 'README updated with a Rate limits section describing the 100 per minute bucket and the Retry-After header.', stop: 'end_turn', outTokens: 50 });
  stopHook();
  push({ type: 'cost-state', sessionId, totalCostUSD: 1.37, totalAPIDuration: 131000, totalAPIDurationWithoutRetries: 131000, totalToolDuration: 82000, totalLinesAdded: 61, totalLinesRemoved: 1, totalDuration: 720000, startTime: Date.parse('2026-10-20T09:12:00.000Z'), modelUsage: { 'claude-fable-5-1': { inputTokens: 260, outputTokens: 6100, thinkingTokens: 2100, cacheReadInputTokens: 410000, cacheCreationInputTokens: 32000, webSearchRequests: 0, costUSD: 1.37 } }, hasUnknownModelCost: false });

  await fsp.writeFile(path.join(dir, sessionId + '.jsonl'), lines.join('\n') + '\n');

  // ---- subagent transcript -----------------------------------------------------------
  const a = []; let ap = null; let at = Date.parse('2026-10-20T09:15:40.000Z');
  const ats = () => new Date(at).toISOString();
  const abase = (o) => ({ parentUuid: ap, isSidechain: true, agentId, userType: 'external', cwd, sessionId, version: '2.1.308', gitBranch: 'feat/rate-limit', entrypoint: 'cli', promptId: uuid(), ...o });
  const apush = (o) => { a.push(JSON.stringify(o)); if (o.uuid) ap = o.uuid; };
  apush(abase({ type: 'user', uuid: uuid(), timestamp: ats(), message: { role: 'user', content: 'Add a test file test/rateLimit.test.js covering: 100 requests with one key pass, the 101st gets 429 with Retry-After, a second key is independent. Use supertest. Run npm test and fix until green. Report the file and result.' } }));
  const acall = (content, stop, out, actx) => { const reqId = 'req_' + hex(22); content.forEach((b, i) => { at += ri(800, 3000); apush(abase({ type: 'assistant', uuid: uuid(), timestamp: ats(), requestId: reqId, apiBlockIndex: i, message: { id: 'msg_' + hex(22), type: 'message', role: 'assistant', model: 'claude-fable-5-1', content: [b], stop_reason: i === content.length - 1 ? stop : null, usage: { input_tokens: ri(5, 30), output_tokens: out, cache_read_input_tokens: Math.round(actx * 0.95), cache_creation_input_tokens: Math.round(actx * 0.05) } } })); }); return content.filter((b) => b.type === 'tool_use'); };
  const ares = (tus, results) => tus.forEach((tu, i) => { at += results[i].ms; apush(abase({ type: 'user', uuid: uuid(), timestamp: ats(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu.id, content: results[i].text, is_error: !!results[i].error }] }, toolUseResult: { stdout: results[i].text } })); });
  let atus = acall([{ type: 'thinking', thinking: 'Check how existing tests boot the app.', signature: hex(30) }, { type: 'tool_use', id: 'toolu_' + hex(20), name: 'Read', input: { file_path: 'test/routes.test.js' } }], 'tool_use', 150, 12000);
  ares(atus, [{ text: "const request = require('supertest');\nconst app = require('../src/app');\ndescribe('public routes', () => { it('lists products', async () => { await request(app).get('/v1/products').set('x-api-key', 'k1').expect(200); }); });", ms: 60 }]);
  atus = acall([{ type: 'tool_use', id: 'toolu_' + hex(20), name: 'Write', input: { file_path: 'test/rateLimit.test.js', content: "const request = require('supertest');\nconst app = require('../src/app');\ndescribe('rate limit', () => {\n  it('allows a burst of 100', async () => { for (let i = 0; i < 100; i++) await request(app).get('/v1/products').set('x-api-key', 'burst').expect(200); });\n  it('rejects the 101st with Retry-After', async () => { const r = await request(app).get('/v1/products').set('x-api-key', 'burst'); expect(r.status).toBe(429); expect(r.headers['retry-after']).toBeDefined(); });\n  it('keys are independent', async () => { await request(app).get('/v1/products').set('x-api-key', 'other').expect(200); });\n});\n" } }], 'tool_use', 900, 13500);
  ares(atus, [{ text: 'File created successfully at: test/rateLimit.test.js', ms: 40 }]);
  atus = acall([{ type: 'tool_use', id: 'toolu_' + hex(20), name: 'Bash', input: { command: 'npm test --silent' } }], 'tool_use', 60, 14000);
  ares(atus, [{ text: '  5 passing (540ms)', ms: 5200 }]);
  acall([{ type: 'text', text: 'Added test/rateLimit.test.js with three cases (burst passes, 101st is 429 with Retry-After, keys are independent). npm test: 5 passing.' }], 'end_turn', 70, 14200);
  await fsp.writeFile(path.join(dir, sessionId, 'subagents', `agent-${agentId}.jsonl`), a.join('\n') + '\n');
  await fsp.writeFile(path.join(dir, sessionId, 'subagents', `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: 'Write burst tests for rateLimit', toolUseId: agentToolUseId, spawnDepth: 1, requestShape: 'foreground', model: 'fable' }, null, 2));
}

if (process.argv[1] && process.argv[1].endsWith('make-demo.mjs')) {
  const out = process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-home');
  await fsp.rm(out, { recursive: true, force: true });
  console.log('demo written to', await ensureDemo(out));
}

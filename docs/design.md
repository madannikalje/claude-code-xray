# Claude Code X-Ray: design

Date: 2026-10-27

## Intent

A local, read-only visualizer for learning how Claude Code works internally.
It shows, for any session on this machine (live or finished), the agentic loop
as it actually runs: user prompt, context assembly, API request, model output
(thinking, text, tool_use), permission check, hooks, tool execution, tool_result
appended, next API call, and finally end_turn. It also shows subagents, context
window growth, prompt-cache behaviour, compaction, and cost.

The audience is one backend developer learning applied AI. The goal is
understanding, not monitoring. Every panel must teach something about the
mechanism, and every raw record must be one click away.

## Goals

- Zero-install: Node 18+ only, no npm dependencies, one command to run.
- Works on existing transcripts with no setup, and gets richer with hooks.
- Live: tails running sessions and animates the loop state machine.
- Explains: each view has an inline "what am I looking at" explainer.

## Non-goals

- Not a monitoring or alerting product. No persistence, no database.
- Not a transcript editor. Read-only.
- No cost accounting beyond what Claude Code itself writes (`cost-state`).

## Anti-goals

- Leaking data: binds to 127.0.0.1 only. Never uploads anything.
- Changing the user's Claude Code config silently. Hook install is explicit.

## Data sources (observed on Claude Code 2.1.30x, macOS)

1. `~/.claude/projects/<slug>/<sessionId>.jsonl`: the transcript. One JSON
   record per line. Record types seen: `user`, `assistant`, `attachment`,
   `system`, `api-request`, `api-request-blob`, `api-request-shape`,
   `cost-state`, `queue-operation`, `file-history-snapshot`,
   `file-history-delta`, `mode`, `pr-link`, `custom-title`, `agent-name`,
   `last-prompt`, `atis-latch`, `summary` (older versions).
   - `assistant` records are one per content block (`apiBlockIndex`), grouped
     by `requestId`. `message.usage` holds input/output/cache tokens.
   - `user` records are either a human prompt (string content) or a
     `tool_result` carrier (list content) with structured `toolUseResult`
     and `permissionDecision`.
   - `attachment` records are context the harness injects (hook output,
     system reminders, tool listings, token reminders).
   - `api-request` describes the real API call: `params`, `cacheControl`
     breakpoints, and a content-addressed message list (`base` + `keep` +
     `tail` hashes resolved by `api-request-blob`), with the system prompt
     and tool schemas in `api-request-shape` keyed by `shapeHash`.
2. `~/.claude/projects/<slug>/<sessionId>/subagents/agent-<id>.jsonl` plus
   `.meta.json` (agentType, description, toolUseId, spawnDepth, model).
3. `~/.claude/sessions/<pid>.json`: registry of running sessions
   (pid, sessionId, cwd, status idle/busy, name, kind, entrypoint). Liveness
   is `process.kill(pid, 0)`.
4. `~/.claude/tasks/<groupId>/<n>.json`: task list items.
5. Hooks of `type: "http"`: Claude Code POSTs the hook JSON to a URL. The
   visualizer accepts them on `/hook` for real-time lifecycle events
   (SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest,
   PostToolUse, PostToolUseFailure, SubagentStart, SubagentStop,
   PreCompact, PostCompact, Notification, Stop, SessionEnd).

## Architecture

```
server.mjs            HTTP on 127.0.0.1:4545, static files, JSON API, SSE
lib/discovery.mjs     find projects, sessions, subagents, live registry
lib/parser.mjs        JSONL records -> session model (turns, calls, tools)
lib/tail.mjs          byte-offset tailing with polling; emits new records
lib/hooks.mjs         /hook receiver, normalises events, broadcasts
public/index.html     single page app, vanilla JS, hand-drawn SVG charts
public/app.js         views: Loop, Trace, Context, Tokens, Hooks, Inspector
public/styles.css     light and dark, chart palette from the dataviz skill
```

Live path: tail.mjs polls open transcripts every 750 ms (fs.watch on macOS
is unreliable for appended files from another process), parses new lines,
updates the in-memory model and pushes `record` and `session` events over
SSE. Hook POSTs are pushed as `hook` events on the same stream.

## Session model (parser output)

```
Session { id, project, cwd, slug, path, version, model, startedAt, endedAt,
          live, status, title, turns[], calls[], tools[], subagents[],
          attachments[], apiRequests[], cost, totals, compactions[] }
Turn    { index, promptUuid, prompt, startedAt, endedAt, calls[] }
Call    { requestId, index, turnIndex, startedAt, endedAt, model, stopReason,
          usage{input,output,cacheRead,cacheCreate}, contextTokens,
          blocks[{type, text|thinking|toolUse}], toolUses[] }
Tool    { id, name, input, callRequestId, startedAt, resultAt, durationMs,
          isError, permission, resultPreview, subagentId? }
Subagent{ id, type, description, toolUseId, model, calls[], tools[] }
```

Context tokens for a call = input + cacheRead + cacheCreate. A drop between
consecutive calls that coincides with an `isCompactSummary` user record is a
compaction.

## Decisions made by the builder

- Vanilla JS and hand-drawn SVG rather than React/Recharts: no build step,
  readable source for a learner, and the app is small.
- Polling rather than fs.watch: correctness over elegance for cross-process
  appends on macOS.
- Prompt text and tool inputs are shown in full in the inspector because the
  tool runs on the owner's machine for their own sessions.

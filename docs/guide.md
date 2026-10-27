# Guide: follow one turn through Claude Code

A 15-minute walkthrough. It uses the built-in demo session so it works on any
machine; every step applies the same way to your own sessions.

```bash
node server.mjs --demo
```

Open http://127.0.0.1:4545 and select "Rate limiting for the public API".

## 1. See the loop (Loop tab)

The diagram at the top is the whole mechanism. Untick **follow latest**, drag
the scrubber to the far left, then press **Play** at 5×. Watch the highlight
walk: User prompt → Assemble context → API request → Model streams → the
`stop_reason` decision → Permission + hooks → Execute tool → tool_result → back
to Assemble context. It only reaches Stop when a call ends with `end_turn`.

The five tiles under the diagram update with the cursor: which turn you are
in, how many API calls and tools that turn has used so far, and the size of
the context at that point.

## 2. Read the records the loop writes (replay list)

Each row in the list is one line of the transcript file. Note the pattern of a
single tool call:

1. `api-request`: the call is built. The label says how many messages were
   reused from the cached prefix and how many are new.
2. `assistant` blocks: `thinking`, then `tool_use`, with `stop=tool_use`.
3. `tool_result`: the tool's output, written as a user message.
4. `attachment`: things the harness injected (a token reminder, a hook result).

Click any row. The Inspector on the right shows the raw JSON with annotations
for the fields that matter: `parentUuid` (the message tree), `requestId`
(blocks of one API response), `usage` (the token accounting), `permissionDecision`.

## 3. Search the transcript

Type `429` in the search box. Every record containing that text is listed with
the match highlighted: the prompt, the tool input that wrote the middleware,
the test output. Press Enter to step through matches; the loop panel follows.

## 4. Measure a turn (Trace tab)

Turn #1 is a waterfall. Blue bars are API calls, the lighter segment at their
start is thinking time; orange bars are tools; a red bar is a failed tool.
Hover a bar for tokens and durations. Notice call 4: `npm test` fails, and the
next call fixes it. That is the loop correcting itself with no human input.

In turn #2 a violet bar is a subagent. Click it: the whole UI switches to that
subagent's own transcript, with its own calls and tools. Press **← main
session** to come back. The parent only ever saw the subagent's final report.

## 5. Understand the context window (Context tab)

The first chart is the size of every API call's input. Almost all of it is
light blue: served from the prompt cache. Only the small dark tail of each bar
was new. The dashed line is a compaction: the conversation was summarised and
the next call starts small again.

Scroll to **Anatomy of one API request**. Move the slider to the last request
and press **reconstruct full request body**. This is the exact body sent to
the API: parameters, three system blocks (click one to read it), twelve tool
schemas, and every message with `kept` or `new` flags. The `harness` rows are
system messages Claude Code slipped in. The `cache_control` row is where the
cache breakpoint sits.

## 6. Count the cost (Tokens tab)

Output tokens are tiny next to cache reads. That ratio is why prompt caching
decides the price of an agent. The tool mix shows what the model reached for;
stop reasons show how many calls continued the loop versus ended a turn.

## 7. Hooks (Hooks tab)

The transcript already records hook outcomes (`hook_success` attachments and
`stop_hook_summary` records). For live events install the HTTP hooks:

```bash
node server.mjs --install-hooks
```

Then every tool call in every Claude Code session on this machine appears in
the feed the moment it happens, with the tool input and response.

## 8. Now your own sessions

Stop the demo and run `node server.mjs`. The sidebar lists every session under
`~/.claude/projects`, live ones first. Pick the session you are working in
right now and leave the Loop tab open while you talk to Claude Code: the
diagram animates in real time.

## Things to try

- Find a session where a tool errored (red bar) and read how the model recovered.
- Open the biggest session you have and look at the context chart around each compaction.
- Reconstruct the first and the last request of a session and compare the
  system prompt sizes: the tools list changes as MCP servers connect.
- Search for `<system-reminder>` to see how much context you never typed.

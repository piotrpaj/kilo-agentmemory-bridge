# kilo-agentmemory-bridge

Server plugin that connects Kilo/OpenCode sessions to a local [agentmemory](https://github.com/rohitg00/agentmemory) server.

It passively records prompts, tool usage, lifecycle events, compaction events, permission prompts, and selected best-effort Kilo events. It also injects recalled context into system prompts and compaction prompts.

## Requirements

- Kilo or OpenCode with server plugin support.
- A local agentmemory server:

```sh
npx @agentmemory/agentmemory
```

The API server defaults to `http://localhost:3111`; the viewer defaults to `http://localhost:3113`.

## Build

```sh
npm install
npm run build
```

The plugin entrypoint is `./dist/server.js`.

## Plugin vs MCP

This package is a Kilo/OpenCode server plugin. It observes Kilo runtime hooks and sends them to agentmemory.

MCP is separate. If you already use the agentmemory MCP server, keep that configuration as-is. This plugin does not install, modify, or replace MCP configuration.

## Kilo Install

For local project usage, build this package and reference it from `.kilo/plugin/` or from your Kilo config using a local path/plugin tuple, depending on your Kilo version.

Example config tuple:

```json
{
  "plugin": [
    [
      "file:///Users/piotr/Projects/agentmemory-kilo/dist/server.js",
      {
        "url": "http://localhost:3111",
        "tokenBudget": 2000,
        "secret": "replace-with-bearer-token-if-required"
      }
    ]
  ]
}
```

Project-local `file://` plugins may not appear in the Kilo plugin-manager UI because they are loaded from config rather than installed as plugin modules.

Run with logs while validating:

```sh
kilo --print-logs --log-level DEBUG
```

Use `kilo config check` for config validation. Avoid `kilo debug config` if your local config contains bearer secrets, because it may print resolved secret values.

## OpenCode Install

OpenCode can load local plugins from configured plugin paths or package references. Build first, then reference the server entrypoint or package export.

Example config tuple:

```json
{
  "plugin": [
    [
      "file:///Users/piotr/Projects/agentmemory-kilo/dist/server.js",
      {
        "url": "http://localhost:3111",
        "tokenBudget": 2000
      }
    ]
  ]
}
```

## Configuration

Plugin tuple options override environment variables, which override defaults.

| Option | Environment | Default | Description |
| --- | --- | --- | --- |
| `url` | `AGENTMEMORY_URL` | `http://localhost:3111` | agentmemory API server URL |
| `secret` | `AGENTMEMORY_SECRET` | unset | Optional bearer token sent as `Authorization: Bearer ...` |
| `tokenBudget` | `AGENTMEMORY_TOKEN_BUDGET` | `2000` | Context budget for session system prompt injection |
| `compactionBudget` | none | `Math.floor(tokenBudget * 0.75)` | Context budget for compaction injection |
| `timeoutMs` | none | `3000` | Default request timeout in milliseconds |
| `shortTimeoutMs` | none | `800` | Observation and optional bridge request timeout |
| `injectTimeoutMs` | none | `1500` | Context and enrichment request timeout |
| `summarizeTimeoutMs` | none | `120000` | Stop summarization timeout |
| `sessionEndTimeoutMs` | none | `30000` | Terminal session end timeout |
| `consolidationTimeoutMs` | none | `120000` | Optional consolidation timeout |
| `injectSessionContext` | `AGENTMEMORY_INJECT_SESSION_CONTEXT` | `true` | Inject recalled session context into system prompts |
| `injectToolContext` | `AGENTMEMORY_INJECT_CONTEXT` | `false` | Fetch pre-tool enrichment for file/search tools |
| `summarizeOnStop` | `AGENTMEMORY_SUMMARIZE_ON_STOP` | `true` | Call `/summarize` when Kilo emits `session.idle` |
| `consolidationEnabled` | `CONSOLIDATION_ENABLED` | `false` | Run `/crystals/auto` and `/consolidate-pipeline` on terminal session end |
| `memoryBridgeSync` | `CLAUDE_MEMORY_BRIDGE` | `false` | Run `/claude-bridge/sync` during compaction and terminal session end |
| `endSessionOnIdle` | none | `false` | Legacy opt-in to treat `session.idle` as terminal session end |

Example environment configuration:

```sh
export AGENTMEMORY_URL=http://localhost:3111
export AGENTMEMORY_TOKEN_BUDGET=2000
export AGENTMEMORY_SECRET=replace-with-bearer-token-if-required
```

Context injection differs from upstream Claude Code defaults. Claude requires `AGENTMEMORY_INJECT_CONTEXT=true`; this Kilo bridge injects session context by default and can be disabled with `injectSessionContext: false` or `AGENTMEMORY_INJECT_SESSION_CONTEXT=false`.

## Captured Data

The plugin sends best-effort requests to:

- `POST /agentmemory/session/start` on `session.created`
- `POST /agentmemory/session/end` on `session.deleted`, and on `session.idle` only when `endSessionOnIdle` is true
- `POST /agentmemory/observe` for `prompt_submit`, `pre_tool_use`, `post_tool_use`, `post_tool_failure`, `pre_compact`, `stop`, `notification`, and best-effort subagent/task events
- `POST /agentmemory/context` during system prompt transform and compaction
- `POST /agentmemory/enrich` before file/search tools when `injectToolContext` is true
- `POST /agentmemory/summarize` on throttled `session.idle` events when `summarizeOnStop` is true
- Optional `POST /agentmemory/crystals/auto`, `POST /agentmemory/consolidate-pipeline`, and `POST /agentmemory/claude-bridge/sync` when enabled

Network failures, timeouts, invalid JSON, and non-2xx responses are logged and never throw from hook execution. Optional consolidation and bridge endpoints may be disabled server-side; `404` and `503` responses for those endpoints are treated as debug-level failures.

## Claude Parity

| Claude hook | Kilo bridge status | Notes |
| --- | --- | --- |
| `session_start` | Exact endpoint mapping | Uses `session.created` and `/session/start` |
| `prompt_submit` | Exact hook mapping | Uses `chat.message` |
| `pre_tool_use` | Exact observation, limited injection | Uses `tool.execute.before`; Kilo has no Claude-style stdout channel |
| `post_tool_use` | Exact hook mapping | Uses `tool.execute.after` plus event dedupe |
| `post_tool_failure` | Best-effort plus event mapping | Uses `session.next.tool.failed` when available and fallback output inspection |
| `pre_compact` | Exact hook mapping | Uses `experimental.session.compacting` |
| `stop` | Best-effort | Uses throttled `session.idle` and optional `/summarize` |
| `notification` | Permission prompts | Uses `permission.ask` and permission response events when session-scoped |
| `session_end` | Terminal delete mapping | Uses `session.deleted`; Kilo may not emit it on every process exit |
| `subagent_start` | Best-effort | Uses exposed agent/step events when they include enough data |
| `subagent_stop` | Best-effort | Uses step end events for active non-primary agents |
| `task_completed` | Best-effort | Uses `todo.updated` only when completed tasks include a session ID |

Unsupported by this bridge:

- Direct Claude PreToolUse stdout injection. Kilo does not expose an equivalent tool-to-model text channel, so pre-tool enrichment is stored and appended at the next safe system transform when that hook runs.
- Auto MCP installation or mutation.
- Claude skill installation or management.

## Session Lifecycle

Kilo `session.idle` behaves like a turn becoming idle, not necessarily terminal session shutdown. The bridge now treats it as Claude-like `Stop`: it records a throttled `stop` observation and optionally calls `/summarize`.

Terminal `/session/end`, optional consolidation, and optional memory bridge sync happen on `session.deleted`. If a Kilo runtime exits without emitting `session.deleted`, terminal cleanup is best-effort until Kilo exposes a stronger shutdown hook.

## Privacy

Prompt and tool data is redacted before being sent to agentmemory.

The redactor removes:

- `<private>...</private>` blocks
- Bearer token values
- OpenAI-style `sk-*` keys
- GitHub `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` and `github_pat_` tokens
- AWS access key IDs
- JWT-looking strings
- Object values whose keys look like keys, secrets, passwords, tokens, auth, or credentials

Tool output is truncated to 8000 characters. Image-like data URLs, PNG base64 payloads, and JPEG base64 payloads up to 1,000,000 characters are replaced with `[image data extracted]` and stored separately in the observation payload; larger image payloads are omitted.

Redaction is best-effort and should not be treated as a security boundary.

## Verification

1. Run `npm install` and `npm run build`.
2. Start agentmemory with `npx @agentmemory/agentmemory`.
3. Verify `http://localhost:3111/agentmemory/health` responds.
4. Configure Kilo/OpenCode to load `dist/server.js`.
5. Start an agent session and confirm logs show `agentmemory bridge loaded`.
6. Send a prompt and run read/search/bash/edit tools.
7. Open `http://localhost:3113` and confirm observations appear.
8. Start a second session and confirm a `## Prior session context` block is injected when context exists.
9. Test `injectSessionContext: false` and confirm no system prompt context block is injected.
10. Stop agentmemory during a session and confirm Kilo/OpenCode continues while warnings are logged.
11. Test fake secrets in prompts/tool output and confirm redaction in the viewer.

# kilo-agentmemory-bridge

Kilo/OpenCode plugin bridge for [agentmemory](https://github.com/rohitg00/agentmemory).

This project ports agentmemory's Claude Code hook integration to Kilo/OpenCode. The bridge captures Kilo/OpenCode session activity through the `@opencode-ai/plugin` hook API and forwards it to an agentmemory API server. It records prompts, tool activity, compaction events, permission prompts, and session lifecycle signals, then injects recalled memory context into future system and compaction prompts.

## Features

- Captures prompts, tool inputs/results, tool failures, compaction events, permission prompts, and lifecycle events.
- Starts and ends agentmemory sessions from Kilo/OpenCode session events.
- Injects recalled session context into the system prompt by default.
- Adds recalled context to compaction prompts.
- Supports optional pre-tool enrichment for file/search tools.
- Supports optional stop summarization, consolidation, and Claude memory bridge sync endpoints.
- Redacts common secret formats before sending data to agentmemory.
- Treats agentmemory calls as best-effort so hook failures do not break Kilo/OpenCode execution.

## Requirements

- Node.js 18 or newer.
- Kilo or OpenCode with `@opencode-ai/plugin`-compatible plugin support.
- A running agentmemory API server.

Start agentmemory locally:

```sh
npx @agentmemory/agentmemory
```

By default, agentmemory serves the API at `http://localhost:3111` and the viewer at `http://localhost:3113`.

## Quick Start

Build the plugin:

```sh
npm install
npm run build
```

Add the compiled plugin to your Kilo or OpenCode config:

```json
{
  "plugin": [
    [
      "file:///absolute/path/to/kilo-agentmemory-bridge/dist/server.js",
      {
        "url": "http://localhost:3111",
        "tokenBudget": 2000
      }
    ]
  ]
}
```

If your agentmemory server requires bearer authentication, add `secret`:

```json
{
  "plugin": [
    [
      "file:///absolute/path/to/kilo-agentmemory-bridge/dist/server.js",
      {
        "url": "http://localhost:3111",
        "secret": "replace-with-bearer-token"
      }
    ]
  ]
}
```

For project-local Kilo config, keep secrets in `.kilo/kilo.json` and keep that file out of git.

## How It Works

Kilo/OpenCode loads `dist/server.js` as an OpenCode plugin module. The plugin exports a `PluginModule` whose `server(input, options)` function returns hook handlers such as `chat.message`, `tool.execute.before`, `tool.execute.after`, `permission.ask`, `experimental.chat.system.transform`, and `experimental.session.compacting`.

Those hooks translate Kilo/OpenCode runtime activity into agentmemory API calls:

| Agentmemory endpoint | Trigger |
| --- | --- |
| `POST /agentmemory/session/start` | `session.created` |
| `POST /agentmemory/session/end` | `session.deleted`, or `session.idle` when `endSessionOnIdle` is enabled |
| `POST /agentmemory/observe` | Prompts, tool events, compaction, stop, permission prompts, and best-effort task/subagent signals |
| `POST /agentmemory/context` | System prompt and compaction context injection |
| `POST /agentmemory/enrich` | Optional pre-tool enrichment when `injectToolContext` is enabled |
| `POST /agentmemory/summarize` | Throttled `session.idle` events when `summarizeOnStop` is enabled |
| `POST /agentmemory/crystals/auto` | Optional terminal session consolidation |
| `POST /agentmemory/consolidate-pipeline` | Optional terminal session consolidation |
| `POST /agentmemory/claude-bridge/sync` | Optional compaction/session-end bridge sync |

The agentmemory MCP server is complementary. Use MCP for interactive memory tools; use this plugin for passive hook capture and automatic context injection.

## Configuration

Plugin tuple options override environment variables, which override defaults.

| Option | Environment | Default | Description |
| --- | --- | --- | --- |
| `url` | `AGENTMEMORY_URL` | `http://localhost:3111` | agentmemory API server URL |
| `secret` | `AGENTMEMORY_SECRET` | unset | Optional bearer token sent as `Authorization: Bearer ...` |
| `tokenBudget` | `AGENTMEMORY_TOKEN_BUDGET` | `2000` | Context budget for system prompt injection |
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
| `consolidationEnabled` | `CONSOLIDATION_ENABLED` | `false` | Run optional consolidation endpoints on terminal session end |
| `memoryBridgeSync` | `CLAUDE_MEMORY_BRIDGE` | `false` | Run optional Claude memory bridge sync during compaction and terminal session end |
| `endSessionOnIdle` | none | `false` | Treat `session.idle` as terminal session end for legacy behavior |

Equivalent environment configuration:

```sh
export AGENTMEMORY_URL=http://localhost:3111
export AGENTMEMORY_TOKEN_BUDGET=2000
export AGENTMEMORY_SECRET=replace-with-bearer-token
```

Session context injection is enabled by default for this bridge. Disable it with `injectSessionContext: false` or `AGENTMEMORY_INJECT_SESSION_CONTEXT=false`.

## Hook Coverage

agentmemory already defines a Claude Code hook vocabulary. This bridge maps that vocabulary onto the closest Kilo/OpenCode plugin hooks and runtime events.

| agentmemory hook type | Kilo/OpenCode source | Support |
| --- | --- | --- |
| `session_start` | `session.created` | Direct |
| `prompt_submit` | `chat.message` | Direct |
| `pre_tool_use` | `tool.execute.before` | Direct observation |
| `post_tool_use` | `tool.execute.after` | Direct, deduped with event stream fallback |
| `post_tool_failure` | `session.next.tool.failed`, `tool.execute.after` fallback | Best-effort |
| `pre_compact` | `experimental.session.compacting` | Direct |
| `stop` | `session.idle` | Best-effort, throttled |
| `notification` | `permission.ask`, permission response events | Best-effort |
| `session_end` | `session.deleted` | Direct when emitted by Kilo/OpenCode |
| `subagent_start` | Agent/step events | Best-effort |
| `subagent_stop` | Step end events | Best-effort |
| `task_completed` | `todo.updated` events with session data | Best-effort |

Pre-tool enrichment is stored for the next safe system-prompt transform. Kilo/OpenCode does not currently expose the same pre-tool stdout injection channel used by Claude Code hooks.

## Session Lifecycle

`session.idle` is treated as a stop/turn-idle signal. The bridge records a throttled `stop` observation and, by default, requests agentmemory summarization.

`session.deleted` is treated as terminal session end. Terminal cleanup can also run optional consolidation and bridge sync endpoints when enabled.

## Privacy

Prompt and tool data is redacted before being sent to agentmemory.

The redactor handles:

- `<private>...</private>` blocks
- Bearer tokens
- OpenAI-style `sk-*` keys
- GitHub `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, and `github_pat_` tokens
- AWS access key IDs
- JWT-looking strings
- Object values whose keys look like keys, secrets, passwords, tokens, auth, or credentials

Tool output is truncated to 8000 characters. Image-like data URLs, PNG base64 payloads, and JPEG base64 payloads up to 1,000,000 characters are extracted into `image_data`; larger image payloads are omitted.

Redaction is best-effort and should not be treated as a security boundary.

## Validation

Run local checks:

```sh
npm run typecheck
npm run build
```

Validate Kilo config loading:

```sh
kilo config check --print-logs --log-level DEBUG
```

Use `kilo config check` for validation when local config contains bearer tokens. `kilo debug config` may print resolved secret values.

## Publishing

This package is configured for npm trusted publishing from GitHub Actions. The workflow lives at `.github/workflows/publish-npm.yml` and runs when a GitHub release is published.

Before the workflow can publish with OIDC, configure npm trusted publishing for this package on npmjs.com:

- Publisher: GitHub Actions
- Repository: `piotrpaj/kilo-agentmemory-bridge`
- Workflow file: `publish-npm.yml`
- Environment: leave blank unless the workflow is updated to use a GitHub environment

Trusted publishing requires npm CLI `11.5.1` or newer and Node.js `22.14.0` or newer. The workflow uses Node.js `24.x` so the bundled npm supports OIDC publishing and automatic provenance.

For a release publish, update `package.json` and `package-lock.json` to the target version, tag the same commit as `vX.Y.Z`, and publish a GitHub release for that tag. The workflow verifies that the release tag matches `package.json` before publishing.

If npm does not allow trusted publisher setup before the package exists, do one initial manual publish from a clean checkout with an npm account that can publish the package: `npm publish --access public --provenance=false`. After that, configure trusted publishing and use GitHub releases for future publishes.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Plugin does not load | Confirm `npm run build` succeeded and the config points to the absolute `file://.../dist/server.js` path |
| No observations in viewer | Confirm agentmemory API is reachable at `url` and bearer `secret` matches server config |
| Context is not injected | Confirm `injectSessionContext` is enabled and `/agentmemory/context` returns context for the session/project |
| Project-local plugin missing from plugin manager UI | File-based config plugins can load without appearing as installed plugin-manager packages |
| Kilo exits before session cleanup | Terminal cleanup depends on Kilo/OpenCode emitting `session.deleted`; summarization still runs from `session.idle` |

## License

MIT

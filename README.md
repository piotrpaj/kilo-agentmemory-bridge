# kilo-agentmemory-bridge

Server plugin that connects Kilo/OpenCode sessions to a local [agentmemory](https://github.com/rohitg00/agentmemory) server.

It passively records prompts, tool results, session lifecycle events, and compaction events, then injects recalled context into new session system prompts and compaction prompts.

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
        "tokenBudget": 2000
      }
    ]
  ]
}
```

Run with logs while validating:

```sh
kilo --print-logs --log-level DEBUG
```

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
| `secret` | `AGENTMEMORY_SECRET` | unset | Optional bearer token sent as `Authorization` |
| `tokenBudget` | `AGENTMEMORY_TOKEN_BUDGET` | `2000` | Context budget for session system prompt injection |
| `compactionBudget` | none | `Math.floor(tokenBudget * 0.75)` | Context budget for compaction injection |
| `timeoutMs` | none | `3000` | Per-request timeout |
| `injectToolContext` | `AGENTMEMORY_INJECT_CONTEXT` | `false` | Reserved for pre-tool enrichment; not active by default |

Example environment configuration:

```sh
export AGENTMEMORY_URL=http://localhost:3111
export AGENTMEMORY_TOKEN_BUDGET=2000
export AGENTMEMORY_SECRET=optional-shared-secret
```

## Captured Data

The plugin sends best-effort requests to:

- `POST /agentmemory/session/start` on `session.created`
- `POST /agentmemory/session/end` on `session.idle` and `session.deleted`
- `POST /agentmemory/observe` for `prompt_submit`, `post_tool_use`, `post_tool_failure`, and `pre_compact`
- `POST /agentmemory/context` during system prompt transform and compaction

Network failures, timeouts, invalid JSON, and non-2xx responses are logged as warnings and never throw from hook execution.

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

Tool output is truncated to 8000 characters. Image-like data URLs/base64 PNG payloads up to 1,000,000 characters are replaced with `[image data extracted]` and stored separately in the observation payload; larger image payloads are omitted.

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
9. Stop agentmemory during a session and confirm Kilo/OpenCode continues while warnings are logged.
10. Test fake secrets in prompts/tool output and confirm redaction in the viewer.

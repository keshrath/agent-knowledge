# Hooks (Claude Code)

agent-knowledge ships four hook scripts that integrate with Claude Code's
lifecycle events. They live under `scripts/hooks/` and are installed by
`scripts/setup.js` into `~/.claude/settings.json`.

All hooks fail open — any internal error is logged to stderr and the hook
returns an empty JSON object so the user is never blocked.

| Script                   | Event        | Purpose                                                  |
| ------------------------ | ------------ | -------------------------------------------------------- |
| `session-start.js`       | SessionStart | Announces the knowledge dashboard URL                    |
| `precompact-flush.mjs`   | PreCompact   | Rich session summary via the library                     |
| `precompact-distill.mjs` | PreCompact   | Lightweight text snapshot of recent user prompts         |
| `sessionend-distill.mjs` | SessionEnd   | Final summary (turn counts, tool uses, first 20 prompts) |

## session-start.js

Prints the dashboard URL (`http://localhost:3423` by default, override via
`AGENT_KNOWLEDGE_PORT`) and injects it as session context.

## precompact-flush.mjs

Called right before the host compacts the transcript. Imports
`dist/sessions/summary.js` from the built agent-knowledge library, pulls a
rich session summary via `getSessionSummary(sessionId)`, and writes it to
`~/agent-knowledge/sessions/<project-slug>/precompact-<timestamp>-<id>.md`.
Requires `npm run build` to have succeeded — if `dist/` is missing, the hook
logs the reason to stderr and emits `{}`.

### Environment variables

| Variable               | Default             | Description                      |
| ---------------------- | ------------------- | -------------------------------- |
| `KNOWLEDGE_MEMORY_DIR` | `~/agent-knowledge` | Where rich summaries are written |

## precompact-distill.mjs

A simpler heuristic companion to `precompact-flush.mjs`. Reads the last
~200 KB of the transcript JSONL, extracts the last 10 user prompts, and
writes them to
`~/claude-memory/projects/precompact-<slug>-<session>.md`. This one does
not require the library to be built, so it still works when `dist/` is
missing. Running both is fine — they target different files.

### Environment variables

| Variable               | Default           | Description                                       |
| ---------------------- | ----------------- | ------------------------------------------------- |
| `KNOWLEDGE_MEMORY_DIR` | `~/claude-memory` | Where the snapshot is written (`<dir>/projects/`) |

## sessionend-distill.mjs

On `SessionEnd`, walks the whole transcript JSONL, counts user / assistant
turns and `tool_use` blocks, collects the first 20 user prompts, and writes
a markdown summary to
`~/claude-memory/projects/session-<slug>-<session>.md`. Gives
agent-knowledge a breadcrumb for later session search/recall.

## Manual configuration

`scripts/setup.js` writes the hooks into `~/.claude/settings.json`
automatically. If you need to configure them by hand, add entries like:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/abs/path/to/agent-knowledge/scripts/hooks/session-start.js\"",
            "timeout": 5
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/abs/path/to/agent-knowledge/scripts/hooks/precompact-flush.mjs\"",
            "timeout": 10
          },
          {
            "type": "command",
            "command": "node \"/abs/path/to/agent-knowledge/scripts/hooks/precompact-distill.mjs\"",
            "timeout": 10
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/abs/path/to/agent-knowledge/scripts/hooks/sessionend-distill.mjs\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Replace `/abs/path/to/agent-knowledge` with your clone path.

## Testing the hooks

`tests/hooks/hooks.test.ts` covers all four scripts with shape-correct
fail-open assertions. Run `npm test -- tests/hooks/` to execute them in
isolation.

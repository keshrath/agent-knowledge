# Hooks (Claude Code)

agent-knowledge ships five hook scripts that integrate with Claude Code's
lifecycle events. They live under `scripts/hooks/` and are installed by
`scripts/setup.js` into `~/.claude/settings.json`.

All hooks fail open — any internal error is logged to stderr and the hook
returns an empty JSON object so the user is never blocked.

| Script                    | Event            | Purpose                                                                  |
| ------------------------- | ---------------- | ------------------------------------------------------------------------ |
| `session-start.js`        | SessionStart     | Announces dashboard URL + auto-loads wakeup payload into context         |
| `first-prompt-inject.mjs` | UserPromptSubmit | Injects query-targeted knowledge hits on the session's first real prompt |
| `precompact-flush.mjs`    | PreCompact       | Rich session summary on disk + save-unsaved-context nudge into context   |
| `precompact-distill.mjs`  | PreCompact       | Lightweight text snapshot of recent user prompts                         |
| `sessionend-distill.mjs`  | SessionEnd       | Final summary (turn counts, tool uses, first 20 prompts)                 |

## session-start.js

Two jobs:

1. Prints the dashboard URL (`http://localhost:3423` by default, override via
   `AGENT_KNOWLEDGE_PORT`) and injects it into SessionStart `additionalContext`.
2. Auto-loads a token-budgeted **wakeup** payload (L0 identity + L1 top-weighted
   entries) into the same `additionalContext`, so the agent starts every session
   with a small world-model already in the prompt — no manual
   `knowledge(action="wakeup")` call required.

### Environment variables

| Variable                        | Default | Description                                         |
| ------------------------------- | ------- | --------------------------------------------------- |
| `AGENT_KNOWLEDGE_PORT`          | `3423`  | Dashboard port announced in the context line        |
| `AGENT_KNOWLEDGE_AUTOWAKE`      | `1`     | Set `0` / `false` to skip the wakeup auto-injection |
| `AGENT_KNOWLEDGE_WAKEUP_BUDGET` | `800`   | Max tokens (chars/4 estimate) for the L0+L1 blob    |

Requires `npm run build` to have succeeded — if `dist/wakeup.js` is missing,
only the dashboard-URL line is emitted (fail-open).

## first-prompt-inject.mjs

Fires on UserPromptSubmit. When the session's FIRST real user prompt arrives,
runs it through `searchKnowledge(prompt, { mmr: true })` and injects the top-K
hits into `additionalContext` before the model reads the prompt. Complements
the wakeup pack (which is query-agnostic) with query-targeted context.

Gates (all must pass to fire):

- Prompt length ≥ 10 characters.
- Prompt does NOT start with `/` (slash command) or `!` (bash shortcut).
- No marker file exists yet for this session ID.

The marker file (`{dataDir}/.first-prompt-seen/<session_id>`) is only written
AFTER a real search has run — skip-gates like `/clear` do NOT burn the shot,
so the user's next real question still gets injection.

### Environment variables

| Variable                               | Default             | Description                                             |
| -------------------------------------- | ------------------- | ------------------------------------------------------- |
| `AGENT_KNOWLEDGE_FIRSTPROMPT_INJECT`   | `1`                 | Set `0` / `false` / `off` to disable                    |
| `AGENT_KNOWLEDGE_FIRSTPROMPT_BUDGET`   | `600`               | Max tokens (chars/4 estimate), clamped to `[100, 8000]` |
| `AGENT_KNOWLEDGE_FIRSTPROMPT_MAX_HITS` | `4`                 | Max rendered entries, clamped to `[1, 20]`              |
| `KNOWLEDGE_MEMORY_DIR`                 | `~/agent-knowledge` | Knowledge base to search                                |

## precompact-flush.mjs

Called right before the host compacts the transcript. Two jobs:

1. Imports `dist/sessions/summary.js` from the built library, pulls a rich
   session summary via `getSessionSummary(sessionId)`, and writes it to
   `~/agent-knowledge/sessions/<project-slug>/precompact-<timestamp>-<id>.md`.
   If `dist/` is missing, the disk dump is skipped (fail-open).
2. Injects a short "save-unsaved-context" nudge into the PreCompact
   `additionalContext` so the agent is prompted to write anything important
   to the knowledge base BEFORE compaction summarises the transcript away.

### Environment variables

| Variable                           | Default             | Description                                                                                          |
| ---------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------- |
| `KNOWLEDGE_MEMORY_DIR`             | `~/agent-knowledge` | Where rich summaries are written                                                                     |
| `AGENT_KNOWLEDGE_PRECOMPACT_NUDGE` | `1`                 | Set `0` / `false` to disable the nudge only. Set `off` to suppress both the nudge AND the disk dump. |

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
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/abs/path/to/agent-knowledge/scripts/hooks/first-prompt-inject.mjs\"",
            "timeout": 10
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

`tests/hooks/hooks.test.ts` covers all five scripts with shape-correct
fail-open assertions plus a positive-path render test for
`first-prompt-inject.mjs`. Run `npm test -- tests/hooks/` to execute them
in isolation.

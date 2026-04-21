# Hooks (Claude Code)

agent-knowledge ships six hook scripts that integrate with Claude Code's
lifecycle events. They live under `scripts/hooks/` and are installed by
`scripts/setup.js` into `~/.claude/settings.json`.

All hooks fail open — any internal error is logged to stderr and the hook
returns an empty JSON object so the user is never blocked.

| Script                     | Event            | Purpose                                                                  |
| -------------------------- | ---------------- | ------------------------------------------------------------------------ |
| `session-start.js`         | SessionStart     | Announces dashboard URL + auto-loads wakeup payload into context         |
| `session-start-ingest.mjs` | SessionStart     | Detects project + reports knowledge-ingest cache drift via SHA256 diff   |
| `first-prompt-inject.mjs`  | UserPromptSubmit | Injects query-targeted knowledge hits on the session's first real prompt |
| `precompact-flush.mjs`     | PreCompact       | Rich session summary on disk + save-unsaved-context nudge into context   |
| `precompact-distill.mjs`   | PreCompact       | Lightweight text snapshot of recent user prompts                         |
| `sessionend-distill.mjs`   | SessionEnd       | Final summary (turn counts, tool uses, first 20 prompts)                 |

## session-start.js

Four jobs:

1. Prints the dashboard URL (`http://localhost:3423` by default, override via
   `AGENT_KNOWLEDGE_PORT`) and injects it into SessionStart `additionalContext`.
2. Auto-loads the **L0 identity** section (who the user is — query-agnostic
   facts from `~/agent-knowledge/identity.md`) into the same
   `additionalContext`, so every session starts with that context without a
   manual `knowledge(action="wakeup")` call.
3. Clears the `first-prompt-inject.mjs` marker file for this `session_id` on
   every SessionStart event (startup / resume / clear). Resumed sessions
   reuse the same `session_id`, so without this the inject hook silently
   skips on the next prompt because the prior run's marker is still on disk.
4. **Identity onboarding**: if neither `identity.md` nor `IDENTITY.md` exists
   in the memory dir AND there is no `.identity-declined` opt-out marker,
   appends a short instruction to `additionalContext` telling the agent to
   ask the user three questions (name/role, stack, projects) and save the
   answers via the host's `Write` tool. The agent drives the conversation;
   the user never has to manually create the file. If the user says "skip"
   or "not now", the agent creates `~/agent-knowledge/.identity-declined` and
   the onboarding prompt stops firing. Delete that file to re-enable.

L1 top-weighted facts are **not** auto-loaded here. The companion
`first-prompt-inject.mjs` runs a query-targeted KB search on the session's
first real prompt and injects a better-matched slice than any
query-agnostic pre-load would. Users who want the full legacy L0+L1 pack can
still call `knowledge(action="wakeup")` manually, or flip
`AGENT_KNOWLEDGE_WAKEUP_BUDGET` up to re-enable larger identity sections.

Also emits a user-visible `systemMessage` on every session start with a
status suffix so the user can always tell the hook ran:

- `agent-knowledge: http://localhost:3423 | identity: 312 chars` — when a
  user-authored `identity.md` was loaded.
- `agent-knowledge: http://localhost:3423 | identity: onboarding pending` —
  when no identity file exists and onboarding is queued (agent will ask
  the user on the next prompt).
- `agent-knowledge: http://localhost:3423 | identity: declined (delete ~/agent-knowledge/.identity-declined to redo)` —
  when the user previously opted out.
- `agent-knowledge: http://localhost:3423 | identity: placeholder (no identity.md) · inject rearmed` —
  fallback for edge cases (e.g. stat errors), with `· inject rearmed` when
  the first-prompt-inject marker was cleared.
- `agent-knowledge: http://localhost:3423 | autowake off · resume` — when
  `AGENT_KNOWLEDGE_AUTOWAKE=0` disables auto-injection.

The model-facing context and the user-facing line are separate channels —
the `systemMessage` is purely a UX signal so the user can see what got
pre-loaded and whether the next prompt will trigger query-targeted injection.

### Environment variables

| Variable                        | Default | Description                                             |
| ------------------------------- | ------- | ------------------------------------------------------- |
| `AGENT_KNOWLEDGE_PORT`          | `3423`  | Dashboard port announced in the context line            |
| `AGENT_KNOWLEDGE_AUTOWAKE`      | `1`     | Set `0` / `false` to skip the identity auto-injection   |
| `AGENT_KNOWLEDGE_WAKEUP_BUDGET` | `200`   | Max tokens (chars/4 estimate) for the L0 identity slice |

Requires `npm run build` to have succeeded — if `dist/wakeup.js` is missing,
only the dashboard-URL line is emitted (fail-open).

## session-start-ingest.mjs

Second SessionStart hook, paired with `session-start.js`. On session start:

1. Detects the current project from `cwd`.
2. Checks whether a `knowledge-ingest` cache exists for it.
3. If no cache → suggests bootstrapping (the `/knowledge-ingest` skill).
4. If cache exists → computes a quick SHA256 diff of the current files vs the cached snapshot and reports how many files changed since last ingest.

Zero LLM tokens, reads/hashes only. Fail-open: all errors logged to stderr,
always outputs valid JSON.

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

When injection fires, the hook also emits a user-visible `systemMessage`:
`knowledge: injected 4 hits (decisions/database-choice.md, sessions/foo.md, +2 more)`.
This is separate from the model-facing `additionalContext` — the user sees a
one-line summary in the transcript, the model sees the full rendered hit list.

### Environment variables

| Variable                               | Default             | Description                                             |
| -------------------------------------- | ------------------- | ------------------------------------------------------- |
| `AGENT_KNOWLEDGE_FIRSTPROMPT_INJECT`   | `1`                 | Set `0` / `false` / `off` to disable                    |
| `AGENT_KNOWLEDGE_FIRSTPROMPT_BUDGET`   | `600`               | Max tokens (chars/4 estimate), clamped to `[100, 8000]` |
| `AGENT_KNOWLEDGE_FIRSTPROMPT_MAX_HITS` | `4`                 | Max rendered entries, clamped to `[1, 20]`              |
| `AGENT_KNOWLEDGE_MEMORY_DIR`           | `~/agent-knowledge` | Knowledge base to search                                |

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
| `AGENT_KNOWLEDGE_MEMORY_DIR`       | `~/agent-knowledge` | Where rich summaries are written                                                                     |
| `AGENT_KNOWLEDGE_PRECOMPACT_NUDGE` | `1`                 | Set `0` / `false` to disable the nudge only. Set `off` to suppress both the nudge AND the disk dump. |

## precompact-distill.mjs

A simpler heuristic companion to `precompact-flush.mjs`. Reads the last
~200 KB of the transcript JSONL, extracts the last 10 user prompts, and
writes them to
`~/agent-knowledge/projects/precompact-<slug>-<session>.md`. This one does
not require the library to be built, so it still works when `dist/` is
missing. Running both is fine — they target different files.

### Environment variables

| Variable                     | Default             | Description                                       |
| ---------------------------- | ------------------- | ------------------------------------------------- |
| `AGENT_KNOWLEDGE_MEMORY_DIR` | `~/agent-knowledge` | Where the snapshot is written (`<dir>/projects/`) |

## sessionend-distill.mjs

On `SessionEnd`, walks the whole transcript JSONL, counts user / assistant
turns and `tool_use` blocks, collects the first 20 user prompts, and writes
a markdown summary to
`~/agent-knowledge/projects/session-<slug>-<session>.md`. Gives
agent-knowledge a breadcrumb for later session search/recall.

Also emits a user-visible `systemMessage` on stdout so you can tell the
hook actually ran — receipt of the turn / tool-use counts and the target
file path, or the reason for skipping (missing transcript, write failure).
A one-line breadcrumb is appended to
`~/agent-knowledge/sessions/index.md` on every successful distill, so
the receipt is durable even when the host tears the transcript down
before painting the message.

On a successful distill the hook also POSTs the receipt to the dashboard's
`POST /api/events` endpoint (port from `AGENT_KNOWLEDGE_PORT`, default
3423). If the dashboard is open, a live toast appears top-right the moment
the session ends — covers hosts (like Claude Code `/exit`) that swallow
`systemMessage` on SessionEnd. Fails open on ECONNREFUSED / timeout; set
`AGENT_KNOWLEDGE_DASHBOARD_EVENTS=0` to suppress the POST entirely.

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

`tests/hooks/hooks.test.ts` covers the six scripts with shape-correct
fail-open assertions plus a positive-path render test for
`first-prompt-inject.mjs`. Run `npm test -- tests/hooks/` to execute them
in isolation.

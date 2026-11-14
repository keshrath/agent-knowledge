# The session lifecycle (Claude Code)

In Claude Code the agent-knowledge plugin's mod (`plugin/hooks/register.tsx`,
Claude Code 2.1.289+) ties the knowledge base into each session. There are no
command hooks to install and nothing to add to `settings.json`: install the
plugin and the lifecycle comes with it.

```
claude plugin marketplace add keshrath/agent-knowledge
claude plugin install agent-knowledge@agent-knowledge
```

Every part goes through the local REST server (`127.0.0.1:3423`, see the
README) and fails open: a server that is down or slow, or an error anywhere,
leaves the session exactly as it would be without the plugin. No part waits
more than 2 s for the server (a snapshot 10 s): a process that holds the port
and never answers costs a prompt at most that, and the holder itself lets the
port go after two unanswered self-checks, 30 s apart.

| When                             | What the mod does                                                                 | REST it calls                                     |
| -------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------- |
| The conversation's first message | One context block: what the knowledge base holds, who the person is, ingest state | `GET /api/overview`, `/api/wakeup`, `/api/ingest` |
| The first real prompt            | The entries matching it ride beside it, once per conversation                     | `GET /api/knowledge/search?mmr=true`              |
| A compaction of the main thread  | Snapshot of the session; the summary keeps what is still to be saved              | `POST /api/sessions/:id/snapshot` (`compact`)     |
| The session ending (or `/clear`) | The session's last snapshot                                                       | `POST /api/sessions/:id/snapshot` (`end`)         |

## The context block (`prompt.context`)

The model's first message carries one block named `agent-knowledge`. It is
computed again after a compaction and after `/clear`.

1. **What the knowledge base holds**: entry and session counts by category,
   and how to reach it (`knowledge_search`, `knowledge` action `read`,
   `/knowledge` for the person).
2. **Who the person is** (the L0 identity): the identity section of the
   wakeup bundle, from `identity.md` in the knowledge base, headed
   `--- Knowledge wakeup (identity only; call `knowledge action=wakeup` for L1 facts) ---`.
3. **Identity onboarding**: while there is neither `identity.md` nor a
   `.identity-declined` marker, the block asks the model to ask the person three
   questions (name and role, stack, projects) and save the answers to
   `identity.md` with the Write tool, or to create `.identity-declined` when
   they say not now. Delete that file to be asked again.
4. **Ingest freshness** of the session's folder (the knowledge-ingest skill's
   `.knowledge-ingest-cache.json`, compared by SHA-256): a folder with three or
   more source files that was never ingested is offered `/knowledge-ingest`;
   one with files changed, new or deleted since says how many. A current
   ingest, or a folder with fewer source files, adds nothing. Hashing only,
   no tokens.

L1 facts are not loaded here: the first-prompt injection brings the entries
that match what is asked, which a query-agnostic pack cannot.

| Variable                        | Default | Description                                             |
| ------------------------------- | ------- | ------------------------------------------------------- |
| `AGENT_KNOWLEDGE_AUTOWAKE`      | `1`     | `0` / `false` / `off`: no identity and no onboarding    |
| `AGENT_KNOWLEDGE_WAKEUP_BUDGET` | `200`   | Tokens (chars/4) for the identity section, `[50, 4000]` |

## The first real prompt (`prompt.submit`)

The conversation's first real prompt is searched against the knowledge base
(MMR re-ranked, so the hits are not five copies of one thing) and the top hits
ride beside it, where the model reads them and the person does not:

```
## Knowledge — top hits for your first prompt

_Injected automatically by agent-knowledge. Query these entries with `knowledge` (action=read, path=…) before deciding whether to issue a wider `knowledge_search`._

- **Release ritual** (`workflows/release.md`, score 3.42) — Bump, tag, push…
```

Under the prompt the transcript shows one line naming them by title, e.g.
`agent-knowledge: 2 entries for this prompt: Release ritual, Tag before you push`.

- A prompt shorter than 10 characters, a slash command, a `!` shell line, a
  background task's notice or another session's message is not searched and
  leaves the injection for the next prompt.
- The first search the server answers spends it, hits or none. A server that
  is down leaves it for the next prompt.
- Once per conversation: again after `/clear` (a new conversation) and in a
  restarted or resumed session.

| Variable                               | Default | Description                                  |
| -------------------------------------- | ------- | -------------------------------------------- |
| `AGENT_KNOWLEDGE_FIRSTPROMPT_INJECT`   | `1`     | `0` / `false` / `off` to turn it off         |
| `AGENT_KNOWLEDGE_FIRSTPROMPT_BUDGET`   | `600`   | Tokens (chars/4) for the hits, `[100, 8000]` |
| `AGENT_KNOWLEDGE_FIRSTPROMPT_MAX_HITS` | `2`     | Entries at most, `[1, 2]`                    |

## The session snapshot (`session.compact`, `session.end`)

When the main conversation is compacted (`/compact`, or at the threshold) and
when the session ends (exit, `/clear`, resume elsewhere), the server writes
the session's gist into the knowledge base:

`sessions/<project>/<YYYY-MM-DD>-<session id, 8 chars>.md`

One file per session, rewritten at each compaction and at the end, titled by
the project, the day and the first thing asked (`demo · 2026-11-13 · fix the
sync`), with the session id, folder, branch (none outside git) and times in
its frontmatter, and sections **What was asked** (the first and last ten
prompts), **Tools used**, **Files** (the ones an editing or writing tool call
changed), **Commits** (the ones `git commit` reported) and **Errors**. In the
`/knowledge` pane they are the `sessions` category, left out of `all`. It is built by the session parser
(every host the adapters read), with secrets, e-mail addresses and system
noise (reminders, task notifications, command wrappers) scrubbed as the
distiller scrubs them. A session where nothing was asked writes nothing. The
file is searchable at once and reaches other machines with the next git sync.

After a compaction a toast names the snapshot (`Session saved at compaction: demo · 2026-11-13 ·
fix the sync`): a transcript line would land in the middle of the turn. After `/clear` the new
conversation's first line names it (`Session saved: …`): a toast is drawn neither in the
conversation ending nor on the screen `/clear` just emptied. Every other open session toasts it
as a live event.

At a compaction the summary is also asked to keep, under **Knowledge to
save**, each durable fact not yet written to the knowledge base (decisions,
gotchas, hard-won commands, people and ownership, project state), so the model
can still save them with `knowledge` (action `write`) afterwards.

| Variable                           | Default | Description                                                                          |
| ---------------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `AGENT_KNOWLEDGE_PRECOMPACT_NUDGE` | `1`     | `0` / `false`: the summary is left as asked. `off`: no snapshot at compaction either |

Subagents' compactions are left alone.

## From 2.x command hooks

agent-knowledge 2.x installed six command hooks (`scripts/hooks/*.js|mjs`)
into `~/.claude/settings.json`. 3.0 removes the scripts. Run
`node scripts/setup.js --host=claude` once to take their entries out of
`settings.json` (or delete every hook command naming
`agent-knowledge/scripts/hooks/`), then install the plugin. Remove a
hand-written `agent-knowledge` entry from `~/.claude.json` too, so the tools do
not appear twice.

## Other hosts

OpenCode gets the first-prompt injection, the compaction nudge and a session
summary from its own plugin (`agent-knowledge/opencode`, see
[SETUP.md](SETUP.md#opencode-plugins)). Any host can call the REST routes above.

## Tests

`plugin/tests/knowledge.test.ts` (`claude plugin test plugin`) covers each
part of the lifecycle against a scripted server: the context block's parts and
switches, the injection's gates, budget and once-per-conversation rule, the
compaction's snapshot and summary, the end. `tests/rest-lifecycle.test.ts`
covers the routes against real files and transcripts, and
`tests/e2e-claude/` runs them in the real Claude Code CLI.

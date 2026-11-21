# agent-knowledge

## Architecture

Layered architecture — `server.ts` handles the MCP tools, `rest-server.ts` the local REST API (no web UI):

```
scripts/
  tree-sitter-extract.mjs  Standalone CLI for zero-token code structure extraction
  tree-sitter-lang.mjs     Per-language tree-sitter query definitions (8 languages)
  setup.js                 Host setup: OpenCode config, the ~/.agents skill, removes 2.x Claude Code command hooks
  plugins/opencode/        The opencode plugin
plugin/                    Claude Code plugin: .mcp.json, skills/knowledge-ingest, one mod (hooks/ = /knowledge pane + session lifecycle)
src/
  server.ts             MCP server, 6 tool definitions, request routing
  rest-server.ts        REST server on 127.0.0.1 (startRestServer, serveRestWhenFree: leader election + takeover)
  transport/            rest.ts (routes), http.ts (json, readBody, Router), guard.ts (Host/Origin/Content-Type)
  events.ts             Live event ring (POST /api/events, read by the pane)
  slice.ts              runSliced / runAll: index builds as steps that give the event loop back
  index.ts              Entry point (MCP stdio; the REST holder also runs the background indexer)
  types.ts              KnowledgeConfig, getConfig(), getVersion()
  package-meta.ts       Cached name/version from package.json
  validate.ts           ValidationError class, input validation
  version.ts            Re-exports getVersion from types.ts
  knowledge/
    store.ts            Markdown CRUD, frontmatter parsing, path traversal protection
    search.ts           TF-IDF search over knowledge entries with regex fallback; the index follows the files (stat check, only changed entries re-read)
    git.ts              git pull/push/sync with timeouts
    distill.ts          Session auto-distillation with secrets scrubbing
    graph.ts            Knowledge graph — edges table, link/unlink/traverse (BFS)
    scoring.ts          Confidence/decay scoring — entry_scores table, auto-promotion
    consolidate.ts      Memory consolidation — TF-IDF duplicate detection, cluster grouping
    reflect.ts          Reflection cycle — surfaces unconnected entries, generates prompts
    analyze.ts          Graph analysis — god nodes, bridges, gaps, knowledge brief
    ingest-freshness.ts A folder against its knowledge-ingest cache (SHA-256)
    similar.ts          How close a prompt is to each entry in meaning (local embeddings), for the first-prompt rule
  sessions/
    parser.ts           Multi-format session parsing with mtime-based cache
    indexer.ts           Background indexing for sessions
    search.ts           TF-IDF ranked search; the index follows the session files (a growing one is read from where the last read ended)
    scopes.ts           Search scopes (errors, plans, configs, tools, files, decisions)
    summary.ts          Session summaries, topic extraction, file path detection
    human.ts            What a person asked: no slash command, no host wrapper (with parser.promptsOf: no isMeta entry); project and branch names
    snapshot.ts         The session snapshot (sessions/<project>/<day>-<id>.md), scrubbed
    adapters/
      index.ts          SessionAdapter interface, adapter registry, auto-init
      opencode.ts       OpenCode adapter (SQLite database)
  search/
    lexicon.ts          What a word is to the base: generic (said in sessions, naming no entry) or what entries are named by
    tfidf.ts            TF-IDF scoring engine (tokenizer, stopwords, index)
    fuzzy.ts            Levenshtein distance, sliding window fuzzy matching
    excerpt.ts          Search result excerpt generation
    types.ts            SearchResult, SearchOptions interfaces
  embeddings/
    index.ts            Embedding provider registry
    factory.ts          Provider factory (auto-detect available providers)
    types.ts            EmbeddingProvider interface
    claude.ts           Claude/Voyage embeddings
    openai.ts           OpenAI embeddings
    gemini.ts           Gemini embeddings
    local.ts            Local embedding fallback
  vectorstore/
    index.ts            Vector store facade
    store.ts            SQLite-backed vector storage with cosine similarity
    chunker.ts          Document chunking for embedding
```

## UI surfaces

There is no web dashboard (removed in 2.0, with the WebSocket and the UI files).

- **Claude Code pane** (`plugin/hooks/register.tsx` + `view.tsx`, Claude Code 2.1.289+ function hooks): `/knowledge` opens Browse (every entry: a Find or category left from before is cleared), `/knowledge <words>` searches, `/knowledge <path>` opens an entry (`.md` optional). The reply goes to the model too: it says something only when something is wrong (nothing found, no such entry, server down, pane not placed). Tabs (hotkeys `1`–`4`, `r` Refresh): Browse (every curated entry newest first, a category bar with counts and the session snapshots last as `snapshots`, Find over title/path/tag (every word), the ring kept in it when a folder appears or goes above it (`barOf`, re-landed after `drawingOf`), headed `Matches` while filtered, 25 rows a page; follows writes from other sessions on the next poll, keeping the ring on its row; while the pane holds the keyboard the drawn order is kept (`pinned`, `pinOrder`), new rows at the end; empty: the next step, `Ingest <project> ›`, fills `/knowledge-ingest <dir>` into the prompt, which takes the keys with it: a `command.run` of it (matched by name, never every command: /clear's lines would go) within 400 ms of the fill or of the last one held (`filled`) is held and the text put back, said once a burst), Search (entries, then past-session messages; snapshots stay out of first-prompt hits (`skip=sessions`); excerpts come from `excerptText` in `src/knowledge/search.ts`: no headings, no code blocks, table rows as their cells, segments joined with `·`), Sessions (newest first, by folder name and first real prompt; this session marked; sessions where nothing was asked folded behind `▸ N more where nothing was asked`; each opens a summary, a snapshot's session coming back to the snapshot), Health (counts from the overview, snapshots apart, search mode, the folder whole, wrapped, git, this project's ingest with `Ingest <project> ›`, Sync now with a remote (never where the ring lands by itself), recent events (a failed sync among them), Analyze links: most linked = 2+ links and, disjoint, one link or none, fewest links first, 30 at a time). An entry page: facts (dates relative up to a week, as the rows), links both ways (`→`/`←`, relation, origin, the other entry's title from the server) that open their entry, `‹` back the trail landing on the link followed, the body as Markdown (frontmatter and a title-repeating heading dropped, folds past 30 lines; fenced code drawn apart (`bodyParts`, a dim `│` before each line, a wrapped line's rest indented without one); links in the text listed as `mentions`; a table too wide as rows of `Header: value`), follows its file on the poll (an edit shows, a delete elsewhere returns to the tab with `!`), Delete last, confirmed in a red box saying what goes (for good without git, the incoming links lost) with `Keep it` first and the ring on it and `Delete <path>`, scrolled into view. A snapshot page names its session and opens it when its transcript is on this machine (`session_on_machine`). Server down: the tabs stay drawn (their digits never reach the prompt), the body says what to do; an older 1.x on the port is named. Status entry = the headline (`N entries · M sessions`, `offline`, `old server x on the port`), or the outcome while the pane shows (`showStatus`); outcomes are marked ✓ done, ✗ failed or refused, ! changed elsewhere, – nothing happened, and go after 10 s; the busy line is a `Progress` ("Syncing"); one toast per poll for new live events (`POST /api/events`), `Label: subject` joined `·`, three at most then `+N more`. Session lifecycle (docs/HOOKS.md, no command hooks): one `prompt.context` block (holdings, identity or onboarding via `/api/wakeup`, ingest via `/api/ingest`, the ingest also toasted to the person since the model is told not to narrate context); `prompt.submit` adds the first real prompt's hits once per conversation (`injected` = the session id; spent by the first answered search; `prompt=true`: the server decides (`PROMPT_RULE`, precision first, measured in tests/first-prompt-eval.test.ts on TUNE and HOLDOUT prompts, the holdout never tuned on; tests/first-prompt-rule.test.ts part by part): searched for what it asks (no "one line, no tools", no greetings or asking words); acks, news ending in thanks, tasks on what is at hand and sums nothing; more words the base never saw than it knows nothing; mostly generic words nothing (`Lexicon` in src/search/lexicon.ts: said in a tenth of the snapshots, naming under a tenth of the entries that use it); each hit named by the prompt's specific words (title, path, tags) for 40% of what they tell (IDF over the curated entries), holding 60% of it, within 0.7 of the best, two at most, identity.md never; with the local model's embeddings (`promptSimilarity`, src/knowledge/similar.ts: the knowledge chunks read from the vector store, a cold model left for the next prompt), the entry closest in meaning at cosine 0.6 or more too; MMR dropping near-copies); `session.compact` (main thread) snapshots and appends to the summary's instructions; `session.end` snapshots. Polls `GET /api/overview` every 5 s while shown, 30 s while not. Focus: every navigation lands explicitly (`landing()`, always a button: the ring enters a text field only when the person asks for it: Search pressed while on Search (2 again, Enter on its tab) or a search typed in its field; the tab key alone lands on the tab, so a command typed next never lands in a field); keys name the new state (`rowKey` by category, `hitKey` by `rev`, `linkKey` by page, `foldKey`, `refreshKey` by up/down and `rev`) because the engine keeps the ring by place, not key; `awaitDrawing()` waits for a redraw through Refresh's fresh key (a button); `focusOn()` says whether the ring moved (a refused key falls back to `land()`), records `focused` (the typing header, `isField`) and marks its own moves (`ownMoves`), so a plugin-origin focus that is not one is a take (ctrl+x tab) and is sent back to `focused`; `/knowledge` closes an open pane and opens it again (as /pipeline does: `$.ui.open` on an open pane would restore the old ring), then lands the ring itself. Every string from the server is cleaned where it comes in (`drawable` in the `api()` reviver: escape sequences dropped, other controls `�`): Claude Code refuses a drawing holding one. A press is a claim (`claims`, `ui.press` and the person's `ui.focus`): a landing yields to a newer one; `sync`, `ingest` and `confirm-yes` hold a press within 400 ms of a view change (`isGuarded`); `back` and `open-session` one within 250 ms of the press before (`isWayOff`), so a burst of Enter does not leave the page it opened; a press whose button was drawn again as it came (its handler gone) is carried out by its key when it only moves (`moveOf`), said when it changes something, and logged (debug) either way. Widths in terminal columns (`cols()`). REST only, through `$.http.fetch` on `AGENT_KNOWLEDGE_PORT` (default 3423). View state in `$.state` (contract `plugin/types/index.d.ts`); the render hook reads it all at once. Every function that takes `$` is a top-level declaration (`claude plugin validate`). Tests: `plugin/tests/*.test.ts` under `claude plugin test plugin` (vitest excludes `plugin/`); the real CLI in `tests/e2e-claude/` (`COVERAGE.md` maps every control to its test). Type-check with a tsconfig outside the folder (never `tsc -p plugin`, it emits .js into plugin/).
- **Desktop app** (`layoutOf(e.surface, e.props.placement)` in view.tsx): `desktop` draws a head (state, git, Refresh, Sync now as `variant="primary"`, count tiles), a side column (tabs and categories with counts) beside the view from 90 columns (stacked below that), an entry body as one Markdown with an Svg graph of its links, and Health's Svg charts (entries per category, updated per week); `widget` placement draws a glance (counts, a stacked Svg strip, git and the latest event, Search). The terminal gets the same views with no Svg (register.tsx drops it from the table there). Charts are plain SVG strings (`categoryChart`, `stripChart`, `activityChart`, `neighbourGraph`) in fixed mid-tone colours that read on light and dark. Tests loop every flow over terminal and desktop (`FLOW` in plugin/tests/knowledge.test.ts).
- **MCP tool results** for every other host.

## REST server

- One process serves it: the first MCP process to bind `127.0.0.1:AGENT_KNOWLEDGE_PORT`; the others retry every 5 s and take over when it exits (`serveRestWhenFree`). The holder also runs the background session indexer and warms both search indexes (sliced, so it keeps answering).
- The holder asks itself for `/health` every 30 s (5 s timeout); two unanswered in a row close its listener and it binds again (a listener that stopped accepting never holds the port). No request may hold the event loop for seconds: index builds run through `runSliced`.
- Request guard (`transport/guard.ts`) on every request: Host must be a loopback name with the port, any `Origin` is refused, bodies must be `application/json`. No CORS, no rate limiter (loopback only; one shared bucket would throttle every pane and hook at once).
- No agent-common dependency: the guard, the router and the package metadata live in `src/`.

## Code Style

- **TypeScript** with strict mode, ES modules
- **Imports**: use `.js` extensions (TypeScript NodeNext convention)
- **Naming**: `camelCase` for functions/variables, `PascalCase` for types/classes, `UPPER_SNAKE` for constants
- **Async**: use `async`/`await` over raw promises
- **Error handling**: throw descriptive errors, catch and return MCP-formatted errors in tool handlers
- **No external formatters** — match existing code style
- **ESLint + Prettier** enforced via lint-staged (husky pre-commit)

## Versioning

- Version lives in `package.json` and is read at runtime via `version.ts`
- Never hardcode version strings
- `package.json`, `server.json` (top-level and package entry) and `plugin/.claude-plugin/plugin.json` stay on the same version (`tests/manifest.test.ts`); `plugin/.mcp.json` pins the major (`agent-knowledge@^3`)
- Patch bumps get no CHANGELOG entry; feature releases do

## Build & Test

```
npm run build         # tsc
npm test              # vitest (unit tests; tests/setup-home.ts gives every file a scratch HOME)
npm run check         # typecheck + lint + format + test
npm run plugin:check  # claude plugin validate + test (needs the claude CLI)
npm run dev           # watch mode (tsc --watch)

npm run e2e:claude    # builds dist-e2e/ (never the live dist/), then the real Claude Code CLI (needs a logged-in claude): the session lifecycle (lifecycle.e2e), the /knowledge pane (pane.e2e) and every MCP tool + action via claude -p (mcp.e2e), one file at a time
npm run manual:record # docs/images/manual/: the manual's stills (PNG) and flows (GIF) from the real CLI (tests/e2e-claude/manual.ts + record.ts)
```

## Key APIs

- **MCP (6 tools, all exposed to the LLM):**
  - `knowledge` — actions `list`, `read`, `write`, `delete`, `sync`, `wakeup`.
  - `knowledge_search` — hybrid general OR scoped (via `scope`); response shape `{mode, sessions, knowledge}`. v1.8 knobs: `mmr`, `mmr_lambda`, `category_mode` (default `boost`), `explain`.
  - `knowledge_session` — `list`, `get`, `summary`.
  - `knowledge_graph` — `link`, `unlink`, `invalidate`, `list`, `traverse`, `bulk_link`, `unlink_by_origin`.
  - `knowledge_analyze` — `consolidate`, `reflect`, `god_nodes`, `bridges`, `gaps`, `brief`, `search_gaps`, `stale_by_code_activity`.
  - `knowledge_admin` — `status`, `config`, `rebuild_embeddings`, `prune_orphans`, `vacuum`, `promote` (6-signal scored promoter).
- **REST** (`src/transport/rest.ts`, loopback): `GET /health`, `GET /api/overview`, `GET|POST /api/knowledge`, `GET /api/knowledge/search`, `GET|DELETE /api/knowledge/:path`, `GET /api/knowledge/:path/links` (each edge with the other end's `title`), `POST /api/knowledge/sync`, `GET /api/analysis`, `GET /api/sessions` (`{ sessions, total }`), `GET /api/sessions/search`, `GET /api/sessions/:id/summary`, `POST /api/sessions/:id/snapshot`, `GET /api/wakeup`, `GET /api/ingest`, `POST /api/events`. `POST /api/knowledge` is the agent-tasks KnowledgeBridge write; `/api/knowledge/search` the mod's (first prompt, `mmr=true`) and the opencode plugin's; snapshot, wakeup and ingest the mod's lifecycle; `POST /api/events` any host's receipt.
- **Git sync**: Auto pull/push on write, manual sync via `knowledge(action: 'sync')`

## Supported Session Sources

Sessions are auto-discovered from all installed AI coding tools via the adapter system:

- **Claude Code** -- JSONL files in `$KNOWLEDGE_DATA_DIR/projects/`
- **Cursor** -- JSONL files in `~/.cursor/projects/*/agent-transcripts/`
- **OpenCode** -- SQLite database at `~/.local/share/opencode/opencode.db` (or `$OPENCODE_DATA_DIR`)

Additional roots: `EXTRA_SESSION_ROOTS` env var (comma-separated). New tools: implement `SessionAdapter` in `src/sessions/adapters/`.

## Knowledge Base

- Entries are Markdown files with YAML frontmatter stored in `~/agent-knowledge/`
- Categories: `projects`, `people`, `decisions`, `workflows`, `notes`
- Search: hybrid semantic (embeddings) + TF-IDF with fuzzy fallback
- Session search scopes: `errors`, `plans`, `configs`, `tools`, `files`, `decisions`, `all`
- Knowledge graph: typed edges between entries (11 relationship types including calls/imports/inherits for code structure), directed BFS traversal via `knowledge_graph` (outbound/inbound/both), bulk_link for batch ingestion, unlink_by_origin for stale edge cleanup
- Confidence/decay scoring: search ranking weighted by access frequency and recency (candidate->established->proven)
- Auto-linking: `knowledge` with `action: "write"` auto-creates `related_to` edges for top-3 similar entries (cosine > 0.7)
- Confidence tagging: entries have optional `confidence: extracted|inferred` frontmatter; inferred entries get 0.85× search ranking
- Evergreen tagging (v1.8): entries with `evergreen: true` frontmatter skip decay in ranking AND are append-only under promotion
- Edge origin: graph edges track `origin` (manual/auto-link/distill/reflect/promote) for provenance
- Analysis: `knowledge_analyze` actions for god_nodes, bridges, gaps, brief
- Pre-extraction: session distillation extracts commits/errors/urls/packages via regex
- Auto-promotion (v1.8): `src/knowledge/promote.ts` replaces the regex distiller. 6-signal scored candidates, 3 gates (all must pass), `.dreams/YYYY-MM-DD.md` audit diary, grounded rehydration (skip if source session missing)

## Commit Messages

Format: `vX.Y.Z: short description`. No Co-Authored-By or AI branding.

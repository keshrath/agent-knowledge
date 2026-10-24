# agent-knowledge

## Architecture

Layered architecture — `server.ts` handles the MCP tools, `rest-server.ts` the local REST API (no web UI):

```
scripts/
  tree-sitter-extract.mjs  Standalone CLI for zero-token code structure extraction
  tree-sitter-lang.mjs     Per-language tree-sitter query definitions (8 languages)
  setup.js                 Automated setup wizard (MCP server + hooks + skill install)
  hooks/                   Claude Code lifecycle hooks
plugin/                    Claude Code plugin: .mcp.json, skills/knowledge-ingest, one mod (hooks/ = /knowledge pane)
src/
  server.ts             MCP server, 6 tool definitions, request routing
  rest-server.ts        REST server on 127.0.0.1 (startRestServer, serveRestWhenFree: leader election + takeover)
  transport/            rest.ts (routes), http.ts (json, readBody, Router), guard.ts (Host/Origin/Content-Type)
  events.ts             Live event ring (POST /api/events, read by the pane)
  index.ts              Entry point (MCP stdio; the REST holder also runs the background indexer)
  types.ts              KnowledgeConfig, getConfig(), getVersion()
  package-meta.ts       Cached name/version from package.json
  validate.ts           ValidationError class, input validation
  version.ts            Re-exports getVersion from types.ts
  knowledge/
    store.ts            Markdown CRUD, frontmatter parsing, path traversal protection
    search.ts           TF-IDF search over knowledge entries with regex fallback
    git.ts              git pull/push/sync with timeouts
    distill.ts          Session auto-distillation with secrets scrubbing
    graph.ts            Knowledge graph — edges table, link/unlink/traverse (BFS)
    scoring.ts          Confidence/decay scoring — entry_scores table, auto-promotion
    consolidate.ts      Memory consolidation — TF-IDF duplicate detection, cluster grouping
    reflect.ts          Reflection cycle — surfaces unconnected entries, generates prompts
    analyze.ts          Graph analysis — god nodes, bridges, gaps, knowledge brief
  sessions/
    parser.ts           Multi-format session parsing with mtime-based cache
    indexer.ts           Background indexing for sessions
    search.ts           TF-IDF ranked search with 60s global index cache
    scopes.ts           Search scopes (errors, plans, configs, tools, files, decisions)
    summary.ts          Session summaries, topic extraction, file path detection
    adapters/
      index.ts          SessionAdapter interface, adapter registry, auto-init
      opencode.ts       OpenCode adapter (SQLite database)
  search/
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

- **Claude Code pane** (`plugin/hooks/register.tsx` + `view.tsx`, Claude Code 2.1.289+ function hooks): `/knowledge` opens Browse, `/knowledge <words>` searches, `/knowledge <path>` opens an entry (`.md` optional) and says what it opened. Tabs (hotkeys `1`–`4`, `r` Refresh): Browse (every entry newest first, a category bar with counts, Find over title/path/tag, headed `Matches` while filtered, 25 rows a page; follows writes from other sessions on the next poll, keeping the ring on its row), Search (entries + session moments; excerpts come from `excerptText` in `src/knowledge/search.ts`: no headings, no code blocks, table rows as their cells, segments joined with `·`), Sessions (newest first; each opens a summary), Health (counts, search mode, the folder cut from the left (`clipPath`), git, Sync now with a remote, Analyze links: most linked = 2+ links and, disjoint, one link or none; recent events). An entry page: facts (dates relative up to a week, as the rows), links both ways (`→`/`←`, relation, origin, the other entry's title from the server) that open their entry, `‹` back the trail landing on the link followed, the body as Markdown (frontmatter and a title-repeating heading dropped, folds past 30 lines), Delete last, confirmed in a red box whose text depends on the git remote, scrolled into view. Server down: only Refresh; an older 1.x on the port is named. Status entry = the headline (`N entries · M sessions`, `offline`, `old server x on the port`); one toast per poll for new live events (`POST /api/events`); one `prompt.context` block. Polls `GET /api/overview` every 5 s while shown, 30 s while not. Focus: every navigation lands explicitly (`landing()`, always a button: the ring enters a text field only when the person asks for it, the Search tab or a search typed in its field, so a command typed next never lands in a field); keys name the new state (`rowKey` by category, `hitKey` by `rev`, `linkKey` by page, `foldKey`, `refreshKey` by up/down and `rev`) because the engine keeps the ring by place, not key; `awaitDrawing()` waits for a redraw through Refresh's fresh key (a button); `focusOn()` says whether the ring moved (a refused key falls back to `land()`), records `focused` (the typing header, `isField`) and marks its own moves (`ownMoves`), so a plugin-origin focus that is not one is a take (ctrl+x tab) and is sent back to `focused`; `/knowledge` opens (an open pane keeps its drawing) and lands the ring itself. Widths in terminal columns (`cols()`). REST only, through `$.http.fetch` on `AGENT_KNOWLEDGE_PORT` (default 3423). View state in `$.state` (contract `plugin/types/index.d.ts`); the render hook reads it all at once. Every function that takes `$` is a top-level declaration (`claude plugin validate`). Tests: `plugin/tests/*.test.ts` under `claude plugin test plugin` (vitest excludes `plugin/`); the real CLI in `tests/e2e-claude/` (`COVERAGE.md` maps every control to its test). Type-check with a tsconfig outside the folder (never `tsc -p plugin`, it emits .js into plugin/).
- **MCP tool results** for every other host.

## REST server

- One process serves it: the first MCP process to bind `127.0.0.1:AGENT_KNOWLEDGE_PORT`; the others retry every 5 s and take over when it exits (`serveRestWhenFree`). The holder also runs the background session indexer.
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
- `package.json`, `server.json` (top-level and package entry) and `plugin/.claude-plugin/plugin.json` stay on the same version (`tests/manifest.test.ts`); `plugin/.mcp.json` pins the major (`agent-knowledge@^2`)
- Patch bumps get no CHANGELOG entry; feature releases do

## Build & Test

```
npm run build         # tsc
npm test              # vitest (unit tests; tests/setup-home.ts gives every file a scratch HOME)
npm run check         # typecheck + lint + format + test
npm run plugin:check  # claude plugin validate + test (needs the claude CLI)
npm run dev           # watch mode (tsc --watch)

npm run e2e:claude    # the real Claude Code CLI (needs a logged-in claude): the /knowledge pane (pane.e2e) and every MCP tool + action via claude -p (mcp.e2e), one file at a time
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
- **REST** (`src/transport/rest.ts`, loopback): `GET /health`, `GET /api/overview`, `GET|POST /api/knowledge`, `GET /api/knowledge/search`, `GET|DELETE /api/knowledge/:path`, `GET /api/knowledge/:path/links` (each edge with the other end's `title`), `POST /api/knowledge/sync`, `GET /api/analysis`, `GET /api/sessions` (`{ sessions, total }`), `GET /api/sessions/search`, `GET /api/sessions/:id/summary`, `POST /api/events`. `POST /api/knowledge` is the agent-tasks KnowledgeBridge write; `/api/knowledge/search` the opencode plugin's; `POST /api/events` the sessionend hook's.
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

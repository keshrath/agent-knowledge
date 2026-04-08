# Changelog

## 1.4.1 (2026-04-08)

Documentation cleanup. No code or behavior changes vs 1.4.0.

## 1.4.0 (2026-04-08)

Seven additions focused on retrieval quality, temporal reasoning, and measurable evaluation.

### Added

- **`knowledge` action `wakeup`.** Returns a token-budgeted "L0 + L1" context blob — identity from `~/agent-knowledge/identity.md` plus the highest-weighted entries — for session-start hydration. Default budget 800 tokens. Weight = `recency × log(size+1)`. Optional `category` param narrows L1 to one category. Folded into the existing `knowledge` tool as a 6th action so the MCP surface stays at six tools.
- **Temporal validity on `knowledge_graph` edges.** New columns `valid_from` / `valid_to` (nullable, ALTER-TABLE migration is backwards compatible). New `invalidate` action sets `valid_to` without deleting the edge so history is preserved. New `as_of` parameter on `list` and `traverse` returns point-in-time snapshots — `links('projects/auth.md', undefined, '2026-02-15')` returns the assignees who were valid in February. New `isEdgeValidAt` helper.
- **Hybrid scoring boosts (`src/search/boosts.ts`).** Two boosts wired into `hybridSearch`: a proper-noun boost (capitalized non-stopword tokens in the query, max 40% score uplift) and a Gaussian temporal-proximity boost when the query mentions a date or relative time (`yesterday`, `last week`, `march 2025`, `2024`). Combined cap at +66.7%. `hasAnyBoostSignal` short-circuits when no signal is present so default behavior is unchanged.
- **`category_mode` on `knowledge_search`.** New option `'filter' | 'boost'` (default `'filter'` — backwards compatible). In `'boost'` mode, `category` becomes a 1.25× score multiplier instead of a hard WHERE filter. Use `'boost'` when you might be wrong about the category — hard filters silently discard the right answer when the metadata doesn't match.
- **`indexVerbatim` config flag.** Toggle verbatim per-message session indexing via `KNOWLEDGE_INDEX_VERBATIM` env var or persisted config. Default `true`. Indexer now drops messages shorter than 30 chars (low-signal acks).
- **PreCompact / Stop hook.** New `scripts/hooks/precompact-flush.mjs` — reads hook JSON from stdin, dynamic-imports `dist/sessions/summary.js`, writes a flushed session summary to `~/agent-knowledge/sessions/<project>/<event>-<stamp>-<sid>.md` so distillation has an anchor when the host compacts the conversation. Fail-open. Wire-up snippet for Claude Code `settings.json` is in the file header. Not auto-installed.
- **Benchmark suite (`bench/`).** Two runners: a small smoke benchmark over `~/agent-knowledge/` (22 hand-authored fixtures) and a full LongMemEval runner (`bench/longmemeval.ts`) against the public Wu et al. 2024 dataset. The LongMemEval runner supports `--raw`, `--boosts`, `--semantic`, and `--hybrid` modes and prints per-question-type breakdowns. `npm run bench` (uses `tsx`).

### Tests

- New e2e suite `tests/e2e/v14-features.e2e.test.ts` (10 tests): wakeup default identity, wakeup with `identity.md`, token-budget truncation, scope filter, `categoryMode` filter vs boost behavior, full KG temporal lifecycle (link → list as_of → invalidate → list as_of), `graph()` traversal with `as_of`, weight-based L1 ordering.
- New unit suite `tests/boosts.test.ts` (14 tests): proper-noun extraction (stopword filtering, dedup), boost ramp, temporal reference parsing, Gaussian decay, combined-boost cap.
- Extended `tests/graph.test.ts` with 9 temporal cases.
- **Total: 390 tests passing**, up from 352.

### Internal

- `chunkSession` accepts an options object alongside the legacy `maxChars` number for backwards compatibility.
- Version bumped across `package.json`, `server.json`, `agent-desk-plugin.json`.

## 1.3.27 (2026-04-08)

### Added

- **`knowledge_admin` actions `prune_orphans` and `vacuum`.** Prune deletes embeddings for sessions that no longer exist on disk (compares `listSessions()` against `SELECT DISTINCT source_id FROM embeddings WHERE source='session'`); auto-VACUUMs after pruning unless disabled. Standalone `vacuum` action reclaims free pages independently. New methods on `VectorStore`: `listIndexedSessionIds`, `pruneOrphanSessions`, `vacuum`. Live cleanup on the dev DB pruned 121 orphan sessions (69364 chunks) and reclaimed 352.4 MB (793 → 441 MB).

### Fixed

- **Sessions header counter showed loaded-page count, not total.** `/api/sessions` now returns `{sessions, total}` when `limit`/`offset` is set; the dashboard header stat uses `total` so it stays at the true session count instead of growing as you scroll.

## 1.3.26 (2026-04-08)

### Fixed

- **Session detail panel showed `unknown / unknown` for cwd + branch** while the session card correctly showed the project + branch. The `getSessionMeta` parser used `entries[0]` directly, which on Claude Code sessions is a metadata-only entry (`permission-mode`, `file-history-snapshot`, …) without `timestamp` / `cwd` / `gitBranch`. Now skips leading metadata entries and uses the first entry that has a top-level `timestamp` — mirrors the existing fix in `fastMeta()`. The two code paths used to disagree.

## 1.3.25 (2026-04-08)

### Documentation

- Self-documenting release: documents this version + retroactively records the 1.3.24 release whose payload was the 1.3.18 – 1.3.23 backfill.

## 1.3.23 (2026-04-08)

### Fixed

- **Standalone dashboard stuck on "Connecting to agent-knowledge..." overlay.** Removed `<script src="template.js">` from `src/ui/index.html`. Since v1.3.9 the standalone autoinit guard in `app.js` (`if (typeof K._template !== 'function')`) was always false because `template.js` was loaded in standalone mode, so `init()` never ran and the loading overlay never hid. `template.js` is only needed by the plugin host (loaded via `agent-desk-plugin.json` `uiFiles`); standalone has the markup hardcoded in the HTML and doesn't need the runtime template.

## 1.3.22 (2026-04-08)

### Fixed

- **Build broken: `createRateLimiter` no longer exported by `agent-common`.** Inlined a minimal token-bucket rate limiter in `src/dashboard.ts` (keyed by remote IP, named `default` + `heavy` windows) to replace the missing import. Resolves the TS2305 build error and re-greens the failing `tests/dashboard.test.ts` file. Vitest count back to 352.

### Added

- **Playwright E2E dashboard test suite** at `tests/e2e-ui/dashboard.pw.ts`. Boots the standalone dashboard with a temp `KNOWLEDGE_MEMORY_DIR` / `KNOWLEDGE_DATA_DIR` so the real `~/agent-knowledge/` is never touched. Seeds three markdown entries, then asserts: page loads with no console errors, REST `/api/knowledge` returns the seeded entries, REST `/api/knowledge/search?q=…` returns results, the search input renders + accepts a query without errors. Runnable via `npm run test:e2e:ui`. Devdep `@playwright/test`.

## 1.3.21 (2026-04-08)

### Changed

- Adopted `createRateLimiter` from agent-common 1.1.0 in place of the local rate-limiter implementation. (Subsequently reverted in 1.3.22 after agent-common dropped the export.)

## 1.3.20 (2026-04-08)

### Changed

- `dashboard.ts` refactored to use `agent-common` helpers (`createRouter`, `json`, `serveStatic`, `setupWebSocket`). Version-file bumps in a follow-up commit.

## 1.3.19 (2026-04-08)

### Fixed

- Raised timeout on the flaky session-search tests for slow CI runners.

## 1.3.18 (2026-04-08)

### Changed

- Added `agent-common` as a dependency for package metadata.

## 1.3.17 (2026-04-07)

### Changed

- **Doc rewrites for post-consolidation tool surface.** Updated `README.md`, `CLAUDE.md`, `docs/ARCHITECTURE.md`, and `docs/SETUP.md` to use the current action-based tool form (`knowledge { action: "write" }`) instead of references to the obsolete per-action tool names (`knowledge_write`, `knowledge_read`, `knowledge_list`, `knowledge_delete`, `knowledge_sync`, `knowledge_recall`). The README's tool table at the top was already correct; this fixes the deeper docs.

### Added

- **Host auto-detect expanded.** `src/types.ts` now auto-detects projects directories from all five well-known AI coding host roots: `.claude`, `.cursor`, `.codex`, `.aider`, `.continue` (was just `.claude` and `.cursor`). Aligned with the host-agnostic Genericity rule.

### Fixed

- All three version files (`package.json`, `server.json`, `agent-desk-plugin.json`) re-aligned to **1.3.17**. They had silently drifted: package was at 1.3.16, server was at 1.3.15 (with the inner package version even older at 1.3.14), and agent-desk-plugin was at 1.3.15.

## 1.3.1 (2026-03-30)

### Changed

- **DRY constants** — `CATEGORIES` now defined once in `knowledge/store.ts`, imported by `tool-handlers.ts` and `server.ts`
- **Type-safe session parsing** — extracted `extractText()` helper in `parser.ts`, replacing 3 repeated unsafe `as unknown[]` cast blocks with a single type-guarded function
- **Stale doc fix** — CLAUDE.md `knowledge_sync` → `knowledge(action: 'sync')`

## 1.3.0 (2026-03-29)

### Further Tool Consolidation (11 → 6)

Reduced MCP tool count from 11 to 6 by merging remaining individual tools into action-based interfaces.

- **`knowledge`** (was 5 tools: `knowledge_list`, `knowledge_read`, `knowledge_write`, `knowledge_delete`, `knowledge_sync`) — actions: `list`, `read`, `write`, `delete`, `sync`
- **`knowledge_search`** now handles scoped recall too — when `scope` is provided (errors, plans, configs, tools, files, decisions), behaves as the former `knowledge_recall`

### MCP Tools (6)

**Knowledge (1):** `knowledge` (actions: list, read, write, delete, sync)

**Search (1):** `knowledge_search` (general search + scoped recall via `scope` param)

**Sessions (1):** `knowledge_session` (actions: list, get, summary)

**Knowledge Graph (1):** `knowledge_graph` (actions: link, unlink, list, traverse)

**Analysis (1):** `knowledge_analyze` (actions: consolidate, reflect)

**Admin (1):** `knowledge_admin` (actions: status, config)

## 1.3.0 (2026-03-29)

### Tool Consolidation (18 → 11)

Reduced MCP tool count from 18 to 11 by merging related tools into action-based interfaces. All functionality is preserved — tools are routed by the `action` parameter.

- **`knowledge_graph`** (was 4 tools: `knowledge_link`, `knowledge_unlink`, `knowledge_links`, `knowledge_graph`) — actions: `link`, `unlink`, `list`, `traverse`
- **`knowledge_session`** (was 3 tools: `knowledge_sessions`, `knowledge_get`, `knowledge_summary`) — actions: `list`, `get`, `summary`
- **`knowledge_analyze`** (was 2 tools: `knowledge_consolidate`, `knowledge_reflect`) — actions: `consolidate`, `reflect`
- **`knowledge_admin`** (was 2 tools: `knowledge_index_status`, `knowledge_config`) — actions: `status`, `config`

### MCP Tools (11)

**Knowledge (5):** `knowledge_list`, `knowledge_read`, `knowledge_write`, `knowledge_delete`, `knowledge_sync`

**Knowledge Graph (1):** `knowledge_graph` (actions: link, unlink, list, traverse)

**Sessions (3):** `knowledge_session` (actions: list, get, summary), `knowledge_search`, `knowledge_recall`

**Analysis (1):** `knowledge_analyze` (actions: consolidate, reflect)

**Admin (1):** `knowledge_admin` (actions: status, config)

## 1.3.0 (2026-03-29)

### Memory Consolidation / Dedup

`knowledge_write` now checks for near-duplicate entries using TF-IDF similarity after writing. If any existing entry exceeds a 0.6 similarity threshold, a warning is included in the response with paths and scores.

- **`knowledge_analyze(action: "consolidate")`** — scans entries in a category (or all), groups near-duplicates into clusters using TF-IDF similarity > 0.5 (configurable), returns clusters with pairwise similarity scores. Read-only analysis.
- **Dashboard**: "Duplicates" button in Knowledge tab header triggers consolidation scan. Entries in duplicate clusters show a warning icon. Clicking opens a panel with cluster details and similarity scores.

### Reflection Cycle

- **`knowledge_analyze(action: "reflect")`** — finds knowledge entries with zero graph edges and prepares a structured prompt for the agent's LLM to identify new connections. Returns unconnected entries with content summaries, connected entries as potential link targets, and a ready-to-use prompt.
- Does NOT call an LLM itself — the agent processes the prompt and calls `knowledge_graph(action: "link")` based on the analysis.
- **Dashboard**: "Reflect" button in Knowledge tab header shows unconnected entries in a panel with summaries and suggested instructions.

### MCP Tools (11)

**Knowledge (5):** `knowledge_list`, `knowledge_read`, `knowledge_write`, `knowledge_delete`, `knowledge_sync`

**Knowledge Graph (1):** `knowledge_graph` (actions: link, unlink, list, traverse)

**Sessions (3):** `knowledge_session` (actions: list, get, summary), `knowledge_search`, `knowledge_recall`

**Analysis (1):** `knowledge_analyze` (actions: consolidate, reflect)

**Admin (1):** `knowledge_admin` (actions: status, config)

## 1.2.0 (2026-03-29)

### Knowledge Graph

New relationship layer for connecting knowledge entries. Edges are stored in a dedicated `edges` SQLite table with 8 typed relationships: `related_to`, `supersedes`, `depends_on`, `contradicts`, `specializes`, `part_of`, `alternative_to`, `builds_on`.

- **`knowledge_graph(action: "link")`** — create or update a weighted edge between two entries
- **`knowledge_graph(action: "unlink")`** — remove edges (optionally filtered by relationship type)
- **`knowledge_graph(action: "list")`** — list edges for an entry or relationship type
- **`knowledge_graph(action: "traverse")`** — BFS traversal from a starting entry to configurable depth
- **`knowledge_read`** now shows related entries alongside content

### Confidence & Decay Scoring

New `entry_scores` SQLite table tracks access frequency and recency. Search results are ranked using:

```
finalScore = baseRelevance * 0.5^(daysSinceLastAccess / 90) * maturityMultiplier
```

- **Auto-promotion**: entries mature from candidate (0.5x) to established (1.0x) at 5 accesses, then to proven (1.5x) at 20 accesses
- Frequently accessed entries rise in rankings; stale entries decay over time

### Auto-linking on Write

`knowledge_write` now automatically finds the top-3 most similar existing entries via cosine similarity and creates `related_to` edges for any pair scoring above 0.7. This builds the knowledge graph organically as entries are added.

### MCP Tools (11)

**Knowledge (5):** `knowledge_list`, `knowledge_read`, `knowledge_write`, `knowledge_delete`, `knowledge_sync`

**Knowledge Graph (1):** `knowledge_graph` (actions: link, unlink, list, traverse)

**Sessions (3):** `knowledge_session` (actions: list, get, summary), `knowledge_search`, `knowledge_recall`

**Admin (1):** `knowledge_admin` (actions: status, config)

## 1.1.1 (2026-03-28)

### Bug Fixes

- **Session discovery**: auto-detect `~/.claude/projects` as extra session root so Claude Code sessions are found without requiring `KNOWLEDGE_DATA_DIR` env var (regression from v1.1.0 generic naming refactor)

### Features

- **Dashboard**: clicking a search result now scrolls to and highlights the matching message in the session panel

### Documentation

- **Windows**: added note about C++ build tools requirement for `better-sqlite3` when prebuilt binaries are unavailable (e.g. Node 24+)

## 1.1.0 (2026-03-27)

### Multi-Source Session Adapters

agent-knowledge now auto-discovers and reads sessions from all major AI coding assistants. If a tool is installed, its sessions appear automatically in the dashboard and search results -- no configuration required.

- **New adapters**: OpenCode (SQLite), Cline (JSON), Continue.dev (JSON), Aider (Markdown/JSONL)
- **Auto-detection**: Cursor sessions discovered from `~/.cursor/projects/*/agent-transcripts/`; OpenCode from `~/.local/share/opencode/opencode.db`; Cline from VS Code globalStorage; Continue.dev from `~/.continue/sessions/`; Aider from `.aider.chat.history.md` / `.aider.llm.history` in project dirs
- **Adapter interface**: pluggable `SessionAdapter` with `isAvailable()`, `discoverProjects()`, `listSessions()`, `parseSession()` -- add new tools by implementing one file
- **`EXTRA_SESSION_ROOTS` env var**: comma-separated paths for additional session directories
- **`OPENCODE_DATA_DIR` env var**: override OpenCode data location (default `~/.local/share/opencode`)

### Generic Naming Refactor

Removed Claude Code-specific language throughout. agent-knowledge is now fully client-agnostic.

- **Config fields renamed**: `claudeDir` -> `dataDir`, `projectsDir` -> `sessionsDir`
- **Env vars renamed**:
  - `KNOWLEDGE_DATA_DIR` (was `CLAUDE_DIR`)
  - `KNOWLEDGE_ANTHROPIC_API_KEY` (was `KNOWLEDGE_CLAUDE_API_KEY`)
- **Default memory directory**: `~/agent-knowledge`
- **Embedding class renamed**: `ClaudeEmbeddingProvider` -> `AnthropicEmbeddingProvider`
- **Documentation**: all references updated to use generic "agent sessions" language, architecture diagrams show "Session Data Dir" instead of `~/.claude/projects`

## 1.0.0 (2026-03-26)

Initial release.

### MCP Tools (11)

**Knowledge (5):** `knowledge_list`, `knowledge_read`, `knowledge_write`, `knowledge_delete`, `knowledge_sync`

**Sessions (3):** `knowledge_session` (actions: list, get, summary), `knowledge_search`, `knowledge_recall`

**Admin (1):** `knowledge_admin` (actions: status, config)

### Search Engine

- Hybrid semantic + TF-IDF search with configurable alpha blending
- Recency decay weighting (newer sessions rank higher)
- Fuzzy matching via Levenshtein distance
- 6 recall scopes: errors, plans, configs, tools, files, decisions
- Role-based filtering (all, user, assistant)
- Regex mode for pattern-based searches

### Embeddings & Vector Store

- SQLite vector store with sqlite-vec for cosine similarity
- 4 embedding providers: local (Hugging Face), OpenAI, Claude/Voyage, Gemini
- Background indexer runs on server startup
- Automatic provider switching with dimension migration

### Knowledge Base

- Git-synced markdown vault at `~/agent-knowledge/` (previously `~/claude-memory/`)
- 5 categories: projects, people, decisions, workflows, notes
- YAML frontmatter for metadata (title, tags, updated)
- Auto git commit + push on writes, pull on reads
- Configurable git URL via `knowledge_admin(action: "config")` tool or `KNOWLEDGE_GIT_URL` env var
- New repos auto-scaffolded with README, .gitignore, and category dirs

### Auto-Distillation

- Automatic extraction of session insights into knowledge base
- Project name normalization (worktrees, swarms merged into parent)
- Secrets scrubbing: API keys, tokens, passwords, JWTs, private keys redacted
- System noise stripped (XML tags, task notifications)
- Absolute paths normalized to `~/`
- Defense-in-depth audit blocks writes with surviving sensitive content

### Persistent Configuration

- `knowledge_admin(action: "config")` for runtime setup (no restart needed)
- Config stored at XDG/AppData location (tool-agnostic)
- Priority: env vars > persisted config > defaults

### Web Dashboard

- http://localhost:3423, auto-starts with MCP server
- 5 tabs: Knowledge, Search, Sessions, Recall, Embeddings
- MD3 design language matching agent-comm and agent-tasks
- Light/dark theme with localStorage persistence
- Side panel (560px, resizable) with markdown rendering
- Live reload via file watcher + WebSocket
- Semantic search toggle with score breakdown

### Performance

- Session file mtime cache (re-parses only changed files)
- Global TF-IDF index cache with 60s TTL
- Background embedding indexer (non-blocking)

### Infrastructure

- REST API: 10 endpoints (knowledge, sessions, search, recall, index-status, health)
- WebSocket server for real-time dashboard updates
- 280 tests passing (vitest)
- TypeScript strict mode, ES modules
- GitHub Actions CI (Node 20/22 matrix, npm publish on tags)

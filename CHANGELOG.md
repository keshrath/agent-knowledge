# Changelog

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

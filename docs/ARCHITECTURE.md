# Architecture

## Overview

```mermaid
graph TB
    Agent[Agent Session] -->|MCP stdio| Server[server.ts]
    Server --> Knowledge[Knowledge Module]
    Server --> Session[Session Module]

    Knowledge --> Store[store.ts — CRUD]
    Knowledge --> KSearch[search.ts — TF-IDF]
    Knowledge --> Git[git.ts — Sync]

    Store --> Vault[(~/agent-knowledge)]
    Git --> Remote[(Git Remote)]

    Session --> Parser[parser.ts — Multi-format + Cache]
    Session --> Adapters[adapters/ — Auto-discovery]
    Session --> SSearch[search.ts — TF-IDF Index]
    Session --> Scopes[scopes.ts — 6 Filters]
    Session --> Summary[summary.ts]

    Parser --> Transcripts[(Claude Code / Cursor<br/>JSONL)]
    Adapters --> OpenCode[(OpenCode<br/>SQLite)]
    Adapters --> Cline[(Cline<br/>JSON)]
    Adapters --> ContinueDev[(Continue.dev<br/>JSON)]
    Adapters --> Aider[(Aider<br/>MD / JSONL)]

    Server --> Dashboard[dashboard.ts — :3423]
    Dashboard --> HTTP[REST API]
    Dashboard --> WS[WebSocket]
    Dashboard --> Watcher[File Watcher]
    HTTP --> Browser[Browser UI]
    WS --> Browser
```

## File Structure

```
src/
  index.ts              Entry point — MCP stdio + dashboard auto-start
  server.ts             6 tool definitions, request routing, error handling
  dashboard.ts          HTTP + WebSocket server, REST API, file watcher
  package-meta.ts       Cached name/version from package.json (used by getVersion / MCP / dashboard)
  types.ts              KnowledgeConfig interface, getConfig(), getVersion()
  knowledge/
    store.ts            CRUD for markdown entries with YAML frontmatter
    search.ts           TF-IDF search over knowledge entries
    git.ts              git pull/push/sync with execSync + timeouts
    graph.ts            Knowledge graph — edges table, link/unlink/BFS traversal
    scoring.ts          Confidence/decay scoring — entry_scores table, auto-promotion
    consolidate.ts      Memory consolidation — TF-IDF duplicate detection, cluster grouping
    reflect.ts          Reflection cycle — surfaces unconnected entries, generates prompts
    analyze.ts          Graph analysis — god nodes, bridges, gaps, knowledge brief (deterministic, no LLM)
  sessions/
    parser.ts           Multi-format parsing with mtime cache + adapter dispatch
    search.ts           TF-IDF ranked search with 60s global index cache
    scopes.ts           6 search scopes, post-filters cached index results
    summary.ts          Topic extraction, tool/file detection
    adapters/
      index.ts          SessionAdapter interface, adapter registry, initAdapters()
      opencode.ts       OpenCode adapter — reads SQLite database (better-sqlite3)
      cline.ts          Cline adapter — reads VS Code globalStorage JSON tasks
      continue.ts       Continue.dev adapter — reads JSON session files
      aider.ts          Aider adapter — parses markdown chat + JSONL LLM history
  search/
    tfidf.ts            TF-IDF scoring engine (tokenizer, stopwords, index)
    fuzzy.ts            Levenshtein distance, sliding window matching
    types.ts            SearchResult, SearchOptions interfaces
  ui/
    index.html          Dashboard SPA
    styles.css           MD3 design tokens (light + dark)
    app.js              Client-side JS (WebSocket, tabs, rendering)
```

## Knowledge Module

### store.ts

CRUD for markdown files with YAML frontmatter:

- **parseFrontmatter()** — splits on `---` delimiters, extracts title/tags/updated
- **listEntries()** — recursively finds `.md` files, skips dot-directories, filters by category/tag
- **readEntry()** — reads file with path traversal protection (`path.resolve` must start with base dir)
- **writeEntry()** — validates category against allowed list, ensures directory exists, auto-adds `.md`
- **deleteEntry()** — removes file with path traversal protection

### git.ts

Wraps `execSync` for git operations with timeouts:

- `gitPull()` — `git pull --rebase --quiet` (15s timeout)
- `gitPush()` — `git add -A`, conditional commit (checks `git diff --cached --quiet`), push (5s/5s/15s)
- `gitSync()` — pull then push, returns both results

### search.ts

Builds a TF-IDF index from all knowledge entries, searches with ranking, falls back to regex for exact phrases.

## Knowledge Graph

### graph.ts

Manages typed, weighted edges between knowledge entries in a dedicated `edges` SQLite table.

**Schema**:

```sql
CREATE TABLE edges (
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  rel_type TEXT NOT NULL,
  strength REAL DEFAULT 1.0,
  created TEXT NOT NULL,
  PRIMARY KEY (source, target, rel_type)
);
```

**8 relationship types**: `related_to`, `supersedes`, `depends_on`, `contradicts`, `specializes`, `part_of`, `alternative_to`, `builds_on`.

**Operations**:

- **link()** — upsert an edge (INSERT OR REPLACE), validates rel_type against allowed set
- **unlink()** — delete edges, optionally filtered by rel_type
- **links()** — list edges for a given entry or rel_type
- **traverse()** — BFS from a starting entry to configurable depth, returns nodes and edges visited

All four operations are exposed via the single `knowledge_graph` tool with an `action` parameter (`link`, `unlink`, `list`, `traverse`).

**Auto-linking**: On `knowledge { action: "write" }`, the top-3 most similar existing entries are found via cosine similarity against the vector store. Entries with similarity > 0.7 get automatic `related_to` edges created.

## Confidence & Decay Scoring

### scoring.ts

Tracks access frequency and recency for search result ranking via an `entry_scores` SQLite table.

**Schema**:

```sql
CREATE TABLE entry_scores (
  path TEXT PRIMARY KEY,
  access_count INTEGER DEFAULT 0,
  last_accessed TEXT NOT NULL,
  maturity TEXT DEFAULT 'candidate'
);
```

**Scoring formula**:

```
finalScore = baseRelevance * 0.5^(daysSinceLastAccess / 90) * maturityMultiplier
```

**Maturity auto-promotion**:

| Stage         | Accesses | Multiplier |
| ------------- | -------- | ---------- |
| `candidate`   | < 5      | 0.5x       |
| `established` | 5-19     | 1.0x       |
| `proven`      | 20+      | 1.5x       |

Access count increments on `knowledge { action: "read" }`. Maturity transitions happen automatically when thresholds are crossed. Search results from `knowledge_search` apply the decay formula to blend relevance with freshness and confidence.

## Memory Consolidation

### consolidate.ts

Detects near-duplicate knowledge entries using TF-IDF similarity scoring.

**`checkDuplicates()`** — called after `knowledge { action: "write" }`. Builds a TF-IDF index from all entries, queries with the written content, and returns entries exceeding a configurable similarity threshold (default: 0.6). Warnings are included in the write response.

**`consolidate()`** — batch scan for `knowledge_consolidate`. Computes pairwise TF-IDF similarities for all entries in a category (or globally), groups entries above threshold (default: 0.5) into clusters using union-find, and returns clusters with representative entries and pairwise similarity scores.

## Reflection Cycle

### reflect.ts

Surfaces unconnected knowledge entries and prepares structured prompts for agent-driven graph enrichment.

**`reflect()`** — reads all entries, queries the knowledge graph for edges, identifies entries with zero connections, and generates a structured markdown prompt listing:

1. Unconnected entries with titles, categories, tags, and 300-char content summaries
2. Connected entries as potential link targets
3. Instructions for the agent to call `knowledge_link` with suggested relationships

Does NOT call an LLM — the calling agent processes the prompt in its own context and makes `knowledge_graph(action: "link")` calls based on its analysis.

## Knowledge Analysis

### analyze.ts

Deterministic graph analysis — no LLM calls. Exposes four entry points under the `knowledge_analyze` MCP tool:

- **`godNodes(top_n)`** — ranks entries by degree centrality (number of incoming + outgoing edges). Entries that are auto-distilled and only have `auto-link` origin edges are excluded as noise. Returns `{ path, title, category, degree, confidence }`.
- **`bridges(top_n)`** — ranks entries by betweenness centrality, filtering to those connecting at least 2 different categories. Returns `{ path, title, betweenness, connects, why }` where `connects` is the list of bridged categories and `why` is a short explanation string.
- **`gaps(max_entries)`** — entries with 0-1 graph edges, sorted `proven` first (most concerning), then by degree ascending. Returns `{ path, title, category, degree, maturity, daysSinceAccess }`.
- **`generateBrief()`** — produces a compact (~200 token) plain-text summary of the knowledge base state: total entries/edges, core concepts (top god nodes), active projects (accessed in last 30 days), recent decisions, stale count, gap count. Cached for 1 hour in-memory; cache invalidated on any `write`/`delete`/`link`/`unlink` operation.

## Confidence Metadata

Entries may carry two optional frontmatter fields:

- `confidence: extracted | inferred` — whether the entry was written by a human/agent (`extracted`, the default) or derived automatically by session distillation (`inferred`).
- `confidence_score: 0.0-1.0` — numeric certainty from the extractor.

Search ranking in `computeFinalScore()` applies a **0.85× multiplier to `inferred` entries** so explicit user knowledge ranks above auto-derived insights when relevance is otherwise equal. The `extracted` default means manually-authored entries keep their full score.

## Edge Provenance

The `edges` table has an additional `origin TEXT NOT NULL DEFAULT 'manual'` column tracking how each edge was created:

| Origin      | Source                                                                    |
| ----------- | ------------------------------------------------------------------------- |
| `manual`    | User/agent-initiated `knowledge_graph(action: "link")` call               |
| `auto-link` | Cosine similarity > 0.7 match created during `knowledge(action: "write")` |
| `distill`   | Session distillation linking newly distilled entries                      |
| `reflect`   | Analysis cycle creating suggested connections                             |

`analyze.ts` uses the `origin` column to exclude auto-link-only distilled entries from god-node results. Migration is non-destructive — pre-existing edges default to `manual`.

## Session Module

### Multi-Source Architecture

Sessions are read from multiple AI coding tools through two mechanisms:

1. **Direct parsing** -- Claude Code and Cursor sessions use JSONL files read directly by `parser.ts`. Claude Code sessions come from the primary data directory (`$KNOWLEDGE_DATA_DIR/projects/`). Cursor sessions are auto-discovered from `~/.cursor/projects/*/agent-transcripts/`.

2. **Adapter dispatch** -- Other tools (OpenCode, Cline, Continue.dev, Aider) use the pluggable adapter system in `adapters/`. When `parseSessionFile()` receives a virtual descriptor (e.g. `opencode://session:abc`), it dispatches to the matching adapter.

```
parseSessionFile(path)
  → for each registered adapter:
      if path starts with `<adapter.prefix>://` → adapter.parseSession(path)
  → else: standard JSONL parsing with mtime cache
```

### Session Adapters

The adapter system (`src/sessions/adapters/`) provides a uniform interface for reading sessions from different tools:

```typescript
interface SessionAdapter {
  prefix: string;                    // Virtual descriptor prefix (e.g. "opencode")
  name: string;                      // Human-readable name
  isAvailable(): boolean;            // Is the tool installed?
  discoverProjects(): Array<{...}>;  // Find projects/groups
  listSessions(desc: string): Array<{...}>;  // List sessions in a project
  parseSession(desc: string): SessionEntry[];  // Parse into normalized entries
}
```

Adapters are registered at startup via `initAdapters()`, which dynamically imports each adapter module. `getAvailableAdapters()` returns only adapters whose `isAvailable()` returns true (the tool is installed).

| Adapter      | Storage                                         | Detection                                                                |
| ------------ | ----------------------------------------------- | ------------------------------------------------------------------------ |
| OpenCode     | SQLite (`opencode.db`)                          | Checks `$OPENCODE_DATA_DIR` or `~/.local/share/opencode/`                |
| Cline        | JSON files in VS Code globalStorage             | Platform-aware path to `saoudrizwan.claude-dev/tasks/`                   |
| Continue.dev | JSON files in `~/.continue/sessions/`           | Checks directory existence                                               |
| Aider        | `.aider.chat.history.md` + `.aider.llm.history` | Scans `~/projects`, `~/code`, `~/dev`, `~/src`, `~/repos`, `~/workspace` |

### parser.ts — Mtime Cache

For JSONL-based sessions (Claude Code, Cursor), the parser checks `fs.statSync` for mtime before parsing. If unchanged since last parse, returns cached result. This avoids re-parsing large transcript files on every search.

```
parseSessionFile(path)
  → if virtual descriptor → dispatch to adapter
  → statSync(path).mtimeMs
  → if mtime matches cache → return cached entries
  → else parse JSONL lines → cache with mtime → return
```

### search.ts — Global TF-IDF Index

Maintains a single TF-IDF index across all sessions with a 60-second TTL:

```
getOrBuildIndex(projects)
  → if cache exists AND age < 60s → return cached index
  → else scan all sessions → parse (using mtime cache) → index all messages → cache → return
```

Role filtering happens post-search: the index includes all roles, and results are filtered after scoring.

### scopes.ts

Uses the cached search index from `search.ts` (via `searchSessions`), then post-filters by scope patterns:

| Scope       | Filter                                                          |
| ----------- | --------------------------------------------------------------- |
| `errors`    | Regex: Error, Exception, failed, crash, ENOENT, TypeError, etc. |
| `plans`     | Regex: plan, step, phase, strategy, TODO, architecture, etc.    |
| `configs`   | Regex: config, .env, .json, tsconfig, docker, etc.              |
| `tools`     | Role filter: tool_use, tool_result messages only                |
| `files`     | Regex: src/, .ts, .js, created, modified, deleted, etc.         |
| `decisions` | Regex: decided, chose, because, tradeoff, opted for, etc.       |

### summary.ts

Extracts session summaries:

- **Topics**: user messages filtered to exclude JSON/tool_result/base64/system-reminders
- **Tools used**: tool names from tool_use entries
- **Files modified**: file paths detected via regex in tool_result content

## Search Engine

### tfidf.ts

Self-contained TF-IDF implementation:

**Tokenization**: lowercase → split on `[^a-z0-9]+` → remove ~100 English stopwords

**Scoring**:

```
TF(t, d)  = count(t in d) / total_terms(d)
IDF(t)    = log(1 + N / docs_containing(t))
Score(q, d) = sum(TF(t, d) * IDF(t)) for each term t in query q
```

The `1 +` in IDF ensures single-document results still get a positive score.

### fuzzy.ts

Levenshtein edit distance with two-row DP (O(n\*m) time, O(m) space). Fuzzy matching uses a sliding window of varying size to find approximate substring matches.

## Dashboard

### dashboard.ts

Single HTTP server handles REST API, write endpoint, and static files:

- **Static serving**: resolves UI directory (checks `src/ui/` then `dist/ui/`), serves with MIME detection and CSP headers
- **REST API (GET)**: routes for knowledge search, session list/search/recall/get/summary, health, graph analysis
- **REST API (POST)**: `POST /api/knowledge` — write entry with full pipeline (git pull, write, embed, auto-link, git push). POST restricted to `/api/` paths.
- **WebSocket**: `ws` library with `noServer` mode, heartbeat every 30s, initial state snapshot on connect
- **File watcher**: `fs.watch` on UI directory, debounced 200ms, broadcasts `{type: "reload"}` to all WS clients

### UI Architecture

Vanilla JS SPA (no framework, no build step):

- WebSocket connects on load, handles `state` and `reload` messages
- 4 tabs with lazy data loading
- `marked` + `DOMPurify` + `highlight.js` for markdown rendering
- Theme persisted in `localStorage('agent-knowledge-theme')`

## Caching Strategy

```
Search Request
    │
    ▼
┌─────────────────────┐
│ TF-IDF index < 60s? │──Yes──► Search cached index (~40ms)
└─────────────────────┘
    │ No
    ▼
┌─────────────────────┐
│ Scan session files  │
│ Check mtime cache   │──► Parse only changed files
└─────────────────────┘
    │
    ▼
┌─────────────────────┐
│ Rebuild index       │──► Cache with 60s TTL (~5s cold)
└─────────────────────┘
    │
    ▼
  Search new index
```

## Data Flow

### Session Search

```mermaid
sequenceDiagram
    participant C as Agent Session
    participant S as MCP Server
    participant I as TF-IDF Index
    participant P as Parser Cache
    participant A as Session Adapters
    participant F as File System

    C->>S: knowledge_search({ query })
    S->>I: search(query)
    alt Index expired
        I->>F: List JSONL files (Claude Code, Cursor)
        I->>A: Discover sessions (OpenCode, Cline, Continue.dev, Aider)
        loop Each JSONL file
            alt Mtime changed
                I->>P: parse(file)
                P->>F: Read JSONL
                P-->>I: Parsed entries
            else Mtime unchanged
                I->>P: getCached(file)
                P-->>I: Cached entries
            end
        end
        loop Each adapter session
            I->>A: parseSession(descriptor)
            A-->>I: Normalized entries
        end
        I->>I: Rebuild index
    end
    I-->>S: Ranked results
    S-->>C: SearchResult[]
```

### Knowledge Write

Two write paths exist — MCP (stdio) and REST (HTTP). Both run the same pipeline.

```mermaid
sequenceDiagram
    participant C as Agent Session
    participant S as MCP Server
    participant D as Dashboard (REST)
    participant G as Git
    participant F as File System
    participant V as Vector Store

    C->>S: knowledge({ action: "write", category, filename, content })
    Note over D: OR: POST /api/knowledge { category, filename, content }
    S->>G: git pull --rebase
    S->>F: Write markdown file
    S->>V: Index embeddings + auto-link (cosine > 0.7)
    S->>G: git add -A && commit && push
    G-->>S: Push result
    S-->>C: { path, autoLinks, duplicateWarnings, git }
```

The REST `POST /api/knowledge` endpoint enables HTTP-based writes from other services (e.g. agent-tasks KnowledgeBridge) without an MCP connection.

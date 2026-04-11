# agent-knowledge User Manual

## Table of Contents

1. [Overview](#1-overview)
2. [Installation](#2-installation)
3. [Configuration](#3-configuration)
4. [Dashboard Guide](#4-dashboard-guide)
5. [MCP Tools Reference](#5-mcp-tools-reference)
6. [REST API Reference](#6-rest-api-reference)
7. [Knowledge Base Management](#7-knowledge-base-management)
8. [Session Search](#8-session-search)
9. [Troubleshooting](#9-troubleshooting)
10. [FAQ](#10-faq)

---

## 1. Overview

### What agent-knowledge Does

agent-knowledge is an MCP (Model Context Protocol) server that provides cross-session memory and recall for AI coding agents. It combines a git-synced knowledge base with session search, knowledge graphs, and hybrid semantic+TF-IDF search:

- **Knowledge base** -- Markdown files with YAML frontmatter stored in a git repository. Categories: `projects`, `people`, `decisions`, `workflows`, `notes`.
- **Git sync** -- automatic pull before reads, push after writes. Knowledge persists across machines.
- **Hybrid search** -- combines semantic vector similarity (via embeddings) with TF-IDF scoring for accurate retrieval.
- **Session search** -- search across past AI coding sessions from Claude Code, Cursor, and OpenCode.
- **Scoped recall** -- targeted search within domains: `errors`, `plans`, `configs`, `tools`, `files`, `decisions`.
- **Knowledge graph** -- typed edges between entries (8 relationship types) with BFS traversal.
- **Confidence scoring** -- entries gain maturity (`candidate` > `established` > `proven`) based on access frequency.
- **Auto-linking** -- new entries are automatically linked to similar existing entries via cosine similarity.
- **Duplicate detection** -- warns when writing entries that are similar to existing ones.
- **Session distillation** -- past sessions are auto-distilled into knowledge entries on server startup.
- **Confidence tagging** -- entries are marked `extracted` (user-written) or `inferred` (auto-distilled). Inferred entries are down-weighted in search ranking so explicit user knowledge is preferred.
- **Knowledge analysis** -- find most-connected concepts (god nodes), cross-category bridges, and isolated entries (gaps).
- **Knowledge brief** -- compact ~200 token summary of the knowledge base state for session-start orientation.
- **Pre-extracted session insights** -- distillation extracts git commits, error patterns, URLs, and package changes from session transcripts via regex (no LLM cost).
- **Real-time dashboard** -- web UI showing knowledge entries, sessions, and search results.

### Architecture

agent-knowledge has two entry points:

| Entry Point      | File             | Purpose                                                                                   |
| ---------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| MCP stdio server | `dist/index.js`  | Communicates with the AI agent via JSON-RPC over stdin/stdout. Auto-starts the dashboard. |
| HTTP server      | `dist/server.js` | Standalone dashboard + REST API + WebSocket.                                              |

Internally:

```
knowledge/     Store (Markdown CRUD), search (TF-IDF), git sync, distillation, graph, scoring, consolidation, reflection
sessions/      Parser (multi-format), indexer, search, scopes, summary, adapters (Claude Code, Cursor, OpenCode)
search/        TF-IDF engine, fuzzy matching, excerpt generation
embeddings/    Provider registry (Claude/Voyage, OpenAI, Gemini, local fallback)
vectorstore/   SQLite-backed vector storage with cosine similarity, document chunking
```

No framework dependencies. Pure Node.js + TypeScript.

---

## 2. Installation

### Prerequisites

- **Node.js 20.11.0 or later**
- **npm** (comes with Node.js)
- **Git** (for knowledge base sync)

### From npm

```bash
npm install -g agent-knowledge
```

### From Source

```bash
git clone https://github.com/keshrath/agent-knowledge.git
cd agent-knowledge
npm install
npm run build
```

### npx (No Installation)

```bash
npx agent-knowledge
```

---

## 3. Configuration

### Environment Variables

| Variable                 | Default             | Description                                    |
| ------------------------ | ------------------- | ---------------------------------------------- |
| `KNOWLEDGE_PORT`         | `3423`              | Dashboard HTTP/WebSocket port                  |
| `KNOWLEDGE_DATA_DIR`     | `~/.claude`         | Base directory for Claude Code session data    |
| `KNOWLEDGE_GIT_URL`      | (none)              | Git remote URL for knowledge base sync         |
| `KNOWLEDGE_MEMORY_DIR`   | `~/agent-knowledge` | Local knowledge base directory                 |
| `KNOWLEDGE_AUTO_DISTILL` | `true`              | Enable/disable session auto-distillation       |
| `EXTRA_SESSION_ROOTS`    | (none)              | Comma-separated additional session directories |

### Claude Code Setup

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "agent-knowledge": {
      "command": "npx",
      "args": ["agent-knowledge"]
    }
  }
}
```

The dashboard auto-starts at http://localhost:3423.

### Permissions (settings.json)

```json
{
  "permissions": {
    "allow": ["mcp__agent-knowledge__*"]
  }
}
```

### Persisted Configuration

Configuration can also be set via the `knowledge_admin` tool with `action: "config"`. Persisted config is stored at a tool-agnostic location and environment variables override persisted settings.

```
knowledge_admin with action "config", git_url "https://github.com/user/memory.git"
knowledge_admin with action "config", memory_dir "/custom/path/knowledge"
knowledge_admin with action "config", auto_distill false
```

---

## 4. Dashboard Guide

### Accessing the Dashboard

The dashboard is available at **http://localhost:3423** (or the port configured via `KNOWLEDGE_PORT`).

### Knowledge Tab

Shows all knowledge base entries organized by category. Each entry card displays:

- **Title** extracted from the Markdown content or filename.
- **Category** badge (`projects`, `people`, `decisions`, `workflows`, `notes`).
- **Tags** from YAML frontmatter.
- **Maturity** level (`candidate`, `established`, `proven`).
- **Access count** -- how many times the entry has been read.
- **Last accessed** timestamp.

Click an entry to view its full Markdown content, related entries (from the knowledge graph), and score data.

The Knowledge tab header includes analysis buttons:

- **Duplicates** — scans entries for near-duplicates (TF-IDF similarity)
- **Reflect** — finds entries with no graph connections, generates a structured prompt for the agent
- **God Nodes** — opens a panel showing the most-connected entries (your core concepts)
- **Bridges** — shows entries that connect different categories with a `why` explanation
- **Gaps** — lists isolated entries (0-1 edges) sorted by maturity
- **Brief** — displays the knowledge base summary suitable for session-start orientation

### Sessions Tab

Lists discovered sessions from all configured sources (Claude Code, Cursor, OpenCode). Each session shows:

- **Session ID** (UUID).
- **Project** name.
- **Message count** and duration.
- **Last modified** timestamp.

Click a session to view its messages.

### Search

The search bar performs hybrid search across both knowledge entries and sessions. Results are ranked by relevance combining TF-IDF and semantic similarity scores.

### Stats

Displays vector store statistics: total entries, knowledge entries, session entries, database size, embedding provider, and dimensions.

### Theme Toggle

Dark and light themes available. Preference saved in `localStorage`.

### Real-Time Updates

The dashboard connects via WebSocket. On connect, it receives the full state snapshot. A file watcher monitors the UI directory for hot-reload during development. The state snapshot is cached for 30 seconds to avoid expensive disk and database scans.

---

## 5. MCP Tools Reference

agent-knowledge exposes 6 MCP tools, each with multiple actions.

### knowledge

Knowledge base CRUD, git sync, and session-start hydration.

**Actions:** `list`, `read`, `write`, `delete`, `sync`, `wakeup`

**Parameters:**

| Name           | Type   | Required | Description                                                                                                                 |
| -------------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `action`       | string | Yes      | One of: `list`, `read`, `write`, `delete`, `sync`, `wakeup`                                                                 |
| `category`     | string | No       | [list/wakeup] Filter by category; [write] Target directory. One of: `projects`, `people`, `decisions`, `workflows`, `notes` |
| `tag`          | string | No       | [list] Filter by tag                                                                                                        |
| `path`         | string | No       | [read/delete] Relative path, e.g. `projects/my-project.md`                                                                  |
| `filename`     | string | No       | [write] Filename with or without .md extension                                                                              |
| `content`      | string | No       | [write] Full Markdown content (max 1MB)                                                                                     |
| `token_budget` | number | No       | [wakeup] Max tokens for the rendered L0+L1 blob (chars/4 estimate, default 800, range 50–8000)                              |

**Action: list**

Browse knowledge entries, optionally filtered by category or tag.

```
knowledge with action "list"
knowledge with action "list", category "projects"
knowledge with action "list", tag "architecture"
```

**Action: read**

Read an entry's content. Records an access for scoring. Returns content, score data, and related entries from the knowledge graph.

```
knowledge with action "read", path "projects/my-project.md"
```

**Action: write**

Create or update an entry. Auto-syncs to git (pull before write, push after). Auto-links to similar entries via vector search. Warns about potential duplicates.

```
knowledge with action "write", category "decisions", filename "use-jwt.md", content "---\ntags: [auth, security]\n---\n# Decision: Use JWT\n\nWe chose JWT over session cookies because..."
```

**Response includes:**

- `path`: Where the file was written.
- `git`: Push result.
- `autoLinked`: Similar entries that were auto-linked (cosine > 0.7).
- `similarEntries`: Potential duplicates found.

**Action: delete**

Remove an entry and sync to git.

```
knowledge with action "delete", path "notes/old-note.md"
```

**Action: sync**

Manual git pull + push.

```
knowledge with action "sync"
```

**Action: wakeup**

Return a small "L0 + L1" context blob: identity (from `~/agent-knowledge/identity.md`) plus the highest-weighted entries, fit under a token budget. Call once at session start so the agent has its world loaded before issuing any real search.

Weight = `recency × log(size+1)` — recently-edited and substantial entries float to the top. The blob is rendered as Markdown with one bullet per L1 entry; each bullet is a short excerpt.

```
knowledge with action "wakeup"
knowledge with action "wakeup", token_budget 1200
knowledge with action "wakeup", category "projects"
```

**Response:**

- `identity` — text from `identity.md`, or a default placeholder.
- `entries` — array of `{ path, title, weight, excerpt }`, top-weighted first.
- `rendered` — the assembled Markdown blob ready to paste into a system prompt.
- `token_estimate` — `chars / 4`.
- `truncated` — `true` when the budget cut off the L1 list.

---

### knowledge_search

Search across sessions and knowledge entries. Supports general search and scoped recall.

**Parameters:**

| Name          | Type    | Required | Description                                                                                                                               |
| ------------- | ------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `query`       | string  | Yes      | Search query -- supports keywords and phrases                                                                                             |
| `scope`       | string  | No       | Search scope: `errors`, `plans`, `configs`, `tools`, `files`, `decisions`, `all`. When provided, performs scoped recall in sessions only. |
| `project`     | string  | No       | Restrict to sessions from this project                                                                                                    |
| `role`        | string  | No       | Filter by message role: `user`, `assistant`, `all` (default: all, ignored when scope is set)                                              |
| `max_results` | number  | No       | Maximum results (default: 20)                                                                                                             |
| `ranked`      | boolean | No       | Use TF-IDF ranking (default: true, ignored when scope is set)                                                                             |
| `semantic`    | boolean | No       | Blend semantic similarity with TF-IDF (default: true)                                                                                     |

**General search** (no scope):

```
knowledge_search with query "authentication error handling"
knowledge_search with query "database migration", project "backend"
```

Returns both session matches and knowledge base matches.

**Scoped recall** (with scope):

```
knowledge_search with query "ECONNREFUSED", scope "errors"
knowledge_search with query "microservices", scope "plans"
knowledge_search with query "DATABASE_URL", scope "configs"
knowledge_search with query "comm_register", scope "tools"
knowledge_search with query "src/auth.ts", scope "files"
knowledge_search with query "JWT vs sessions", scope "decisions"
```

Scope descriptions:

| Scope       | What it searches                                   |
| ----------- | -------------------------------------------------- |
| `errors`    | Stack traces, error messages, debugging sessions   |
| `plans`     | Architecture discussions, TODOs, planning messages |
| `configs`   | Settings, environment variables, configuration     |
| `tools`     | MCP tool calls, tool results                       |
| `files`     | File paths, code references                        |
| `decisions` | Trade-offs, choices, "chose X over Y"              |
| `all`       | No filter (same as general search within sessions) |

---

### knowledge_session

Session operations.

**Parameters:**

| Name            | Type    | Required | Description                                                      |
| --------------- | ------- | -------- | ---------------------------------------------------------------- |
| `action`        | string  | Yes      | One of: `list`, `get`, `summary`                                 |
| `session_id`    | string  | Varies   | Session UUID (required for `get`, `summary`)                     |
| `project`       | string  | No       | Filter by project name (substring match)                         |
| `include_tools` | boolean | No       | [get] Include tool_use and tool_result messages (default: false) |
| `tail`          | number  | No       | [get] Only return the last N messages                            |
| `limit`         | number  | No       | [list] Max sessions (default: 20, max: 500)                      |
| `offset`        | number  | No       | [list] Skip first N sessions (default: 0)                        |

**Action: list**

Browse sessions, optionally filtered by project.

```
knowledge_session with action "list"
knowledge_session with action "list", project "backend", limit 50
```

**Action: get**

Retrieve full conversation messages for a session.

```
knowledge_session with action "get", session_id "abc-123-def"
knowledge_session with action "get", session_id "abc-123-def", include_tools true, tail 20
```

**Action: summary**

Get a quick overview of a session (topics, file paths, message counts).

```
knowledge_session with action "summary", session_id "abc-123-def"
```

---

### knowledge_admin

Admin operations for configuration, index stats, and embedding management.

**Parameters:**

| Name           | Type    | Required | Description                                              |
| -------------- | ------- | -------- | -------------------------------------------------------- |
| `action`       | string  | Yes      | One of: `status`, `config`, `rebuild_embeddings`         |
| `git_url`      | string  | No       | [config] Git remote URL (empty string to remove)         |
| `memory_dir`   | string  | No       | [config] Local knowledge base directory (empty to reset) |
| `auto_distill` | boolean | No       | [config] Enable/disable session distillation             |

**Action: status**

View vector store statistics.

```
knowledge_admin with action "status"
```

Returns total entries, knowledge entries, session entries, unique sessions, database size, provider name, and dimensions.

**Action: config**

View or update configuration. Without update params, returns current config.

```
# View config
knowledge_admin with action "config"

# Update git URL
knowledge_admin with action "config", git_url "https://github.com/user/memory.git"

# Disable auto-distillation
knowledge_admin with action "config", auto_distill false
```

**Action: rebuild_embeddings**

Re-embed all knowledge entries. Useful when switching embedding providers.

```
knowledge_admin with action "rebuild_embeddings"
```

Wipes existing vectors, re-creates the store with the current provider's dimensions, and re-embeds all entries. Returns processed/failed counts.

---

### knowledge_graph

Knowledge graph operations for creating and traversing relationships between entries.

**Parameters:**

| Name       | Type   | Required | Description                                                            |
| ---------- | ------ | -------- | ---------------------------------------------------------------------- |
| `action`   | string | Yes      | One of: `link`, `unlink`, `list`, `traverse`                           |
| `source`   | string | Varies   | [link/unlink] Source entry path                                        |
| `target`   | string | Varies   | [link/unlink] Target entry path                                        |
| `entry`    | string | No       | [list] Filter by entry path; [traverse] BFS start node                 |
| `rel_type` | string | Varies   | Relationship type (required for link, optional filter for unlink/list) |
| `strength` | number | No       | [link] Edge strength 0-1 (default: 0.5)                                |
| `depth`    | number | No       | [traverse] Max traversal depth in hops (default: 2)                    |

**Relationship types:**

| Type             | Description                          |
| ---------------- | ------------------------------------ |
| `related_to`     | General association                  |
| `supersedes`     | Entry replaces another               |
| `depends_on`     | Entry depends on another             |
| `contradicts`    | Entries have conflicting information |
| `specializes`    | Entry is a specific case of another  |
| `part_of`        | Entry is a component of another      |
| `alternative_to` | Entry is an alternative to another   |
| `builds_on`      | Entry extends or builds on another   |

**Action: link**

Create an edge between two entries.

```
knowledge_graph with action "link", source "projects/backend.md", target "decisions/use-jwt.md", rel_type "depends_on", strength 0.8
```

**Action: unlink**

Remove an edge.

```
knowledge_graph with action "unlink", source "projects/backend.md", target "decisions/use-jwt.md"
knowledge_graph with action "unlink", source "projects/backend.md", target "decisions/use-jwt.md", rel_type "depends_on"
```

**Action: list**

List edges, optionally filtered by entry or relationship type.

```
knowledge_graph with action "list"
knowledge_graph with action "list", entry "projects/backend.md"
knowledge_graph with action "list", rel_type "depends_on"
```

**Action: traverse**

BFS traversal from a starting entry. Returns a graph of connected entries.

```
knowledge_graph with action "traverse", entry "projects/backend.md"
knowledge_graph with action "traverse", entry "projects/backend.md", depth 3
```

---

### knowledge_analyze

Analysis tools for knowledge base maintenance.

**Parameters:**

| Name          | Type   | Required | Description                                                                      |
| ------------- | ------ | -------- | -------------------------------------------------------------------------------- |
| `action`      | string | Yes      | One of: `consolidate`, `reflect`, `god_nodes`, `bridges`, `gaps`, `brief`        |
| `category`    | string | No       | Scan only this category (omit for all)                                           |
| `threshold`   | number | No       | [consolidate] Similarity threshold 0-1 (default: 0.5)                            |
| `max_entries` | number | No       | [reflect/gaps] Max entries to include (default: 20 for reflect, 30 for gaps)     |
| `top_n`       | number | No       | [god_nodes/bridges] Max entries to return (default: 10 for god_nodes, 5 bridges) |

**Action: consolidate**

Find near-duplicate entries using TF-IDF similarity.

```
knowledge_analyze with action "consolidate"
knowledge_analyze with action "consolidate", category "projects", threshold 0.7
```

Returns clusters of similar entries that may be candidates for merging.

**Action: reflect**

Find entries with no graph connections and generate a structured prompt for linking them.

```
knowledge_analyze with action "reflect"
knowledge_analyze with action "reflect", category "decisions", max_entries 10
```

Returns unconnected entries and suggested relationships to investigate.

**Action: `god_nodes`**

Returns the most-connected entries in the knowledge graph, ranked by degree centrality.

| Parameter | Type   | Default | Description               |
| --------- | ------ | ------- | ------------------------- |
| `top_n`   | number | 10      | Maximum entries to return |

Returns: array of `{ path, title, category, degree, confidence }` sorted by degree descending. Entries with only auto-link edges and the `auto-distilled` tag are excluded.

**Action: `bridges`**

Returns entries that bridge different categories, ranked by betweenness centrality.

| Parameter | Type   | Default | Description               |
| --------- | ------ | ------- | ------------------------- |
| `top_n`   | number | 5       | Maximum bridges to return |

Returns: array of `{ path, title, betweenness, connects, why }`. Only entries connecting at least 2 different categories are returned.

**Action: `gaps`**

Returns entries with 0-1 graph edges (weakly connected or isolated).

| Parameter     | Type   | Default | Description               |
| ------------- | ------ | ------- | ------------------------- |
| `max_entries` | number | 30      | Maximum entries to return |

Returns: array of `{ path, title, category, degree, maturity, daysSinceAccess }` sorted with `proven` entries first (most concerning gaps), then by degree ascending.

**Action: `brief`**

Returns a compact summary of the knowledge base state (cached 1 hour, invalidated on write/delete/link/unlink).

No parameters.

Returns: `{ total_entries, total_edges, core_concepts, active_projects, recent_decisions, stale_count, gap_count, generated_at, text }`. The `text` field is a ~200 token plain-text summary suitable for injection into agent prompts.

---

## 6. REST API Reference

The REST API is served by the dashboard. All responses include CORS headers. Rate limited: 100 requests/minute general, 20 requests/minute for search/analyze endpoints.

### Health

```
GET  /health                              Status, version, uptime, knowledge entry count
```

### Knowledge Entries

```
GET  /api/knowledge                       List entries (?category=&tag=)
GET  /api/knowledge/:path                 Read entry content (enriched with score data)
GET  /api/knowledge/:path/links           Get graph edges for an entry
GET  /api/knowledge/search                Search entries (?q=&category=&max_results=)
GET  /api/knowledge/consolidate           Find duplicates (?category=&threshold=)
GET  /api/knowledge/reflect               Find unconnected entries (?category=&max_entries=)
GET  /api/knowledge/god-nodes             Most-connected entries (?top_n=)
GET  /api/knowledge/bridges               Cross-category connectors (?top_n=)
GET  /api/knowledge/gaps                  Isolated entries (?max_entries=)
GET  /api/knowledge/brief                 Cached knowledge base brief
```

### `GET /api/knowledge/god-nodes`

Query params: `top_n` (number, default 10).

Returns: same as `knowledge_analyze(action: "god_nodes")`.

### `GET /api/knowledge/bridges`

Query params: `top_n` (number, default 5).

Returns: same as `knowledge_analyze(action: "bridges")`.

### `GET /api/knowledge/gaps`

Query params: `max_entries` (number, default 30).

Returns: same as `knowledge_analyze(action: "gaps")`.

### `GET /api/knowledge/brief`

No query params. Returns the cached knowledge brief.

### Sessions

```
GET  /api/sessions                        List sessions (?project=&limit=&offset=)
GET  /api/sessions/:id                    Get session messages (?project=&include_tools=&tail=)
GET  /api/sessions/:id/summary            Get session summary (?project=)
GET  /api/sessions/search                 Search sessions (?q=&role=&max_results=&ranked=&project=&semantic=)
GET  /api/sessions/recall                 Scoped recall (?scope=&q=&max_results=&project=)
```

### Index Status

```
GET  /api/index-status                    Vector store statistics
```

### Example Requests

```bash
# Health check
curl http://localhost:3423/health

# List all knowledge entries
curl http://localhost:3423/api/knowledge

# Read a specific entry
curl http://localhost:3423/api/knowledge/projects/backend.md

# Search knowledge
curl "http://localhost:3423/api/knowledge/search?q=authentication&max_results=5"

# Search sessions
curl "http://localhost:3423/api/sessions/search?q=deploy+error&role=assistant&max_results=10"

# Scoped recall
curl "http://localhost:3423/api/sessions/recall?scope=errors&q=ECONNREFUSED"

# List sessions for a project
curl "http://localhost:3423/api/sessions?project=backend&limit=20"
```

---

## 7. Knowledge Base Management

### Entry Format

Knowledge entries are Markdown files with optional YAML frontmatter:

```markdown
---
tags: [auth, security, jwt]
---

# JWT Authentication

We use JWT with refresh tokens for stateless authentication...
```

### Categories

Entries are organized into categories (directories):

| Category    | Purpose                                  |
| ----------- | ---------------------------------------- |
| `projects`  | Project context, architecture, team info |
| `people`    | Team members, contacts, roles            |
| `decisions` | Architecture decisions, trade-offs       |
| `workflows` | Processes, CI/CD, deployment procedures  |
| `notes`     | General notes, observations              |

### Git Sync

The knowledge base is optionally backed by a git repository. When configured:

- `knowledge(action: "read")` does a `git pull` before reading.
- `knowledge(action: "write")` does a `git pull` before writing, then `git push` after.
- `knowledge(action: "sync")` does a manual pull + push.

Configure the git remote:

```
knowledge_admin with action "config", git_url "https://github.com/user/memory.git"
```

### Scoring and Maturity

Entries have a confidence score that increases with access:

| Maturity      | Description                            |
| ------------- | -------------------------------------- |
| `candidate`   | New entry, not yet validated           |
| `established` | Accessed multiple times, gaining trust |
| `proven`      | Frequently accessed, high confidence   |

Scores include a decay factor -- entries not accessed recently receive lower rankings in search results. The decay is based on time since last access.

### Auto-Linking

When writing a new entry, agent-knowledge automatically:

1. Generates embeddings for the content.
2. Searches for similar existing entries via vector similarity.
3. Creates `related_to` edges for entries with cosine similarity > 0.7 (up to 3 links).

Auto-linked entries appear in the write response.

### Duplicate Detection

On write, TF-IDF similarity is checked against existing entries. If similar entries are found, a `similarEntries` warning is included in the response. This helps avoid knowledge fragmentation.

### Session Distillation

On server startup (when `auto_distill` is enabled), past sessions are automatically scanned and distilled into knowledge entries. The distillation process:

1. Parses session files from all configured sources.
2. Extracts key insights, decisions, and patterns.
3. Scrubs secrets (API keys, tokens, passwords) from the content.
4. Writes distilled entries to the `projects/` category.

---

## 8. Session Search

### Supported Sources

Sessions are auto-discovered from installed AI coding tools:

| Tool        | Location                                          |
| ----------- | ------------------------------------------------- |
| Claude Code | `$KNOWLEDGE_DATA_DIR/projects/` (JSONL files)     |
| Cursor      | `~/.cursor/projects/*/agent-transcripts/` (JSONL) |
| OpenCode    | `~/.local/share/opencode/opencode.db` (SQLite)    |

Additional roots can be added via `EXTRA_SESSION_ROOTS` (comma-separated paths).

### Search Modes

**General search** finds matches across all sessions and knowledge entries:

```
knowledge_search with query "authentication"
```

**Scoped recall** targets specific domains within sessions:

```
knowledge_search with query "ECONNREFUSED", scope "errors"
```

### Ranking

Results are ranked using a hybrid approach:

1. **TF-IDF**: Term frequency-inverse document frequency scoring.
2. **Semantic**: Cosine similarity between query and document embeddings (when available).
3. **Combined**: Weighted blend of both scores (configurable via `embeddingAlpha` in config).

Set `semantic: false` to use pure TF-IDF, or `ranked: false` for regex-based matching.

### Embedding Providers

Semantic search requires an embedding provider. Supported providers (auto-detected):

| Provider      | Environment Variable   |
| ------------- | ---------------------- |
| Claude/Voyage | `ANTHROPIC_API_KEY`    |
| OpenAI        | `OPENAI_API_KEY`       |
| Gemini        | `GOOGLE_API_KEY`       |
| Local         | (fallback, no API key) |

If no provider is available, search falls back to pure TF-IDF.

---

## 9. Troubleshooting

### Dashboard Won't Start

**Symptom:** Port 3423 already in use.

**Solutions:**

1. Set `KNOWLEDGE_PORT=3424` in the MCP config env.
2. Multiple MCP instances share the same database. Only one serves the dashboard.

### Search Returns No Results

**Causes and solutions:**

- **No sessions found**: Check that `KNOWLEDGE_DATA_DIR` points to the correct directory. Verify session files exist.
- **Embeddings not available**: Semantic search requires an API key. Check the embedding provider configuration.
- **Index not built**: Background indexing runs 5 seconds after startup. Wait for it to complete. Check stderr for `[knowledge] Background index` messages.

### Git Sync Fails

**Symptom:** Push or pull errors.

**Solutions:**

- Verify the git remote URL is correct and accessible.
- Ensure git credentials are configured (SSH keys or credential helper).
- Git operations have a 30-second timeout to prevent hangs.
- Run `knowledge(action: "sync")` manually to diagnose.

### Vector Store Issues

**Symptom:** Large database file, slow searches, or embedding errors.

**Solutions:**

- The vector store uses SQLite and can grow large with many sessions. Check size via `knowledge_admin(action: "status")`.
- If the embedding provider changes, rebuild embeddings: `knowledge_admin(action: "rebuild_embeddings")`.
- If the database is corrupted, delete `knowledge-vectors.db` and associated WAL files. Embeddings will be rebuilt on next startup.

### Memory Directory Not Found

**Symptom:** Errors about missing knowledge base directory.

**Solutions:**

- The default directory is `~/agent-knowledge/`. Create it manually or let the git clone create it.
- Override via `KNOWLEDGE_MEMORY_DIR` or `knowledge_admin(action: "config", memory_dir: "/path")`.

---

## 10. FAQ

### Can I use this with Cursor/OpenCode?

Yes. agent-knowledge is a standard MCP server. It also auto-discovers sessions from Cursor and OpenCode installations, so you can search across all your AI coding sessions regardless of which tool created them.

### Where are knowledge entries stored?

In `~/agent-knowledge/` by default (configurable via `KNOWLEDGE_MEMORY_DIR`). Entries are plain Markdown files with YAML frontmatter, organized in category subdirectories.

### How does git sync work?

When a git URL is configured, the knowledge directory is a git repository. Reads trigger `git pull`, writes trigger `git pull` + `git push`. This keeps the knowledge base synchronized across machines.

### What happens without an embedding provider?

Search falls back to pure TF-IDF (keyword-based). Semantic features (vector similarity, auto-linking) are disabled. The system still works well for exact and fuzzy keyword matching.

### How do I add support for another AI tool's sessions?

Implement the `SessionAdapter` interface in `src/sessions/adapters/`. The adapter registry auto-detects new adapters on startup. Each adapter defines how to find and parse session files for a specific tool.

### Can I share knowledge across machines?

Yes. Configure a git remote via `knowledge_admin(action: "config", git_url: "...")`. All writes are automatically pushed to the remote. On startup and before reads, the latest changes are pulled.

### How large can the vector store get?

The vector store grows with the number of indexed entries (knowledge + sessions). Each entry generates multiple chunks with embedding vectors. The `knowledge_admin(action: "status")` tool shows the current database size and entry counts.

### What is the difference between knowledge_search and knowledge_session?

- `knowledge_search` is for finding information: it searches across both sessions and knowledge entries, ranking results by relevance.
- `knowledge_session` is for browsing sessions: listing them, reading their messages, or getting summaries.

### How are secrets scrubbed during distillation?

The distillation process applies regex patterns to detect and remove common secret formats (API keys, tokens, passwords, connection strings) before writing knowledge entries. This prevents accidental persistence of sensitive data.

### Can I disable auto-distillation?

Yes. Set `KNOWLEDGE_AUTO_DISTILL=false` as an environment variable, or use `knowledge_admin(action: "config", auto_distill: false)`.

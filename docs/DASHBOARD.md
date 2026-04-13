# Dashboard

The dashboard runs at **http://localhost:3423** and auto-starts with the MCP server.

## Tabs

| Tab           | Purpose                                                         |
| ------------- | --------------------------------------------------------------- |
| **Knowledge** | Browse knowledge base entries by category                       |
| **Search**    | TF-IDF ranked search across session transcripts                 |
| **Sessions**  | Browse and read session conversation logs                       |
| **Recall**    | Scoped search (errors, plans, configs, tools, files, decisions) |

## Knowledge Tab

Card grid of knowledge entries. Each card shows:

- Category badge with color: projects (blue), people (purple), decisions (orange), workflows (green), notes (yellow)
- **Maturity badge**: candidate (gray), established (blue), proven (green) — based on access frequency
- Title and tag pills
- Last updated date

![Knowledge entries with maturity badges](assets/knowledge-maturity.png)

Category filter chips at the top: All, Projects, People, Decisions, Workflows, Notes. Search bar for filtering entries by title.

**Header action buttons:**

- **Duplicates** — scans all entries for near-duplicates using TF-IDF similarity. Entries in duplicate clusters get a warning icon on their card. Opens a side panel showing clusters with pairwise similarity scores. Click any entry in a cluster to view it.
- **Reflect** — finds entries with no graph connections. Opens a side panel listing unconnected entries with content summaries and instructions for creating new links.
- **God Nodes** — opens a side panel showing the most-connected entries (top degree centrality) with edge counts. These are your core concepts.
- **Bridges** — shows entries that connect different categories, ranked by betweenness centrality. Each row includes a `why` explanation of which categories it bridges.
- **Gaps** — lists isolated entries (0-1 edges) grouped by maturity, with `proven` entries listed first as the most concerning gaps.
- **Brief** — displays the cached ~200 token knowledge base summary in a code block plus card sections for core concepts and recent decisions. Suitable for session-start orientation.

Click a card to open the side panel with rendered markdown content, score details, and related entries.

## Search Tab

Full-text search across all session transcripts.

**Controls:**

- Search input with debounce (300ms)
- Role filter chips: All, User, Assistant
- Mode toggle: Ranked (TF-IDF) vs Regex

**Results show:**

- Role badge (user/assistant)
- Project name
- Relative timestamp
- Score bar with numeric value
- Excerpt with highlighted matching terms

Click a result to open the session in the side panel.

## Sessions Tab

Lists sessions from all detected AI coding tools with metadata:

- Source tool indicator (Claude Code, Cursor, OpenCode, Cline, Continue.dev, Aider)
- Project name
- Git branch (when available)
- Message count
- Date
- Preview of first user message

Project filter dropdown at the top. Sessions from all tools are merged into a single unified list.

Click a session to open the side panel with the full conversation rendered as chat bubbles.

## Recall Tab

Scoped search that pre-filters results by category:

| Scope       | What it finds                             |
| ----------- | ----------------------------------------- |
| `errors`    | Stack traces, exceptions, failed commands |
| `plans`     | Architecture, TODOs, implementation steps |
| `configs`   | Settings, env vars, configuration files   |
| `tools`     | MCP tool calls, CLI commands              |
| `files`     | File paths, modifications                 |
| `decisions` | Trade-offs, rationale, choices            |

Results use the same format as the Search tab.

## Side Panel

- Width: 560px, resizable by dragging the left edge
- Close: X button or press Escape
- Knowledge entries: rendered as markdown via marked + DOMPurify + highlight.js
- **Related entries**: linked entries shown with colored relationship-type pills (related_to, depends_on, supersedes, etc.) — clickable to navigate
- **Score details**: maturity level, access count, decay factor, and maturity multiplier
- Sessions: chat bubbles (user = right/accent, assistant = left/surface)

## Theming

- Toggle: sun/moon button in header
- Persisted in `localStorage('agent-knowledge-theme')`
- MD3 design tokens matching agent-comm and agent-tasks dashboards
- CSS custom properties on `:root`, switched via `data-theme` attribute

## Live Reload

File watcher monitors `src/ui/` for `.html`, `.css`, `.js` changes. On change, broadcasts `{type: "reload"}` via WebSocket. Connected browsers auto-refresh.

## Keyboard Shortcuts

| Shortcut        | Action             |
| --------------- | ------------------ |
| `/` or `Ctrl+K` | Focus search input |
| `Escape`        | Close side panel   |

## REST API

| Method | Endpoint                                | Description                  |
| ------ | --------------------------------------- | ---------------------------- |
| GET    | `/api/knowledge`                        | List entries                 |
| GET    | `/api/knowledge/search?q=`              | Search knowledge             |
| GET    | `/api/knowledge/:path`                  | Read entry (with score data) |
| GET    | `/api/knowledge/:path/links`            | Graph edges for entry        |
| GET    | `/api/knowledge/consolidate?threshold=` | Duplicate cluster analysis   |
| GET    | `/api/knowledge/reflect?max_entries=`   | Unconnected entries + prompt |
| GET    | `/api/knowledge/god-nodes?top_n=`       | Most-connected entries       |
| GET    | `/api/knowledge/bridges?top_n=`         | Cross-category connectors    |
| GET    | `/api/knowledge/gaps?max_entries=`      | Isolated entries by maturity |
| GET    | `/api/knowledge/brief`                  | Cached knowledge base brief  |
| GET    | `/api/sessions`                         | List sessions                |
| GET    | `/api/sessions/search?q=&role=&ranked=` | Search sessions              |
| GET    | `/api/sessions/recall?scope=&q=`        | Scoped recall                |
| GET    | `/api/sessions/:id`                     | Read session                 |
| GET    | `/api/sessions/:id/summary`             | Session summary              |
| POST   | `/api/knowledge`                        | Write entry (JSON body)      |
| GET    | `/health`                               | Health check                 |

### POST /api/knowledge

Write a knowledge entry via REST. Runs the same pipeline as the MCP `knowledge(action: "write")` tool: git pull, file write, embedding index, auto-link (cosine > 0.7), git push, duplicate check.

**Request:**

```json
{
  "category": "decisions",
  "filename": "my-entry.md",
  "content": "---\ntitle: My Entry\ntags: [foo]\n---\n\nContent here."
}
```

**Response (201):**

```json
{
  "path": "decisions/my-entry.md",
  "git": { "success": true, "message": "pushed" },
  "autoLinks": [{ "target": "decisions/related.md", "similarity": 0.82 }],
  "duplicateWarnings": []
}
```

Valid categories: `projects`, `people`, `decisions`, `workflows`, `notes`. POST is restricted to `/api/` paths; non-API POST returns 405.

Used by agent-tasks `KnowledgeBridge` to push learning/decision artifacts on task completion.

## WebSocket

Connects to `ws://localhost:3423` on page load.

**State message** (on connect):

```json
{
  "type": "state",
  "knowledge": [...],
  "sessions": [...],
  "stats": { "knowledge_entries": 12, "session_count": 247 }
}
```

**Reload message** (on file change):

```json
{ "type": "reload" }
```

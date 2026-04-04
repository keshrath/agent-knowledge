# agent-knowledge

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node >= 20](https://img.shields.io/badge/Node-%3E%3D%2020-brightgreen.svg)](https://nodejs.org)
[![Tests: 352 passing](https://img.shields.io/badge/Tests-352%20passing-brightgreen.svg)]()
[![MCP Tools: 6](https://img.shields.io/badge/MCP%20Tools-6-blueviolet.svg)]()

**Cross-session memory and recall for AI coding assistants** -- works with Claude Code, Cursor, OpenCode, Cline, Continue.dev, and Aider out of the box. Git-synced knowledge base, hybrid semantic+TF-IDF search, auto-distillation with secrets scrubbing.

<table>
<tr>
<td><img src="docs/assets/knowledge-light.png" alt="Knowledge Base (light)" width="480"></td>
<td><img src="docs/assets/search-light.png" alt="Session Search" width="480"></td>
</tr>
<tr>
<td align="center"><em>Knowledge base with category filtering</em></td>
<td align="center"><em>TF-IDF ranked session search</em></td>
</tr>
</table>

## Why

AI coding sessions are ephemeral. When a session ends, everything it learned -- architecture decisions, debugging insights, project context -- is gone. The next session starts from scratch.

**agent-knowledge** solves this with two complementary systems:

1. **Knowledge Base** -- a git-synced markdown vault of structured entries (decisions, workflows, project context) that persists across sessions and machines.
2. **Session Search** -- TF-IDF ranked full-text search across session transcripts from all your coding tools, so agents can recall what happened before -- regardless of which tool was used.

## Supported Tools

Sessions from all major AI coding assistants are auto-discovered -- if a tool is installed, its sessions appear automatically.

| Tool             | Format         | Auto-detected path                                              |
| ---------------- | -------------- | --------------------------------------------------------------- |
| **Claude Code**  | JSONL          | `$KNOWLEDGE_DATA_DIR/projects/` (default `~/.claude/projects/`) |
| **Cursor**       | JSONL          | `~/.cursor/projects/*/agent-transcripts/`                       |
| **OpenCode**     | SQLite         | `~/.local/share/opencode/opencode.db` (or `$OPENCODE_DATA_DIR`) |
| **Cline**        | JSON           | VS Code globalStorage `saoudrizwan.claude-dev/tasks/`           |
| **Continue.dev** | JSON           | `~/.continue/sessions/`                                         |
| **Aider**        | Markdown/JSONL | `.aider.chat.history.md` / `.aider.llm.history` in project dirs |

No configuration needed. Additional session roots can be added via the `EXTRA_SESSION_ROOTS` env var (comma-separated paths).

## Features

- **Multi-tool session search** -- unified search across Claude Code, Cursor, OpenCode, Cline, Continue.dev, and Aider sessions
- **Hybrid search** -- semantic vector similarity blended with TF-IDF keyword ranking
- **Git-synced knowledge base** -- markdown vault with YAML frontmatter, auto commit and push on writes
- **Auto-distillation** -- session insights automatically extracted and pushed to git with secrets scrubbing
- **Pluggable adapter system** -- add support for new tools by implementing the `SessionAdapter` interface
- **Embeddings** -- local (Hugging Face), OpenAI, Claude/Voyage, or Gemini providers
- **Fuzzy matching** -- typo-tolerant search using Levenshtein distance
- **6 search scopes** -- errors, plans, configs, tools, files, decisions
- **6 MCP tools** -- consolidated action-based interface (knowledge, knowledge_search, knowledge_session, knowledge_graph, knowledge_analyze, knowledge_admin)
- **Configurable git URL** -- `knowledge_admin(action: "config")` for runtime setup, persisted at XDG/AppData location
- **Cross-machine persistence** -- knowledge syncs via git, sessions read from local storage of each tool
- **Real-time dashboard** -- browse, search, and manage at `localhost:3423`
- **Secrets scrubbing** -- API keys, tokens, passwords, private keys automatically redacted before git push
- **Knowledge graph** -- relationship edges between entries (related_to, supersedes, depends_on, contradicts, specializes, part_of, alternative_to, builds_on) with BFS traversal
- **Confidence/decay scoring** -- entries scored by access frequency and recency; auto-promotion from candidate to established to proven
- **Memory consolidation** -- TF-IDF duplicate detection on write (warns of similar entries) plus `knowledge_analyze(action: "consolidate")` for batch dedup scanning
- **Reflection cycle** -- `knowledge_analyze(action: "reflect")` surfaces unconnected entries and generates structured prompts for the agent to identify new graph connections
- **Auto-linking on write** -- new entries automatically linked to top-3 similar existing entries when cosine similarity > 0.7

## Quick Start

### Install from npm

```bash
npm install -g agent-knowledge
```

### Or clone from source

```bash
git clone https://github.com/keshrath/agent-knowledge.git
cd agent-knowledge
npm install && npm run build
```

> **Windows note**: `better-sqlite3` requires native compilation. If `npm install` fails with `gyp ERR!`, install the C++ build tools:
>
> ```powershell
> winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive"
> ```
>
> Then re-run `npm install`. This is only needed when prebuilt binaries aren't available for your Node.js version (e.g. Node 24+).

### Option 1: MCP server (for AI agents)

Add to your MCP client config (Claude Code, Cline, etc.):

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

The dashboard auto-starts at http://localhost:3423 on the first MCP connection.

See [Setup Guide](docs/SETUP.md) for client-specific instructions (Claude Code, Cursor, Windsurf, OpenCode).

### Option 2: Standalone server (for REST/WebSocket clients)

```bash
node dist/server.js --port 3423
```

## MCP Tools (6)

### Knowledge Base

| Tool        | Action   | Description                         | Parameters                                       |
| ----------- | -------- | ----------------------------------- | ------------------------------------------------ |
| `knowledge` | `list`   | List entries by category and/or tag | `category?`, `tag?`                              |
|             | `read`   | Read a specific entry               | `path` (required)                                |
|             | `write`  | Create/update entry (auto git sync) | `category`, `filename`, `content` (all required) |
|             | `delete` | Delete an entry (auto git sync)     | `path` (required)                                |
|             | `sync`   | Manual git pull + push              | --                                               |

### Search

| Tool               | Description                                     | Parameters                                              |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------- |
| `knowledge_search` | Hybrid semantic + TF-IDF search across sessions | `query`, `project?`, `role?`, `max_results?`, `ranked?` |
|                    | Scoped recall (when `scope` is provided)        | `query`, `scope`, `project?`, `max_results?`            |

Scopes: `errors`, `plans`, `configs`, `tools`, `files`, `decisions`, `all`.

### Sessions

| Tool                | Action    | Description                            | Parameters                                          |
| ------------------- | --------- | -------------------------------------- | --------------------------------------------------- |
| `knowledge_session` | `list`    | List sessions with metadata            | `project?`                                          |
|                     | `get`     | Retrieve full session conversation     | `session_id`, `project?`, `include_tools?`, `tail?` |
|                     | `summary` | Session summary (topics, tools, files) | `session_id`, `project?`                            |

### Knowledge Graph

| Tool              | Action     | Description                        | Parameters                                  |
| ----------------- | ---------- | ---------------------------------- | ------------------------------------------- |
| `knowledge_graph` | `link`     | Create/update edge between entries | `source`, `target`, `rel_type`, `strength?` |
|                   | `unlink`   | Remove edges between entries       | `source`, `target`, `rel_type?`             |
|                   | `list`     | List edges                         | `entry?`, `rel_type?`                       |
|                   | `traverse` | BFS traversal from an entry        | `entry`, `depth?`                           |

Relationship types: `related_to`, `supersedes`, `depends_on`, `contradicts`, `specializes`, `part_of`, `alternative_to`, `builds_on`.

### Analysis

| Tool                | Action        | Description                          | Parameters                  |
| ------------------- | ------------- | ------------------------------------ | --------------------------- |
| `knowledge_analyze` | `consolidate` | Find near-duplicate entries          | `category?`, `threshold?`   |
|                     | `reflect`     | Find unconnected entries for linking | `category?`, `max_entries?` |

### Admin

| Tool              | Action   | Description                  | Parameters                                 |
| ----------------- | -------- | ---------------------------- | ------------------------------------------ |
| `knowledge_admin` | `status` | Vector store statistics      | --                                         |
|                   | `config` | View or update configuration | `git_url?`, `memory_dir?`, `auto_distill?` |

## REST API

| Method | Endpoint                                | Description              |
| ------ | --------------------------------------- | ------------------------ |
| GET    | `/api/knowledge`                        | List knowledge entries   |
| GET    | `/api/knowledge/search?q=`              | Search knowledge base    |
| GET    | `/api/knowledge/:path`                  | Read a specific entry    |
| GET    | `/api/sessions`                         | List sessions            |
| GET    | `/api/sessions/search?q=&role=&ranked=` | Search sessions (TF-IDF) |
| GET    | `/api/sessions/recall?scope=&q=`        | Scoped recall            |
| GET    | `/api/sessions/:id`                     | Read a session           |
| GET    | `/api/sessions/:id/summary`             | Session summary          |
| GET    | `/health`                               | Health check             |

## Architecture

```mermaid
graph LR
    subgraph Storage
        KB[(Knowledge Base<br/>~/agent-knowledge<br/>Git Repository)]
    end

    subgraph Session Sources
        CC[(Claude Code<br/>JSONL)]
        CU[(Cursor<br/>JSONL)]
        OC[(OpenCode<br/>SQLite)]
        CL[(Cline<br/>JSON)]
        CD[(Continue.dev<br/>JSON)]
        AI[(Aider<br/>MD / JSONL)]
    end

    subgraph agent-knowledge
        KM[Knowledge Module<br/>store / search / git]
        AD[Session Adapters<br/>auto-discovery]
        SE[Search Engine<br/>TF-IDF + Fuzzy]
        DS[Dashboard<br/>:3423]
        MCP[MCP Server<br/>stdio]
    end

    subgraph Clients
        AG[Agent Sessions]
        WB[Web Browser]
    end

    KB <-->|git pull/push| KM
    CC --> AD
    CU --> AD
    OC --> AD
    CL --> AD
    CD --> AD
    AI --> AD
    AD --> SE
    KM --> MCP
    SE --> MCP
    KM --> DS
    SE --> DS
    MCP --> AG
    DS --> WB
```

## Knowledge Graph

Entries can be connected via typed, weighted edges stored in a dedicated `edges` SQLite table. Eight relationship types are supported: `related_to`, `supersedes`, `depends_on`, `contradicts`, `specializes`, `part_of`, `alternative_to`, `builds_on`.

- **`knowledge_graph(action: "link")`** creates or updates an edge (with optional strength 0-1)
- **`knowledge_graph(action: "unlink")`** removes edges (optionally filtered by type)
- **`knowledge_graph(action: "list")`** lists edges for an entry or relationship type
- **`knowledge_graph(action: "traverse")`** performs BFS traversal from a starting entry to a configurable depth

### Auto-linking

When `knowledge_write` creates or updates an entry, it automatically finds the top-3 most similar existing entries via cosine similarity and creates `related_to` edges for any pair scoring above 0.7.

## Confidence & Decay Scoring

Each knowledge entry has a confidence score tracked in the `entry_scores` SQLite table. Search results are ranked using:

```
finalScore = baseRelevance * 0.5^(daysSinceLastAccess / 90) * maturityMultiplier
```

Entries mature automatically based on access count:

| Stage         | Accesses | Multiplier |
| ------------- | -------- | ---------- |
| `candidate`   | < 5      | 0.5x       |
| `established` | 5-19     | 1.0x       |
| `proven`      | 20+      | 1.5x       |

Frequently accessed entries rise in search rankings; stale entries decay over time.

## Search Capabilities

**TF-IDF Ranking** -- results scored by term frequency-inverse document frequency. Rare terms boost relevance. Global index cached for 60 seconds.

**Fuzzy Matching** -- Levenshtein edit distance with sliding window. Configurable threshold (default 0.7).

**Scoped Recall** via `knowledge_recall`:

| Scope       | Matches                                   |
| ----------- | ----------------------------------------- |
| `errors`    | Stack traces, exceptions, failed commands |
| `plans`     | Architecture, TODOs, implementation steps |
| `configs`   | Settings, env vars, configuration files   |
| `tools`     | MCP tool calls, CLI commands              |
| `files`     | File paths, modifications                 |
| `decisions` | Trade-offs, rationale, choices            |

## Testing

```bash
npm test              # 352 tests across 20 files
npm run test:watch    # Watch mode
npm run lint          # Type-check (tsc --noEmit)
```

## Environment Variables

| Variable                                            | Default             | Description                                                           |
| --------------------------------------------------- | ------------------- | --------------------------------------------------------------------- |
| `KNOWLEDGE_MEMORY_DIR`                              | `~/agent-knowledge` | Path to git-synced knowledge base                                     |
| `KNOWLEDGE_GIT_URL`                                 | --                  | Git remote URL (auto-clones if dir missing)                           |
| `KNOWLEDGE_AUTO_DISTILL`                            | `true`              | Auto-distill session insights to knowledge base                       |
| `KNOWLEDGE_EMBEDDING_PROVIDER`                      | `local`             | Embedding provider: `local`, `openai`, `claude`, `gemini`             |
| `KNOWLEDGE_EMBEDDING_ALPHA`                         | `0.3`               | TF-IDF vs semantic blend weight (0=pure semantic, 1=pure TF-IDF)      |
| `KNOWLEDGE_EMBEDDING_IDLE_TIMEOUT`                  | `60`                | Seconds before unloading local model from memory (0 = keep alive)     |
| `KNOWLEDGE_DATA_DIR`                                | `~/.claude`         | Primary session data directory (Claude Code JSONL files)              |
| `EXTRA_SESSION_ROOTS`                               | --                  | Additional session directories, comma-separated paths                 |
| `OPENCODE_DATA_DIR`                                 | (see below)         | Override OpenCode data directory (default: `~/.local/share/opencode`) |
| `KNOWLEDGE_ANTHROPIC_API_KEY` / `ANTHROPIC_API_KEY` | --                  | API key for Claude/Voyage embeddings                                  |
| `KNOWLEDGE_PORT`                                    | `3423`              | Dashboard HTTP port                                                   |

## Documentation

- [Setup Guide](docs/SETUP.md) — installation, client setup (Claude Code, OpenCode, Cursor, Windsurf), hooks
- [Architecture](docs/ARCHITECTURE.md) — source structure, design principles, database schema
- [Dashboard](docs/DASHBOARD.md) — web UI views and features
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)

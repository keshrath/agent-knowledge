# agent-knowledge

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node >= 20](https://img.shields.io/badge/Node-%3E%3D%2020-brightgreen.svg)](https://nodejs.org)
[![Tests: 558 passing](https://img.shields.io/badge/Tests-558%20passing-brightgreen.svg)]()
[![MCP Tools: 6](https://img.shields.io/badge/MCP%20Tools-6-blueviolet.svg)]()
[![LongMemEval R@5: 98.8%](https://img.shields.io/badge/LongMemEval%20R%405-98.8%25-brightgreen.svg)]()

**Cross-session memory and recall for AI coding assistants** -- works with Claude Code, Cursor, OpenCode, Cline, Continue.dev, and Aider out of the box. Git-synced knowledge base, hybrid semantic+TF-IDF search, auto-distillation with secrets scrubbing.

**Benchmark:** **R@5 = 97.2% (sparse) / 98.8% (hybrid)** on `longmemeval_s` and **86.0% (sparse) / 88.4% (hybrid)** on the harder `longmemeval_m` split — the public LongMemEval academic benchmark (Wu et al. 2024, ICLR 2025), full 500 questions per split, no LLM, no API key, runs entirely offline. **+8.6pp to +13.2pp R@5 over the paper's official `flat-bm25` baseline** in apples-to-apples reproduction. Full per-category table, reproduction instructions, and paper-comparison details in [`bench/README.md`](bench/README.md).

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
| **Claude Code**  | JSONL          | `~/.claude/projects/`                                           |
| **Cursor**       | JSONL          | `~/.cursor/projects/*/agent-transcripts/`                       |
| **Codex CLI**    | JSONL          | `~/.codex/projects/`                                            |
| **Aider**        | Markdown/JSONL | `.aider.chat.history.md` / `.aider.llm.history` in project dirs |
| **Continue.dev** | JSON           | `~/.continue/projects/`                                         |
| **Cline**        | JSON           | VS Code globalStorage `saoudrizwan.claude-dev/tasks/`           |
| **OpenCode**     | SQLite         | `~/.local/share/opencode/opencode.db` (or `$OPENCODE_DATA_DIR`) |

No configuration needed. Additional session roots can be added via the `AGENT_KNOWLEDGE_EXTRA_SESSION_ROOTS` env var (comma-separated paths).

## Features

- **Host-agnostic session search** -- unified search across every major AI coding assistant (Claude Code, Cursor, Codex CLI, Aider, Continue.dev, Cline, OpenCode). No host name is baked into configuration — the adapter registry probes installed host roots at startup.
- **Hybrid search** -- semantic vector similarity blended with TF-IDF keyword ranking
- **Git-synced knowledge base** -- markdown vault with YAML frontmatter, auto commit and push on writes
- **Automatic staleness detection (v1.8.1)** -- `knowledge_analyze(action: "stale_by_code_activity")` cross-references file paths mentioned in each entry body against `filesModified` in recent session summaries. Pairs with a symbol-presence precision layer: identifiers the entry quotes (inline backticks + fenced blocks) are checked in the touched file; if they still exist, confidence downweights ×0.3. Entries with `evergreen: true` are exempt.
- **Search-gap tracking (v1.8.1)** -- `knowledge_analyze(action: "search_gaps")` surfaces zero-result queries over the last `since_days`, grouped by token-Jaccard similarity. The clearest signal for "what entries should I write next?".
- **Section-priority context packer (v1.8.1)** -- `knowledge(action: "wakeup")` assembles a multi-section bundle (`identity` → `active_tasks` → `recent_decisions` → `known_gotchas` → `last_session_summary` → `top_weighted` → `semantic_fallback`) within a token budget. Unused section budget redistributes to later sections.
- **Scored + gated promoter (v1.8)** -- session insights promoted via a 6-signal weighted scorer with three independent gates (`minScore`, `minRecallCount`, `minUniqueQueries`). Runs automatically in background, on demand via `knowledge_admin(action: "promote")`, or benchable offline via `npm run bench:promote`. Emits an auditable `.dreams/YYYY-MM-DD.md` diary every run. Replaces the regex-only distiller.
- **Pluggable adapter system** -- add support for new tools by implementing the `SessionAdapter` interface
- **Embeddings** -- local (Hugging Face), OpenAI, Claude/Voyage, or Gemini providers
- **Fuzzy matching** -- typo-tolerant search using Levenshtein distance
- **6 search scopes** -- errors, plans, configs, tools, files, decisions
- **6 MCP tools** -- consolidated action-based interface (`knowledge`, `knowledge_search`, `knowledge_session`, `knowledge_graph`, `knowledge_analyze`, `knowledge_admin`)
- **Evergreen entries (v1.8)** -- `evergreen: true` in frontmatter exempts an entry from decay in ranking AND makes it append-only under promotion. Dashboard renders a push-pin badge on these cards.
- **Author attribution (v1.8.1)** -- optional `author: <string>` frontmatter surfaces as a muted chip on each card.
- **Code graph resolution** -- `calls`, `imports`, `inherits` edge types for code structure; directed BFS traversal (`outbound`/`inbound`/`both`); `bulk_link` for efficient ingestion; `unlink_by_origin` for clearing stale code edges before re-ingest; `code:` prefixed node IDs distinguish code from knowledge
- **Temporal knowledge graph** -- edges support `valid_from` / `valid_to` validity windows; `as_of` queries return point-in-time snapshots; `invalidate` action marks facts as ended without deleting them
- **Hybrid scoring boosts** -- proper-noun and temporal-proximity boosts on top of TF-IDF + semantic blend, capped at +66.7%, short-circuit when no signals are present
- **Category as boost (not filter)** -- opt into `category_mode: "boost"` so a wrong category guess down-ranks instead of discarding the right answer
- **Verbatim session indexing** -- per-message chunks (≥30 chars) embedded into the vector store so raw conversation is retrievable; toggle with `AGENT_KNOWLEDGE_INDEX_VERBATIM=false`
- **Configurable git URL** -- `knowledge_admin(action: "config")` for runtime setup, persisted at XDG/AppData location
- **Cross-machine persistence** -- knowledge syncs via git, sessions read from local storage of each tool
- **Real-time dashboard** -- browse, search, and manage at `localhost:3423`
- **Secrets scrubbing** -- API keys, tokens, passwords, private keys automatically redacted before git push
- **Knowledge graph** -- relationship edges between entries (related_to, supersedes, depends_on, contradicts, specializes, part_of, alternative_to, builds_on) with BFS traversal
- **Confidence/decay scoring** -- entries scored by access frequency and recency; auto-promotion from candidate to established to proven
- **Memory consolidation** -- TF-IDF duplicate detection on write (warns of similar entries) plus `knowledge_analyze(action: "consolidate")` for batch dedup scanning
- **Reflection cycle** -- `knowledge_analyze(action: "reflect")` surfaces unconnected entries and generates structured prompts for the agent to identify new graph connections
- **Auto-linking on write** -- new entries automatically linked to top-3 similar existing entries when cosine similarity > 0.7
- **Confidence metadata** — entries tagged `extracted` (user-written) or `inferred` (auto-distilled, 0.85× search rank multiplier); `confidence_score` field carries the model's certainty 0-1
- **Knowledge analysis** — `knowledge_analyze` actions `god_nodes` (most-connected entries), `bridges` (cross-category connectors), `gaps` (isolated entries)
- **Knowledge brief** — `knowledge_analyze(action: "brief")` returns a cached ~200 token summary (core concepts, active projects, recent decisions, stale and gap counts) for session-start orientation
- **Edge provenance** — graph edges track `origin` (manual, auto-link, distill, reflect) so analysis can distinguish user judgment from automated heuristics
- **Deterministic pre-extraction in distillation** — session summaries now include git commits, error patterns, URLs accessed, and packages changed extracted via regex from bash/tool output (no LLM cost)
- **Freshness metadata on every search hit (v1.8.1)** — every knowledge result carries `freshness: { body_age_days, last_accessed, access_count, verified_at, verification_age_days, evergreen }`. Agent reads the trust signal and decides; we impose no policy demotion.
- **Per-category decay windows (v1.8.1)** — the "Unused" filter and bytype chart honor per-category thresholds (projects 180d, people 365d, decisions 90d, workflows 60d, notes 30d) so identity-shaped content doesn't look stale just because it isn't re-read weekly.
- **Lifecycle hooks** — `SessionStart` auto-wakeup + ingest-freshness check, `UserPromptSubmit` first-prompt targeted injection, `PreCompact` memory-flush nudge + distill, `SessionEnd` distill. Six hook scripts total, all fail-open, each toggleable via an `AGENT_KNOWLEDGE_*` env var. See [`docs/HOOKS.md`](docs/HOOKS.md).
- **Replaces host auto-memory** — on hosts with a per-session memory system (Claude Code's `~/.claude/projects/*/memory/`, similar in other IDEs), route durable user facts and feedback to agent-knowledge instead. Auto-memory is machine-local and invisible to other machines; agent-knowledge is git-synced, cross-machine, searchable, and surfaces in wakeup. See the Claude Code integration note in [`docs/USER-MANUAL.md`](docs/USER-MANUAL.md#persistent-memory--agent-knowledge-not-host-auto-memory).

## Codebase Ingestion

The **knowledge-ingest** skill populates or updates the knowledge base from a codebase directory. It uses tree-sitter for zero-token structural extraction (classes, functions, imports, call graphs, rationale comments), then clusters files into subsystems and creates knowledge entries + graph edges via existing MCP tools. Subsequent runs are incremental — only changed files are reprocessed.

```
/knowledge-ingest ./my-project
```

Uses the [Agent Skills standard](https://agentskills.io) — works with Claude Code, OpenCode, Cursor, Codex CLI, and Gemini CLI. See [Ingestion Guide](docs/INGEST.md) for details.

**Supported languages:** TypeScript, JavaScript, Python, Go, Rust, Java, C, C++.

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

| Tool        | Action   | Description                                                   | Parameters                                       |
| ----------- | -------- | ------------------------------------------------------------- | ------------------------------------------------ |
| `knowledge` | `list`   | List entries by category and/or tag                           | `category?`, `tag?`                              |
|             | `read`   | Read a specific entry                                         | `path` (required)                                |
|             | `write`  | Create/update entry (auto git sync)                           | `category`, `filename`, `content` (all required) |
|             | `delete` | Delete an entry (auto git sync)                               | `path` (required)                                |
|             | `sync`   | Manual git pull + push                                        | --                                               |
|             | `wakeup` | Return L0 identity + L1 top-weighted entries (token-budgeted) | `token_budget?`, `category?`                     |

### Search

| Tool               | Description                                   | Parameters                                                                                                                             |
| ------------------ | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `knowledge_search` | General hybrid TF-IDF + semantic (no `scope`) | `query`, `project?`, `role?`, `max_results?`, `ranked?`, `semantic?`, `category?`, `category_mode?`, `mmr?`, `mmr_lambda?`, `explain?` |
|                    | Scoped session-only recall (when `scope` set) | `query`, `scope`, `project?`, `max_results?`                                                                                           |

Response shape: `{mode: "general" | "scoped", sessions, knowledge}`. Scoped mode returns `knowledge: []` by design.

Scopes: `errors`, `plans`, `configs`, `tools`, `files`, `decisions`, `all`.

v1.8 search knobs:

- `mmr: true` applies Maximal Marginal Relevance re-ranking (kills near-duplicate clusters in top-K). `mmr_lambda` 0-1, default 0.7.
- `category_mode: "boost"` (default) gives matching-category entries a 1.25× score multiplier instead of dropping non-matches. Pass `"filter"` for legacy hard-filter behavior.
- `explain: true` attaches `score_components: {bm25, decay, maturity, confidence, category_boost, mmr_penalty}` to every knowledge hit.

### Sessions

| Tool                | Action    | Description                            | Parameters                                          |
| ------------------- | --------- | -------------------------------------- | --------------------------------------------------- |
| `knowledge_session` | `list`    | List sessions with metadata            | `project?`                                          |
|                     | `get`     | Retrieve full session conversation     | `session_id`, `project?`, `include_tools?`, `tail?` |
|                     | `summary` | Session summary (topics, tools, files) | `session_id`, `project?`                            |

### Knowledge Graph

| Tool              | Action             | Description                               | Parameters                                                        |
| ----------------- | ------------------ | ----------------------------------------- | ----------------------------------------------------------------- |
| `knowledge_graph` | `link`             | Create/update edge between entries        | `source`, `target`, `rel_type`, `strength?`                       |
|                   | `unlink`           | Remove edges between entries              | `source`, `target`, `rel_type?`                                   |
|                   | `invalidate`       | Mark edges as expired (set valid_to)      | `source`, `target`, `rel_type?`, `valid_to?`                      |
|                   | `list`             | List edges                                | `entry?`, `rel_type?`, `as_of?`                                   |
|                   | `traverse`         | Directed BFS traversal from an entry      | `entry`, `depth?`, `direction?`, `rel_type?`, `as_of?`            |
|                   | `bulk_link`        | Batch-create edges (code graph ingestion) | `edges` (array of {source, target, rel_type, strength?, origin?}) |
|                   | `unlink_by_origin` | Delete all edges by origin                | `origin`                                                          |

**Knowledge types**: `related_to`, `supersedes`, `depends_on`, `contradicts`, `specializes`, `part_of`, `alternative_to`, `builds_on`
**Code structure types**: `calls`, `imports`, `inherits`

**Traverse directions**: `outbound` (source→target), `inbound` (target→source), `both` (default, undirected)

### Analysis

| Tool                | Action        | Description                                | Parameters                  |
| ------------------- | ------------- | ------------------------------------------ | --------------------------- |
| `knowledge_analyze` | `consolidate` | Find near-duplicate entries                | `category?`, `threshold?`   |
|                     | `reflect`     | Find unconnected entries for linking       | `category?`, `max_entries?` |
|                     | `god_nodes`   | Most-connected entries (degree centrality) | `top_n?`                    |
|                     | `bridges`     | Cross-category connectors (betweenness)    | `top_n?`                    |
|                     | `gaps`        | Isolated entries (0-1 edges) by maturity   | `max_entries?`              |
|                     | `brief`       | Cached ~200 token knowledge base summary   | --                          |

### Admin

| Tool              | Action               | Description                                                | Parameters                                                                                     |
| ----------------- | -------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `knowledge_admin` | `status`             | Vector store statistics                                    | --                                                                                             |
|                   | `config`             | View or update configuration                               | `git_url?`, `memory_dir?`, `auto_distill?`                                                     |
|                   | `rebuild_embeddings` | Re-embed all knowledge entries (useful on provider switch) | --                                                                                             |
|                   | `prune_orphans`      | Delete embeddings for sessions no longer on disk           | `vacuum?`, `force_vacuum?`                                                                     |
|                   | `vacuum`             | Reclaim free pages in the vector store                     | --                                                                                             |
|                   | `promote`            | Scored + gated promoter (v1.8)                             | `promote_mode?` (`apply`\|`explain`), `min_score?`, `min_recall_count?`, `min_unique_queries?` |

### Scored promoter (v1.8)

Session insights no longer drop into the knowledge base via regex distillation. Instead, every project-level candidate is scored on six signals (relevance 0.30, frequency 0.24, query-diversity 0.15, recency 0.15, consolidation 0.10, conceptual-richness 0.06) and gated on `minScore ≥ 0.5`, `minRecallCount ≥ 2`, `minUniqueQueries ≥ 2`. All three gates must pass. Background auto-promotion is controlled by the same `auto_distill` config flag; invoke on demand with `knowledge_admin(action: "promote")`.

- `promote_mode: "explain"` (default) — score + gate candidates, write diary, DO NOT touch the KB.
- `promote_mode: "apply"` — promote candidates that pass, write diary, git-commit.
- Every run drops `~/agent-knowledge/.dreams/YYYY-MM-DD.md` with per-candidate signal breakdowns and gate outcomes. The `.`-prefixed dir is git-tracked but excluded from list/search.
- Grounded rehydration: a candidate is skipped if its source session file no longer exists on disk (prevents promoting deleted content).
- Entries with `evergreen: true` frontmatter are never overwritten by promotion — activity is appended.

Write-bench harness: `npm run bench:promote` — offline replay with auto-labeling by "referenced in later sessions". Compares gated promoter to a naive "ship all" baseline, reports precision / recall / F1. Use it to gate signal-weight or threshold changes before rolling them out.

## REST API

| Method | Endpoint                                | Description                |
| ------ | --------------------------------------- | -------------------------- |
| GET    | `/api/knowledge`                        | List knowledge entries     |
| GET    | `/api/knowledge/search?q=`              | Search knowledge base      |
| GET    | `/api/knowledge/:path`                  | Read a specific entry      |
| GET    | `/api/knowledge/god-nodes?top_n=`       | Most-connected entries     |
| GET    | `/api/knowledge/bridges?top_n=`         | Cross-category connectors  |
| GET    | `/api/knowledge/gaps?max_entries=`      | Isolated entries           |
| GET    | `/api/knowledge/brief`                  | Knowledge base brief       |
| GET    | `/api/sessions`                         | List sessions              |
| GET    | `/api/sessions/search?q=&role=&ranked=` | Search sessions (TF-IDF)   |
| GET    | `/api/sessions/recall?scope=&q=`        | Scoped recall              |
| GET    | `/api/sessions/:id`                     | Read a session             |
| GET    | `/api/sessions/:id/summary`             | Session summary            |
| POST   | `/api/knowledge`                        | Write entry (HTTP clients) |
| GET    | `/health`                               | Health check               |

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

Entries and code symbols can be connected via typed, weighted edges stored in a dedicated `edges` SQLite table. Eleven relationship types are supported — 8 for knowledge edges and 3 for code structure:

**Knowledge**: `related_to`, `supersedes`, `depends_on`, `contradicts`, `specializes`, `part_of`, `alternative_to`, `builds_on`
**Code structure**: `calls`, `imports`, `inherits`

- **`knowledge_graph(action: "link")`** creates or updates an edge (with optional strength 0-1)
- **`knowledge_graph(action: "unlink")`** removes edges (optionally filtered by type)
- **`knowledge_graph(action: "list")`** lists edges for an entry or relationship type
- **`knowledge_graph(action: "traverse")`** performs directed BFS traversal from a starting entry. Supports `direction` (`outbound`, `inbound`, `both`) and `rel_type` filter
- **`knowledge_graph(action: "bulk_link")`** batch-creates edges in a single transaction (for code graph ingestion)
- **`knowledge_graph(action: "unlink_by_origin")`** deletes all edges with a specific origin (for clearing stale code edges before re-ingest)

### Code Graph

Code structure edges are created by the `knowledge-ingest` skill during codebase ingestion. They use `code:` prefixed node IDs:

```
code:src/auth/middleware.ts                    # file node
code:src/auth/middleware.ts::validateToken      # symbol node
```

Query examples:

```
# Who calls validateToken?
knowledge_graph({ action: "traverse", entry: "code:src/auth.ts::validateToken", direction: "inbound", rel_type: "calls", depth: 3 })

# What breaks if I change this function?
knowledge_graph({ action: "traverse", entry: "code:src/auth.ts::validateToken", direction: "inbound", rel_type: "calls", depth: 5 })

# Combined: callers + knowledge context (decisions, design rationale)
knowledge_graph({ action: "traverse", entry: "code:src/auth.ts::validateToken", depth: 2 })
```

### Auto-linking

When `knowledge` with `action: "write"` creates or updates an entry, it automatically finds the top-3 most similar existing entries via cosine similarity and creates `related_to` edges for any pair scoring above 0.7.

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

**Scoped Recall** via `knowledge_search` with the `scope` parameter:

| Scope       | Matches                                   |
| ----------- | ----------------------------------------- |
| `errors`    | Stack traces, exceptions, failed commands |
| `plans`     | Architecture, TODOs, implementation steps |
| `configs`   | Settings, env vars, configuration files   |
| `tools`     | MCP tool calls, CLI commands              |
| `files`     | File paths, modifications                 |
| `decisions` | Trade-offs, rationale, choices            |

## Integrations

### REST Write Endpoint

`POST /api/knowledge` accepts `{ category, filename, content }` and runs the full write pipeline: git pull → file write → embedding index → auto-link → git push → duplicate check. Returns `{ path, autoLinks?, duplicateWarnings?, git }` with status 201.

This enables HTTP-based writes from other services without an MCP connection.

### agent-tasks KnowledgeBridge

[agent-tasks](https://github.com/keshrath/agent-tasks) has a built-in `KnowledgeBridge` that auto-pushes `learning` and `decision` artifacts to agent-knowledge on task completion. Entries land in `decisions/` with frontmatter tags (`agent-tasks`, project name, artifact type), are auto-indexed with embeddings, and auto-linked to similar entries. No configuration needed — if agent-knowledge is running at `localhost:3423`, it works.

## Testing

```bash
npm test              # 352 tests across 20 files
npm run test:watch    # Watch mode
npm run lint          # Type-check (tsc --noEmit)
```

## Environment Variables

All env vars live under the `AGENT_KNOWLEDGE_*` prefix. No host name is baked in — the adapter registry auto-detects installed AI coding hosts (`.claude`, `.cursor`, `.codex`, `.aider`, `.continue`, OpenCode) without configuration.

### Core

| Variable                              | Default             | Description                                                                                                                       |
| ------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_KNOWLEDGE_MEMORY_DIR`          | `~/agent-knowledge` | Git-synced knowledge base directory                                                                                               |
| `AGENT_KNOWLEDGE_GIT_URL`             | --                  | Git remote URL (auto-clones if dir missing)                                                                                       |
| `AGENT_KNOWLEDGE_AUTO_DISTILL`        | `true`              | Auto-distill session insights into the knowledge base                                                                             |
| `AGENT_KNOWLEDGE_INDEX_VERBATIM`      | `true`              | Index raw session message chunks into the vector store so conversation is retrievable later. Set `false` to save disk at scale.   |
| `AGENT_KNOWLEDGE_DATA_DIR`            | (platform config)   | Override the primary host data root. Leave unset in the common case — adapters auto-detect every well-known host root under `~/`. |
| `AGENT_KNOWLEDGE_EXTRA_SESSION_ROOTS` | --                  | Extra session directories, comma-separated. Added to whatever auto-detection finds.                                               |
| `AGENT_KNOWLEDGE_PORT`                | `3423`              | Dashboard HTTP/WebSocket port                                                                                                     |

### Embeddings

| Variable                                 | Default | Description                                                              |
| ---------------------------------------- | ------- | ------------------------------------------------------------------------ |
| `AGENT_KNOWLEDGE_EMBEDDING_PROVIDER`     | `local` | `local` \| `openai` \| `claude` \| `gemini`                              |
| `AGENT_KNOWLEDGE_EMBEDDING_ALPHA`        | `0.3`   | TF-IDF vs semantic blend weight (`0` = pure semantic, `1` = pure TF-IDF) |
| `AGENT_KNOWLEDGE_EMBEDDING_MODEL`        | --      | Override provider default model                                          |
| `AGENT_KNOWLEDGE_EMBEDDING_IDLE_TIMEOUT` | `60`    | Seconds before unloading the local model (`0` = keep loaded)             |
| `AGENT_KNOWLEDGE_EMBEDDING_THREADS`      | (auto)  | ONNX / OMP thread count for the local provider                           |

### API keys

Project-scoped overrides win over the standard keys. Set either; the scoped form lets you run agent-knowledge with a different key than the rest of your environment.

| Variable                            | Fallback            | Description                |
| ----------------------------------- | ------------------- | -------------------------- |
| `AGENT_KNOWLEDGE_OPENAI_API_KEY`    | `OPENAI_API_KEY`    | OpenAI embeddings          |
| `AGENT_KNOWLEDGE_ANTHROPIC_API_KEY` | `ANTHROPIC_API_KEY` | Claude / Voyage embeddings |
| `AGENT_KNOWLEDGE_GEMINI_API_KEY`    | `GEMINI_API_KEY`    | Gemini embeddings          |

### Hooks (v1.8 lifecycle integration)

| Variable                               | Default | Description                                                                                                                                               |
| -------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_KNOWLEDGE_AUTOWAKE`             | `1`     | Auto-inject a `knowledge(action: wakeup)` bundle into `SessionStart`. Set `0` to disable.                                                                 |
| `AGENT_KNOWLEDGE_WAKEUP_BUDGET`        | `800`   | Tokens for the wakeup bundle                                                                                                                              |
| `AGENT_KNOWLEDGE_FIRSTPROMPT_INJECT`   | `1`     | Run a targeted `knowledge_search` on the first user prompt and inject top hits. `0` / `false` / `off` to disable.                                         |
| `AGENT_KNOWLEDGE_FIRSTPROMPT_BUDGET`   | `600`   | Tokens for first-prompt injection (clamp `[100, 8000]`)                                                                                                   |
| `AGENT_KNOWLEDGE_FIRSTPROMPT_MAX_HITS` | `4`     | Max knowledge hits attached to the first prompt (clamp `[1, 20]`)                                                                                         |
| `AGENT_KNOWLEDGE_PRECOMPACT_NUDGE`     | `1`     | Before pre-compaction, nudge the agent to save context via `knowledge(action: write)`. `0` disables the nudge; `off` suppresses both nudge and disk dump. |

### External tool overrides

| Variable            | Default                   | Description                                                                             |
| ------------------- | ------------------------- | --------------------------------------------------------------------------------------- |
| `OPENCODE_DATA_DIR` | `~/.local/share/opencode` | Override where OpenCode's session DB lives (OpenCode's own env, honored by our adapter) |

## Documentation

- [Setup Guide](docs/SETUP.md) — installation, client setup (Claude Code, OpenCode, Cursor, Windsurf), hooks, skills
- [Ingestion Guide](docs/INGEST.md) — codebase ingestion skill, tree-sitter extraction, incremental updates
- [Architecture](docs/ARCHITECTURE.md) — source structure, design principles, database schema
- [Dashboard](docs/DASHBOARD.md) — web UI views and features
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)

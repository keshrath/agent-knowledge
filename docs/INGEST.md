# Codebase Ingestion

The **knowledge-ingest** skill populates or updates agent-knowledge from a codebase directory. It uses tree-sitter for zero-token structural extraction, then the agent distills the results into knowledge entries and graph edges.

**Same command for both initial ingest and updates** — the skill detects whether a `.knowledge-ingest-cache.json` exists in the target directory and behaves accordingly:

| Mode                   | Trigger             | Behavior                                                                                        |
| ---------------------- | ------------------- | ----------------------------------------------------------------------------------------------- |
| **Full ingest**        | No cache file found | Scans all files, creates all entries from scratch                                               |
| **Incremental update** | Cache file exists   | Only reprocesses changed files (SHA256 diff), adds new files, removes entries for deleted files |

## How It Works

```
Codebase → tree-sitter AST → clusters → knowledge entries + graph edges
            (zero tokens)     (agent)     (via existing MCP tools)
                                ↕
                    .knowledge-ingest-cache.json
                    (tracks SHA256 per file for incremental updates)
```

**Phase 1 — Structural extraction**: A standalone Node.js script (`scripts/tree-sitter-extract.mjs`) parses source files via web-tree-sitter (WASM). Extracts classes, functions, imports, exports, call graphs, rationale comments, and SHA256 hashes. No LLM tokens consumed.

**Phase 2 — Clustering**: The agent groups files into subsystems based on the dependency graph and directory structure. Identifies god nodes (most-imported symbols), entry points, and cross-cutting concerns.

**Phase 3 — Knowledge entries**: One entry per subsystem (not per file), plus project overview, architecture decisions from rationale comments, and workflow entries from CI configs. All created via `knowledge({ action: "write" })`.

**Phase 4 — Graph edges**: Subsystem relationships mapped via `knowledge_graph({ action: "link" })` — `part_of`, `depends_on`, `builds_on`. Auto-linking adds `related_to` edges automatically.

**Phase 4b — Code graph edges**: Call, import, and inheritance edges extracted from the tree-sitter data and created via `knowledge_graph({ action: "bulk_link" })`. Uses `code:` prefixed node IDs (e.g. `code:src/auth.ts::validateToken`). Stale edges from previous ingests are cleared first via `unlink_by_origin`. Cross-reference edges link code files to their knowledge subsystem entries.

**Phase 5 — Multi-modal**: PDFs, architecture diagrams, and URLs are processed if present.

## Prerequisites

The tree-sitter dependencies ship with agent-knowledge (v1.6.0+):

- `web-tree-sitter` — WASM-based parser (no native compilation)
- `tree-sitter-wasms` — pre-built grammar files for 8 languages

No additional installation needed.

## Supported Languages

| Language   | Extensions                          |
| ---------- | ----------------------------------- |
| TypeScript | `.ts`, `.tsx`                       |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs`       |
| Python     | `.py`                               |
| Go         | `.go`                               |
| Rust       | `.rs`                               |
| Java       | `.java`                             |
| C          | `.c`, `.h`                          |
| C++        | `.cpp`, `.cc`, `.cxx`, `.hpp`, etc. |

## Usage

### Supported Platforms

The skill uses the [Agent Skills standard](https://agentskills.io) (`SKILL.md`) and works on Claude Code, OpenCode, Cursor, Codex CLI, and Gemini CLI. `setup.js` installs to both `~/.claude/skills/` and `~/.agents/skills/` to cover all platforms.

```
/knowledge-ingest .
/knowledge-ingest ~/projects/my-api
/knowledge-ingest ./libs/auth
```

Or use natural language: "ingest this codebase", "scan this project", "load this into knowledge", "update knowledge", "refresh knowledge".

### Direct Script Usage

Run the tree-sitter extraction script directly (any platform):

```bash
node ~/.claude/mcp-servers/agent-knowledge/scripts/tree-sitter-extract.mjs ./my-project --json
```

Then use the JSON output to create knowledge entries via the REST API or MCP tools.

## Extraction Script

The tree-sitter extraction script is a standalone CLI:

```bash
node scripts/tree-sitter-extract.mjs <path> [options]
```

### Options

| Flag          | Default                        | Description                     |
| ------------- | ------------------------------ | ------------------------------- |
| `--include`   | all supported extensions       | Glob patterns (comma-separated) |
| `--exclude`   | node_modules, dist, .git, etc. | Directories to skip             |
| `--max-files` | 2000                           | Cap on files to process         |
| `--json`      | compact                        | Pretty-print JSON output        |

### Output Schema

```json
{
  "version": 1,
  "timestamp": "2026-04-12T...",
  "root": "/path/to/project",
  "fileCount": 42,
  "files": [
    {
      "path": "src/foo.ts",
      "language": "typescript",
      "sha256": "abc123...",
      "size": 4200,
      "symbols": [
        {
          "kind": "class",
          "name": "FooService",
          "line": 10,
          "endLine": 85,
          "params": null,
          "docstring": "..."
        }
      ],
      "imports": [{ "source": "./bar", "names": ["BarService"] }],
      "exports": ["FooService"],
      "rationale": [{ "line": 22, "tag": "WHY", "text": "Debounce due to upstream rate limit" }],
      "calls": [{ "caller": "processFoo", "callee": "BarService.create" }]
    }
  ],
  "dependencyGraph": {
    "src/foo.ts": ["src/bar.ts"]
  }
}
```

## Incremental Updates

After the first ingest, a `.knowledge-ingest-cache.json` file is written to the target directory. On subsequent runs:

- **Unchanged files** (same SHA256): skipped entirely
- **Changed files**: re-extracted, corresponding knowledge entries updated
- **Deleted files**: their knowledge entries removed
- **New files**: processed normally

## What Gets Created

A typical 200-file project produces:

| Category     | Count | Content                                    |
| ------------ | ----- | ------------------------------------------ |
| `projects/`  | 1     | Project overview, tech stack, architecture |
| `notes/`     | 10-25 | Subsystem summaries                        |
| `decisions/` | 2-10  | From rationale comments                    |
| `workflows/` | 1-5   | From CI/build configs                      |

Plus graph edges: `part_of`, `depends_on`, `builds_on`, and auto-linked `related_to`.

## Customization

### Exclude patterns

```
/knowledge-ingest ./project --exclude "test,mock,generated"
```

Or pass to the script directly:

```bash
node scripts/tree-sitter-extract.mjs ./project --exclude "test,mock,generated,vendor"
```

### Large codebases

The `--max-files` flag (default 2000) caps how many files are processed, prioritizing the most recently modified. For very large repos, the agent also caps at 30 clusters and merges smaller ones.

## Code Graph

Starting with v1.7.0, `knowledge-ingest` creates code structure edges in the knowledge graph alongside knowledge entries. These edges enable code navigation queries via the existing `knowledge_graph` tool — no additional MCP tools needed.

### Edge Types

| Type       | Source                | Target                     | Example                                                |
| ---------- | --------------------- | -------------------------- | ------------------------------------------------------ |
| `calls`    | `code:file::caller`   | `code:file::callee`        | `code:src/auth.ts::validate` → `code:src/db.ts::query` |
| `imports`  | `code:importing-file` | `code:imported-file`       | `code:src/auth.ts` → `code:src/db.ts`                  |
| `inherits` | `code:file::subclass` | `code:file::superclass`    | `code:src/admin.ts::Admin` → `code:src/user.ts::User`  |
| `part_of`  | `code:file`           | `notes/project-cluster.md` | Links code files to their knowledge subsystem entry    |

### Node ID Convention

- **Code files**: `code:src/auth/middleware.ts` (relative path prefixed with `code:`)
- **Code symbols**: `code:src/auth/middleware.ts::validateToken` (file + `::` + symbol name)
- **Module-level calls**: `code:src/index.ts` (no `::` suffix — the call is at file scope)

### Querying the Code Graph

Use `knowledge_graph(action: "traverse")` with the `direction` and `rel_type` parameters:

```
# Who calls this function? (impact analysis)
knowledge_graph({
  action: "traverse",
  entry: "code:src/auth.ts::validateToken",
  direction: "inbound",
  rel_type: "calls",
  depth: 5
})

# What does this function call? (dependency analysis)
knowledge_graph({
  action: "traverse",
  entry: "code:src/auth.ts::validateToken",
  direction: "outbound",
  rel_type: "calls",
  depth: 3
})

# Combined: code callers + knowledge decisions (undirected, all types)
knowledge_graph({
  action: "traverse",
  entry: "code:src/auth.ts::validateToken",
  depth: 2
})
```

The combined query (no direction/rel_type filter) follows both `calls` edges to code callers AND `part_of`/`related_to` edges to knowledge entries — giving you "who calls this AND what design decisions exist about it" in one query.

### Re-ingest Behavior

On re-ingest, all code edges from the previous ingest are cleared via `unlink_by_origin` before creating new ones. Each project uses a unique origin (`tree-sitter:<project-name>`) so re-ingesting one project doesn't affect another's edges.

## Installation

### Via setup script

```bash
cd /path/to/agent-knowledge
node scripts/setup.js
```

Installs to both `~/.claude/skills/knowledge-ingest/` and `~/.agents/skills/knowledge-ingest/`, covering Claude Code, OpenCode, Cursor, Codex CLI, and Gemini CLI.

### Manual

Copy `skills/knowledge-ingest/SKILL.md` to either location:

```bash
~/.claude/skills/knowledge-ingest/SKILL.md   # Claude Code, OpenCode, Cursor
~/.agents/skills/knowledge-ingest/SKILL.md   # Codex CLI, Gemini CLI, universal
```

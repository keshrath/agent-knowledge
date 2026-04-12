---
name: knowledge-ingest
description: >
  Ingest or update a codebase in the agent-knowledge base. First run
  bootstraps the knowledge base from scratch; subsequent runs are
  incremental (only changed/new/deleted files reprocessed). Uses
  tree-sitter for zero-token structural extraction. Trigger on
  "/knowledge-ingest", "ingest this codebase", "load this into knowledge",
  "scan this project", "index this repo", "update knowledge",
  "refresh knowledge", "re-ingest".
---

# knowledge-ingest

Populate or update agent-knowledge from a codebase. Tree-sitter extracts structure (zero LLM tokens), then the agent distills clusters into knowledge entries + graph edges via existing MCP tools.

**First run**: full ingest — scans all files, creates entries from scratch.
**Subsequent runs**: incremental — only reprocesses files whose SHA256 changed, adds entries for new files, removes entries for deleted files. The `.knowledge-ingest-cache.json` file in the target directory tracks state between runs.

## When to use

- **Onboarding a new project** — bootstrap the knowledge base so future sessions have context
- **After a refactor** — re-run to update subsystem boundaries and relationships
- **Periodic refresh** — re-run after significant changes to keep knowledge current
- **Importing documentation** — PDFs, architecture diagrams, or external URLs

## When NOT to use

- Single-file changes — just write a knowledge entry manually
- No code changes since last ingest — the cache will skip everything anyway (fast no-op)

## Procedure

### Phase 0 — Validation

1. Confirm the target path exists and is a directory.
2. Detect project name:
   - Check `package.json` → `name` field
   - Check `Cargo.toml` → `[package] name`
   - Check `go.mod` → `module` line
   - Check `pyproject.toml` → `[project] name`
   - Fall back to directory basename
3. Check for `.knowledge-ingest-cache.json` in the target directory. If found, load it — this is an incremental run. Report how many files changed since last ingest.

### Phase 1 — Structural Extraction (zero tokens)

4. Locate the tree-sitter extraction script. It ships with agent-knowledge:

```bash
node "<agent-knowledge-repo>/scripts/tree-sitter-extract.mjs" "<target-path>" --exclude "node_modules,dist,.git,vendor,__pycache__,build,target,.venv,coverage" --json
```

To find `<agent-knowledge-repo>`, check common locations:

- `~/.claude/mcp-servers/agent-knowledge/`
- Or locate via: `dirname $(which agent-knowledge)/../`

5. Capture the JSON output. It contains per-file: symbols (classes, functions, methods), imports, exports, rationale comments (WHY/NOTE/DECISION/HACK/TODO/FIXME), call edges, SHA256 hashes, and a dependency graph.

6. If the script fails (missing dependency, path error), report the error to the user and offer to fall back to manual file reading for a subset of key files.

### Phase 2 — Clustering

7. From the dependency graph and directory structure, group files into subsystems:
   - Files that import each other heavily belong to the same cluster
   - Files in the same directory with related names belong to the same cluster
   - Entry points (files with no importers) get flagged as roots
   - Aim for **5-30 clusters**. If more, merge the smallest.
   - Name each cluster from its directory name or dominant class/module.

8. Identify structural highlights:
   - **God nodes**: symbols imported by 5+ files
   - **Entry points**: files not imported by anything (CLI entry, main, index)
   - **Cross-cutting concerns**: symbols used across multiple clusters

### Phase 3 — Knowledge Entry Creation

9. Create the **project overview** entry:

```
knowledge({ action: "write", category: "projects", filename: "<project-name>", content: "---\ntitle: <Project Name>\ntags: [auto-ingested, <primary-language>]\nupdated: <today>\nconfidence: inferred\nconfidence_score: 0.8\n---\n\n# <Project Name>\n\n## Tech Stack\n...\n\n## Architecture\n...\n\n## Entry Points\n...\n\n## Subsystems\n- <cluster-1>: <one-line description>\n- <cluster-2>: <one-line description>\n..." })
```

Include: project name, tech stack (languages, frameworks, key dependencies), directory structure overview, entry points, subsystem list with one-line descriptions.

10. For each cluster/subsystem, create a **subsystem entry**:

```
knowledge({ action: "write", category: "notes", filename: "<project>-<cluster-name>", content: "---\ntitle: <Project> — <Cluster Name>\ntags: [auto-ingested, subsystem, <language>]\nupdated: <today>\nconfidence: inferred\nconfidence_score: 0.75\n---\n\n## Purpose\n<inferred from symbol names and structure>\n\n## Key Symbols\n- `ClassName` (line N) — <from docstring or inferred>\n- `functionName(params)` (line N)\n\n## Dependencies\nImports from: <other clusters>\nImported by: <other clusters>\n\n## Rationale\n<any WHY/NOTE/DECISION comments found in this cluster>" })
```

Keep each entry **under 300 words**. Focus on structure and relationships, not implementation details.

11. For rationale comments (WHY/DECISION/HACK), create **decision entries**:

```
knowledge({ action: "write", category: "decisions", filename: "<project>-<slug>", content: "---\ntitle: <Decision summary>\ntags: [auto-ingested, rationale]\nupdated: <today>\nconfidence: extracted\nconfidence_score: 1.0\n---\n\n## Decision\n<the rationale comment text>\n\n## Context\nFile: `<file-path>`, line <N>\nSymbol: `<enclosing function/class>`\n\n## Related\n<other rationale comments or subsystems this connects to>" })
```

Only create decision entries for substantive rationale (WHY, DECISION, SAFETY). Skip generic TODOs and FIXMEs unless they contain real architectural reasoning.

12. For CI/build configs found in the project (`.github/workflows/`, `Makefile`, `Dockerfile`, `docker-compose.yml`, `Jenkinsfile`, `.gitlab-ci.yml`), read them directly and create **workflow entries**:

```
knowledge({ action: "write", category: "workflows", filename: "<project>-<workflow>", content: "..." })
```

Summarize: what the workflow does, triggers, key steps, deployment targets.

### Phase 4 — Graph Edges

13. Create `part_of` edges from each subsystem to the project:

```
knowledge_graph({ action: "link", source: "notes/<project>-<cluster>.md", target: "projects/<project>.md", rel_type: "part_of", strength: 0.9, origin: "ingest" })
```

14. Create `depends_on` edges between subsystems based on the import dependency graph:

```
knowledge_graph({ action: "link", source: "notes/<project>-<cluster-a>.md", target: "notes/<project>-<cluster-b>.md", rel_type: "depends_on", strength: 0.8, origin: "ingest" })
```

15. Create `builds_on` edges from decisions to the subsystem they relate to:

```
knowledge_graph({ action: "link", source: "decisions/<project>-<decision>.md", target: "notes/<project>-<cluster>.md", rel_type: "builds_on", strength: 0.7, origin: "ingest" })
```

16. Do NOT manually create `related_to` edges — auto-linking fires on every `knowledge write` and handles cross-entry similarity.

### Phase 5 — Multi-modal (if applicable)

17. If **PDF files** exist in the project (root, `docs/`, `papers/`):
    - Read them natively (agent is multimodal)
    - Write a summary entry to `notes/<project>-<pdf-name>.md`

18. If **architecture diagram images** exist (`.png`, `.svg`, `.jpg` in `docs/`, `architecture/`, `diagrams/`):
    - Read them natively
    - Write a description entry to `notes/<project>-<diagram-name>.md`

19. If **URLs** are provided by the user:
    - Fetch via WebFetch
    - Write summary entries to `notes/`

20. Skip this phase entirely if no such files exist. Do not search exhaustively for media files.

### Phase 6 — Cache

21. Write `.knowledge-ingest-cache.json` to the target directory:

```json
{
  "version": 1,
  "timestamp": "<ISO date>",
  "project": "<project-name>",
  "agent_knowledge_version": "<version>",
  "files": {
    "src/foo.ts": {
      "sha256": "abc123...",
      "entries": ["notes/<project>-foo-module.md"]
    }
  },
  "entries_created": [
    "projects/<project>.md",
    "notes/<project>-core.md",
    "decisions/<project>-auth-design.md"
  ]
}
```

22. On **incremental re-runs**, compare SHA256 hashes:
    - Unchanged files: skip entirely
    - Changed files: re-extract, update corresponding entries
    - Deleted files: remove their entries from knowledge base via `knowledge({ action: "delete" })`
    - New files: process normally

### Phase 7 — Validate

23. Run the validation script to verify the ingest produced correct results:

```bash
node "<agent-knowledge-repo>/skills/knowledge-ingest/scripts/validate.mjs" "<target-path>"
```

24. Parse the JSON output. If `status` is `FAIL`:
    - Review each issue in the `issues` array
    - Fix the issue (create missing entries, repair the cache file, etc.)
    - Re-run validation until it passes
    - Only proceed to the report once validation passes

### Phase 8 — Report

25. Print a summary:

```
Ingested <project-name>:
  Files scanned: N
  Clusters identified: N
  Entries created:
    - projects/: 1
    - notes/: N (subsystems)
    - decisions/: N (rationale)
    - workflows/: N (CI/build)
  Graph edges: N
  Skipped (cached): N files unchanged
```

## Anti-patterns

- **Do NOT read every file** — that defeats the purpose of tree-sitter extraction. Only read files the agent needs for summarization (CI configs, READMEs, a few key entry points).
- **Do NOT create one entry per file** — cluster into subsystems. A 200-file project should produce ~15-25 entries, not 200.
- **Do NOT skip the cache write** — it is essential for incremental updates.
- **Do NOT create `related_to` edges manually** — auto-linking handles this on every write.
- **Do NOT exceed 40 `knowledge write` calls** in a single run — batch small clusters together if needed.
- **Do NOT include raw source code** in knowledge entries — focus on structure, purpose, and relationships.

## Examples

```
/knowledge-ingest .
/knowledge-ingest ~/projects/my-api
/knowledge-ingest ./libs/auth --exclude "test,mock"
```

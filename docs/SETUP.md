# Setup Guide

Detailed instructions for installing, configuring, and integrating agent-knowledge with any MCP-compatible AI agent or coding assistant.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Client Setup](#client-setup)
  - [Claude Code](#claude-code)
  - [OpenCode](#opencode)
  - [Cursor](#cursor)
  - [Windsurf](#windsurf)
  - [REST API](#rest-api)
- [Hooks](#hooks)
  - [Claude Code Hooks](#claude-code-hooks)
  - [OpenCode Plugins](#opencode-plugins)
  - [Cursor and Windsurf](#cursor-and-windsurf)
- [Knowledge Base Setup](#knowledge-base-setup)
- [Environment Variables](#environment-variables)
- [Dashboard](#dashboard)
- [Multi-Machine Sync](#multi-machine-sync)
- [Session Sources](#session-sources)
- [Session Auto-Distillation](#session-auto-distillation)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

- **Node.js 20+** (ES modules and TypeScript features)
- **Git** (for knowledge base sync)

```bash
node --version   # v20.0.0 or later
git --version
```

---

## Installation

```bash
git clone https://github.com/keshrath/agent-knowledge.git
cd agent-knowledge
npm install
npm run build
```

For development with auto-rebuild:

```bash
npm run dev
```

---

## Client Setup

agent-knowledge works with any MCP client (stdio) or HTTP client (REST API). Pick your client below.

### Claude Code

#### Register the MCP server

```bash
claude mcp add agent-knowledge -s user \
  -e KNOWLEDGE_MEMORY_DIR="$HOME/agent-knowledge" \
  -- node /path/to/agent-knowledge/dist/index.js
```

#### Permissions

Add to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["mcp__agent-knowledge__*"]
  }
}
```

#### Verify

```bash
claude mcp list
# Should show: agent-knowledge ... Connected
```

### OpenCode

`opencode.json` (project root) or `~/.config/opencode/opencode.json` (global):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "agent-knowledge": {
      "type": "local",
      "command": ["node", "/absolute/path/to/agent-knowledge/dist/index.js"],
      "environment": {
        "KNOWLEDGE_MEMORY_DIR": "/home/you/agent-knowledge",
        "KNOWLEDGE_PORT": "3423"
      }
    }
  }
}
```

### Cursor

`.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "agent-knowledge": {
      "command": "node",
      "args": ["/absolute/path/to/agent-knowledge/dist/index.js"],
      "env": {
        "KNOWLEDGE_MEMORY_DIR": "/home/you/agent-knowledge",
        "KNOWLEDGE_PORT": "3423"
      }
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "agent-knowledge": {
      "command": "node",
      "args": ["/absolute/path/to/agent-knowledge/dist/index.js"],
      "env": {
        "KNOWLEDGE_MEMORY_DIR": "/home/you/agent-knowledge",
        "KNOWLEDGE_PORT": "3423"
      }
    }
  }
}
```

### REST API

If your tool doesn't support MCP, use the REST API:

```bash
# List entries
curl http://localhost:3423/api/knowledge

# Search
curl 'http://localhost:3423/api/knowledge/search?q=deployment+pipeline'

# Read an entry
curl http://localhost:3423/api/knowledge/projects/my-project

# Write an entry
curl -X PUT http://localhost:3423/api/knowledge/notes/my-note \
  -H 'Content-Type: application/json' \
  -d '{"content": "---\ntitle: My Note\ntags: [example]\n---\n\nContent here."}'
```

---

## Hooks

Hooks announce the dashboard URL on session start. Support varies by client.

### Claude Code Hooks

#### SessionStart + SubagentStart (`scripts/hooks/session-start.js`)

Announces the knowledge dashboard URL on session start. Also fires for subagents via `SubagentStart`, ensuring spawned agents know about the knowledge base.

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/path/to/agent-knowledge/scripts/hooks/session-start.js\"",
            "timeout": 5
          }
        ]
      }
    ],
    "SubagentStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/path/to/agent-knowledge/scripts/hooks/session-start.js\"",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

### OpenCode Plugins

OpenCode supports lifecycle hooks via JavaScript/TypeScript plugins. Create a plugin in `.opencode/plugins/` or `~/.config/opencode/plugins/`:

```typescript
// .opencode/plugins/agent-knowledge.ts
import type { Plugin } from '@opencode-ai/plugin';

export const AgentKnowledgePlugin: Plugin = async ({ client }) => {
  return {
    event: async (event) => {
      if (event.type === 'session.created') {
        // Knowledge base instructions provided via AGENTS.md
      }
    },
  };
};
```

Available events: `session.created`, `session.idle`, `tool.execute.before`, `tool.execute.after`, `message.updated`, `file.edited`.

Combine with `AGENTS.md` instructions (see below).

### Cursor and Windsurf

Cursor and Windsurf don't support lifecycle hooks. Use rules files instead:

| Client   | Rules location        |
| -------- | --------------------- |
| Cursor   | `.cursor/rules/*.mdc` |
| Windsurf | `.windsurfrules`      |

#### Cursor Rules Setup

Create `.cursor/rules/agent-mcp-stack.mdc` with "Always Apply" mode:

```yaml
---
description: Agent MCP stack integration
globs: *
alwaysApply: true
---

# Agent MCP Stack

## Default behavior in every chat

Treat `agent-comm`, `agent-knowledge`, and `agent-tasks` as default infrastructure
for this repository. Do not wait for the user to restate this.

At the start of each new chat/session:

1. Bootstrap `agent-comm` (`comm_register`, join `general`, send one-line intent, then `comm_inbox`).
2. Use `agent-knowledge` first for recall/session context when it can help
   (especially prior decisions, errors, tool usage, and related sessions).
3. Check `agent-tasks` before creating work (`task_list`), and keep task
   state/artifacts/comments current when work spans more than one step.

If an MCP server is unavailable, report it briefly and continue with local tools;
retry MCP usage after restoring connectivity.
```

Optionally create `.cursor/rules/session-wrapup-knowledge.mdc` for session wrap-up:

```yaml
---
description: Save session learnings to knowledge base
globs: *
alwaysApply: false
---

# Session Wrap-up

Before ending a session, save non-obvious learnings to agent-knowledge:

1. `knowledge_search` for existing entries that overlap with this session's work.
2. `knowledge { action: "write" }` new entries for decisions, architecture changes, or error patterns
   that aren't already captured.
3. `knowledge_link` related entries together.

Categories: projects (project context), decisions (trade-offs made), workflows (processes),
notes (everything else).
```

#### Windsurf

Add equivalent instructions to `.windsurfrules` in your project root.

---

## Knowledge Base Setup

The knowledge base is a git repository with categorized markdown files.

### Clone existing or create new

```bash
# Clone existing
git clone https://your-git-host/agent-knowledge.git ~/agent-knowledge

# Or create new
mkdir -p ~/agent-knowledge && cd ~/agent-knowledge && git init
mkdir projects people decisions workflows notes
git add . && git commit -m "Initialize knowledge base"
git remote add origin <your-remote-url>
git push -u origin main
```

### Directory structure

```
~/agent-knowledge/
  projects/       # Project context, architecture, tech stacks
  people/         # Team members, contacts, preferences
  decisions/      # Architecture decisions, trade-offs, rationale
  workflows/      # Processes, deployment steps, runbooks
  notes/          # General notes, research, references
```

### Entry format

```markdown
---
title: My Project
tags: [typescript, react, postgres]
updated: 2026-03-25
---

# My Project

Architecture notes, deployment info, etc.
```

---

## Environment Variables

| Variable                                            | Default             | Description                                                    |
| --------------------------------------------------- | ------------------- | -------------------------------------------------------------- |
| `KNOWLEDGE_MEMORY_DIR`                              | `~/agent-knowledge` | Path to git-synced knowledge base                              |
| `KNOWLEDGE_DATA_DIR`                                | `~/.claude`         | Primary session data directory (Claude Code JSONL)             |
| `EXTRA_SESSION_ROOTS`                               | --                  | Additional session directories, comma-separated                |
| `OPENCODE_DATA_DIR`                                 | (platform default)  | Override OpenCode data dir (default `~/.local/share/opencode`) |
| `KNOWLEDGE_PORT`                                    | `3423`              | Dashboard HTTP/WebSocket port                                  |
| `KNOWLEDGE_EMBEDDING_PROVIDER`                      | `local`             | Embedding provider (local, openai, claude, gemini)             |
| `KNOWLEDGE_EMBEDDING_ALPHA`                         | `0.5`               | Blend weight for semantic vs TF-IDF search (0-1)               |
| `KNOWLEDGE_EMBEDDING_IDLE_TIMEOUT`                  | —                   | Idle timeout for embedding worker (ms)                         |
| `KNOWLEDGE_EMBEDDING_THREADS`                       | —                   | Number of ONNX threads for local embeddings                    |
| `KNOWLEDGE_EMBEDDING_MODEL`                         | —                   | Model name for embedding provider                              |
| `KNOWLEDGE_GIT_URL`                                 | —                   | Remote git URL for knowledge base sync                         |
| `KNOWLEDGE_AUTO_DISTILL`                            | —                   | Enable auto-distillation of sessions (true/false)              |
| `KNOWLEDGE_OPENAI_API_KEY` / `OPENAI_API_KEY`       | —                   | API key for OpenAI embeddings                                  |
| `KNOWLEDGE_ANTHROPIC_API_KEY` / `ANTHROPIC_API_KEY` | —                   | API key for Claude/Voyage embeddings                           |
| `KNOWLEDGE_GEMINI_API_KEY` / `GEMINI_API_KEY`       | —                   | API key for Gemini embeddings                                  |

Set in your shell profile or pass via MCP config:

```bash
export KNOWLEDGE_MEMORY_DIR="$HOME/agent-knowledge"
```

On Windows (PowerShell):

```powershell
$env:KNOWLEDGE_MEMORY_DIR = "$env:USERPROFILE\agent-knowledge"
```

---

## Dashboard

Auto-starts with the MCP server at **http://localhost:3423**.

4 tabs: Knowledge, Search, Sessions, Embeddings. Supports light/dark theme.

Live reload: edit files in `src/ui/` and the browser refreshes automatically.

---

## Multi-Machine Sync

| Operation                             | Git Action                     | When           |
| ------------------------------------- | ------------------------------ | -------------- |
| `knowledge` action: `read`, `list`    | `git pull --rebase`            | Before reading |
| `knowledge` action: `write`, `delete` | `git add -A && commit && push` | After writing  |
| `knowledge` action: `sync`            | `git pull` then `git push`     | Manual trigger |

Ensure git credentials are configured (SSH key or credential helper):

```bash
cd ~/agent-knowledge && git pull && git push  # Should work without prompts
```

---

## Session Sources

agent-knowledge auto-discovers sessions from all major AI coding assistants. If a tool is installed on your machine, its sessions appear automatically in search results and the dashboard Sessions tab.

| Tool             | Format         | Auto-detected path                                              | Override              |
| ---------------- | -------------- | --------------------------------------------------------------- | --------------------- |
| **Claude Code**  | JSONL          | `$KNOWLEDGE_DATA_DIR/projects/`                                 | `KNOWLEDGE_DATA_DIR`  |
| **Cursor**       | JSONL          | `~/.cursor/projects/*/agent-transcripts/`                       | `EXTRA_SESSION_ROOTS` |
| **OpenCode**     | SQLite         | `~/.local/share/opencode/opencode.db`                           | `OPENCODE_DATA_DIR`   |
| **Cline**        | JSON           | VS Code globalStorage `saoudrizwan.claude-dev/tasks/`           | --                    |
| **Continue.dev** | JSON           | `~/.continue/sessions/`                                         | --                    |
| **Aider**        | Markdown/JSONL | `.aider.chat.history.md` / `.aider.llm.history` in project dirs | --                    |

### Adding extra session directories

Use the `EXTRA_SESSION_ROOTS` environment variable to add session directories that are not auto-detected:

```bash
export EXTRA_SESSION_ROOTS="/path/to/custom/sessions,/another/path"
```

Each path is scanned for JSONL files or Cursor-style `agent-transcripts/` subdirectories.

## Session Auto-Distillation

agent-knowledge can auto-distill session transcripts into knowledge entries. Auto-distillation reads from all discovered session sources and works with any tool whose sessions are available through the adapter system.

To manually save knowledge from any client, use `knowledge` with `action: "write"`.

---

## Troubleshooting

### Port already in use

```bash
# Find the process
netstat -ano | findstr :3423   # Windows
lsof -i :3423                  # Linux/macOS

# Use a different port
export KNOWLEDGE_PORT=3424
```

### Git authentication failures

Verify credentials work manually:

```bash
cd ~/agent-knowledge && git push
```

Set up SSH keys or a credential helper if prompted.

### MCP server not connecting

1. Check path points to `dist/index.js` (not `src/index.ts`)
2. Verify Node.js 20+ is on your PATH
3. Try running manually: `node /path/to/agent-knowledge/dist/index.js`

### No session results

Verify session data exists for at least one supported tool:

```bash
# Claude Code (JSONL)
ls ~/.claude/projects/

# Cursor (JSONL)
ls ~/.cursor/projects/*/agent-transcripts/

# OpenCode (SQLite)
ls ~/.local/share/opencode/opencode.db

# Cline (JSON) — path varies by platform
# Windows: %APPDATA%/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/
# macOS:   ~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/
# Linux:   ~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/

# Continue.dev (JSON)
ls ~/.continue/sessions/

# Aider (Markdown) — check project directories
ls ~/projects/*/.aider.chat.history.md
```

If your session data is in a non-standard location, use `EXTRA_SESSION_ROOTS` to point to it.

## Client Comparison

| Feature              | Claude Code | Cursor               | OpenCode      | Cline      | Continue.dev | Aider          | Windsurf       |
| -------------------- | ----------- | -------------------- | ------------- | ---------- | ------------ | -------------- | -------------- |
| MCP stdio transport  | Yes         | Yes                  | Yes           | Yes        | Yes          | --             | Yes            |
| Session reading      | Yes (JSONL) | Yes (JSONL)          | Yes (SQLite)  | Yes (JSON) | Yes (JSON)   | Yes (MD/JSONL) | --             |
| Lifecycle hooks      | Yes (JSON)  | No                   | Yes (plugins) | No         | No           | --             | No             |
| Session auto-distill | Yes         | Yes                  | Yes           | Yes        | Yes          | Yes            | --             |
| System prompt file   | CLAUDE.md   | .cursor/rules/\*.mdc | AGENTS.md     | --         | --           | --             | .windsurfrules |
| REST API fallback    | Yes         | Yes                  | Yes           | Yes        | Yes          | Yes            | Yes            |

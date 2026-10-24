import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface GitResult {
  success: boolean;
  message: string;
}

const CATEGORIES = ['projects', 'people', 'decisions', 'workflows', 'notes'];

/**
 * Run a git command safely using execFileSync (no shell).
 */
function execGit(args: string[], cwd: string, timeout: number): string {
  try {
    const output = execFileSync('git', args, {
      cwd,
      stdio: 'pipe',
      timeout,
    });
    return output ? output.toString().trim() : '';
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer; message?: string };
    const msg = e.stderr ? e.stderr.toString().trim() : (e.message ?? String(err));
    throw new Error(`git ${args[0]} failed: ${msg}`, { cause: err });
  }
}

/**
 * Pull latest changes from remote with rebase.
 */
export async function gitPull(dir: string): Promise<GitResult> {
  try {
    const output = execGit(['pull', '--rebase', '--quiet'], dir, 15_000);
    return { success: true, message: output || 'up to date' };
  } catch (err: unknown) {
    return { success: false, message: err instanceof Error ? (err as Error).message : String(err) };
  }
}

/**
 * Stage all changes, commit if dirty, and push.
 * Only commits when there are staged changes.
 */
export async function gitPush(dir: string, commitMsg?: string): Promise<GitResult> {
  const message = commitMsg ?? 'update knowledge base';
  try {
    execGit(['add', '-A'], dir, 5_000);

    // Only commit if there are staged changes
    try {
      execGit(['diff', '--cached', '--quiet'], dir, 5_000);
      // No error means no changes — skip commit
    } catch {
      // diff --cached --quiet exits non-zero when there ARE changes
      execGit(['commit', '-m', message], dir, 5_000);
    }

    execGit(['push', '--quiet'], dir, 15_000);
    return { success: true, message: 'pushed successfully' };
  } catch (err: unknown) {
    return { success: false, message: err instanceof Error ? (err as Error).message : String(err) };
  }
}

/**
 * Pull then push — full bidirectional sync.
 */
export async function gitSync(dir: string): Promise<{ pull: GitResult; push: GitResult }> {
  const pull = await gitPull(dir);
  const push = await gitPush(dir);
  return { pull, push };
}

// ── Scaffold templates ──────────────────────────────────────────────────────

const SCAFFOLD_GITIGNORE = `# OS
.DS_Store
Thumbs.db
Desktop.ini

# Editors
*.swp
*.swo
*~
.vscode/
.idea/

# Secrets — never commit these
.env
.env.*
*.pem
*.key
credentials.*
secrets.*

# Obsidian — keep config, ignore workspace cache
.obsidian/workspace.json
.obsidian/workspace-mobile.json
.obsidian/cache/
`;

const SCAFFOLD_README = `# Knowledge Base

Shared knowledge base managed by [agent-knowledge](https://github.com/keshrath/agent-knowledge).

## Structure

\`\`\`
├── projects/    — Per-project context, architecture, tech stacks
├── people/      — Team members, roles, contacts
├── decisions/   — Architecture decisions, trade-offs
├── workflows/   — Processes, deployment steps, runbooks
└── notes/       — General notes, research, ideas
\`\`\`

## Auto-Distillation

Agent-knowledge automatically distills session insights into \`projects/\` entries:
- Topics discussed, tools used, files touched
- All content is scrubbed for secrets before committing
- Runs after each server startup

## Usage

### Via MCP tools

- \`knowledge\` (actions list, read, write, delete, sync, wakeup) — browse and edit entries
- \`knowledge_search\` — hybrid semantic + keyword search
- \`knowledge_admin\` (action config) — view or update settings

### File format

Markdown with optional YAML frontmatter:

\`\`\`markdown
---
title: My Project
tags: [backend, api]
updated: 2026-01-01
---

# My Project

Content here.
\`\`\`

## Security

Content is scrubbed before every git push:
- API keys, tokens, passwords, JWTs, private keys → redacted
- System noise (XML tags, task notifications) → stripped
- Absolute user paths → normalized to \`~/\`
- Final audit blocks writes that still contain sensitive patterns
`;

/**
 * Write scaffold files (README, .gitignore, category dirs) into a new
 * knowledge base directory. Skips files that already exist.
 */
function scaffoldRepo(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  for (const cat of CATEGORIES) {
    const catDir = join(dir, cat);
    if (!existsSync(catDir)) {
      mkdirSync(catDir, { recursive: true });
    }
  }

  const readme = join(dir, 'README.md');
  if (!existsSync(readme)) {
    writeFileSync(readme, SCAFFOLD_README, 'utf-8');
  }

  const gitignore = join(dir, '.gitignore');
  if (!existsSync(gitignore)) {
    writeFileSync(gitignore, SCAFFOLD_GITIGNORE, 'utf-8');
  }
}

// ── Repo initialization ─────────────────────────────────────────────────────

/**
 * Ensure the memory directory exists and is a git repo.
 *
 * - If dir missing + gitUrl set → clone, then scaffold missing files
 * - If dir exists but not a git repo + gitUrl set → scaffold + init + push
 * - If dir missing + no gitUrl → scaffold local-only dir
 * - If dir exists + is a git repo → no-op
 */
export function ensureRepo(dir: string, gitUrl?: string): GitResult {
  const isGitRepo = existsSync(join(dir, '.git'));

  if (isGitRepo) {
    return { success: true, message: 'repo already exists' };
  }

  if (!existsSync(dir) && gitUrl) {
    try {
      execGit(['clone', gitUrl, dir], process.cwd(), 30_000);
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
    scaffoldRepo(dir);
    try {
      execGit(['add', '-A'], dir, 5_000);
      execGit(['diff', '--cached', '--quiet'], dir, 5_000);
    } catch {
      try {
        execGit(['commit', '-m', 'add scaffold files'], dir, 5_000);
        execGit(['push', '--quiet'], dir, 15_000);
      } catch {
        /* push scaffold back may fail — that's ok */
      }
    }
    return { success: true, message: `cloned ${gitUrl} into ${dir}` };
  }

  scaffoldRepo(dir);

  if (gitUrl) {
    try {
      execGit(['init'], dir, 5_000);
      execGit(['remote', 'add', 'origin', gitUrl], dir, 5_000);
      execGit(['add', '-A'], dir, 5_000);
      try {
        execGit(['commit', '-m', 'init knowledge base'], dir, 5_000);
      } catch {
        /* no files to commit is fine */
      }
      try {
        execGit(['push', '-u', 'origin', 'HEAD', '--quiet'], dir, 15_000);
      } catch {
        /* remote may have existing content — pull first next time */
      }
      return { success: true, message: `initialized repo with remote ${gitUrl}` };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  return { success: true, message: 'created local-only memory directory (no git URL configured)' };
}

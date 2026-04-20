#!/usr/bin/env node

// =============================================================================
// agent-knowledge PreCompact / Stop hook — memory-flush
//
// Two jobs, both best-effort:
//
//   1. Dump the session summary to ~/agent-knowledge/sessions/<project>/ so
//      later distillation/promotion has a durable anchor even if the host
//      garbage-collects the transcript.
//
//   2. Emit a short "save-your-context" nudge as a top-level `systemMessage`.
//      The compaction pass is about to summarize — anything important and
//      unsaved should be written to the knowledge base NOW via
//      `knowledge(action="write", …)`. Pre-compaction memory-flush primitive.
//      (PreCompact rejects `hookSpecificOutput.additionalContext` — only
//      UserPromptSubmit/PostToolUse accept that shape — so the nudge rides
//      in `systemMessage`, which lands in the transcript and survives
//      compaction.)
//
// Disable the nudge by exporting AGENT_KNOWLEDGE_PRECOMPACT_NUDGE=0 (the disk
// dump still runs). Set AGENT_KNOWLEDGE_PRECOMPACT_NUDGE=off to suppress both.
//
// Fail-open: every error path prints a valid JSON response so the host never
// blocks on this hook.
//
// Reads hook JSON from stdin (the host pipes it). Fields used:
//   { session_id, hook_event_name, cwd? }
// =============================================================================

import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const NUDGE_MODE = (process.env.AGENT_KNOWLEDGE_PRECOMPACT_NUDGE ?? '1').trim().toLowerCase();
const nudgeEnabled = NUDGE_MODE !== '0' && NUDGE_MODE !== 'false' && NUDGE_MODE !== 'off';
const diskDumpEnabled = NUDGE_MODE !== 'off';

const NUDGE_TEXT = [
  'knowledge: PreCompact — flush durable facts to the KB before summary replaces the transcript.',
  'Write architectural decisions, non-obvious gotchas, hard-won commands, people/ownership facts, project state via',
  '`knowledge(action="write", category="decisions"|"notes"|"workflows", filename=..., content=...)`.',
  'Skip transient things (file diffs, TODO lists, in-flight plans — plan/task systems own those).',
].join(' ');

function emitResult(nudge) {
  const payload = nudge ? { systemMessage: nudge } : {};
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(0);
}

function warn(msg) {
  process.stderr.write(`[precompact-flush] ${msg}\n`);
}

async function readStdin() {
  return new Promise((resolveP) => {
    let data = '';
    if (process.stdin.isTTY) return resolveP('');
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolveP(data));
    setTimeout(() => resolveP(data), 2000);
  });
}

function slugify(input) {
  return (input || 'session')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function memoryDir() {
  return process.env.AGENT_KNOWLEDGE_MEMORY_DIR || join(homedir(), 'agent-knowledge');
}

async function dumpSummaryToDisk({ sessionId, event, cwd, projectSlug }) {
  const distSummary = resolve(__dirname, '..', '..', 'dist', 'sessions', 'summary.js');
  if (!existsSync(distSummary)) {
    warn(`dist not built: ${distSummary} (run \`npm run build\`)`);
    return;
  }

  let summaryFn;
  try {
    const mod = await import(`file://${distSummary.replace(/\\/g, '/')}`);
    summaryFn = mod.getSessionSummary;
  } catch (err) {
    warn(`import failed: ${err?.message || err}`);
    return;
  }
  if (typeof summaryFn !== 'function') {
    warn('getSessionSummary not exported from dist/sessions/summary.js');
    return;
  }

  let summary;
  try {
    summary = summaryFn(sessionId);
  } catch (err) {
    warn(`getSessionSummary threw: ${err?.message || err}`);
    return;
  }
  if (!summary) {
    warn(`session ${sessionId} not found — nothing to flush`);
    return;
  }

  const outDir = join(memoryDir(), 'sessions', projectSlug);
  try {
    mkdirSync(outDir, { recursive: true });
  } catch (err) {
    warn(`mkdir ${outDir}: ${err?.message || err}`);
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = join(outDir, `${event}-${stamp}-${sessionId.slice(0, 8)}.md`);

  const body = [
    '---',
    `session_id: ${sessionId}`,
    `event: ${event}`,
    `flushed_at: ${new Date().toISOString()}`,
    `cwd: ${cwd}`,
    '---',
    '',
    `# Session ${sessionId}`,
    '',
    typeof summary === 'string'
      ? summary
      : '```json\n' + JSON.stringify(summary, null, 2) + '\n```',
    '',
  ].join('\n');

  try {
    writeFileSync(outPath, body, 'utf-8');
    warn(`wrote ${outPath}`);
  } catch (err) {
    warn(`write ${outPath}: ${err?.message || err}`);
    return;
  }

  // Best-effort: append a breadcrumb readable later by `knowledge` action=list
  try {
    const breadcrumb = join(memoryDir(), 'sessions', 'index.md');
    const existing = existsSync(breadcrumb)
      ? readFileSync(breadcrumb, 'utf-8')
      : '# Session flushes\n';
    writeFileSync(
      breadcrumb,
      existing + `- ${event} ${stamp} ${sessionId} → ${outPath}\n`,
      'utf-8',
    );
  } catch {
    /* ignore */
  }
}

async function main() {
  const raw = await readStdin();
  let payload = {};
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      /* ignore — host may not pipe JSON */
    }
  }

  const sessionId = payload.session_id || process.env.CLAUDE_SESSION_ID || 'unknown';
  const event = payload.hook_event_name || 'precompact';
  const cwd = payload.cwd || process.cwd();
  const projectSlug = slugify(cwd.split(/[\\/]/).filter(Boolean).pop() || 'project');

  if (diskDumpEnabled) {
    await dumpSummaryToDisk({ sessionId, event, cwd, projectSlug });
  }

  emitResult(nudgeEnabled ? NUDGE_TEXT : undefined);
}

main().catch((err) => {
  warn(err?.message || String(err));
  emitResult(nudgeEnabled ? NUDGE_TEXT : undefined);
});

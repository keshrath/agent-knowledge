#!/usr/bin/env node

// =============================================================================
// agent-knowledge PreCompact / Stop hook
//
// Flushes a session summary to ~/agent-knowledge/sessions/ before the host
// (Claude Code, Cursor, Codex CLI, etc.) compacts or ends the conversation,
// so the verbatim distillation has something to anchor against later.
//
// Fail-open: any error
// is logged to stderr and the hook still prints `{}` so it never blocks the host.
//
// Wire-up (host-specific — examples):
//
//   Claude Code (~/.claude/settings.json):
//     {
//       "hooks": {
//         "PreCompact": [{"matcher": "", "hooks": [
//           {"type": "command",
//            "command": "node \"$HOME/.claude/mcp-servers/agent-knowledge/scripts/hooks/precompact-flush.mjs\"",
//            "timeout": 10}
//         ]}],
//         "Stop": [{"matcher": "", "hooks": [
//           {"type": "command",
//            "command": "node \"$HOME/.claude/mcp-servers/agent-knowledge/scripts/hooks/precompact-flush.mjs\"",
//            "timeout": 10}
//         ]}]
//       }
//     }
//
// Reads hook JSON from stdin (the host pipes it). The fields we look at:
//   { session_id, hook_event_name, cwd? }
// =============================================================================

import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function fail(msg) {
  process.stderr.write(`[precompact-flush] ${msg}\n`);
  process.stdout.write('{}\n');
  process.exit(0);
}

function ok() {
  process.stdout.write('{}\n');
  process.exit(0);
}

async function readStdin() {
  return new Promise((resolveP) => {
    let data = '';
    if (process.stdin.isTTY) return resolveP('');
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolveP(data));
    // Don't hang forever if the host doesn't pipe anything
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
  return process.env.KNOWLEDGE_MEMORY_DIR || join(homedir(), 'agent-knowledge');
}

async function main() {
  const raw = await readStdin();
  let payload = {};
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      // Ignore — host may not have piped JSON
    }
  }

  const sessionId = payload.session_id || process.env.CLAUDE_SESSION_ID || 'unknown';
  const event = payload.hook_event_name || 'precompact';
  const cwd = payload.cwd || process.cwd();
  const projectSlug = slugify(cwd.split(/[\\/]/).filter(Boolean).pop() || 'project');

  // Try to import the agent-knowledge summary helper directly (ESM dynamic import).
  // The compiled output lives next to this script: ../../dist/sessions/summary.js
  const distSummary = resolve(__dirname, '..', '..', 'dist', 'sessions', 'summary.js');
  if (!existsSync(distSummary)) {
    return fail(`dist not built: ${distSummary} (run \`npm run build\`)`);
  }

  let summaryFn;
  try {
    const mod = await import(`file://${distSummary.replace(/\\/g, '/')}`);
    summaryFn = mod.getSessionSummary;
  } catch (err) {
    return fail(`import failed: ${err?.message || err}`);
  }
  if (typeof summaryFn !== 'function') {
    return fail('getSessionSummary not exported from dist/sessions/summary.js');
  }

  let summary;
  try {
    summary = summaryFn(sessionId);
  } catch (err) {
    return fail(`getSessionSummary threw: ${err?.message || err}`);
  }
  if (!summary) {
    return fail(`session ${sessionId} not found — nothing to flush`);
  }

  const outDir = join(memoryDir(), 'sessions', projectSlug);
  try {
    mkdirSync(outDir, { recursive: true });
  } catch (err) {
    return fail(`mkdir ${outDir}: ${err?.message || err}`);
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
  } catch (err) {
    return fail(`write ${outPath}: ${err?.message || err}`);
  }

  process.stderr.write(`[precompact-flush] wrote ${outPath}\n`);

  // Best-effort: append a one-line breadcrumb readable later by `knowledge` action=list
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

  ok();
}

main().catch((err) => fail(err?.message || String(err)));

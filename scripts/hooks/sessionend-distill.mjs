#!/usr/bin/env node

// =============================================================================
// agent-knowledge SessionEnd distill hook
//
// Dumps a final session summary (turn counts, tool uses, first 20 user
// prompts) into the knowledge base when the host ends the conversation.
// Lightweight heuristic snapshot — the richer distillation happens via
// the library on next agent-knowledge startup.
//
// Emits a top-level `systemMessage` so the user can see the hook actually
// fired (receipt of what was distilled, or reason for skipping). Also
// appends a one-line breadcrumb to `~/agent-knowledge/sessions/index.md`
// so the receipt is durable even if the host tears the transcript down
// before painting the message.
//
// Fail-open.
// =============================================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { request } from 'http';

process.on('uncaughtException', (err) => {
  process.stderr.write(`[sessionend-distill] fatal: ${err.message}\n`);
  emit();
  process.exit(0);
});

const MEMORY_DIR = process.env.AGENT_KNOWLEDGE_MEMORY_DIR || join(homedir(), 'agent-knowledge');

function emit(systemMessage) {
  const payload = systemMessage ? { systemMessage } : {};
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function appendBreadcrumb(line) {
  try {
    const dir = join(MEMORY_DIR, 'sessions');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'index.md');
    const header = existsSync(file) ? '' : '# Session flushes\n';
    appendFileSync(file, header + line + '\n', 'utf8');
  } catch {
    // ignore — breadcrumb is best-effort
  }
}

// Best-effort POST to the agent-knowledge dashboard so a live toast appears
// in the UI when the session ends. Silently drops on any failure (dashboard
// not running, network error, timeout) — the disk receipts are authoritative.
function postDashboardEvent(kind, message) {
  return new Promise((resolve) => {
    if (process.env.AGENT_KNOWLEDGE_DASHBOARD_EVENTS === '0') {
      resolve();
      return;
    }
    const port = Number(process.env.AGENT_KNOWLEDGE_PORT || 3423);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      resolve();
      return;
    }
    const payload = JSON.stringify({ kind, message });
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/events',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 1500,
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', resolve);
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.on('error', () => resolve());
    req.write(payload);
    req.end();
  });
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData = {};
  try {
    hookData = JSON.parse(input);
  } catch {
    // ignore
  }

  const transcriptPath = hookData?.transcript_path;
  const sessionId = hookData?.session_id || 'unknown';
  const cwd = hookData?.workspace?.current_dir || process.cwd();

  if (!transcriptPath || !existsSync(transcriptPath)) {
    emit('knowledge: SessionEnd skipped — transcript unavailable');
    return;
  }

  let raw = '';
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    // ignore
  }

  const lines = raw.split(/\r?\n/).filter(Boolean);
  let userTurns = 0;
  let assistantTurns = 0;
  let toolUses = 0;
  const userMsgs = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj?.type === 'user') {
        userTurns++;
        if (typeof obj.message?.content === 'string') {
          userMsgs.push(obj.message.content.slice(0, 300));
        }
      } else if (obj?.type === 'assistant') {
        assistantTurns++;
        const content = obj.message?.content;
        if (Array.isArray(content)) {
          toolUses += content.filter((c) => c.type === 'tool_use').length;
        }
      }
    } catch {
      // ignore non-JSON lines
    }
  }

  const memDir = join(MEMORY_DIR, 'projects');
  try {
    mkdirSync(memDir, { recursive: true });
  } catch {
    // ignore
  }

  const slug = cwd.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 64);
  const file = join(memDir, `session-${slug}-${sessionId.slice(0, 8)}.md`);
  const endedAt = new Date().toISOString();
  const body = `---
type: session-end
session: ${sessionId}
cwd: ${cwd}
ended: ${endedAt}
turns: ${userTurns}u/${assistantTurns}a
tool_uses: ${toolUses}
---

# Session ${sessionId.slice(0, 8)}

**cwd**: ${cwd}
**Turns**: ${userTurns} user / ${assistantTurns} assistant
**Tool uses**: ${toolUses}

## User prompts (first 20)

${userMsgs
  .slice(0, 20)
  .map((m, i) => `${i + 1}. ${m}`)
  .join('\n')}
`;

  let wrote = false;
  try {
    writeFileSync(file, body, 'utf8');
    wrote = true;
  } catch (err) {
    process.stderr.write(`[sessionend-distill] write failed: ${err?.message || err}\n`);
  }

  if (wrote) {
    appendBreadcrumb(`- SessionEnd ${endedAt} ${sessionId} → ${file}`);
    const receipt = `${userTurns}u/${assistantTurns}a turns, ${toolUses} tool uses → ${file}`;
    await postDashboardEvent('session-end', receipt);
    emit(`knowledge: SessionEnd — ${receipt}`);
  } else {
    emit(`knowledge: SessionEnd — write failed for ${file}`);
  }
}

main().catch((err) => {
  process.stderr.write(`[sessionend-distill] ${err.message}\n`);
  emit('knowledge: SessionEnd — hook crashed (fail-open)');
});

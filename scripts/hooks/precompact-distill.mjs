#!/usr/bin/env node

// =============================================================================
// agent-knowledge PreCompact distill hook
//
// Dumps the tail of the current session transcript into the knowledge base
// right before the host compacts the conversation, so cross-machine memory
// survives the summarization. This is a lightweight heuristic snapshot —
// the companion `precompact-flush.mjs` hook does a richer summary via the
// compiled agent-knowledge library when available. Running both is fine;
// they write to distinct files.
//
// Fail-open: any error logs to stderr and emits `{}` so it never blocks.
// =============================================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

process.on('uncaughtException', (err) => {
  process.stderr.write(`[precompact-distill] fatal: ${err.message}\n`);
  console.log(JSON.stringify({}));
  process.exit(0);
});

const MEMORY_DIR = process.env.AGENT_KNOWLEDGE_MEMORY_DIR || join(homedir(), 'agent-knowledge');

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
    console.log(JSON.stringify({}));
    return;
  }

  let recent = '';
  try {
    const buf = readFileSync(transcriptPath);
    recent = buf.slice(Math.max(0, buf.length - 200_000)).toString('utf8');
  } catch {
    // ignore
  }

  const lines = recent.split(/\r?\n/).filter(Boolean);
  const userMsgs = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj?.type === 'user' && typeof obj.message?.content === 'string') {
        userMsgs.push(obj.message.content.slice(0, 500));
      }
    } catch {
      // ignore non-JSON lines
    }
  }
  const summary = userMsgs.slice(-10).join('\n---\n');

  const memDir = join(MEMORY_DIR, 'projects');
  try {
    mkdirSync(memDir, { recursive: true });
  } catch {
    // ignore
  }

  const slug = cwd.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 64);
  const file = join(memDir, `precompact-${slug}-${sessionId.slice(0, 8)}.md`);
  const body = `---
type: precompact-snapshot
session: ${sessionId}
cwd: ${cwd}
created: ${new Date().toISOString()}
---

# Pre-compact snapshot

Last ${userMsgs.length} user prompts (most recent ${Math.min(10, userMsgs.length)}):

${summary}
`;

  try {
    writeFileSync(file, body, 'utf8');
  } catch {
    // ignore — don't block on write failure
  }

  console.log(JSON.stringify({}));
}

main().catch((err) => {
  process.stderr.write(`[precompact-distill] ${err.message}\n`);
  console.log(JSON.stringify({}));
});

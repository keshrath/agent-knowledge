#!/usr/bin/env node

// =============================================================================
// agent-knowledge SessionEnd distill hook
//
// Dumps a final session summary (turn counts, tool uses, first 20 user
// prompts) into the knowledge base when the host ends the conversation.
// Lightweight heuristic snapshot — the richer distillation happens via
// the library on next agent-knowledge startup.
//
// Fail-open.
// =============================================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

process.on('uncaughtException', (err) => {
  process.stderr.write(`[sessionend-distill] fatal: ${err.message}\n`);
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
  const body = `---
type: session-end
session: ${sessionId}
cwd: ${cwd}
ended: ${new Date().toISOString()}
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

  try {
    writeFileSync(file, body, 'utf8');
  } catch {
    // ignore
  }

  console.log(JSON.stringify({}));
}

main().catch((err) => {
  process.stderr.write(`[sessionend-distill] ${err.message}\n`);
  console.log(JSON.stringify({}));
});

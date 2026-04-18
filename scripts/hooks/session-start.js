#!/usr/bin/env node

// =============================================================================
// agent-knowledge SessionStart hook
//
// 1. Announces the knowledge dashboard URL.
// 2. Auto-loads a token-budgeted wakeup payload (L0 identity + L1 top-weighted
//    entries) into the host's additionalContext so the agent starts each
//    session with a small, well-chosen window into the knowledge base — no
//    manual `knowledge action=wakeup` call required.
//
// Disable auto-wakeup by exporting AGENT_KNOWLEDGE_AUTOWAKE=0. Tune budget
// with AGENT_KNOWLEDGE_WAKEUP_BUDGET (default 800 tokens).
//
// Fail-open: every error path still prints a valid JSON hook response so the
// session never blocks on this hook.
// =============================================================================

import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const knowledgePort = process.env.AGENT_KNOWLEDGE_PORT || '3423';
const autoWakeEnabled =
  (process.env.AGENT_KNOWLEDGE_AUTOWAKE ?? '1').trim().toLowerCase() !== '0' &&
  (process.env.AGENT_KNOWLEDGE_AUTOWAKE ?? '1').trim().toLowerCase() !== 'false';
const wakeupBudget = Number.parseInt(process.env.AGENT_KNOWLEDGE_WAKEUP_BUDGET ?? '800', 10) || 800;

function emit(additionalContext) {
  const msg = {
    systemMessage: `agent-knowledge: http://localhost:${knowledgePort}`,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  };
  process.stdout.write(JSON.stringify(msg) + '\n');
  process.exit(0);
}

async function loadWakeup() {
  const distWakeup = resolve(__dirname, '..', '..', 'dist', 'wakeup.js');
  if (!existsSync(distWakeup)) return null;
  try {
    const mod = await import(`file://${distWakeup.replace(/\\/g, '/')}`);
    if (typeof mod.wakeup !== 'function') return null;
    const result = mod.wakeup({ tokenBudget: wakeupBudget });
    if (result && typeof result.rendered === 'string') return result.rendered;
  } catch (err) {
    process.stderr.write(`[knowledge session-start] wakeup failed: ${err?.message || err}\n`);
  }
  return null;
}

async function main() {
  const dashboardLine = `Knowledge: http://localhost:${knowledgePort}`;

  if (!autoWakeEnabled) {
    return emit(dashboardLine);
  }

  const rendered = await loadWakeup();
  if (!rendered) {
    return emit(dashboardLine);
  }

  const combined = [
    dashboardLine,
    '',
    '--- Knowledge wakeup (auto-loaded; call `knowledge action=wakeup` to refresh) ---',
    rendered,
  ].join('\n');

  emit(combined);
}

main().catch((err) => {
  process.stderr.write(`[knowledge session-start] ${err?.message || err}\n`);
  emit(`Knowledge: http://localhost:${knowledgePort}`);
});

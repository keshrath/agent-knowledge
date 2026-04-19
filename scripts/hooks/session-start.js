#!/usr/bin/env node

// =============================================================================
// agent-knowledge SessionStart hook
//
// 1. Announces the knowledge dashboard URL.
// 2. Auto-loads the L0 identity section into the host's additionalContext so
//    the agent starts each session with "who the user is" already in the
//    prompt — query-agnostic facts that apply regardless of the first question.
// 3. Clears the first-prompt-inject marker for this session_id so a resumed
//    or cleared session gets another shot at query-targeted L1 injection.
//    Without this, /exit + resume re-uses the session_id and the inject hook
//    silently skips because the marker from the prior run is still on disk.
//
// L1 top-weighted facts are NOT auto-injected here anymore. The companion
// `first-prompt-inject.mjs` hook runs query-targeted search against the KB
// on the session's first real prompt, which produces a better-matched slice
// than any query-agnostic pre-load.
//
// Disable auto-wakeup entirely by exporting AGENT_KNOWLEDGE_AUTOWAKE=0.
// Tune the identity slice with AGENT_KNOWLEDGE_WAKEUP_BUDGET (default 200
// tokens — L0 is small, doesn't need the legacy 800-token window).
//
// Fail-open: every error path still prints a valid JSON hook response so the
// session never blocks on this hook.
// =============================================================================

import { existsSync, rmSync } from 'fs';
import path, { dirname, resolve, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const knowledgePort = process.env.AGENT_KNOWLEDGE_PORT || '3423';
const autoWakeEnabled =
  (process.env.AGENT_KNOWLEDGE_AUTOWAKE ?? '1').trim().toLowerCase() !== '0' &&
  (process.env.AGENT_KNOWLEDGE_AUTOWAKE ?? '1').trim().toLowerCase() !== 'false';
const wakeupBudget = Number.parseInt(process.env.AGENT_KNOWLEDGE_WAKEUP_BUDGET ?? '200', 10) || 200;

function emit(additionalContext, statusSuffix) {
  const base = `agent-knowledge: http://localhost:${knowledgePort}`;
  const systemMessage = statusSuffix ? `${base} | ${statusSuffix}` : base;
  const msg = {
    systemMessage,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  };
  process.stdout.write(JSON.stringify(msg) + '\n');
  process.exit(0);
}

async function readStdin() {
  return new Promise((resolveP) => {
    let data = '';
    if (process.stdin.isTTY) return resolveP('');
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolveP(data));
    setTimeout(() => resolveP(data), 1500);
  });
}

// Keep in sync with first-prompt-inject.mjs dataDir().
function dataDir() {
  if (process.env.AGENT_KNOWLEDGE_DATA_DIR) return process.env.AGENT_KNOWLEDGE_DATA_DIR;
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'),
      'knowledge',
    );
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'knowledge');
}

function memoryDir() {
  return process.env.AGENT_KNOWLEDGE_MEMORY_DIR || join(homedir(), 'agent-knowledge');
}

function identityOnboardingState() {
  const dir = memoryDir();
  try {
    if (existsSync(join(dir, 'identity.md')) || existsSync(join(dir, 'IDENTITY.md'))) {
      return 'configured';
    }
    if (existsSync(join(dir, '.identity-declined'))) {
      return 'declined';
    }
  } catch {
    return 'unknown';
  }
  return 'pending';
}

const ONBOARDING_INSTRUCTION = [
  '',
  '--- Identity onboarding (no identity.md yet) ---',
  `The user has no ~/agent-knowledge/identity.md. Before diving into their request, briefly ask:`,
  '  1. Name + primary role',
  '  2. Main stack / tech focus',
  '  3. Projects they maintain',
  `Then use the Write tool to save their answers to \`~/agent-knowledge/identity.md\` as short markdown.`,
  `If the user says "skip" / "not now" / declines, use Write to create an empty file at \`~/agent-knowledge/.identity-declined\` so this prompt stops appearing.`,
  `Do not invent facts — only record what the user actually tells you.`,
].join('\n');

function clearFirstPromptMarker(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return false;
  try {
    const marker = path.join(dataDir(), '.first-prompt-seen', sessionId);
    if (existsSync(marker)) {
      rmSync(marker, { force: true });
      return true;
    }
  } catch (err) {
    process.stderr.write(`[knowledge session-start] marker clear failed: ${err?.message || err}\n`);
  }
  return false;
}

async function loadIdentitySection() {
  const distWakeup = resolve(__dirname, '..', '..', 'dist', 'wakeup.js');
  if (!existsSync(distWakeup)) return { rendered: null, hasIdentity: false, bodyChars: 0 };
  try {
    const mod = await import(`file://${distWakeup.replace(/\\/g, '/')}`);
    if (typeof mod.buildContextBundle !== 'function') {
      return { rendered: null, hasIdentity: false, bodyChars: 0 };
    }
    const result = mod.buildContextBundle({
      tokenBudget: wakeupBudget,
      sections: ['identity'],
    });
    if (!result || typeof result.rendered !== 'string' || result.rendered.length === 0) {
      return { rendered: null, hasIdentity: false, bodyChars: 0 };
    }
    const identitySection = (result.sections ?? []).find((s) => s.name === 'identity');
    const hasIdentity = !!(identitySection && !identitySection.empty);
    const bodyChars = identitySection?.content?.length ?? result.rendered.length;
    return { rendered: result.rendered, hasIdentity, bodyChars };
  } catch (err) {
    process.stderr.write(
      `[knowledge session-start] identity load failed: ${err?.message || err}\n`,
    );
  }
  return { rendered: null, hasIdentity: false, bodyChars: 0 };
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
  const sessionId = payload.session_id || process.env.CLAUDE_SESSION_ID;
  const source = payload.source || 'startup';

  // Re-arm first-prompt-inject for this session_id. Resumed sessions reuse the
  // session_id, so without this the inject hook's marker from the previous
  // run would skip the very next user prompt.
  const markerCleared = clearFirstPromptMarker(sessionId);

  const dashboardLine = `Knowledge: http://localhost:${knowledgePort}`;

  const autowakeOffSuffix = markerCleared ? `${source} · inject rearmed` : source;
  if (!autoWakeEnabled) {
    return emit(dashboardLine, `autowake off · ${autowakeOffSuffix}`);
  }

  const { rendered, hasIdentity, bodyChars } = await loadIdentitySection();
  const onboarding = hasIdentity ? 'configured' : identityOnboardingState();

  let identityStatus;
  if (hasIdentity) {
    identityStatus = `identity: ${bodyChars} chars`;
  } else if (onboarding === 'pending') {
    identityStatus = 'identity: onboarding pending';
  } else if (onboarding === 'declined') {
    identityStatus = 'identity: declined (delete ~/agent-knowledge/.identity-declined to redo)';
  } else {
    identityStatus = 'identity: placeholder (no identity.md)';
  }
  const rearmStatus = markerCleared ? ' · inject rearmed' : '';
  const suffix = `${identityStatus}${rearmStatus}`;

  const onboardingBlock = onboarding === 'pending' ? ONBOARDING_INSTRUCTION : '';

  if (!rendered) {
    return emit(`${dashboardLine}${onboardingBlock}`, suffix);
  }

  const base = [
    dashboardLine,
    '',
    '--- Knowledge wakeup (identity only; call `knowledge action=wakeup` for L1 facts) ---',
    rendered,
  ].join('\n');
  const combined = onboardingBlock ? `${base}\n${onboardingBlock}` : base;

  emit(combined, suffix);
}

main().catch((err) => {
  process.stderr.write(`[knowledge session-start] ${err?.message || err}\n`);
  emit(`Knowledge: http://localhost:${knowledgePort}`, null);
});

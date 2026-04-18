#!/usr/bin/env node

// =============================================================================
// agent-knowledge UserPromptSubmit hook — first-prompt knowledge injection
//
// When the user sends the FIRST real prompt of a session, run the prompt text
// through knowledge_search and inject the top-K hits as additionalContext
// before the model sees the prompt. Complements the SessionStart wakeup
// (which is query-agnostic) by pulling in entries that are directly relevant
// to whatever the user is about to ask.
//
// Gates (all must pass to fire):
//   - AGENT_KNOWLEDGE_FIRSTPROMPT_INJECT != 0 / false / off
//   - Prompt is >= 10 chars
//   - Prompt does not start with `/` (skip slash commands)
//   - No marker file exists yet for this session id
//
// Fires once per session. Subsequent prompts see only the wakeup pack and
// whatever they search for themselves. A marker file at
// `{dataDir}/.first-prompt-seen/<session_id>` records "already fired".
//
// Envs:
//   AGENT_KNOWLEDGE_FIRSTPROMPT_INJECT   (default "1") — set "0" to disable
//   AGENT_KNOWLEDGE_FIRSTPROMPT_BUDGET   (default "600") — max chars/4 tokens
//   AGENT_KNOWLEDGE_FIRSTPROMPT_MAX_HITS (default "4")   — cap on rendered hits
//   KNOWLEDGE_MEMORY_DIR                  — resolves memory dir (same as core)
//
// Fail-open: every error path prints `{}` so the host never blocks on this
// hook. Log-only stderr for diagnostics.
// =============================================================================

import fs from 'fs';
import path from 'path';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function emit(additionalContext) {
  const payload = additionalContext
    ? {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext,
        },
      }
    : {};
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(0);
}

function warn(msg) {
  process.stderr.write(`[knowledge firstprompt] ${msg}\n`);
}

function isEnabled() {
  const raw = (process.env.AGENT_KNOWLEDGE_FIRSTPROMPT_INJECT ?? '1').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off';
}

function tokenBudget() {
  const raw = process.env.AGENT_KNOWLEDGE_FIRSTPROMPT_BUDGET ?? '600';
  const n = Number.parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 100 && n <= 8000) return n;
  return 600;
}

function maxHits() {
  const raw = process.env.AGENT_KNOWLEDGE_FIRSTPROMPT_MAX_HITS ?? '4';
  const n = Number.parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 1 && n <= 20) return n;
  return 4;
}

function memoryDir() {
  return process.env.KNOWLEDGE_MEMORY_DIR || path.join(homedir(), 'agent-knowledge');
}

function dataDir() {
  if (process.env.KNOWLEDGE_DATA_DIR) return process.env.KNOWLEDGE_DATA_DIR;
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'),
      'knowledge',
    );
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'knowledge');
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

function markerPath(sessionId) {
  return path.join(dataDir(), '.first-prompt-seen', sessionId);
}

function hasFired(sessionId) {
  try {
    return fs.existsSync(markerPath(sessionId));
  } catch {
    return false;
  }
}

function recordFired(sessionId) {
  try {
    const file = markerPath(sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, new Date().toISOString(), 'utf-8');
  } catch (err) {
    warn(`marker write failed: ${err?.message || err}`);
  }
}

function isSkippablePrompt(prompt) {
  const trimmed = (prompt ?? '').trim();
  if (trimmed.length < 10) return true;
  if (trimmed.startsWith('/')) return true;
  if (trimmed.startsWith('!')) return true;
  return false;
}

async function loadSearch() {
  const distSearch = resolve(__dirname, '..', '..', 'dist', 'knowledge', 'search.js');
  if (!fs.existsSync(distSearch)) {
    warn(`dist not built: ${distSearch} (run \`npm run build\`)`);
    return null;
  }
  try {
    const mod = await import(`file://${distSearch.replace(/\\/g, '/')}`);
    if (typeof mod.searchKnowledge !== 'function') {
      warn('searchKnowledge not exported');
      return null;
    }
    return mod.searchKnowledge;
  } catch (err) {
    warn(`import failed: ${err?.message || err}`);
    return null;
  }
}

function renderHits(hits, budgetChars) {
  if (!hits || hits.length === 0) return null;

  const header =
    '## Knowledge — top hits for your first prompt\n' +
    '\n' +
    '_Injected automatically by agent-knowledge. Query these entries with `knowledge` (action=read, path=…) before deciding whether to issue a wider `knowledge_search`._\n' +
    '\n';

  let used = header.length;
  const lines = [];
  for (const hit of hits) {
    const title = hit.entry?.title || hit.entry?.path || '(untitled)';
    const pathStr = hit.entry?.path ?? '';
    const score = typeof hit.score === 'number' ? hit.score.toFixed(2) : '?';
    const excerpt = (hit.excerpt ?? '').replace(/\s+/g, ' ').trim().slice(0, 220);
    const line = `- **${title}** (\`${pathStr}\`, score ${score}) — ${excerpt}`;
    if (used + line.length + 1 > budgetChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return null;

  return header + lines.join('\n') + '\n';
}

async function main() {
  if (!isEnabled()) return emit(null);

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
  const prompt = payload.prompt;

  if (!sessionId || typeof prompt !== 'string') return emit(null);
  if (hasFired(sessionId)) return emit(null);

  // IMPORTANT: don't burn the marker on skip-gates. If the user starts with
  // `/clear`, `!bash`, or "hi", we want the NEXT real prompt to still get
  // injection. Same for missing-dist / missing-memoryDir: those are setup
  // states that might be fixed before the agent's next turn. Only burn the
  // marker once a real search has actually run against a real KB.
  if (isSkippablePrompt(prompt)) return emit(null);

  const searchFn = await loadSearch();
  if (!searchFn) return emit(null);

  const dir = memoryDir();
  if (!fs.existsSync(dir)) return emit(null);

  let hits;
  try {
    hits = searchFn(dir, prompt.trim(), { maxResults: maxHits(), mmr: true });
  } catch (err) {
    warn(`search failed: ${err?.message || err}`);
    recordFired(sessionId);
    return emit(null);
  }

  recordFired(sessionId);

  const budgetChars = tokenBudget() * 4;
  const rendered = renderHits(hits, budgetChars);
  if (!rendered) return emit(null);
  emit(rendered);
}

main().catch((err) => {
  warn(err?.message || String(err));
  emit(null);
});

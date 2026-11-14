// =============================================================================
// agent-knowledge opencode plugin
//
// The session lifecycle the Claude Code mod (plugin/hooks/register.tsx) gives,
// on opencode's plugin API (@opencode-ai/plugin):
//   - session.created                 → names the knowledge base (toast)
//   - chat.message                    → the first real prompt carries the matching entries
//   - experimental.session.compacting → the summary is asked to keep what is still to be saved
//   - session.deleted                 → the session snapshot (POST /api/sessions/:id/snapshot)
//
// The snapshot is the server's, as for Claude Code: read from opencode's
// database by the session adapter, secrets scrubbed, committed under sessions/.
//
// Not here (no opencode analog): the identity / onboarding and ingest-freshness
// context (use AGENTS.md), and the snapshot at compaction (opencode's compaction
// does not expose the transcript).
//
// Register via opencode.json:
//   {
//     "plugin": ["agent-knowledge/opencode"]
//   }
//
// Env vars (as for the Claude Code mod):
//   AGENT_KNOWLEDGE_MEMORY_DIR            — knowledge base root (default ~/agent-knowledge)
//   AGENT_KNOWLEDGE_DATA_DIR              — marker/cache dir (default <memory>/.data)
//   AGENT_KNOWLEDGE_PORT                  — REST port for search (default 3423)
//   AGENT_KNOWLEDGE_FIRSTPROMPT_INJECT    — "0" / "false" / "off" to disable inject
//   AGENT_KNOWLEDGE_FIRSTPROMPT_BUDGET    — max inject tokens (chars/4, clamped [100,8000])
//   AGENT_KNOWLEDGE_FIRSTPROMPT_MAX_HITS  — max rendered hits (clamped [1,2])
//
// Fails open on every hook — any error is swallowed, the user is never blocked.
// =============================================================================

import type { Plugin } from '@opencode-ai/plugin';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── Config ──────────────────────────────────────────────────────────────────

function memoryDir(): string {
  return process.env.AGENT_KNOWLEDGE_MEMORY_DIR || join(homedir(), 'agent-knowledge');
}

function dataDir(): string {
  return process.env.AGENT_KNOWLEDGE_DATA_DIR || join(memoryDir(), '.data');
}

function markerDir(): string {
  return join(dataDir(), '.first-prompt-seen');
}

function restUrl(): string {
  const port = process.env.AGENT_KNOWLEDGE_PORT || '3423';
  return `http://localhost:${port}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function injectEnabled(): boolean {
  const raw = (process.env.AGENT_KNOWLEDGE_FIRSTPROMPT_INJECT ?? '1').toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off';
}

function maxHits(): number {
  const raw = parseInt(process.env.AGENT_KNOWLEDGE_FIRSTPROMPT_MAX_HITS ?? '2', 10);
  return clamp(Number.isFinite(raw) && raw > 0 ? raw : 2, 1, 2);
}

function budgetChars(): number {
  const raw = parseInt(process.env.AGENT_KNOWLEDGE_FIRSTPROMPT_BUDGET ?? '600', 10);
  return clamp(Number.isFinite(raw) && raw > 0 ? raw : 600, 100, 8000) * 4;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
}

function markerPath(sessionId: string): string {
  return join(markerDir(), sessionId);
}

type TextPart = { type: 'text'; text?: string };

function isTextPart(part: unknown): part is TextPart {
  return !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'text';
}

function extractText(parts: unknown[]): string {
  return parts
    .filter(isTextPart)
    .map((p) => p.text ?? '')
    .join('\n')
    .trim();
}

function shouldInject(text: string): boolean {
  if (!text || text.length < 10) return false;
  const first = text.trimStart().charAt(0);
  return first !== '/' && first !== '!';
}

// ── Knowledge search via the REST server ─────────────────────────────────────

type Hit = {
  entry?: { path?: string; category?: string; title?: string };
  path?: string;
  score?: number;
  snippet?: string;
  excerpt?: string;
  title?: string;
};

async function searchKnowledge(query: string): Promise<Hit[]> {
  try {
    const url = new URL(`${restUrl()}/api/knowledge/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('max_results', String(maxHits()));
    // As the Claude Code mod asks: near-copies once, no session snapshots, no hit on one word,
    // the prompt searched for what it asks about (not "one line, no tools").
    url.searchParams.set('mmr', 'true');
    url.searchParams.set('skip', 'sessions');
    url.searchParams.set('prompt', 'true');
    const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return [];
    const data = (await resp.json()) as unknown;
    if (!Array.isArray(data)) return [];
    return (data as Hit[]).slice(0, maxHits());
  } catch {
    return [];
  }
}

function renderHits(hits: Hit[]): string {
  if (!hits.length) return '';
  const lines = hits.map((h) => {
    const path = h.entry?.path || h.path || h.title || '?';
    const score = typeof h.score === 'number' ? ` (score ${h.score.toFixed(2)})` : '';
    const snippetRaw = h.snippet || h.excerpt || h.entry?.title || '';
    const snippet = snippetRaw.replace(/\s+/g, ' ').slice(0, 200);
    return `- **${path}**${score}${snippet ? ` — ${snippet}` : ''}`;
  });
  const header =
    '## Knowledge — top hits for your first prompt\n\n' +
    '_Injected by agent-knowledge (opencode plugin). Query these entries with the ' +
    '`knowledge` MCP tool (action=read, path=…) before issuing a wider `knowledge_search`._';
  let out = `${header}\n\n${lines.join('\n')}\n`;
  const budget = budgetChars();
  if (out.length > budget) out = out.slice(0, budget) + '\n…';
  return out;
}

// ── Session snapshot ────────────────────────────────────────────────────────

type ClientLike = {
  tui?: {
    showToast?: (opts: {
      body?: { title?: string; message: string; variant: string; duration?: number };
    }) => Promise<unknown>;
  };
};

/** The session's snapshot, written (scrubbed) by the server from opencode's own records. */
async function snapshotSession(sessionId: string, cwd: string): Promise<void> {
  try {
    await fetch(`${restUrl()}/api/sessions/${encodeURIComponent(sessionId)}/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'end', ...(cwd ? { cwd } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    /* fail open */
  }
}

// ── Plugin entry point ──────────────────────────────────────────────────────

export const AgentKnowledgePlugin: Plugin = async ({ client, directory }) => {
  ensureDir(markerDir());
  const typedClient = client as unknown as ClientLike;

  return {
    event: async ({ event }) => {
      try {
        const type = (event as { type?: string }).type;
        if (type === 'session.created') {
          const info = (event as { properties?: { info?: { id?: string } } }).properties?.info;
          if (info?.id) {
            // Resumed sessions reuse the same id — clear stale marker so first-prompt
            // inject re-arms, as a restarted Claude Code session does.
            const p = markerPath(info.id);
            if (existsSync(p)) {
              try {
                writeFileSync(p, '');
              } catch {
                /* ignore */
              }
            }
          }
          try {
            await typedClient.tui?.showToast?.({
              body: {
                title: 'agent-knowledge',
                message: `knowledge base: ${memoryDir()}`,
                variant: 'info',
                duration: 3000,
              },
            });
          } catch {
            /* CLI mode / no TUI — ignore */
          }
        } else if (type === 'session.deleted') {
          const id =
            (event as { properties?: { info?: { id?: string }; sessionID?: string } }).properties
              ?.info?.id ||
            (event as { properties?: { sessionID?: string } }).properties?.sessionID;
          if (id) await snapshotSession(id, directory);
        }
      } catch {
        /* fail open */
      }
    },

    'chat.message': async (input, output) => {
      if (!injectEnabled()) return;
      try {
        const parts = (output as { parts?: unknown[] }).parts;
        if (!Array.isArray(parts)) return;
        const text = extractText(parts);
        if (!shouldInject(text)) return;

        const marker = markerPath(input.sessionID);
        if (existsSync(marker)) return;

        const hits = await searchKnowledge(text);
        // Always set marker, even on zero-hit — don't burn searches on every turn
        try {
          writeFileSync(marker, String(Date.now()));
        } catch {
          /* ignore */
        }
        if (!hits.length) return;

        const rendered = renderHits(hits);
        if (!rendered) return;

        // Prepend so the model sees the knowledge block before the user question.
        (parts as unknown[]).unshift({ type: 'text', text: rendered });

        try {
          await typedClient.tui?.showToast?.({
            body: {
              title: 'agent-knowledge',
              message: `injected ${hits.length} hit${hits.length === 1 ? '' : 's'}`,
              variant: 'success',
              duration: 2500,
            },
          });
        } catch {
          /* ignore */
        }
      } catch {
        /* fail open */
      }
    },

    'experimental.session.compacting': async (_input, output) => {
      try {
        output.context.push(
          '## Save unsaved knowledge before compaction\n\n' +
            'Before the transcript is compacted, write any important facts, decisions, or ' +
            'workflows to agent-knowledge via the `knowledge` MCP tool (action=write). ' +
            'Compaction summarises the conversation away — durable facts must live in the ' +
            'knowledge base to survive.',
        );
      } catch {
        /* fail open */
      }
    },
  };
};

export default AgentKnowledgePlugin;

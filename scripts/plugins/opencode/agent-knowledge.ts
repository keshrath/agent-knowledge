// =============================================================================
// agent-knowledge opencode plugin
//
// Ports the Claude Code lifecycle hooks (session-start announce, first-prompt
// knowledge injection, pre-compact save nudge, session-end distill) to
// opencode's plugin API (@opencode-ai/plugin).
//
// Coverage vs. the Claude hook set:
//   - session.created                → session-start.js (dashboard announce)
//   - chat.message                   → first-prompt-inject.mjs (first-prompt KB inject)
//   - experimental.session.compacting → precompact-flush.mjs (save-context nudge)
//   - session.deleted                → sessionend-distill.mjs (session summary file)
//
// Gaps (no opencode analog):
//   - session-start-ingest.mjs       (paired with /knowledge-ingest skill)
//   - precompact-distill.mjs         (opencode compaction doesn't expose the transcript)
//   - L0 identity auto-load          (no additionalContext equivalent — use AGENTS.md)
//
// Register via opencode.json:
//   {
//     "plugin": ["agent-knowledge/opencode"]
//   }
//
// Env vars (same as the Claude hooks):
//   AGENT_KNOWLEDGE_MEMORY_DIR            — knowledge base root (default ~/agent-knowledge)
//   AGENT_KNOWLEDGE_DATA_DIR              — marker/cache dir (default <memory>/.data)
//   AGENT_KNOWLEDGE_PORT                  — dashboard port for search (default 3423)
//   AGENT_KNOWLEDGE_FIRSTPROMPT_INJECT    — "0" / "false" / "off" to disable inject
//   AGENT_KNOWLEDGE_FIRSTPROMPT_BUDGET    — max inject tokens (chars/4, clamped [100,8000])
//   AGENT_KNOWLEDGE_FIRSTPROMPT_MAX_HITS  — max rendered hits (clamped [1,20])
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

function dashboardUrl(): string {
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
  const raw = parseInt(process.env.AGENT_KNOWLEDGE_FIRSTPROMPT_MAX_HITS ?? '4', 10);
  return clamp(Number.isFinite(raw) && raw > 0 ? raw : 4, 1, 20);
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

// ── Knowledge search via dashboard HTTP ─────────────────────────────────────

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
    const url = new URL(`${dashboardUrl()}/api/knowledge/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('max_results', String(maxHits()));
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

// ── Session-end distill ─────────────────────────────────────────────────────

type ClientLike = {
  session: {
    messages: (opts: { path: { id: string } }) => Promise<unknown>;
  };
  tui?: {
    showToast?: (opts: {
      body?: { title?: string; message: string; variant: string; duration?: number };
    }) => Promise<unknown>;
  };
};

async function distillSession(sessionId: string, client: ClientLike): Promise<void> {
  try {
    const raw = await client.session.messages({ path: { id: sessionId } });
    const list = Array.isArray((raw as { data?: unknown })?.data)
      ? ((raw as { data: unknown[] }).data as unknown[])
      : Array.isArray(raw)
        ? (raw as unknown[])
        : [];
    if (!list.length) return;

    let userTurns = 0;
    let assistantTurns = 0;
    let toolUses = 0;
    const userPrompts: string[] = [];

    for (const m of list) {
      const entry = m as { info?: { role?: string }; parts?: unknown[] };
      const role = entry.info?.role;
      const parts = Array.isArray(entry.parts) ? entry.parts : [];
      if (role === 'user') {
        userTurns++;
        const text = extractText(parts);
        if (text && userPrompts.length < 20) userPrompts.push(text);
      } else if (role === 'assistant') {
        assistantTurns++;
        for (const p of parts) {
          if (p && typeof p === 'object' && (p as { type?: unknown }).type === 'tool') {
            toolUses++;
          }
        }
      }
    }

    const slug = sessionId.slice(0, 8);
    const projectsDir = join(memoryDir(), 'projects');
    ensureDir(projectsDir);
    const outPath = join(projectsDir, `session-opencode-${slug}.md`);
    const body =
      [
        '---',
        'type: session-end',
        `session: ${sessionId}`,
        'host: opencode',
        `ended: ${new Date().toISOString()}`,
        `turns: ${userTurns}u/${assistantTurns}a`,
        `tool_uses: ${toolUses}`,
        '---',
        '',
        `# Session ${slug}`,
        '',
        '**Host**: opencode',
        `**Turns**: ${userTurns} user / ${assistantTurns} assistant`,
        `**Tool uses**: ${toolUses}`,
        '',
        '## First user prompts',
        '',
        ...userPrompts.map((p) => `- ${p.replace(/\s+/g, ' ').slice(0, 240)}`),
      ].join('\n') + '\n';
    writeFileSync(outPath, body);
  } catch {
    /* fail open */
  }
}

// ── Plugin entry point ──────────────────────────────────────────────────────

export const AgentKnowledgePlugin: Plugin = async ({ client }) => {
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
            // inject re-arms, matching the Claude session-start.js behaviour.
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
                message: `dashboard: ${dashboardUrl()}`,
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
          if (id) await distillSession(id, typedClient);
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

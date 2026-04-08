/**
 * wakeup — return a tiny "L0 + L1" context blob at session start.
 *
 * Exposed via the MCP `knowledge` tool as `action: "wakeup"` (no separate tool).
 *
 * Layered-memory model:
 *   L0 = identity (~100 tokens, always loaded, plain text)
 *   L1 = essential facts — top-N highest-weight knowledge entries
 *
 * The whole blob is bounded by a token budget (chars/4 estimate). Designed
 * to be called once at session start so the agent has a small but well-chosen
 * window into the user's world before it ever issues a real search.
 */

import fs from 'fs';
import path from 'path';
import { listEntries, readEntry } from './knowledge/store.js';
import { getConfig } from './types.js';

export interface WakeupOptions {
  /** Max total tokens (chars/4) for the rendered blob. Default 800. */
  tokenBudget?: number;
  /** Optional category filter for L1 (e.g. only `projects`). */
  scope?: string;
}

export interface WakeupResult {
  identity: string;
  entries: Array<{
    path: string;
    title: string;
    weight: number;
    excerpt: string;
  }>;
  rendered: string;
  token_estimate: number;
  truncated: boolean;
}

const DEFAULT_BUDGET = 800;
const CHARS_PER_TOKEN = 4;
const L1_EXCERPT_CHARS = 240;

const DEFAULT_IDENTITY = `## L0 — IDENTITY
No identity configured.
Create ~/agent-knowledge/identity.md to populate Layer 0.
Suggested fields: who you are, your primary role, the people you work with, the projects you maintain.`;

function loadIdentity(memoryDir: string): string {
  const candidates = [path.join(memoryDir, 'identity.md'), path.join(memoryDir, 'IDENTITY.md')];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        return fs.readFileSync(p, 'utf-8').trim();
      }
    } catch {
      // ignore — fall through
    }
  }
  return DEFAULT_IDENTITY;
}

interface ScoredEntry {
  path: string;
  title: string;
  weight: number;
  content: string;
}

/**
 * Weight = recency * log(size + 1).
 * No frontmatter weight field exists today, so we use mtime + body size as a
 * proxy for "this entry is large and recently touched, therefore important".
 */
function weighEntries(memoryDir: string, scope?: string): ScoredEntry[] {
  const entries = listEntries(memoryDir, scope);
  const now = Date.now();
  const scored: ScoredEntry[] = [];

  for (const entry of entries) {
    try {
      const fullPath = path.join(memoryDir, entry.path);
      const stat = fs.statSync(fullPath);
      const { content } = readEntry(memoryDir, entry.path);
      const ageDays = Math.max(1, (now - stat.mtimeMs) / (24 * 3600_000));
      // Recency factor decays over ~90 days; size factor uses log to avoid huge files dominating.
      const recency = Math.exp(-ageDays / 90);
      const sizeFactor = Math.log(stat.size + 1);
      const weight = recency * sizeFactor;
      scored.push({
        path: entry.path,
        title: entry.title || entry.path,
        weight,
        content,
      });
    } catch {
      continue;
    }
  }

  scored.sort((a, b) => b.weight - a.weight);
  return scored;
}

function shortExcerpt(content: string, maxChars: number): string {
  const cleaned = content.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxChars) return cleaned;
  return cleaned.slice(0, maxChars).trimEnd() + '…';
}

/**
 * Build the wakeup payload.
 * Greedily includes top-weighted entries until the token budget is hit.
 */
export function wakeup(options: WakeupOptions = {}): WakeupResult {
  const tokenBudget = options.tokenBudget ?? DEFAULT_BUDGET;
  const charBudget = tokenBudget * CHARS_PER_TOKEN;
  const config = getConfig();

  const identity = loadIdentity(config.memoryDir);
  const identityChars = identity.length + 16; // header overhead
  let used = identityChars;

  const scored = weighEntries(config.memoryDir, options.scope);
  const included: WakeupResult['entries'] = [];
  let truncated = false;

  for (const entry of scored) {
    const excerpt = shortExcerpt(entry.content, L1_EXCERPT_CHARS);
    const lineCost = excerpt.length + entry.title.length + entry.path.length + 12;
    if (used + lineCost > charBudget) {
      truncated = true;
      break;
    }
    included.push({
      path: entry.path,
      title: entry.title,
      weight: Math.round(entry.weight * 100) / 100,
      excerpt,
    });
    used += lineCost;
  }

  const lines: string[] = [];
  lines.push(identity);
  lines.push('');
  lines.push('## L1 — ESSENTIAL FACTS');
  if (included.length === 0) {
    lines.push(
      '_No entries indexed. Write some via `knowledge` action=write to populate Layer 1._',
    );
  } else {
    for (const e of included) {
      lines.push(`- **${e.title}** (\`${e.path}\`) — ${e.excerpt}`);
    }
  }
  if (truncated) {
    lines.push('');
    lines.push('_(L1 truncated to fit token budget — call `knowledge_search` for the rest.)_');
  }
  const rendered = lines.join('\n');

  return {
    identity,
    entries: included,
    rendered,
    token_estimate: Math.ceil(rendered.length / CHARS_PER_TOKEN),
    truncated,
  };
}

/**
 * wakeup — return a token-budgeted context blob at session start.
 *
 * v1.8.1: evolved from a flat top-K renderer into a section-priority
 * context packer. `buildContextBundle` assembles a multi-section blob
 * (identity, active_tasks, recent_decisions, known_gotchas,
 * last_session_summary, top_weighted, semantic_fallback) where each
 * section gets its own per-section budget and the packer greedily fills
 * top-to-bottom until the global token budget is hit.
 *
 * `wakeup()` is retained as a thin backwards-compatibility wrapper: when
 * called with only `tokenBudget` + `scope` (no `sections`), it routes to
 * the `top_weighted` section alone, producing output shape-compatible
 * with v1.8.0.
 *
 * Exposed via the MCP `knowledge` tool as `action: "wakeup"`.
 */

import fs from 'fs';
import path from 'path';
import { listEntries, readEntry, type KnowledgeEntry } from './knowledge/store.js';
import { getConfig } from './types.js';
import { listSessions } from './sessions/summary.js';
import { getEntryScoring } from './knowledge/scoring.js';

// ── Public types ────────────────────────────────────────────────────────────

export type SectionName =
  | 'identity'
  | 'active_tasks'
  | 'recent_decisions'
  | 'known_gotchas'
  | 'last_session_summary'
  | 'top_weighted'
  | 'semantic_fallback';

export const DEFAULT_SECTIONS: SectionName[] = [
  'identity',
  'active_tasks',
  'recent_decisions',
  'known_gotchas',
  'last_session_summary',
  'top_weighted',
  'semantic_fallback',
];

export interface ContextBundleOptions {
  /** Max total tokens (chars/4 estimate) for the rendered blob. Default 800. */
  tokenBudget?: number;
  /** Optional category filter applied to the top_weighted section. */
  scope?: string;
  /** Ordered list of sections to emit. Defaults to DEFAULT_SECTIONS. */
  sections?: SectionName[];
  /**
   * Per-section token-budget overrides. Unspecified sections share the
   * remainder evenly. If omitted, all sections get an equal slice.
   */
  sectionBudgets?: Partial<Record<SectionName, number>>;
}

export interface RenderedSection {
  name: SectionName;
  /** Rendered markdown for this section (already includes its heading). */
  content: string;
  /** Budget this section was given (in tokens). */
  budget: number;
  /** Tokens actually consumed. */
  used: number;
  /** True when the section was cut short to fit. */
  truncated: boolean;
  /** True when this section had no content to render. */
  empty: boolean;
}

export interface ContextBundleResult {
  identity: string;
  /** v1.8.0-compatible entries view — the `top_weighted` section's picks. */
  entries: Array<{ path: string; title: string; weight: number; excerpt: string }>;
  sections: RenderedSection[];
  rendered: string;
  token_estimate: number;
  truncated: boolean;
}

// Backwards-compat aliases
export type WakeupOptions = Pick<ContextBundleOptions, 'tokenBudget' | 'scope'>;
export type WakeupResult = ContextBundleResult;

// ── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_BUDGET = 800;
const CHARS_PER_TOKEN = 4;
const L1_EXCERPT_CHARS = 240;
const SECTION_EXCERPT_CHARS = 200;

const DEFAULT_IDENTITY = `## L0 — IDENTITY
No identity configured.
Create ~/agent-knowledge/identity.md to populate Layer 0.
Suggested fields: who you are, your primary role, the people you work with, the projects you maintain.`;

// ── Identity ────────────────────────────────────────────────────────────────

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

// ── Weighted scoring (v1.8.0 L1 logic) ──────────────────────────────────────

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
      const { entry: parsed } = readEntry(memoryDir, entry.path);
      const ageDays = Math.max(1, (now - stat.mtimeMs) / (24 * 3600_000));
      const recency = Math.exp(-ageDays / 90);
      const sizeFactor = Math.log(stat.size + 1);
      const weight = recency * sizeFactor;
      scored.push({
        path: entry.path,
        title: entry.title || entry.path,
        weight,
        content: parsed.content ?? '',
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

// ── Entry helpers ───────────────────────────────────────────────────────────

function listEntriesSafely(memoryDir: string, category?: string): KnowledgeEntry[] {
  try {
    return listEntries(memoryDir, category);
  } catch {
    return [];
  }
}

/**
 * Return the frontmatter-stripped body of an entry. `readEntry` returns
 * `{ entry, content }` where `content` is the raw file bytes (including the
 * YAML frontmatter block) and `entry.content` is the body-only view — we
 * want the latter so excerpts don't leak `---\ntitle: ...\n---` scaffolding.
 */
function readEntrySafely(memoryDir: string, entryPath: string): string {
  try {
    const { entry } = readEntry(memoryDir, entryPath);
    return entry.content ?? '';
  } catch {
    return '';
  }
}

/** Lexicographic descending on `updated` (YYYY-MM-DD) with path as tiebreaker. */
function sortByUpdatedDesc(a: KnowledgeEntry, b: KnowledgeEntry): number {
  const au = a.updated || '';
  const bu = b.updated || '';
  if (au !== bu) return bu.localeCompare(au);
  return a.path.localeCompare(b.path);
}

// ── Section renderers ───────────────────────────────────────────────────────

// Each renderer returns `{ content, empty }`. Content includes its heading and
// is pre-truncated to the supplied charBudget. `empty` means there was nothing
// to render (the section produces a short placeholder instead of silence).

interface SectionContext {
  memoryDir: string;
  scope?: string;
  charBudget: number;
}

type RawRender = { content: string; empty: boolean; truncated: boolean };

function renderIdentity(ctx: SectionContext): RawRender {
  const identity = loadIdentity(ctx.memoryDir);
  const isDefault = identity === DEFAULT_IDENTITY;
  // Identity already carries its own `## L0 — IDENTITY` heading. If the user's
  // file omits one, emit a heading ourselves.
  const hasHeading = /^##\s+/m.test(identity.split('\n').slice(0, 2).join('\n'));
  const body = hasHeading ? identity : `## L0 — IDENTITY\n${identity}`;
  const truncated = body.length > ctx.charBudget;
  const content = truncated ? body.slice(0, Math.max(0, ctx.charBudget - 1)).trimEnd() + '…' : body;
  return { content, empty: isDefault, truncated };
}

function renderActiveTasks(_ctx: SectionContext): RawRender {
  // No in-repo task data. Emit a placeholder pointing at agent-tasks (the
  // upstream source of truth). Keeps the section-slot visible so downstream
  // UIs don't silently collapse it.
  const body =
    '## ACTIVE TASKS\n' +
    '_No in-repo task data. Query agent-tasks (`task_list` stage=in_progress) for current work._';
  return { content: body, empty: true, truncated: false };
}

function renderRecentDecisions(ctx: SectionContext, maxItems = 5): RawRender {
  const entries = listEntriesSafely(ctx.memoryDir, 'decisions');
  if (entries.length === 0) {
    return {
      content:
        '## RECENT DECISIONS\n_No entries in `decisions/` yet. Write one via `knowledge` action=write._',
      empty: true,
      truncated: false,
    };
  }
  const sorted = [...entries].sort(sortByUpdatedDesc).slice(0, maxItems);
  const lines: string[] = ['## RECENT DECISIONS'];
  let used = lines[0].length + 1;
  let truncated = false;
  for (const e of sorted) {
    const body = readEntrySafely(ctx.memoryDir, e.path);
    const excerpt = shortExcerpt(body, SECTION_EXCERPT_CHARS);
    const line = `- **${e.title || e.path}** (\`${e.path}\`) — ${excerpt}`;
    if (used + line.length + 1 > ctx.charBudget) {
      truncated = true;
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return { content: lines.join('\n'), empty: false, truncated };
}

function renderKnownGotchas(ctx: SectionContext, maxItems = 5): RawRender {
  // Pull tagged `gotcha` from any category. listEntries supports a tag filter.
  let entries: KnowledgeEntry[];
  try {
    entries = listEntries(ctx.memoryDir, undefined, 'gotcha');
  } catch {
    entries = [];
  }
  if (entries.length === 0) {
    return {
      content:
        '## KNOWN GOTCHAS\n_No entries tagged `gotcha`. Add `tags: [gotcha]` to frontmatter to surface pitfalls here._',
      empty: true,
      truncated: false,
    };
  }
  const sorted = [...entries].sort(sortByUpdatedDesc).slice(0, maxItems);
  const lines: string[] = ['## KNOWN GOTCHAS'];
  let used = lines[0].length + 1;
  let truncated = false;
  for (const e of sorted) {
    const body = readEntrySafely(ctx.memoryDir, e.path);
    const excerpt = shortExcerpt(body, SECTION_EXCERPT_CHARS);
    const line = `- **${e.title || e.path}** (\`${e.path}\`) — ${excerpt}`;
    if (used + line.length + 1 > ctx.charBudget) {
      truncated = true;
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return { content: lines.join('\n'), empty: false, truncated };
}

function renderLastSessionSummary(_ctx: SectionContext): RawRender {
  let sessions: ReturnType<typeof listSessions>;
  try {
    sessions = listSessions();
  } catch {
    sessions = [];
  }
  if (!sessions || sessions.length === 0) {
    return {
      content: '## LAST SESSION\n_No prior sessions indexed._',
      empty: true,
      truncated: false,
    };
  }
  const latest = sessions[0];
  const lines: string[] = ['## LAST SESSION'];
  lines.push(`- **Project:** ${latest.project}`);
  lines.push(`- **Session:** ${latest.sessionId}`);
  if (latest.startTime && latest.startTime !== 'unknown') {
    lines.push(`- **Started:** ${latest.startTime}`);
  }
  if (typeof latest.messageCount === 'number') {
    lines.push(`- **Messages:** ${latest.messageCount}`);
  }
  if (latest.preview && latest.preview !== 'N/A') {
    lines.push(`- **Preview:** ${shortExcerpt(latest.preview, SECTION_EXCERPT_CHARS)}`);
  }
  const joined = lines.join('\n');
  const truncated = joined.length > _ctx.charBudget;
  const content = truncated
    ? joined.slice(0, Math.max(0, _ctx.charBudget - 1)).trimEnd() + '…'
    : joined;
  return { content, empty: false, truncated };
}

function renderTopWeighted(
  ctx: SectionContext,
  heading = '## L1 — ESSENTIAL FACTS',
): { rendered: RawRender; picks: ContextBundleResult['entries'] } {
  const scored = weighEntries(ctx.memoryDir, ctx.scope);
  const picks: ContextBundleResult['entries'] = [];
  const lines: string[] = [heading];
  let used = heading.length + 1;
  let truncated = false;

  if (scored.length === 0) {
    const body =
      heading +
      '\n_No entries indexed. Write some via `knowledge` action=write to populate Layer 1._';
    return {
      rendered: { content: body, empty: true, truncated: false },
      picks: [],
    };
  }

  for (const entry of scored) {
    const excerpt = shortExcerpt(entry.content, L1_EXCERPT_CHARS);
    const line = `- **${entry.title}** (\`${entry.path}\`) — ${excerpt}`;
    if (used + line.length + 1 > ctx.charBudget) {
      truncated = true;
      break;
    }
    lines.push(line);
    used += line.length + 1;
    picks.push({
      path: entry.path,
      title: entry.title,
      weight: Math.round(entry.weight * 100) / 100,
      excerpt,
    });
  }
  if (truncated) {
    const note = '_(truncated to fit budget — call `knowledge_search` for the rest.)_';
    if (used + note.length + 1 <= ctx.charBudget) {
      lines.push('');
      lines.push(note);
    }
  }
  return {
    rendered: { content: lines.join('\n'), empty: false, truncated },
    picks,
  };
}

function renderSemanticFallback(ctx: SectionContext): RawRender {
  // Pure top-weighted catch-all when earlier sections under-filled. Same
  // scoring as top_weighted but marked as a distinct section for clarity.
  const { rendered } = renderTopWeighted(ctx, '## SEMANTIC FALLBACK');
  return rendered;
}

// ── Budget allocation ───────────────────────────────────────────────────────

/**
 * Allocate a per-section character budget. Explicit overrides win; the
 * remainder is split evenly among unspecified sections. Values are capped
 * so explicit overrides never exceed the global budget.
 */
function allocateBudgets(
  sections: SectionName[],
  totalChars: number,
  sectionBudgets: Partial<Record<SectionName, number>> | undefined,
): Map<SectionName, number> {
  const out = new Map<SectionName, number>();
  if (sections.length === 0) return out;

  if (!sectionBudgets || Object.keys(sectionBudgets).length === 0) {
    const per = Math.max(1, Math.floor(totalChars / sections.length));
    for (const s of sections) out.set(s, per);
    return out;
  }

  // Convert any provided overrides from tokens → chars, capped at total.
  const explicit = new Map<SectionName, number>();
  let explicitSum = 0;
  for (const s of sections) {
    const v = sectionBudgets[s];
    if (typeof v === 'number' && v > 0) {
      const chars = Math.min(totalChars, Math.floor(v * CHARS_PER_TOKEN));
      explicit.set(s, chars);
      explicitSum += chars;
    }
  }

  const unspecified = sections.filter((s) => !explicit.has(s));
  const remaining = Math.max(0, totalChars - explicitSum);
  const perUnspec =
    unspecified.length > 0 ? Math.max(1, Math.floor(remaining / unspecified.length)) : 0;

  for (const s of sections) {
    if (explicit.has(s)) out.set(s, explicit.get(s)!);
    else out.set(s, perUnspec);
  }
  return out;
}

// ── Main assembler ──────────────────────────────────────────────────────────

function renderSection(
  name: SectionName,
  ctx: SectionContext,
): { render: RawRender; picks?: ContextBundleResult['entries'] } {
  switch (name) {
    case 'identity':
      return { render: renderIdentity(ctx) };
    case 'active_tasks':
      return { render: renderActiveTasks(ctx) };
    case 'recent_decisions':
      return { render: renderRecentDecisions(ctx) };
    case 'known_gotchas':
      return { render: renderKnownGotchas(ctx) };
    case 'last_session_summary':
      return { render: renderLastSessionSummary(ctx) };
    case 'top_weighted': {
      const { rendered, picks } = renderTopWeighted(ctx);
      return { render: rendered, picks };
    }
    case 'semantic_fallback':
      return { render: renderSemanticFallback(ctx) };
    default: {
      // Exhaustiveness guard — unknown section names render as no-ops.
      const never: never = name;
      void never;
      return { render: { content: '', empty: true, truncated: false } };
    }
  }
}

/**
 * Build the section-priority context bundle.
 *
 * Greedy-fill algorithm:
 *   1. Allocate per-section char budget (defaults to an even split).
 *   2. For each section in priority order, render up to its budget.
 *   3. If a section under-uses its budget, redistribute the remainder
 *      to subsequent sections.
 *   4. Stop once total rendered chars ≥ global budget.
 *   5. Mark `truncated: true` if any emitted section was cut.
 */
export function buildContextBundle(options: ContextBundleOptions = {}): ContextBundleResult {
  const tokenBudget = options.tokenBudget ?? DEFAULT_BUDGET;
  const charBudget = tokenBudget * CHARS_PER_TOKEN;
  const sections =
    options.sections && options.sections.length > 0 ? options.sections : DEFAULT_SECTIONS;
  const config = getConfig();

  // Honour an explicit empty `sections: []` — caller is opting out of all
  // rendering. Return an empty bundle instead of silently substituting the
  // defaults (the previous behaviour surprised callers trying to emit
  // nothing).
  if (options.sections && options.sections.length === 0) {
    return {
      identity: '',
      entries: [],
      sections: [],
      rendered: '',
      token_estimate: 0,
      truncated: false,
    };
  }

  const budgets = allocateBudgets(sections, charBudget, options.sectionBudgets);
  // Snapshot the original per-section allocation so that the emitted
  // `budget` field reflects what the caller asked for, not the post-
  // redistribution number (which can grow as earlier sections under-fill).
  const originalBudgets = new Map(budgets);

  // Load identity once — both the ContextBundleResult.identity field and
  // renderIdentity() previously re-read it independently.
  const identity = loadIdentity(config.memoryDir);
  const emitted: RenderedSection[] = [];
  let allPicks: ContextBundleResult['entries'] = [];
  let totalUsed = 0;
  let anyTruncated = false;

  for (let i = 0; i < sections.length; i++) {
    const name = sections[i];
    const remainingGlobal = charBudget - totalUsed;
    if (remainingGlobal <= 0) break;

    const allocated = budgets.get(name) ?? 0;
    // Step 3: allow this section to use any remainder handed down from earlier
    // under-filled sections. We cap at the global remainder so we never bust
    // the overall budget.
    const effective = Math.max(0, Math.min(remainingGlobal, allocated));
    if (effective === 0) continue;

    const ctx: SectionContext = {
      memoryDir: config.memoryDir,
      scope: options.scope,
      charBudget: effective,
    };
    const { render, picks } = renderSection(name, ctx);

    // Enforce the char cap defensively — renderers should already respect it.
    const safe =
      render.content.length > effective
        ? {
            ...render,
            content: render.content.slice(0, effective).trimEnd() + '…',
            truncated: true,
          }
        : render;

    const usedChars = safe.content.length;
    const usedTokens = Math.ceil(usedChars / CHARS_PER_TOKEN);

    const reportedBudgetChars = originalBudgets.get(name) ?? allocated;
    emitted.push({
      name,
      content: safe.content,
      budget: Math.ceil(reportedBudgetChars / CHARS_PER_TOKEN),
      used: usedTokens,
      truncated: safe.truncated,
      empty: safe.empty,
    });

    // +2 accounts for the `\n\n` separator `buildContextBundle` uses when
    // joining sections at line ~553. Previously undercounted by 1 per
    // boundary, letting total rendered exceed the global budget by up to
    // N-1 chars on an N-section bundle.
    totalUsed += usedChars + 2;
    if (safe.truncated) anyTruncated = true;
    if (picks && picks.length > 0) allPicks = picks;

    // Redistribute leftover budget from this section evenly across the
    // remaining sections.
    const leftover = allocated - usedChars;
    const restCount = sections.length - (i + 1);
    if (leftover > 0 && restCount > 0) {
      const bonus = Math.floor(leftover / restCount);
      for (let j = i + 1; j < sections.length; j++) {
        const nxt = sections[j];
        budgets.set(nxt, (budgets.get(nxt) ?? 0) + bonus);
      }
    }
  }

  const rendered = emitted.map((s) => s.content).join('\n\n');

  // Mark access for every entry that actually made it into the bundle.
  // Wakeup injection is the primary knowledge-consumption path (L1 facts
  // packed into the first prompt on every session start). Before this,
  // `last_accessed` only bumped on explicit `knowledge(action: read)` —
  // so the scoring DB under-reported real usage and the bytype chart
  // showed "mostly unused" even when wakeup was actively feeding content.
  if (allPicks.length > 0) {
    try {
      const paths = allPicks.map((p) => p.path).filter((p): p is string => !!p);
      if (paths.length > 0) getEntryScoring().recordBulkAccess(paths);
    } catch (err) {
      // Non-fatal — scoring DB issues shouldn't block context rendering.
      console.error('[wakeup] recordBulkAccess failed:', err instanceof Error ? err.message : err);
    }
  }

  return {
    identity,
    entries: allPicks,
    sections: emitted,
    rendered,
    token_estimate: Math.ceil(rendered.length / CHARS_PER_TOKEN),
    truncated: anyTruncated,
  };
}

// ── Backwards-compat wrapper ────────────────────────────────────────────────

/**
 * v1.8.0-compatible entry point.
 *
 * When invoked with only `tokenBudget` + `scope`, routes to the
 * `top_weighted` section alone so the `rendered` output stays shape-
 * compatible with pre-v1.8.1 callers (identity heading + L1 facts list).
 */
export function wakeup(options: WakeupOptions = {}): WakeupResult {
  return buildContextBundle({
    tokenBudget: options.tokenBudget,
    scope: options.scope,
    sections: ['identity', 'top_weighted'],
  });
}

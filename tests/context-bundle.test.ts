/**
 * Tests for the v1.8.1 section-priority context packer.
 *
 * Covers:
 *   1. Default section order renders all 7 sections (identity first).
 *   2. Custom `sections` skips the middle sections.
 *   3. Custom `section_budgets` honored.
 *   4. Tight budget truncates later sections; `truncated: true` is set.
 *   5. Backwards compat: `wakeup({tokenBudget})` alone stays
 *      shape-compatible with v1.8.0 — identity + L1 bullets only.
 *   6. Each section handles empty data with a short placeholder.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { buildContextBundle, wakeup, DEFAULT_SECTIONS } from '../src/wakeup.js';

// ── Test harness ────────────────────────────────────────────────────────────

function makeTmpMemoryDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ctx-bundle-'));
}

function writeMd(
  dir: string,
  relPath: string,
  frontmatter: Record<string, unknown>,
  body: string,
): void {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const fmLines: string[] = ['---'];
  for (const [k, v] of Object.entries(frontmatter)) {
    if (Array.isArray(v)) {
      fmLines.push(`${k}: [${v.join(', ')}]`);
    } else {
      fmLines.push(`${k}: ${String(v)}`);
    }
  }
  fmLines.push('---');
  fs.writeFileSync(full, fmLines.join('\n') + '\n' + body, 'utf-8');
}

function seedTinyKnowledge(dir: string): void {
  writeMd(
    dir,
    'identity.md',
    {},
    '## L0 — IDENTITY\nTest user. Works on agent-knowledge. Ships small, sharp tools.',
  );
  // Decisions (newest first via `updated` frontmatter)
  writeMd(
    dir,
    'decisions/use-sqlite.md',
    { title: 'Use SQLite for vectors', tags: ['architecture'], updated: '2026-04-15' },
    'Pick SQLite with a vec extension over a full vector DB — keeps the surface small.',
  );
  writeMd(
    dir,
    'decisions/prefer-tfidf-fallback.md',
    { title: 'Prefer TF-IDF fallback', tags: ['search'], updated: '2026-04-10' },
    'When embeddings unavailable, fall back to TF-IDF so search still functions.',
  );
  // Gotcha-tagged entries
  writeMd(
    dir,
    'notes/windows-path-trap.md',
    { title: 'Windows path trap', tags: ['gotcha', 'windows'], updated: '2026-04-12' },
    'Backslashes in JSON-encoded paths break the parser — always normalise to forward slashes.',
  );
  // Projects
  writeMd(
    dir,
    'projects/agent-knowledge.md',
    { title: 'agent-knowledge', tags: ['mcp'], updated: '2026-04-17' },
    'Layered memory MCP server. Sessions + entries + graph + dashboard.',
  );
  writeMd(
    dir,
    'people/mathias.md',
    { title: 'Mathias', tags: ['team'], updated: '2026-04-01' },
    'Primary maintainer. Prefers concise output, no AI branding on commits.',
  );
}

// ── Fixtures ────────────────────────────────────────────────────────────────

let memoryDir: string;
let dataDir: string;
const prevMem = process.env.KNOWLEDGE_MEMORY_DIR;
const prevData = process.env.KNOWLEDGE_DATA_DIR;
const prevAutoDistill = process.env.KNOWLEDGE_AUTO_DISTILL;

beforeEach(() => {
  memoryDir = makeTmpMemoryDir();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ctx-bundle-data-'));
  process.env.KNOWLEDGE_MEMORY_DIR = memoryDir;
  process.env.KNOWLEDGE_DATA_DIR = dataDir;
  process.env.KNOWLEDGE_AUTO_DISTILL = 'false';
});

afterEach(() => {
  if (prevMem === undefined) delete process.env.KNOWLEDGE_MEMORY_DIR;
  else process.env.KNOWLEDGE_MEMORY_DIR = prevMem;
  if (prevData === undefined) delete process.env.KNOWLEDGE_DATA_DIR;
  else process.env.KNOWLEDGE_DATA_DIR = prevData;
  if (prevAutoDistill === undefined) delete process.env.KNOWLEDGE_AUTO_DISTILL;
  else process.env.KNOWLEDGE_AUTO_DISTILL = prevAutoDistill;
  try {
    fs.rmSync(memoryDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ── 1. Default section order renders all 7 sections (identity first) ────────

describe('buildContextBundle: default sections', () => {
  it('renders all 7 default sections with identity first', () => {
    seedTinyKnowledge(memoryDir);
    const result = buildContextBundle({ tokenBudget: 2000 });

    expect(result.sections.map((s) => s.name)).toEqual(DEFAULT_SECTIONS);
    expect(result.sections[0].name).toBe('identity');
    // Identity content is rendered first in the concatenated output.
    const identityIdx = result.rendered.indexOf('L0 — IDENTITY');
    const topWeightedIdx = result.rendered.indexOf('L1 — ESSENTIAL FACTS');
    expect(identityIdx).toBeGreaterThanOrEqual(0);
    expect(topWeightedIdx).toBeGreaterThan(identityIdx);
    // Within budget.
    expect(result.token_estimate).toBeLessThanOrEqual(2000);
  });
});

// ── 2. Custom sections list skips middle sections ───────────────────────────

describe('buildContextBundle: custom section list', () => {
  it('skips middle sections when only identity + top_weighted requested', () => {
    seedTinyKnowledge(memoryDir);
    const result = buildContextBundle({
      tokenBudget: 2000,
      sections: ['identity', 'top_weighted'],
    });

    expect(result.sections.map((s) => s.name)).toEqual(['identity', 'top_weighted']);
    expect(result.rendered).not.toContain('ACTIVE TASKS');
    expect(result.rendered).not.toContain('RECENT DECISIONS');
    expect(result.rendered).not.toContain('KNOWN GOTCHAS');
    expect(result.rendered).not.toContain('LAST SESSION');
    expect(result.rendered).toContain('L0 — IDENTITY');
    expect(result.rendered).toContain('L1 — ESSENTIAL FACTS');
  });
});

// ── 3. Custom section_budgets honored ───────────────────────────────────────

describe('buildContextBundle: section_budgets', () => {
  it('honors per-section token budgets', () => {
    seedTinyKnowledge(memoryDir);
    const result = buildContextBundle({
      tokenBudget: 2000,
      sections: ['identity', 'recent_decisions', 'top_weighted'],
      sectionBudgets: {
        identity: 50,
        recent_decisions: 200,
        top_weighted: 800,
      },
    });

    const byName = new Map(result.sections.map((s) => [s.name, s]));
    // Each section's reported `budget` (tokens) matches what we allocated.
    expect(byName.get('identity')?.budget).toBe(50);
    expect(byName.get('recent_decisions')?.budget).toBe(200);
    expect(byName.get('top_weighted')?.budget).toBe(800);
    // And no section exceeds its allocation.
    for (const s of result.sections) {
      expect(s.used).toBeLessThanOrEqual(s.budget);
    }
  });
});

// ── 4. Tight budget truncates later sections ────────────────────────────────

describe('buildContextBundle: tight budget', () => {
  it('sets truncated=true when a section is cut', () => {
    seedTinyKnowledge(memoryDir);
    // Tight budget — identity alone will soak most of it up.
    const result = buildContextBundle({
      tokenBudget: 80,
      sections: ['identity', 'top_weighted'],
      sectionBudgets: { identity: 60, top_weighted: 20 },
    });

    expect(result.truncated).toBe(true);
    // The global budget is respected.
    expect(result.token_estimate).toBeLessThanOrEqual(80 + 2); // +small rounding
    // At least one emitted section is flagged as truncated.
    expect(result.sections.some((s) => s.truncated)).toBe(true);
  });
});

// ── 5. Backwards compat: wakeup({tokenBudget}) stays shape-compatible ───────

describe('wakeup: backwards compat', () => {
  it('wakeup({tokenBudget}) alone renders identity + L1 only', () => {
    seedTinyKnowledge(memoryDir);
    const result = wakeup({ tokenBudget: 800 });

    // Shape: identity string, entries array, rendered string, token_estimate,
    // truncated — matches v1.8.0.
    expect(typeof result.identity).toBe('string');
    expect(Array.isArray(result.entries)).toBe(true);
    expect(typeof result.rendered).toBe('string');
    expect(typeof result.token_estimate).toBe('number');
    expect(typeof result.truncated).toBe('boolean');

    // Only the two legacy sections appear.
    expect(result.sections.map((s) => s.name)).toEqual(['identity', 'top_weighted']);
    expect(result.rendered).toContain('L0 — IDENTITY');
    expect(result.rendered).toContain('L1 — ESSENTIAL FACTS');
    expect(result.rendered).not.toContain('ACTIVE TASKS');
    expect(result.rendered).not.toContain('RECENT DECISIONS');
    // `entries` carries the top-weighted picks (non-empty — we seeded data).
    expect(result.entries.length).toBeGreaterThan(0);
    for (const e of result.entries) {
      expect(typeof e.path).toBe('string');
      expect(typeof e.title).toBe('string');
      expect(typeof e.weight).toBe('number');
      expect(typeof e.excerpt).toBe('string');
    }
  });
});

// ── 6. Empty data yields a placeholder per section ──────────────────────────

describe('buildContextBundle: empty data handling', () => {
  it('each section emits a placeholder when its data is missing', () => {
    // Empty memoryDir — no identity, no entries, no sessions.
    const result = buildContextBundle({ tokenBudget: 2000 });

    expect(result.sections.map((s) => s.name)).toEqual(DEFAULT_SECTIONS);
    const byName = new Map(result.sections.map((s) => [s.name, s]));

    // Identity falls back to the default placeholder.
    expect(byName.get('identity')?.empty).toBe(true);
    expect(byName.get('identity')?.content).toContain('No identity configured');

    // Active tasks has no repo-local data source → always placeholder.
    expect(byName.get('active_tasks')?.empty).toBe(true);
    expect(byName.get('active_tasks')?.content).toContain('agent-tasks');

    // Decisions / gotchas / last-session all emit the short placeholder.
    expect(byName.get('recent_decisions')?.empty).toBe(true);
    expect(byName.get('recent_decisions')?.content).toContain('decisions/');

    expect(byName.get('known_gotchas')?.empty).toBe(true);
    expect(byName.get('known_gotchas')?.content).toContain('gotcha');

    // last_session_summary discovers sessions from globally-detected hosts
    // (~/.claude, ~/.cursor, etc.), so its emptiness depends on the test
    // environment. Only assert that the section rendered with its heading.
    expect(byName.get('last_session_summary')?.content).toContain('LAST SESSION');

    // Top-weighted / semantic-fallback: no indexed entries → placeholder.
    expect(byName.get('top_weighted')?.empty).toBe(true);
    expect(byName.get('top_weighted')?.content).toContain('No entries indexed');
    expect(byName.get('semantic_fallback')?.empty).toBe(true);
  });
});

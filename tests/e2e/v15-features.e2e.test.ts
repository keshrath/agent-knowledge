/**
 * End-to-end coverage for v1.5.2+ features:
 * - Confidence metadata on entries (extracted/inferred)
 * - Edge origin column (manual/auto-link/distill/reflect)
 * - Knowledge analysis layer: god_nodes, bridges, gaps
 * - Knowledge brief generation with caching
 *
 * Each test sets up a real on-disk memoryDir, exercises the full code path
 * with a real KnowledgeGraph (real SQLite), and asserts user-visible behavior.
 *
 * No mocks of internal components — uses `resetKnowledgeGraph` /
 * `resetEntryScoring` + per-test `AGENT_KNOWLEDGE_DATA_DIR` so each test gets an
 * isolated graph DB and scoring DB.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  KnowledgeGraph,
  getKnowledgeGraph,
  resetKnowledgeGraph,
} from '../../src/knowledge/graph.js';
import { listEntries, readEntry } from '../../src/knowledge/store.js';
import { resetEntryScoring } from '../../src/knowledge/scoring.js';
import {
  godNodes,
  bridges,
  gaps,
  generateBrief,
  invalidateBriefCache,
} from '../../src/knowledge/analyze.js';
import { searchKnowledge, invalidateKnowledgeIndexCache } from '../../src/knowledge/search.js';

function makeTmpMemoryDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-e2e-v15-'));
  for (const sub of ['projects', 'people', 'decisions', 'workflows', 'notes']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

function writeEntry(
  dir: string,
  rel: string,
  frontmatter: Record<string, string>,
  body: string,
): void {
  const lines = ['---'];
  for (const [k, v] of Object.entries(frontmatter)) lines.push(`${k}: ${v}`);
  lines.push('---', '', body);
  fs.writeFileSync(path.join(dir, rel), lines.join('\n'));
}

// ── Confidence metadata ─────────────────────────────────────────────────────

describe('e2e v1.5: confidence metadata', () => {
  let memoryDir: string;
  let dataDir: string;
  const prevMem = process.env.AGENT_KNOWLEDGE_MEMORY_DIR;
  const prevData = process.env.AGENT_KNOWLEDGE_DATA_DIR;

  beforeEach(() => {
    memoryDir = makeTmpMemoryDir();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-e2e-v15-data-'));
    process.env.AGENT_KNOWLEDGE_MEMORY_DIR = memoryDir;
    process.env.AGENT_KNOWLEDGE_DATA_DIR = dataDir;
    resetKnowledgeGraph();
    resetEntryScoring();
    invalidateKnowledgeIndexCache();
    invalidateBriefCache();
  });

  afterEach(() => {
    resetKnowledgeGraph();
    resetEntryScoring();
    invalidateKnowledgeIndexCache();
    invalidateBriefCache();
    if (prevMem === undefined) delete process.env.AGENT_KNOWLEDGE_MEMORY_DIR;
    else process.env.AGENT_KNOWLEDGE_MEMORY_DIR = prevMem;
    if (prevData === undefined) delete process.env.AGENT_KNOWLEDGE_DATA_DIR;
    else process.env.AGENT_KNOWLEDGE_DATA_DIR = prevData;
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

  it('listEntries populates confidence and confidence_score from frontmatter', () => {
    writeEntry(
      memoryDir,
      'projects/explicit.md',
      { title: 'Explicit Project', confidence: 'extracted' },
      'User-written project.',
    );
    writeEntry(
      memoryDir,
      'projects/auto.md',
      {
        title: 'Auto Project',
        confidence: 'inferred',
        confidence_score: '0.7',
      },
      'Auto-distilled.',
    );

    const entries = listEntries(memoryDir, 'projects');
    const explicit = entries.find((e) => e.path === 'projects/explicit.md');
    const auto = entries.find((e) => e.path === 'projects/auto.md');

    expect(explicit?.confidence).toBe('extracted');
    expect(explicit?.confidence_score).toBeUndefined();
    expect(auto?.confidence).toBe('inferred');
    expect(auto?.confidence_score).toBeCloseTo(0.7);
  });

  it('readEntry includes confidence fields from frontmatter', () => {
    writeEntry(
      memoryDir,
      'decisions/use-redis.md',
      { title: 'Use Redis', confidence: 'extracted' },
      'Decision body.',
    );

    const { entry } = readEntry(memoryDir, 'decisions/use-redis.md');
    expect(entry.confidence).toBe('extracted');
  });

  it('inferred entries are ranked lower than extracted in search', () => {
    // Two entries with effectively identical content — differ only in confidence.
    writeEntry(
      memoryDir,
      'notes/foo-extracted.md',
      { title: 'Foo Extracted', confidence: 'extracted' },
      'unique-keyword-xyz foo bar baz qux quux',
    );
    writeEntry(
      memoryDir,
      'notes/foo-inferred.md',
      { title: 'Foo Inferred', confidence: 'inferred' },
      'unique-keyword-xyz foo bar baz qux quux',
    );

    invalidateKnowledgeIndexCache();
    const results = searchKnowledge(memoryDir, 'unique-keyword-xyz');
    expect(results.length).toBe(2);
    // Extracted should rank strictly before inferred (1.0 vs 0.85 multiplier).
    const extractedIdx = results.findIndex((r) => r.entry.path === 'notes/foo-extracted.md');
    const inferredIdx = results.findIndex((r) => r.entry.path === 'notes/foo-inferred.md');
    expect(extractedIdx).toBeGreaterThanOrEqual(0);
    expect(inferredIdx).toBeGreaterThanOrEqual(0);
    expect(extractedIdx).toBeLessThan(inferredIdx);
  });
});

// ── Edge origin column ──────────────────────────────────────────────────────

describe('e2e v1.5: edge origin column', () => {
  let tmpDir: string;
  let graph: KnowledgeGraph;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-e2e-v15-graph-'));
    graph = new KnowledgeGraph(path.join(tmpDir, 'edges.db'));
  });

  afterEach(() => {
    try {
      graph.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('link() defaults origin to "manual"', () => {
    const edge = graph.link('a.md', 'b.md', 'related_to', 0.8);
    expect(edge.origin).toBe('manual');
  });

  it('link() stores explicit origin (auto-link)', () => {
    const edge = graph.link('a.md', 'b.md', 'related_to', 0.8, null, null, 'auto-link');
    expect(edge.origin).toBe('auto-link');
  });

  it('link() stores other origin values (distill, reflect)', () => {
    const distilled = graph.link('a.md', 'b.md', 'related_to', 0.8, null, null, 'distill');
    expect(distilled.origin).toBe('distill');
    const reflected = graph.link('c.md', 'd.md', 'related_to', 0.8, null, null, 'reflect');
    expect(reflected.origin).toBe('reflect');
  });

  it('links() returns origin for all edges', () => {
    graph.link('a.md', 'b.md', 'related_to', 0.5, null, null, 'manual');
    graph.link('a.md', 'c.md', 'related_to', 0.8, null, null, 'auto-link');
    const all = graph.links();
    expect(all.length).toBe(2);
    expect(all.map((e) => e.origin).sort()).toEqual(['auto-link', 'manual']);
  });

  it('upserting an edge updates origin', () => {
    graph.link('a.md', 'b.md', 'related_to', 0.5, null, null, 'auto-link');
    const updated = graph.link('a.md', 'b.md', 'related_to', 0.9, null, null, 'manual');
    expect(updated.origin).toBe('manual');
    const all = graph.links('a.md');
    expect(all.length).toBe(1);
    expect(all[0].origin).toBe('manual');
  });
});

// ── Shared setup for singleton-backed analysis features ─────────────────────

interface SingletonTestCtx {
  memoryDir: string;
  dataDir: string;
}

function makeSingletonCtx(): SingletonTestCtx {
  const memoryDir = makeTmpMemoryDir();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-e2e-v15-data-'));
  process.env.AGENT_KNOWLEDGE_MEMORY_DIR = memoryDir;
  process.env.AGENT_KNOWLEDGE_DATA_DIR = dataDir;
  resetKnowledgeGraph();
  resetEntryScoring();
  invalidateBriefCache();
  invalidateKnowledgeIndexCache();
  // Pin the graph singleton to the isolated DB for this test.
  getKnowledgeGraph(path.join(dataDir, 'knowledge-scores.db'));
  return { memoryDir, dataDir };
}

function teardownSingletonCtx(
  ctx: SingletonTestCtx,
  prevMem: string | undefined,
  prevData: string | undefined,
): void {
  resetKnowledgeGraph();
  resetEntryScoring();
  invalidateBriefCache();
  invalidateKnowledgeIndexCache();
  if (prevMem === undefined) delete process.env.AGENT_KNOWLEDGE_MEMORY_DIR;
  else process.env.AGENT_KNOWLEDGE_MEMORY_DIR = prevMem;
  if (prevData === undefined) delete process.env.AGENT_KNOWLEDGE_DATA_DIR;
  else process.env.AGENT_KNOWLEDGE_DATA_DIR = prevData;
  try {
    fs.rmSync(ctx.memoryDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ── godNodes ────────────────────────────────────────────────────────────────

describe('e2e v1.5: godNodes', () => {
  let ctx: SingletonTestCtx;
  const prevMem = process.env.AGENT_KNOWLEDGE_MEMORY_DIR;
  const prevData = process.env.AGENT_KNOWLEDGE_DATA_DIR;

  beforeEach(() => {
    ctx = makeSingletonCtx();
  });

  afterEach(() => {
    teardownSingletonCtx(ctx, prevMem, prevData);
  });

  it('returns empty array when no edges exist', () => {
    writeEntry(ctx.memoryDir, 'projects/alpha.md', { title: 'Alpha' }, 'Alpha');
    expect(godNodes(ctx.memoryDir)).toEqual([]);
  });

  it('ranks entries by edge degree', () => {
    writeEntry(ctx.memoryDir, 'projects/hub.md', { title: 'Hub' }, 'Central hub');
    writeEntry(ctx.memoryDir, 'projects/leaf1.md', { title: 'Leaf 1' }, 'Leaf');
    writeEntry(ctx.memoryDir, 'projects/leaf2.md', { title: 'Leaf 2' }, 'Leaf');
    writeEntry(ctx.memoryDir, 'projects/leaf3.md', { title: 'Leaf 3' }, 'Leaf');

    const graph = getKnowledgeGraph();
    graph.link('projects/hub.md', 'projects/leaf1.md', 'related_to', 0.8);
    graph.link('projects/hub.md', 'projects/leaf2.md', 'related_to', 0.8);
    graph.link('projects/hub.md', 'projects/leaf3.md', 'related_to', 0.8);

    const result = godNodes(ctx.memoryDir);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].path).toBe('projects/hub.md');
    expect(result[0].degree).toBe(3);
  });

  it('excludes auto-distilled entries whose only edges are auto-link', () => {
    writeEntry(ctx.memoryDir, 'projects/hub.md', { title: 'Hub', tags: '[auto-distilled]' }, 'Hub');
    writeEntry(ctx.memoryDir, 'projects/leaf1.md', { title: 'Leaf 1' }, 'Leaf');
    writeEntry(ctx.memoryDir, 'projects/leaf2.md', { title: 'Leaf 2' }, 'Leaf');
    writeEntry(ctx.memoryDir, 'projects/manual.md', { title: 'Manual' }, 'Manual');
    writeEntry(ctx.memoryDir, 'projects/other.md', { title: 'Other' }, 'Other');

    const graph = getKnowledgeGraph();
    // Hub only ever gets auto-link edges (and is tagged auto-distilled) -> exclude.
    graph.link('projects/hub.md', 'projects/leaf1.md', 'related_to', 0.8, null, null, 'auto-link');
    graph.link('projects/hub.md', 'projects/leaf2.md', 'related_to', 0.8, null, null, 'auto-link');
    // Manual gets a single manual edge -> should be included.
    graph.link('projects/manual.md', 'projects/other.md', 'related_to', 0.8, null, null, 'manual');

    const result = godNodes(ctx.memoryDir);
    const paths = result.map((g) => g.path);
    expect(paths).not.toContain('projects/hub.md');
    expect(paths).toContain('projects/manual.md');
  });
});

// ── bridges ─────────────────────────────────────────────────────────────────

describe('e2e v1.5: bridges', () => {
  let ctx: SingletonTestCtx;
  const prevMem = process.env.AGENT_KNOWLEDGE_MEMORY_DIR;
  const prevData = process.env.AGENT_KNOWLEDGE_DATA_DIR;

  beforeEach(() => {
    ctx = makeSingletonCtx();
  });

  afterEach(() => {
    teardownSingletonCtx(ctx, prevMem, prevData);
  });

  it('returns empty when no edges exist', () => {
    writeEntry(ctx.memoryDir, 'projects/alpha.md', { title: 'Alpha' }, 'Alpha');
    expect(bridges(ctx.memoryDir)).toEqual([]);
  });

  it('finds entries connecting different categories', () => {
    writeEntry(ctx.memoryDir, 'projects/alpha.md', { title: 'Alpha Project' }, 'Project');
    writeEntry(ctx.memoryDir, 'decisions/use-x.md', { title: 'Use X' }, 'Decision');
    writeEntry(ctx.memoryDir, 'workflows/deploy.md', { title: 'Deploy' }, 'Workflow');
    writeEntry(ctx.memoryDir, 'notes/aux.md', { title: 'Aux' }, 'Aux');

    const graph = getKnowledgeGraph();
    graph.link('projects/alpha.md', 'decisions/use-x.md', 'depends_on', 0.9);
    graph.link('projects/alpha.md', 'workflows/deploy.md', 'related_to', 0.7);
    graph.link('decisions/use-x.md', 'notes/aux.md', 'related_to', 0.5);
    graph.link('workflows/deploy.md', 'notes/aux.md', 'related_to', 0.5);

    const result = bridges(ctx.memoryDir);
    // alpha connects projects<->decisions<->workflows and has betweenness>0.
    expect(result.length).toBeGreaterThan(0);
    // Each returned bridge should connect at least two distinct categories.
    for (const b of result) {
      expect(b.connects.length).toBeGreaterThanOrEqual(2);
      expect(b.why).toMatch(/bridges /);
    }
  });

  it('same-category-only edges do not produce bridges', () => {
    writeEntry(ctx.memoryDir, 'projects/a.md', { title: 'A' }, 'A');
    writeEntry(ctx.memoryDir, 'projects/b.md', { title: 'B' }, 'B');
    writeEntry(ctx.memoryDir, 'projects/c.md', { title: 'C' }, 'C');

    const graph = getKnowledgeGraph();
    graph.link('projects/a.md', 'projects/b.md', 'related_to', 0.8);
    graph.link('projects/b.md', 'projects/c.md', 'related_to', 0.8);

    // b has betweenness > 0, but all neighbors are same category -> not a bridge.
    const result = bridges(ctx.memoryDir);
    expect(result).toEqual([]);
  });
});

// ── gaps ────────────────────────────────────────────────────────────────────

describe('e2e v1.5: gaps', () => {
  let ctx: SingletonTestCtx;
  const prevMem = process.env.AGENT_KNOWLEDGE_MEMORY_DIR;
  const prevData = process.env.AGENT_KNOWLEDGE_DATA_DIR;

  beforeEach(() => {
    ctx = makeSingletonCtx();
  });

  afterEach(() => {
    teardownSingletonCtx(ctx, prevMem, prevData);
  });

  it('finds isolated entries (degree 0)', () => {
    writeEntry(ctx.memoryDir, 'projects/connected1.md', { title: 'C1' }, 'Connected');
    writeEntry(ctx.memoryDir, 'projects/connected2.md', { title: 'C2' }, 'Connected');
    writeEntry(ctx.memoryDir, 'notes/orphan.md', { title: 'Orphan' }, 'Alone');

    const graph = getKnowledgeGraph();
    graph.link('projects/connected1.md', 'projects/connected2.md', 'related_to', 0.8);

    const result = gaps(ctx.memoryDir);
    const orphan = result.find((g) => g.path === 'notes/orphan.md');
    expect(orphan).toBeDefined();
    expect(orphan?.degree).toBe(0);
  });

  it('finds entries with 1 edge (weakly connected)', () => {
    writeEntry(ctx.memoryDir, 'projects/a.md', { title: 'A' }, 'A');
    writeEntry(ctx.memoryDir, 'projects/b.md', { title: 'B' }, 'B');

    const graph = getKnowledgeGraph();
    graph.link('projects/a.md', 'projects/b.md', 'related_to', 0.5);

    const result = gaps(ctx.memoryDir);
    // Both a and b have degree 1 — they are both "weakly connected" gaps.
    const paths = result.map((g) => g.path).sort();
    expect(paths).toContain('projects/a.md');
    expect(paths).toContain('projects/b.md');
    for (const g of result) {
      expect(g.degree).toBe(1);
    }
  });

  it('excludes entries with 2+ edges', () => {
    writeEntry(ctx.memoryDir, 'projects/hub.md', { title: 'Hub' }, 'Hub');
    writeEntry(ctx.memoryDir, 'projects/leaf1.md', { title: 'Leaf 1' }, 'L1');
    writeEntry(ctx.memoryDir, 'projects/leaf2.md', { title: 'Leaf 2' }, 'L2');

    const graph = getKnowledgeGraph();
    graph.link('projects/hub.md', 'projects/leaf1.md', 'related_to', 0.8);
    graph.link('projects/hub.md', 'projects/leaf2.md', 'related_to', 0.8);

    const result = gaps(ctx.memoryDir);
    const paths = result.map((g) => g.path);
    // hub has degree 2 — should NOT be a gap.
    expect(paths).not.toContain('projects/hub.md');
    // leaf1 and leaf2 have degree 1 — they ARE gaps.
    expect(paths).toContain('projects/leaf1.md');
    expect(paths).toContain('projects/leaf2.md');
  });

  it('sorts by maturity (proven first)', () => {
    // All entries start at maturity=candidate by default, so we just confirm
    // the ordering contract: the result is sorted by maturity rank.
    writeEntry(ctx.memoryDir, 'projects/a.md', { title: 'A' }, 'A');
    writeEntry(ctx.memoryDir, 'projects/b.md', { title: 'B' }, 'B');
    writeEntry(ctx.memoryDir, 'projects/c.md', { title: 'C' }, 'C');

    const result = gaps(ctx.memoryDir);
    const maturityOrder: Record<string, number> = {
      proven: 0,
      established: 1,
      candidate: 2,
    };
    for (let i = 1; i < result.length; i++) {
      const prev = maturityOrder[result[i - 1].maturity] ?? 3;
      const curr = maturityOrder[result[i].maturity] ?? 3;
      expect(prev).toBeLessThanOrEqual(curr);
    }
  });
});

// ── generateBrief ───────────────────────────────────────────────────────────

describe('e2e v1.5: knowledge brief', () => {
  let ctx: SingletonTestCtx;
  const prevMem = process.env.AGENT_KNOWLEDGE_MEMORY_DIR;
  const prevData = process.env.AGENT_KNOWLEDGE_DATA_DIR;

  beforeEach(() => {
    ctx = makeSingletonCtx();
  });

  afterEach(() => {
    teardownSingletonCtx(ctx, prevMem, prevData);
  });

  it('returns a structured brief with all expected fields', () => {
    writeEntry(ctx.memoryDir, 'projects/alpha.md', { title: 'Alpha' }, 'A');
    writeEntry(
      ctx.memoryDir,
      'decisions/use-redis.md',
      { title: 'Use Redis', updated: '2026-04-08' },
      'D',
    );
    writeEntry(
      ctx.memoryDir,
      'decisions/use-postgres.md',
      { title: 'Use Postgres', updated: '2026-04-09' },
      'D',
    );

    invalidateBriefCache();
    const brief = generateBrief(ctx.memoryDir);

    expect(brief.total_entries).toBeGreaterThanOrEqual(3);
    expect(typeof brief.total_edges).toBe('number');
    expect(Array.isArray(brief.core_concepts)).toBe(true);
    expect(Array.isArray(brief.active_projects)).toBe(true);
    expect(Array.isArray(brief.recent_decisions)).toBe(true);
    expect(typeof brief.stale_count).toBe('number');
    expect(typeof brief.gap_count).toBe('number');
    expect(brief.generated_at).toBeTruthy();
    expect(brief.text).toContain('Knowledge Base:');
  });

  it('sorts recent_decisions by updated descending', () => {
    writeEntry(
      ctx.memoryDir,
      'decisions/a.md',
      { title: 'Decision A', updated: '2026-04-01' },
      'A',
    );
    writeEntry(
      ctx.memoryDir,
      'decisions/b.md',
      { title: 'Decision B', updated: '2026-04-09' },
      'B',
    );
    writeEntry(
      ctx.memoryDir,
      'decisions/c.md',
      { title: 'Decision C', updated: '2026-04-05' },
      'C',
    );

    invalidateBriefCache();
    const brief = generateBrief(ctx.memoryDir);
    expect(brief.recent_decisions[0]).toBe('Decision B');
    expect(brief.recent_decisions[1]).toBe('Decision C');
    expect(brief.recent_decisions[2]).toBe('Decision A');
  });

  it('includes core_concepts from god nodes', () => {
    writeEntry(ctx.memoryDir, 'projects/hub.md', { title: 'Hub Project' }, 'Hub');
    writeEntry(ctx.memoryDir, 'projects/leaf1.md', { title: 'Leaf 1' }, 'L');
    writeEntry(ctx.memoryDir, 'projects/leaf2.md', { title: 'Leaf 2' }, 'L');
    writeEntry(ctx.memoryDir, 'projects/leaf3.md', { title: 'Leaf 3' }, 'L');

    const graph = getKnowledgeGraph();
    graph.link('projects/hub.md', 'projects/leaf1.md', 'related_to', 0.8);
    graph.link('projects/hub.md', 'projects/leaf2.md', 'related_to', 0.8);
    graph.link('projects/hub.md', 'projects/leaf3.md', 'related_to', 0.8);

    invalidateBriefCache();
    const brief = generateBrief(ctx.memoryDir);
    expect(brief.core_concepts).toContain('Hub Project');
  });

  it('caches brief on subsequent calls (same generated_at)', () => {
    writeEntry(ctx.memoryDir, 'projects/alpha.md', { title: 'Alpha' }, 'A');
    invalidateBriefCache();
    const brief1 = generateBrief(ctx.memoryDir);
    const brief2 = generateBrief(ctx.memoryDir);
    expect(brief1.generated_at).toBe(brief2.generated_at);
  });

  it('invalidateBriefCache forces regeneration with a fresh generated_at', () => {
    writeEntry(ctx.memoryDir, 'projects/alpha.md', { title: 'Alpha' }, 'A');
    invalidateBriefCache();
    const brief1 = generateBrief(ctx.memoryDir);
    invalidateBriefCache();
    // Spin briefly so the ISO-timestamp has room to advance.
    const until = Date.now() + 10;
    while (Date.now() < until) {
      /* spin */
    }
    const brief2 = generateBrief(ctx.memoryDir);
    expect(brief2.generated_at).not.toBe(brief1.generated_at);
  });

  it('text format includes Recent decisions section when populated', () => {
    writeEntry(ctx.memoryDir, 'projects/alpha.md', { title: 'Alpha' }, 'A');
    writeEntry(ctx.memoryDir, 'decisions/use-x.md', { title: 'Use X', updated: '2026-04-09' }, 'D');

    invalidateBriefCache();
    const brief = generateBrief(ctx.memoryDir);
    expect(brief.text).toContain('Knowledge Base:');
    expect(brief.text).toContain('Recent decisions:');
    expect(brief.text).toContain('Use X');
  });
});

/**
 * End-to-end coverage for the v1.4 features.
 *
 * Each test sets up a real on-disk memoryDir, exercises the full code path
 * (chunker / index / search / wakeup / graph / temporal / boosts), and asserts
 * the user-visible behavior. No mocks of internal components.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { KnowledgeGraph, isEdgeValidAt } from '../../src/knowledge/graph.js';
import { searchKnowledge, invalidateKnowledgeIndexCache } from '../../src/knowledge/search.js';
import { wakeup } from '../../src/wakeup.js';

function makeTmpMemoryDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-e2e-'));
  for (const sub of ['projects', 'people', 'decisions', 'workflows', 'notes']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

function writeEntry(dir: string, rel: string, frontmatter: Record<string, string>, body: string) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(frontmatter)) lines.push(`${k}: ${v}`);
  lines.push('---', '', body);
  fs.writeFileSync(path.join(dir, rel), lines.join('\n'));
}

describe('e2e: knowledge action=wakeup', () => {
  let memoryDir: string;
  const prevEnv = process.env.AGENT_KNOWLEDGE_MEMORY_DIR;

  beforeEach(() => {
    memoryDir = makeTmpMemoryDir();
    process.env.AGENT_KNOWLEDGE_MEMORY_DIR = memoryDir;
    invalidateKnowledgeIndexCache();
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.AGENT_KNOWLEDGE_MEMORY_DIR;
    else process.env.AGENT_KNOWLEDGE_MEMORY_DIR = prevEnv;
    fs.rmSync(memoryDir, { recursive: true, force: true });
  });

  it('returns the default identity when identity.md is missing', () => {
    writeEntry(memoryDir, 'projects/alpha.md', { title: 'Alpha' }, 'Alpha project content.');
    const result = wakeup({ tokenBudget: 800 });
    expect(result.identity).toContain('No identity configured');
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.token_estimate).toBeGreaterThan(0);
    expect(result.rendered).toContain('## L1 — ESSENTIAL FACTS');
  });

  it('reads identity.md when present', () => {
    fs.writeFileSync(
      path.join(memoryDir, 'identity.md'),
      'I am the test agent. I work on agent-knowledge.',
    );
    writeEntry(memoryDir, 'projects/alpha.md', { title: 'Alpha' }, 'Alpha project content.');
    const result = wakeup({ tokenBudget: 800 });
    expect(result.identity).toContain('test agent');
  });

  it('respects the token budget and marks truncated when overflowed', () => {
    // Write many large entries
    for (let i = 0; i < 20; i++) {
      writeEntry(
        memoryDir,
        `projects/proj-${i}.md`,
        { title: `Project ${i}` },
        'lorem ipsum '.repeat(60),
      );
    }
    const result = wakeup({ tokenBudget: 200 });
    expect(result.token_estimate).toBeLessThanOrEqual(220); // small overhead allowed
    expect(result.truncated).toBe(true);
    expect(result.entries.length).toBeLessThan(20);
  });

  it('scope filter narrows L1 to one category', () => {
    writeEntry(memoryDir, 'projects/alpha.md', { title: 'Alpha' }, 'Alpha content.');
    writeEntry(memoryDir, 'people/bob.md', { title: 'Bob' }, 'Bob content.');
    const result = wakeup({ tokenBudget: 800, scope: 'people' });
    expect(result.entries.every((e) => e.path.startsWith('people/'))).toBe(true);
    expect(result.entries.find((e) => e.title === 'Bob')).toBeDefined();
  });
});

describe('e2e: knowledge_search categoryMode', () => {
  let memoryDir: string;
  const prevEnv = process.env.AGENT_KNOWLEDGE_MEMORY_DIR;

  beforeEach(() => {
    memoryDir = makeTmpMemoryDir();
    process.env.AGENT_KNOWLEDGE_MEMORY_DIR = memoryDir;
    invalidateKnowledgeIndexCache();

    // Same query target lives in two categories — once in `decisions`,
    // once in `notes`. The user passes category='decisions'.
    writeEntry(
      memoryDir,
      'decisions/postgres.md',
      { title: 'Postgres decision' },
      'We chose Postgres over SQLite for concurrent writes and 10GB+ datasets.',
    );
    writeEntry(
      memoryDir,
      'notes/postgres-perf.md',
      { title: 'Postgres perf note' },
      'Postgres beat SQLite in our concurrent writes benchmark by 4x.',
    );
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.AGENT_KNOWLEDGE_MEMORY_DIR;
    else process.env.AGENT_KNOWLEDGE_MEMORY_DIR = prevEnv;
    fs.rmSync(memoryDir, { recursive: true, force: true });
    invalidateKnowledgeIndexCache();
  });

  it('filter mode discards non-matching category entries (current default)', () => {
    const results = searchKnowledge(memoryDir, 'postgres concurrent writes', {
      category: 'decisions',
      categoryMode: 'filter',
    });
    const paths = results.map((r) => r.entry.path);
    expect(paths).toContain('decisions/postgres.md');
    expect(paths).not.toContain('notes/postgres-perf.md');
  });

  it('boost mode keeps non-matching entries but ranks the matching category higher', () => {
    invalidateKnowledgeIndexCache();
    const results = searchKnowledge(memoryDir, 'postgres concurrent writes', {
      category: 'decisions',
      categoryMode: 'boost',
    });
    const paths = results.map((r) => r.entry.path);
    expect(paths).toContain('decisions/postgres.md');
    expect(paths).toContain('notes/postgres-perf.md');
    // Decisions entry should outrank the notes entry due to the 1.25x boost.
    const decIdx = paths.indexOf('decisions/postgres.md');
    const noteIdx = paths.indexOf('notes/postgres-perf.md');
    expect(decIdx).toBeLessThan(noteIdx);
  });
});

describe('e2e: knowledge_graph temporal validity', () => {
  let tmpDir: string;
  let graph: KnowledgeGraph;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-e2e-graph-'));
    graph = new KnowledgeGraph(path.join(tmpDir, 'graph.db'));
  });

  afterEach(() => {
    try {
      graph.close();
    } catch {
      /* ignore */
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('full lifecycle: link → list as_of → invalidate → list as_of', () => {
    // "Maya assigned to auth" valid Jan-Mar; "Soren assigned to auth" valid Apr+
    graph.link('people/maya.md', 'projects/auth.md', 'related_to', 0.9, '2026-01-01', '2026-03-31');
    graph.link('people/soren.md', 'projects/auth.md', 'related_to', 0.9, '2026-04-01', null);

    // Snapshot in February — Maya is the only assignee.
    const inFeb = graph.links('projects/auth.md', undefined, '2026-02-15');
    const febSources = inFeb.map((e) => e.source).sort();
    expect(febSources).toEqual(['people/maya.md']);

    // Snapshot in May — Soren has taken over (Maya's edge expired naturally).
    const inMay = graph.links('projects/auth.md', undefined, '2026-05-15');
    const maySources = inMay.map((e) => e.source).sort();
    expect(maySources).toEqual(['people/soren.md']);

    // Open-ended snapshot (no asOf) — current valid edges only (Soren has no valid_to).
    const open = graph.links('projects/auth.md');
    const openValid = open.filter((e) => e.valid_to === null);
    expect(openValid.length).toBe(1);
    expect(openValid[0].source).toBe('people/soren.md');

    // Manually invalidate Soren as of June.
    const updated = graph.invalidate(
      'people/soren.md',
      'projects/auth.md',
      'related_to',
      '2026-06-01',
    );
    expect(updated).toBe(1);

    // July snapshot — both edges have expired.
    const inJul = graph.links('projects/auth.md', undefined, '2026-07-01');
    expect(inJul.length).toBe(0);
  });

  it('graph traversal respects temporal filter', () => {
    graph.link('a.md', 'b.md', 'related_to', 0.5, '2026-01-01', '2026-06-30');
    graph.link('b.md', 'c.md', 'depends_on', 0.5, '2026-07-01', null);
    // In June, a→b is live but b→c hasn't started yet.
    const inJune = graph.graph('a.md', 5, '2026-06-15');
    expect(inJune.nodes.map((n) => n.path).sort()).toEqual(['a.md', 'b.md']);
    // In August, a→b has expired, so a can't even reach b.
    const inAug = graph.graph('a.md', 5, '2026-08-15');
    expect(inAug.nodes.length).toBe(1);
  });

  it('isEdgeValidAt: edge with no valid_to is open-ended', () => {
    const edge = graph.link('a.md', 'b.md', 'related_to', 0.5, '2026-01-01', null);
    expect(isEdgeValidAt(edge, '2030-01-01')).toBe(true);
    expect(isEdgeValidAt(edge, '2025-12-31')).toBe(false);
  });
});

describe('e2e: knowledge action=wakeup ranks higher-weight entries first', () => {
  let memoryDir: string;
  const prevEnv = process.env.AGENT_KNOWLEDGE_MEMORY_DIR;

  beforeEach(() => {
    memoryDir = makeTmpMemoryDir();
    process.env.AGENT_KNOWLEDGE_MEMORY_DIR = memoryDir;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.AGENT_KNOWLEDGE_MEMORY_DIR;
    else process.env.AGENT_KNOWLEDGE_MEMORY_DIR = prevEnv;
    fs.rmSync(memoryDir, { recursive: true, force: true });
  });

  it('orders L1 by recency * log(size)', () => {
    // Tiny old entry
    writeEntry(memoryDir, 'projects/old.md', { title: 'Old' }, 'tiny');
    const oldPath = path.join(memoryDir, 'projects/old.md');
    const old = new Date('2024-01-01').getTime();
    fs.utimesSync(oldPath, old / 1000, old / 1000);

    // Big recent entry
    writeEntry(
      memoryDir,
      'projects/big-recent.md',
      { title: 'Big Recent' },
      'lorem ipsum dolor sit amet '.repeat(50),
    );

    const result = wakeup({ tokenBudget: 800 });
    const titles = result.entries.map((e) => e.title);
    // Big Recent should be ranked above Old
    const bigIdx = titles.indexOf('Big Recent');
    const oldIdx = titles.indexOf('Old');
    expect(bigIdx).toBeGreaterThanOrEqual(0);
    expect(bigIdx).toBeLessThan(oldIdx);
  });
});

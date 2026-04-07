import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { searchSessions } from '../src/sessions/search.js';
import * as parser from '../src/sessions/parser.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-ssearch-test-'));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function createSessionFile(dir: string, sessionId: string, entries: object[]): void {
  const content = entries.map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), content);
}

describe('searchSessions', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    const projectDir = path.join(tmpDir, 'my-project');
    fs.mkdirSync(projectDir, { recursive: true });

    createSessionFile(projectDir, 'sess-typescript', [
      {
        type: 'user',
        timestamp: '2026-01-01T00:00:00Z',
        cwd: '/proj',
        message: { role: 'user', content: 'How do I configure TypeScript for ESM modules?' },
      },
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:01Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Set module to NodeNext in tsconfig.json' }],
        },
      },
    ]);

    createSessionFile(projectDir, 'sess-python', [
      {
        type: 'user',
        timestamp: '2026-01-02T00:00:00Z',
        cwd: '/proj',
        message: { role: 'user', content: 'How do I setup Python virtual environment?' },
      },
      {
        type: 'assistant',
        timestamp: '2026-01-02T00:00:01Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Use python -m venv .venv to create a virtual environment' },
          ],
        },
      },
    ]);

    createSessionFile(projectDir, 'sess-database', [
      {
        type: 'user',
        timestamp: '2026-01-03T00:00:00Z',
        cwd: '/proj',
        message: {
          role: 'user',
          content: 'What database should I use for this TypeScript project?',
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-01-03T00:00:01Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'PostgreSQL is a great choice for TypeScript applications' },
          ],
        },
      },
    ]);

    vi.spyOn(parser, 'getProjectDirs').mockReturnValue([{ name: 'my-project', path: projectDir }]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup(tmpDir);
  });

  // ── Ranked (TF-IDF) mode ─────────────────────────────────────────────────

  it('returns ranked results by TF-IDF relevance', async () => {
    const results = await searchSessions('TypeScript', { semantic: false });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('ranks results with most relevant first', async () => {
    const results = await searchSessions('TypeScript', { semantic: false });
    // Results about TypeScript should come first
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('includes source, id, project, excerpt, and score fields', async () => {
    const results = await searchSessions('TypeScript', { semantic: false });
    expect(results.length).toBeGreaterThan(0);
    const r = results[0];
    expect(r.source).toBe('session');
    expect(r.id).toMatch(/^sess-/);
    expect(r.project).toBe('my-project');
    expect(r.excerpt).toMatch(/TypeScript/i);
    expect(r.score).toBeGreaterThan(0);
  });

  it('filters by role (user only)', async () => {
    const results = await searchSessions('TypeScript', { role: 'user', semantic: false });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.role === 'user')).toBe(true);
  });

  it('filters by role (assistant only)', async () => {
    const results = await searchSessions('TypeScript', { role: 'assistant', semantic: false });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.role === 'assistant')).toBe(true);
  });

  it('returns all roles by default', async () => {
    const results = await searchSessions('TypeScript', { semantic: false });
    const roles = new Set(results.map((r) => r.role));
    expect(roles.size).toBeGreaterThanOrEqual(1);
  });

  it('respects maxResults limit', async () => {
    const results = await searchSessions('TypeScript', { maxResults: 1, semantic: false });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('returns empty for query with only stopwords', async () => {
    const results = await searchSessions('the and or but', { semantic: false });
    expect(results).toEqual([]);
  });

  it('filters by project name', async () => {
    const results = await searchSessions('TypeScript', { project: 'my-project', semantic: false });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.project === 'my-project')).toBe(true);
  });

  it('returns fewer or no results when project filter excludes matches', async () => {
    const matched = await searchSessions('TypeScript', { project: 'my-project', semantic: false });
    const filtered = await searchSessions('TypeScript', {
      project: 'xyznonexist999zzz',
      semantic: false,
    });
    expect(filtered.length).toBeLessThanOrEqual(matched.length);
  });

  // ── Regex mode ───────────────────────────────────────────────────────────

  it('supports regex mode with ranked=false', async () => {
    const results = await searchSessions('TypeScript', { ranked: false, semantic: false });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.score === 1)).toBe(true); // regex mode uses score=1
  });

  it('regex mode handles special characters gracefully', async () => {
    const results = await searchSessions('test[invalid(regex', { ranked: false, semantic: false });
    // Should not throw; may return empty or results but must be a valid array
    expect(results).toEqual(expect.any(Array));
    for (const r of results) {
      expect(r.score).toBeDefined();
    }
  });

  it('regex mode respects role filter', async () => {
    const results = await searchSessions('TypeScript', {
      ranked: false,
      role: 'user',
      semantic: false,
    });
    expect(results.every((r) => r.role === 'user')).toBe(true);
  });

  it('regex mode respects maxResults', async () => {
    const results = await searchSessions('TypeScript', {
      ranked: false,
      maxResults: 1,
      semantic: false,
    });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('regex mode includes excerpts containing the search term', async () => {
    const results = await searchSessions('TypeScript', { ranked: false, semantic: false });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].excerpt).toMatch(/TypeScript/i);
  });

  // ── Semantic fallback ──────────────────────────────────────────────────

  it(
    'semantic: true falls back gracefully when no embeddings available',
    { timeout: 30_000 },
    async () => {
      const results = await searchSessions('TypeScript', { semantic: true });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].score).toBeGreaterThan(0);
    },
  );

  it(
    'default behavior returns results when no vector store exists',
    { timeout: 30_000 },
    async () => {
      const results = await searchSessions('TypeScript');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].score).toBeGreaterThan(0);
    },
  );
});

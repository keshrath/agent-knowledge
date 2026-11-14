import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { scopedSearch } from '../src/sessions/scopes.js';
import * as parser from '../src/sessions/parser.js';
import { resetProvider } from '../src/embeddings/factory.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-scopes-test-'));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function createSessionFile(dir: string, sessionId: string, entries: object[]): void {
  const content = entries.map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), content);
}

describe('scopedSearch', () => {
  let tmpDir: string;

  beforeEach(() => {
    // No embeddings, said outright: a provider with no key. The default (local) would load a
    // model, and fetch it when not cached: seconds, and the network, in a unit test.
    vi.stubEnv('AGENT_KNOWLEDGE_EMBEDDING_PROVIDER', 'openai');
    vi.stubEnv('AGENT_KNOWLEDGE_OPENAI_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    resetProvider();
    tmpDir = makeTmpDir();
    const projectDir = path.join(tmpDir, 'test-project');
    fs.mkdirSync(projectDir, { recursive: true });

    createSessionFile(projectDir, 'sess-errors', [
      {
        type: 'user',
        timestamp: '2026-01-01T00:00:00Z',
        cwd: '/',
        message: { role: 'user', content: 'I got a TypeError exception when running the app' },
      },
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:01Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'The TypeError is caused by a null reference. Let me fix it.' },
          ],
        },
      },
    ]);

    createSessionFile(projectDir, 'sess-plans', [
      {
        type: 'user',
        timestamp: '2026-01-02T00:00:00Z',
        cwd: '/',
        message: { role: 'user', content: 'Let me plan the architecture for phase 2' },
      },
      {
        type: 'assistant',
        timestamp: '2026-01-02T00:00:01Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Here is the roadmap: step 1 setup, step 2 implement, step 3 test',
            },
          ],
        },
      },
    ]);

    createSessionFile(projectDir, 'sess-configs', [
      {
        type: 'user',
        timestamp: '2026-01-03T00:00:00Z',
        cwd: '/',
        message: { role: 'user', content: 'Update the tsconfig.json and package.json settings' },
      },
    ]);

    createSessionFile(projectDir, 'sess-tools', [
      { type: 'tool_use', content: '{"name": "Read", "input": {"path": "src/index.ts"}}' },
      { type: 'tool_result', message: { content: 'File content here' } },
    ]);

    createSessionFile(projectDir, 'sess-files', [
      {
        type: 'user',
        timestamp: '2026-01-05T00:00:00Z',
        cwd: '/',
        message: { role: 'user', content: 'I modified src/server.ts and created lib/utils.ts' },
      },
    ]);

    createSessionFile(projectDir, 'sess-decisions', [
      {
        type: 'user',
        timestamp: '2026-01-06T00:00:00Z',
        cwd: '/',
        message: {
          role: 'user',
          content: 'We decided to use PostgreSQL because of its reliability instead of MongoDB',
        },
      },
    ]);

    vi.spyOn(parser, 'getProjectDirs').mockReturnValue([
      { name: 'test-project', path: projectDir },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetProvider();
    cleanup(tmpDir);
  });

  it.each([
    { scope: 'errors' as const, query: 'null reference', expectMatch: /error|typeerror|null/i },
    { scope: 'plans' as const, query: 'roadmap', expectMatch: /roadmap|plan|step/i },
    { scope: 'configs' as const, query: 'tsconfig', expectMatch: /tsconfig|package\.json/i },
    { scope: 'files' as const, query: 'server', expectMatch: /server|src/i },
    { scope: 'decisions' as const, query: 'PostgreSQL', expectMatch: /postgresql|decided/i },
    { scope: 'all' as const, query: 'null', expectMatch: /null/i },
  ])(
    'filters $scope scope and returns matching excerpts for "$query"',
    async ({ scope, query, expectMatch }) => {
      const results = await scopedSearch(scope, query, { semantic: false });
      expect(results.length).toBeGreaterThanOrEqual(1);
      const allExcerpts = results.map((r) => r.excerpt).join(' ');
      expect(allExcerpts).toMatch(expectMatch);
      for (const r of results) {
        expect(r.metadata?.scope).toBe(scope);
      }
    },
  );

  it('filters tools scope and tags results with correct metadata', async () => {
    const results = await scopedSearch('tools', 'Read', { semantic: false });
    for (const r of results) {
      expect(r.metadata?.scope).toBe('tools');
    }
  });

  it('returns empty results when query has no matches', async () => {
    const results = await scopedSearch('errors', 'xyznonexistent', { semantic: false });
    expect(results).toEqual([]);
  });

  it('respects maxResults option', async () => {
    const results = await scopedSearch('all', 'the', { maxResults: 1, semantic: false });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('filters by project', async () => {
    const results = await scopedSearch('all', 'null', { project: 'test-project', semantic: false });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.project === 'test-project')).toBe(true);
  });

  it('returns fewer or no results when project filter excludes matches', async () => {
    const broad = await scopedSearch('all', 'null', { project: 'test-project', semantic: false });
    const narrow = await scopedSearch('all', 'null', {
      project: 'xyznonexist999zzz',
      semantic: false,
    });
    expect(narrow.length).toBeLessThanOrEqual(broad.length);
  });

  it('includes metadata with scope info', async () => {
    const results = await scopedSearch('errors', 'TypeError', { semantic: false });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].metadata!.scope).toBe('errors');
  });

  it('semantic: true falls back gracefully when no embeddings available', async () => {
    const results = await scopedSearch('all', 'TypeError', { semantic: true });
    // Should fall back to TF-IDF and still find matches
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[0].excerpt.toLowerCase()).toContain('typeerror');
  });
});

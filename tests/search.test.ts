import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { excerptText, searchKnowledge } from '../src/knowledge/search.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-search-test-'));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeDoc(dir: string, category: string, filename: string, content: string): void {
  const catDir = path.join(dir, category);
  fs.mkdirSync(catDir, { recursive: true });
  fs.writeFileSync(path.join(catDir, filename), content, 'utf-8');
}

describe('searchKnowledge', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    writeDoc(
      tmpDir,
      'projects',
      'typescript-app.md',
      '---\ntitle: TypeScript App\ntags: [typescript, react]\n---\nA web application built with TypeScript and React for frontend development.',
    );
    writeDoc(
      tmpDir,
      'projects',
      'python-api.md',
      '---\ntitle: Python API\ntags: [python, flask]\n---\nA REST API built with Python Flask for backend services.',
    );
    writeDoc(
      tmpDir,
      'notes',
      'meeting.md',
      '---\ntitle: Team Meeting\ntags: [meeting]\n---\nDiscussed deployment strategy and database migration plan.',
    );
    writeDoc(
      tmpDir,
      'decisions',
      'db-choice.md',
      '---\ntitle: Database Choice\ntags: [database, postgres]\n---\nDecided to use PostgreSQL for the main database due to its reliability.',
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it('returns results ranked by TF-IDF relevance', () => {
    const results = searchKnowledge(tmpDir, 'typescript');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].entry.title).toBe('TypeScript App');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('returns empty array for empty directory', () => {
    const emptyDir = makeTmpDir();
    const results = searchKnowledge(emptyDir, 'anything');
    expect(results).toEqual([]);
    cleanup(emptyDir);
  });

  it('returns empty array for non-matching query with all stopwords', () => {
    const results = searchKnowledge(tmpDir, 'the and or');
    expect(results).toEqual([]);
  });

  it('filters by category', () => {
    const results = searchKnowledge(tmpDir, 'built', { category: 'projects' });
    for (const r of results) {
      expect(r.entry.category).toBe('projects');
    }
  });

  it('falls back to regex search when TF-IDF returns no results', () => {
    // This exact phrase search should trigger regex fallback
    const results = searchKnowledge(tmpDir, 'PostgreSQL');
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('respects maxResults option', () => {
    const results = searchKnowledge(tmpDir, 'built application', { maxResults: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('includes excerpts containing the search term', () => {
    const results = searchKnowledge(tmpDir, 'typescript');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].excerpt.toLowerCase()).toContain('typescript');
  });

  it('takes excerpts from the body, never the frontmatter', () => {
    const results = searchKnowledge(tmpDir, 'flask');
    expect(results[0]?.entry.path).toBe('projects/python-api.md');
    expect(results[0]!.excerpt).toContain('Python Flask');
    expect(results[0]!.excerpt).not.toMatch(/---|title:|tags:/);
  });

  it('builds excerpt text without headings, one segment per paragraph and list item', () => {
    expect(
      excerptText(
        '# Zebrafish\n\nThe zebrafish service\ndeploys with make ship.\n\n- REST stays\n- the dashboard is gone\n\n```\ncode\n```',
      ),
    ).toBe('The zebrafish service deploys with make ship. · REST stays · the dashboard is gone');
  });

  it('drops what a code block holds and table separator rows from excerpts', () => {
    expect(
      excerptText(
        'Build it:\n\n```sh\nnpm run build\ntsc\n```\n\n| a | b |\n|---|:---:|\n| 1 | 2 |\n\n~~~\nraw\n~~~\nDone.',
      ),
    ).toBe('Build it: · a, b · 1, 2 · Done.');
  });

  it('handles special regex characters in query gracefully', () => {
    const results = searchKnowledge(tmpDir, 'test[invalid(regex');
    // Should not throw; returns empty or results but never crashes
    expect(results).toEqual(expect.any(Array));
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
    }
  });
});

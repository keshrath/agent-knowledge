import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  parseFrontmatter,
  listEntries,
  readEntry,
  writeEntry,
  deleteEntry,
  sanitizePath,
} from '../src/knowledge/store.js';

// ── Helper: temp directory ─────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-store-test-'));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── parseFrontmatter ───────────────────────────────────────────────────────

describe('parseFrontmatter', () => {
  it('reads a quoted value without its quotes, escapes and all', () => {
    const { meta } = parseFrontmatter(
      [
        '---',
        'title: "Task #1: ship the \\"pane\\""',
        "author: 'it''s me'",
        'plain: a: b',
        'tags: ["release notes", \'pane\', plain]',
        '---',
        'body',
      ].join('\n'),
    );
    expect(meta.title).toBe('Task #1: ship the "pane"');
    expect(meta.author).toBe("it's me");
    expect(meta.plain).toBe('a: b');
    expect(meta.tags).toEqual(['release notes', 'pane', 'plain']);
  });

  it('parses valid frontmatter with title, tags, and updated', () => {
    const content =
      '---\ntitle: My Project\ntags: [a, b, c]\nupdated: 2026-01-01\n---\nBody text here.';
    const { meta, body } = parseFrontmatter(content);
    expect(meta.title).toBe('My Project');
    expect(meta.tags).toEqual(['a', 'b', 'c']);
    expect(meta.updated).toBe('2026-01-01');
    expect(body).toBe('Body text here.');
  });

  it('returns empty meta and full body when no frontmatter', () => {
    const content = 'Just some text without frontmatter.';
    const { meta, body } = parseFrontmatter(content);
    expect(meta).toEqual({});
    expect(body).toBe(content);
  });

  it('handles Windows line endings (\\r\\n)', () => {
    const content = '---\r\ntitle: Windows File\r\ntags: [win]\r\n---\r\nBody with CRLF.';
    const { meta, body } = parseFrontmatter(content);
    expect(meta.title).toBe('Windows File');
    expect(meta.tags).toEqual(['win']);
    expect(body).toBe('Body with CRLF.');
  });

  it('handles empty tags array', () => {
    const content = '---\ntitle: Empty Tags\ntags: []\n---\nBody.';
    const { meta } = parseFrontmatter(content);
    expect(meta.tags).toEqual([]);
  });

  it('handles missing closing delimiter', () => {
    const content = '---\ntitle: Broken\n';
    const { meta, body } = parseFrontmatter(content);
    expect(meta).toEqual({});
    expect(body).toBe(content);
  });

  it('handles empty body after frontmatter', () => {
    const content = '---\ntitle: No Body\n---\n';
    const { meta, body } = parseFrontmatter(content);
    expect(meta.title).toBe('No Body');
    expect(body).toBe('');
  });

  it('handles frontmatter with no key-value pairs', () => {
    const content = '---\nnot a key value\n---\nBody.';
    const { meta, body } = parseFrontmatter(content);
    expect(meta).toEqual({});
    expect(body).toBe('Body.');
  });

  it('handles single-value tags (not array)', () => {
    const content = '---\ntitle: Single Tag\ntags: typescript\n---\nBody.';
    const { meta } = parseFrontmatter(content);
    expect(meta.tags).toBe('typescript');
  });
});

// ── sanitizePath ───────────────────────────────────────────────────────────

describe('sanitizePath', () => {
  it('allows normal relative paths', () => {
    expect(sanitizePath('projects/my-file.md')).toBe('projects/my-file.md');
  });

  it('rejects paths with null bytes', () => {
    expect(() => sanitizePath('projects/\0evil.md')).toThrow('null bytes');
  });

  it('rejects paths with .. traversal', () => {
    expect(() => sanitizePath('../../../etc/passwd')).toThrow('Path traversal');
  });

  it('rejects absolute paths starting with /', () => {
    expect(() => sanitizePath('/etc/passwd')).toThrow('Path traversal');
  });

  it('rejects backslash traversal', () => {
    expect(() => sanitizePath('..\\..\\etc\\passwd')).toThrow('Path traversal');
  });
});

// ── listEntries ────────────────────────────────────────────────────────────

describe('listEntries', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it('returns empty array for non-existent directory', () => {
    const entries = listEntries(path.join(tmpDir, 'nonexistent'));
    expect(entries).toEqual([]);
  });

  it('lists .md files with frontmatter', () => {
    const projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectsDir, 'test.md'),
      '---\ntitle: Test\ntags: [a]\n---\nContent',
    );

    const entries = listEntries(tmpDir);
    expect(entries.length).toBe(1);
    expect(entries[0].title).toBe('Test');
    expect(entries[0].tags).toEqual(['a']);
    expect(entries[0].category).toBe('projects');
    expect(entries[0].path).toBe('projects/test.md');
  });

  it('filters by category', () => {
    const projectsDir = path.join(tmpDir, 'projects');
    const notesDir = path.join(tmpDir, 'notes');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(notesDir, { recursive: true });
    fs.writeFileSync(path.join(projectsDir, 'p1.md'), '---\ntitle: Project\n---\n');
    fs.writeFileSync(path.join(notesDir, 'n1.md'), '---\ntitle: Note\n---\n');

    const entries = listEntries(tmpDir, 'projects');
    expect(entries.length).toBe(1);
    expect(entries[0].title).toBe('Project');
  });

  it('filters by tag (case-insensitive)', () => {
    const notesDir = path.join(tmpDir, 'notes');
    fs.mkdirSync(notesDir, { recursive: true });
    fs.writeFileSync(
      path.join(notesDir, 'tagged.md'),
      '---\ntitle: Tagged\ntags: [TypeScript, React]\n---\n',
    );
    fs.writeFileSync(path.join(notesDir, 'untagged.md'), '---\ntitle: Untagged\n---\n');

    const entries = listEntries(tmpDir, undefined, 'typescript');
    expect(entries.length).toBe(1);
    expect(entries[0].title).toBe('Tagged');
  });

  it('skips hidden directories', () => {
    const hiddenDir = path.join(tmpDir, '.git');
    fs.mkdirSync(hiddenDir, { recursive: true });
    fs.writeFileSync(path.join(hiddenDir, 'config.md'), 'git config');

    const entries = listEntries(tmpDir);
    expect(entries.length).toBe(0);
  });

  it('derives title from filename when no frontmatter title', () => {
    fs.writeFileSync(path.join(tmpDir, 'no-frontmatter.md'), 'Just text, no frontmatter.');

    const entries = listEntries(tmpDir);
    expect(entries.length).toBe(1);
    expect(entries[0].title).toBe('no-frontmatter');
  });
});

// ── readEntry ──────────────────────────────────────────────────────────────

describe('readEntry', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    const notesDir = path.join(tmpDir, 'notes');
    fs.mkdirSync(notesDir, { recursive: true });
    fs.writeFileSync(
      path.join(notesDir, 'test.md'),
      '---\ntitle: Read Test\ntags: [x]\nupdated: 2026-01-01\n---\nEntry body.',
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it('reads an entry and returns parsed content', () => {
    const { entry, content } = readEntry(tmpDir, 'notes/test.md');
    expect(entry.title).toBe('Read Test');
    expect(entry.tags).toEqual(['x']);
    expect(entry.category).toBe('notes');
    expect(entry.content).toBe('Entry body.');
    expect(content).toContain('title: Read Test');
  });

  it('throws for non-existent file', () => {
    expect(() => readEntry(tmpDir, 'notes/missing.md')).toThrow('File not found');
  });

  it('rejects path traversal', () => {
    expect(() => readEntry(tmpDir, '../../../etc/passwd')).toThrow();
  });

  it('rejects null bytes', () => {
    expect(() => readEntry(tmpDir, 'notes/\0evil.md')).toThrow('null bytes');
  });
});

// ── writeEntry ─────────────────────────────────────────────────────────────

describe('writeEntry', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it('writes a new entry and returns the relative path', () => {
    const relPath = writeEntry(tmpDir, 'projects', 'new-project', '# My Project\nContent here.');
    expect(relPath).toBe('projects/new-project.md');
    const written = fs.readFileSync(path.join(tmpDir, relPath), 'utf-8');
    expect(written).toBe('# My Project\nContent here.');
  });

  it('auto-appends .md extension when missing', () => {
    const relPath = writeEntry(tmpDir, 'notes', 'myfile', 'content');
    expect(relPath).toBe('notes/myfile.md');
    expect(fs.existsSync(path.join(tmpDir, relPath))).toBe(true);
  });

  it('does not double-add .md extension', () => {
    const relPath = writeEntry(tmpDir, 'notes', 'myfile.md', 'content');
    expect(relPath).toBe('notes/myfile.md');
  });

  it('rejects invalid category', () => {
    expect(() => writeEntry(tmpDir, 'invalid', 'file', 'content')).toThrow('Invalid category');
  });

  it('rejects filename with path separators', () => {
    expect(() => writeEntry(tmpDir, 'notes', '../evil', 'content')).toThrow();
  });

  it('creates category directory if it does not exist', () => {
    writeEntry(tmpDir, 'workflows', 'deploy', 'steps');
    expect(fs.existsSync(path.join(tmpDir, 'workflows'))).toBe(true);
  });
});

// ── deleteEntry ────────────────────────────────────────────────────────────

describe('deleteEntry', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    const notesDir = path.join(tmpDir, 'notes');
    fs.mkdirSync(notesDir, { recursive: true });
    fs.writeFileSync(path.join(notesDir, 'to-delete.md'), 'delete me');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it('deletes an existing file and returns true', () => {
    const result = deleteEntry(tmpDir, 'notes/to-delete.md');
    expect(result).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'notes/to-delete.md'))).toBe(false);
  });

  it('returns false for non-existent file', () => {
    const result = deleteEntry(tmpDir, 'notes/nonexistent.md');
    expect(result).toBe(false);
  });

  it('rejects path traversal', () => {
    expect(() => deleteEntry(tmpDir, '../../../etc/passwd')).toThrow();
  });

  it('rejects null bytes', () => {
    expect(() => deleteEntry(tmpDir, 'notes/\0evil.md')).toThrow('null bytes');
  });

  it('touches nothing that is no entry: not .md, hidden, in a hidden folder', () => {
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.git', 'config'), '[core]');
    fs.writeFileSync(path.join(tmpDir, '.git', 'x.md'), '# x');
    fs.writeFileSync(path.join(tmpDir, '.identity-declined'), '');
    fs.writeFileSync(path.join(tmpDir, 'notes', 'data.json'), '{}');
    for (const p of ['.git/config', '.git/x.md', '.identity-declined', 'notes/data.json']) {
      expect(() => deleteEntry(tmpDir, p)).toThrow('Not a knowledge entry');
      expect(() => readEntry(tmpDir, p)).toThrow('Not a knowledge entry');
      expect(fs.existsSync(path.join(tmpDir, p))).toBe(true);
    }
  });
});

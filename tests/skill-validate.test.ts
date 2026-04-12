import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const VALIDATE_PATH = join(
  __dirname,
  '..',
  'skills',
  'knowledge-ingest',
  'scripts',
  'validate.mjs',
);

const TMP_TARGET = join(__dirname, '__tmp_validate_target__');
const TMP_KNOWLEDGE = join(__dirname, '__tmp_validate_knowledge__');

function runValidate(
  targetPath: string,
  knowledgeDir?: string,
): { status: string; passed: string[]; issues: string[] } {
  const kdFlag = knowledgeDir ? ` --knowledge-dir "${knowledgeDir}"` : '';
  try {
    const out = execSync(`node "${VALIDATE_PATH}" "${targetPath}"${kdFlag}`, {
      encoding: 'utf-8',
      timeout: 10_000,
      env: { ...process.env, KNOWLEDGE_MEMORY_DIR: knowledgeDir || TMP_KNOWLEDGE },
    });
    return JSON.parse(out);
  } catch (e: unknown) {
    const err = e as { stdout?: string };
    if (err.stdout) return JSON.parse(err.stdout);
    throw e;
  }
}

beforeEach(() => {
  mkdirSync(TMP_TARGET, { recursive: true });
  mkdirSync(join(TMP_KNOWLEDGE, 'projects'), { recursive: true });
  mkdirSync(join(TMP_KNOWLEDGE, 'notes'), { recursive: true });
  mkdirSync(join(TMP_KNOWLEDGE, 'decisions'), { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_TARGET)) rmSync(TMP_TARGET, { recursive: true, force: true });
  if (existsSync(TMP_KNOWLEDGE)) rmSync(TMP_KNOWLEDGE, { recursive: true, force: true });
});

describe('knowledge-ingest validate', () => {
  it('fails when no cache file exists', () => {
    const result = runValidate(TMP_TARGET);
    expect(result.status).toBe('FAIL');
    expect(result.issues.some((i) => i.includes('Cache file'))).toBe(true);
  });

  it('fails when cache file is invalid JSON', () => {
    writeFileSync(join(TMP_TARGET, '.knowledge-ingest-cache.json'), 'not json');
    const result = runValidate(TMP_TARGET);
    expect(result.status).toBe('FAIL');
    expect(result.issues.some((i) => i.includes('not valid JSON'))).toBe(true);
  });

  it('fails when cache is missing required fields', () => {
    writeFileSync(join(TMP_TARGET, '.knowledge-ingest-cache.json'), JSON.stringify({}));
    const result = runValidate(TMP_TARGET);
    expect(result.status).toBe('FAIL');
    expect(result.issues.some((i) => i.includes('missing required fields'))).toBe(true);
  });

  it('fails when entries listed in cache are missing on disk', () => {
    const cache = {
      version: 1,
      timestamp: new Date().toISOString(),
      project: 'test-project',
      files: { 'src/main.ts': { sha256: 'a'.repeat(64), entries: ['notes/test-project-core.md'] } },
      entries_created: ['projects/test-project.md', 'notes/test-project-core.md'],
    };
    writeFileSync(join(TMP_TARGET, '.knowledge-ingest-cache.json'), JSON.stringify(cache));
    const result = runValidate(TMP_TARGET);
    expect(result.status).toBe('FAIL');
    expect(result.issues.some((i) => i.includes('missing on disk'))).toBe(true);
  });

  it('passes when all entries exist and cache is valid', () => {
    const projectContent = `---\ntitle: Test Project\ntags: [auto-ingested]\n---\n\n# Test Project\n\nA test project with enough content to pass the length check for validation purposes.\n`;
    const noteContent = `---\ntitle: Test Project — Core\ntags: [auto-ingested, subsystem]\n---\n\n## Purpose\nCore module.\n`;

    writeFileSync(join(TMP_KNOWLEDGE, 'projects', 'test-project.md'), projectContent);
    writeFileSync(join(TMP_KNOWLEDGE, 'notes', 'test-project-core.md'), noteContent);

    const cache = {
      version: 1,
      timestamp: new Date().toISOString(),
      project: 'test-project',
      files: { 'src/main.ts': { sha256: 'a'.repeat(64), entries: ['notes/test-project-core.md'] } },
      entries_created: ['projects/test-project.md', 'notes/test-project-core.md'],
    };
    writeFileSync(join(TMP_TARGET, '.knowledge-ingest-cache.json'), JSON.stringify(cache));

    const result = runValidate(TMP_TARGET);
    expect(result.status).toBe('PASS');
    expect(result.issues).toHaveLength(0);
    expect(result.passed.length).toBeGreaterThan(3);
  });

  it('detects invalid SHA256 hashes', () => {
    writeFileSync(
      join(TMP_KNOWLEDGE, 'projects', 'test-project.md'),
      `---\ntitle: Test\n---\n\n# Test\n\nSome content here for the validation check to pass the minimum length.\n`,
    );

    const cache = {
      version: 1,
      timestamp: new Date().toISOString(),
      project: 'test-project',
      files: { 'src/main.ts': { sha256: 'short', entries: ['projects/test-project.md'] } },
      entries_created: ['projects/test-project.md'],
    };
    writeFileSync(join(TMP_TARGET, '.knowledge-ingest-cache.json'), JSON.stringify(cache));

    const result = runValidate(TMP_TARGET);
    expect(result.status).toBe('FAIL');
    expect(result.issues.some((i) => i.includes('invalid or missing SHA256'))).toBe(true);
  });

  it('detects empty entries_created', () => {
    const cache = {
      version: 1,
      timestamp: new Date().toISOString(),
      project: 'test-project',
      files: {},
      entries_created: [],
    };
    writeFileSync(join(TMP_TARGET, '.knowledge-ingest-cache.json'), JSON.stringify(cache));

    const result = runValidate(TMP_TARGET);
    expect(result.status).toBe('FAIL');
    expect(result.issues.some((i) => i.includes('empty'))).toBe(true);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HOOK_PATH = join(__dirname, '..', '..', 'scripts', 'hooks', 'session-start-ingest.mjs');
const TMP_DIR = join(__dirname, '__tmp_ingest_hook__');

function runHook(
  cwd: string,
  stdin?: string,
): { hookSpecificOutput?: { additionalContext?: string } } {
  const input = stdin || JSON.stringify({ cwd });
  try {
    const out = execSync(`node "${HOOK_PATH}"`, {
      encoding: 'utf-8',
      timeout: 15_000,
      input,
    });
    return JSON.parse(out.trim());
  } catch (e: unknown) {
    const err = e as { stdout?: string };
    if (err.stdout) return JSON.parse(err.stdout.trim());
    throw e;
  }
}

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('session-start-ingest hook', () => {
  it('outputs empty JSON for directories with too few source files', () => {
    writeFileSync(join(TMP_DIR, 'readme.txt'), 'hello');
    const result = runHook(TMP_DIR);
    expect(result).toEqual({});
  });

  it('suggests bootstrapping when no cache exists and source files found', () => {
    mkdirSync(join(TMP_DIR, 'src'), { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(TMP_DIR, 'src', `file${i}.ts`), `export const x${i} = ${i};\n`);
    }
    const result = runHook(TMP_DIR);
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    expect(ctx).toContain('has not been ingested yet');
    expect(ctx).toContain('/knowledge-ingest');
  });

  it('reports up to date when cache matches current files', () => {
    mkdirSync(join(TMP_DIR, 'src'), { recursive: true });
    const content = 'export const x = 1;\n';
    writeFileSync(join(TMP_DIR, 'src', 'main.ts'), content);

    const hash = createHash('sha256').update(content).digest('hex');

    const cache = {
      version: 1,
      timestamp: new Date().toISOString(),
      project: 'test-proj',
      files: { 'src/main.ts': { sha256: hash, entries: ['notes/test-proj-core.md'] } },
      entries_created: ['projects/test-proj.md', 'notes/test-proj-core.md'],
    };
    writeFileSync(join(TMP_DIR, '.knowledge-ingest-cache.json'), JSON.stringify(cache));

    const result = runHook(TMP_DIR);
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    expect(ctx).toContain('up to date');
  });

  it('reports changed files when cache is stale', () => {
    mkdirSync(join(TMP_DIR, 'src'), { recursive: true });
    writeFileSync(join(TMP_DIR, 'src', 'main.ts'), 'export const x = 2;\n');

    const cache = {
      version: 1,
      timestamp: new Date().toISOString(),
      project: 'test-proj',
      files: { 'src/main.ts': { sha256: 'a'.repeat(64), entries: ['notes/test-proj-core.md'] } },
      entries_created: ['projects/test-proj.md'],
    };
    writeFileSync(join(TMP_DIR, '.knowledge-ingest-cache.json'), JSON.stringify(cache));

    const result = runHook(TMP_DIR);
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    expect(ctx).toContain('file changes since last ingest');
    expect(ctx).toContain('/knowledge-ingest');
  });

  it('detects new files not in cache', () => {
    mkdirSync(join(TMP_DIR, 'src'), { recursive: true });
    writeFileSync(join(TMP_DIR, 'src', 'main.ts'), 'export const x = 1;\n');
    writeFileSync(join(TMP_DIR, 'src', 'new.ts'), 'export const y = 2;\n');

    const hash = createHash('sha256').update('export const x = 1;\n').digest('hex');

    const cache = {
      version: 1,
      timestamp: new Date().toISOString(),
      project: 'test-proj',
      files: { 'src/main.ts': { sha256: hash, entries: ['notes/test-proj-core.md'] } },
      entries_created: ['projects/test-proj.md'],
    };
    writeFileSync(join(TMP_DIR, '.knowledge-ingest-cache.json'), JSON.stringify(cache));

    const result = runHook(TMP_DIR);
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    expect(ctx).toContain('1 new');
  });

  it('detects deleted files', () => {
    mkdirSync(join(TMP_DIR, 'src'), { recursive: true });
    writeFileSync(join(TMP_DIR, 'src', 'main.ts'), 'export const x = 1;\n');

    const cache = {
      version: 1,
      timestamp: new Date().toISOString(),
      project: 'test-proj',
      files: {
        'src/main.ts': { sha256: 'a'.repeat(64), entries: [] },
        'src/deleted.ts': { sha256: 'b'.repeat(64), entries: [] },
      },
      entries_created: ['projects/test-proj.md'],
    };
    writeFileSync(join(TMP_DIR, '.knowledge-ingest-cache.json'), JSON.stringify(cache));

    const result = runHook(TMP_DIR);
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    expect(ctx).toContain('deleted');
  });

  it('fails open on invalid stdin', () => {
    const result = runHook(TMP_DIR, 'not json');
    expect(result).toBeDefined();
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_PATH = join(__dirname, '..', 'scripts', 'tree-sitter-extract.mjs');

const TMP_DIR = join(__dirname, '__tmp_extract_test__');

function runExtract(path: string, args: string[] = []): unknown {
  const cmd = `node "${SCRIPT_PATH}" "${path}" ${args.join(' ')}`;
  const out = execSync(cmd, { encoding: 'utf-8', timeout: 30_000 });
  return JSON.parse(out);
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('tree-sitter-extract', () => {
  it('produces valid output schema', () => {
    const tsContent = 'export function hello(name: string): string { return name; }\n';
    writeFileSync(join(TMP_DIR, 'index.ts'), tsContent);

    const result = runExtract(TMP_DIR) as {
      version: number;
      timestamp: string;
      root: string;
      fileCount: number;
      files: unknown[];
      dependencyGraph: Record<string, string[]>;
    };

    expect(result.version).toBe(1);
    expect(result.timestamp).toBeTruthy();
    expect(result.root).toBeTruthy();
    expect(result.fileCount).toBe(1);
    expect(result.files).toHaveLength(1);
    expect(result.dependencyGraph).toBeDefined();
  });

  it('extracts TypeScript symbols', () => {
    const tsContent = `
export class UserService {
  constructor(private db: Database) {}

  async getUser(id: string): Promise<User> {
    return this.db.find(id);
  }
}

export function createService(db: Database): UserService {
  return new UserService(db);
}
`;
    writeFileSync(join(TMP_DIR, 'user.ts'), tsContent);

    const result = runExtract(TMP_DIR) as {
      files: Array<{ symbols: Array<{ kind: string; name: string }> }>;
    };
    const file = result.files[0];
    const names = file.symbols.map((s) => s.name);

    expect(names).toContain('UserService');
    expect(names).toContain('createService');
    expect(file.symbols.find((s) => s.name === 'UserService')?.kind).toBe('class');
    expect(file.symbols.find((s) => s.name === 'createService')?.kind).toBe('function');
  });

  it('extracts Python symbols', () => {
    const pyContent = `
class DataProcessor:
    def __init__(self, config):
        self.config = config

    def process(self, data):
        return self._transform(data)

def create_processor(config):
    return DataProcessor(config)
`;
    writeFileSync(join(TMP_DIR, 'processor.py'), pyContent);

    const result = runExtract(TMP_DIR) as {
      files: Array<{ symbols: Array<{ kind: string; name: string }> }>;
    };
    const file = result.files[0];
    const names = file.symbols.map((s) => s.name);

    expect(names).toContain('DataProcessor');
    expect(names).toContain('create_processor');
  });

  it('extracts imports', () => {
    const tsContent = `
import { join, resolve } from 'path';
import { UserService } from './user';
import fs from 'fs';

console.log(join('.', 'test'));
`;
    writeFileSync(join(TMP_DIR, 'main.ts'), tsContent);

    const result = runExtract(TMP_DIR) as {
      files: Array<{ imports: Array<{ source: string; names: string[] }> }>;
    };
    const file = result.files[0];
    const sources = file.imports.map((i) => i.source);

    expect(sources).toContain('path');
    expect(sources).toContain('./user');
    expect(sources).toContain('fs');
  });

  it('computes correct SHA256', () => {
    const content = 'const x = 42;\n';
    writeFileSync(join(TMP_DIR, 'hash.ts'), content);

    const result = runExtract(TMP_DIR) as { files: Array<{ sha256: string }> };
    expect(result.files[0].sha256).toBe(sha256(content));
  });

  it('extracts rationale comments', () => {
    const tsContent = `
// WHY: Rate limiting needed due to upstream API constraints
function throttle(fn: Function) {
  // HACK: Workaround for Node bug #12345
  return fn;
}

// TODO: Add proper error handling
function risky() {}

// NOTE: This is intentionally synchronous for startup performance
function loadConfig() {}
`;
    writeFileSync(join(TMP_DIR, 'rationale.ts'), tsContent);

    const result = runExtract(TMP_DIR) as {
      files: Array<{ rationale: Array<{ tag: string; text: string; line: number }> }>;
    };
    const rationale = result.files[0].rationale;

    expect(rationale.length).toBeGreaterThanOrEqual(4);
    expect(rationale.find((r) => r.tag === 'WHY')).toBeTruthy();
    expect(rationale.find((r) => r.tag === 'HACK')).toBeTruthy();
    expect(rationale.find((r) => r.tag === 'TODO')).toBeTruthy();
    expect(rationale.find((r) => r.tag === 'NOTE')).toBeTruthy();
  });

  it('respects --exclude flag', () => {
    mkdirSync(join(TMP_DIR, 'src'), { recursive: true });
    mkdirSync(join(TMP_DIR, 'test'), { recursive: true });
    writeFileSync(join(TMP_DIR, 'src', 'main.ts'), 'export const x = 1;\n');
    writeFileSync(join(TMP_DIR, 'test', 'main.test.ts'), 'import { x } from "../src/main";\n');

    const result = runExtract(TMP_DIR, ['--exclude', 'test']) as {
      fileCount: number;
      files: Array<{ path: string }>;
    };

    expect(result.fileCount).toBe(1);
    expect(result.files[0].path).toBe('src/main.ts');
  });

  it('respects --max-files flag', () => {
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(TMP_DIR, `file${i}.ts`), `export const x${i} = ${i};\n`);
    }

    const result = runExtract(TMP_DIR, ['--max-files', '3']) as { fileCount: number };
    expect(result.fileCount).toBe(3);
  });

  it('builds dependency graph from imports', () => {
    mkdirSync(join(TMP_DIR, 'src'), { recursive: true });
    writeFileSync(
      join(TMP_DIR, 'src', 'main.ts'),
      'import { helper } from "./utils";\nconsole.log(helper());\n',
    );
    writeFileSync(join(TMP_DIR, 'src', 'utils.ts'), 'export function helper() { return 42; }\n');

    const result = runExtract(TMP_DIR) as { dependencyGraph: Record<string, string[]> };
    expect(result.dependencyGraph['src/main.ts']).toBeDefined();
  });

  it('extracts call edges', () => {
    const tsContent = `
function processData(input: string) {
  const result = transform(input);
  return validate(result);
}

function transform(s: string) { return s.toUpperCase(); }
function validate(s: string) { return s.length > 0; }
`;
    writeFileSync(join(TMP_DIR, 'calls.ts'), tsContent);

    const result = runExtract(TMP_DIR) as {
      files: Array<{ calls: Array<{ caller: string; callee: string }> }>;
    };
    const calls = result.files[0].calls;
    const processDataCalls = calls.filter((c) => c.caller === 'processData');

    expect(processDataCalls.map((c) => c.callee)).toContain('transform');
    expect(processDataCalls.map((c) => c.callee)).toContain('validate');
  });

  it('handles empty directories gracefully', () => {
    const result = runExtract(TMP_DIR) as { fileCount: number; files: unknown[] };
    expect(result.fileCount).toBe(0);
    expect(result.files).toHaveLength(0);
  });

  it('handles multiple languages in one directory', () => {
    writeFileSync(join(TMP_DIR, 'app.ts'), 'export class App {}\n');
    writeFileSync(join(TMP_DIR, 'lib.py'), 'class Lib:\n    pass\n');
    writeFileSync(join(TMP_DIR, 'main.go'), 'package main\n\nfunc main() {}\n');

    const result = runExtract(TMP_DIR) as { fileCount: number; files: Array<{ language: string }> };
    const languages = result.files.map((f) => f.language);

    expect(result.fileCount).toBe(3);
    expect(languages).toContain('typescript');
    expect(languages).toContain('python');
    expect(languages).toContain('go');
  });
});

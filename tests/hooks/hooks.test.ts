// =============================================================================
// Hook script unit tests
//
// Spawns each script in scripts/hooks/ as a child process with crafted
// stdin, asserts it fails open and emits shape-correct JSON for the Claude
// Code hook schema. Covers all four hooks: session-start, precompact-flush,
// precompact-distill, sessionend-distill.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HOOKS_DIR = join(__dirname, '..', '..', 'scripts', 'hooks');

interface HookResult {
  code: number | null;
  stdout: string;
  stderr: string;
  json: unknown;
}

function runHook(
  script: string,
  stdinInput: unknown,
  { timeoutMs = 5000, env = {} }: { timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<HookResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(HOOKS_DIR, script)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`hook ${script} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const trimmed = stdout.trim();
      let json: unknown = null;
      if (trimmed) {
        try {
          json = JSON.parse(trimmed);
        } catch (err) {
          reject(new Error(`${script}: non-JSON stdout: ${trimmed}\n${(err as Error).message}`));
          return;
        }
      }
      resolve({ code, stdout: trimmed, stderr, json });
    });

    if (stdinInput !== null && stdinInput !== undefined) {
      child.stdin.write(typeof stdinInput === 'string' ? stdinInput : JSON.stringify(stdinInput));
    }
    child.stdin.end();
  });
}

const scratch = mkdtempSync(join(tmpdir(), 'agent-knowledge-hooks-'));
const isolatedEnv = { KNOWLEDGE_MEMORY_DIR: scratch };

// ---------------------------------------------------------------------------
// session-start.js
// ---------------------------------------------------------------------------

describe('session-start.js', () => {
  it('emits SessionStart hookSpecificOutput', async () => {
    const { code, json } = await runHook('session-start.js', {});
    expect(code).toBe(0);
    const obj = json as { hookSpecificOutput?: { hookEventName?: string } };
    expect(obj.hookSpecificOutput?.hookEventName).toBe('SessionStart');
  });
});

// ---------------------------------------------------------------------------
// precompact-flush.mjs
// ---------------------------------------------------------------------------

describe('precompact-flush.mjs', () => {
  it('exits 0 on empty stdin', async () => {
    const { code } = await runHook('precompact-flush.mjs', '');
    expect(code).toBe(0);
  });

  it('exits 0 on non-JSON stdin', async () => {
    const { code } = await runHook('precompact-flush.mjs', 'junk');
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// precompact-distill.mjs
// ---------------------------------------------------------------------------

describe('precompact-distill.mjs', () => {
  it('exits 0 on empty stdin', async () => {
    const { code, json } = await runHook('precompact-distill.mjs', '', { env: isolatedEnv });
    expect(code).toBe(0);
    expect(json).toEqual({});
  });

  it('exits 0 on non-JSON stdin', async () => {
    const { code, json } = await runHook('precompact-distill.mjs', 'junk', { env: isolatedEnv });
    expect(code).toBe(0);
    expect(json).toEqual({});
  });

  it('missing transcript_path → {}', async () => {
    const { json } = await runHook(
      'precompact-distill.mjs',
      { session_id: 'abc' },
      { env: isolatedEnv },
    );
    expect(json).toEqual({});
  });

  it('nonexistent transcript_path → {}', async () => {
    const { json } = await runHook(
      'precompact-distill.mjs',
      { transcript_path: '/no/such/file.jsonl', session_id: 'abc' },
      { env: isolatedEnv },
    );
    expect(json).toEqual({});
  });

  it('valid transcript does not crash', async () => {
    const file = join(scratch, 'transcript.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'user', message: { content: 'hello' } }),
        JSON.stringify({ type: 'assistant', message: { content: 'hi' } }),
      ].join('\n'),
    );
    const { code, json } = await runHook(
      'precompact-distill.mjs',
      {
        transcript_path: file,
        session_id: 'testsess1',
        workspace: { current_dir: scratch },
      },
      { env: isolatedEnv },
    );
    expect(code).toBe(0);
    expect(json).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// sessionend-distill.mjs
// ---------------------------------------------------------------------------

describe('sessionend-distill.mjs', () => {
  it('exits 0 on empty stdin', async () => {
    const { code, json } = await runHook('sessionend-distill.mjs', '', { env: isolatedEnv });
    expect(code).toBe(0);
    expect(json).toEqual({});
  });

  it('missing transcript_path → {}', async () => {
    const { json } = await runHook(
      'sessionend-distill.mjs',
      { session_id: 'abc' },
      { env: isolatedEnv },
    );
    expect(json).toEqual({});
  });

  it('valid transcript does not crash', async () => {
    const file = join(scratch, 'end-transcript.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'user', message: { content: 'hi' } }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: '1' }] },
        }),
      ].join('\n'),
    );
    const { code, json } = await runHook(
      'sessionend-distill.mjs',
      {
        transcript_path: file,
        session_id: 'testsess2',
        workspace: { current_dir: scratch },
      },
      { env: isolatedEnv },
    );
    expect(code).toBe(0);
    expect(json).toEqual({});
  });
});

process.on('exit', () => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

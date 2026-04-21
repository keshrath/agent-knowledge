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
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
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
const isolatedEnv = { AGENT_KNOWLEDGE_MEMORY_DIR: scratch };

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

  it('emits user-visible systemMessage with dashboard URL', async () => {
    const { json } = await runHook('session-start.js', {});
    const obj = json as { systemMessage?: string };
    expect(obj.systemMessage).toMatch(/^agent-knowledge: http:\/\/localhost:/);
  });

  it('emits identity-onboarding instruction when no identity.md AND no decline marker', async () => {
    const kb = mkdtempSync(join(tmpdir(), 'agent-knowledge-sstart-onboard-'));
    const { json } = await runHook(
      'session-start.js',
      {},
      { env: { AGENT_KNOWLEDGE_MEMORY_DIR: kb } },
    );
    const obj = json as {
      systemMessage?: string;
      hookSpecificOutput?: { additionalContext?: string };
    };
    expect(obj.systemMessage).toContain('identity: onboarding pending');
    const ctx = obj.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('Identity onboarding');
    expect(ctx).toContain('Name + primary role');
    expect(ctx).toContain('~/agent-knowledge/.identity-declined');
  });

  it('skips onboarding when user has opted out via .identity-declined', async () => {
    const kb = mkdtempSync(join(tmpdir(), 'agent-knowledge-sstart-declined-'));
    writeFileSync(join(kb, '.identity-declined'), '', 'utf-8');
    const { json } = await runHook(
      'session-start.js',
      {},
      { env: { AGENT_KNOWLEDGE_MEMORY_DIR: kb } },
    );
    const obj = json as {
      systemMessage?: string;
      hookSpecificOutput?: { additionalContext?: string };
    };
    expect(obj.systemMessage).toContain('identity: declined');
    const ctx = obj.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).not.toContain('Identity onboarding');
  });

  it('skips onboarding when identity.md exists', async () => {
    const kb = mkdtempSync(join(tmpdir(), 'agent-knowledge-sstart-hasid-'));
    writeFileSync(join(kb, 'identity.md'), '# Identity\n\nJane Doe — staff engineer.\n', 'utf-8');
    const { json } = await runHook(
      'session-start.js',
      {},
      { env: { AGENT_KNOWLEDGE_MEMORY_DIR: kb } },
    );
    const obj = json as {
      systemMessage?: string;
      hookSpecificOutput?: { additionalContext?: string };
    };
    expect(obj.systemMessage).toMatch(/identity: \d+ chars/);
    const ctx = obj.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).not.toContain('Identity onboarding');
  });

  it('clears the first-prompt-inject marker for its session_id (resume re-arms)', async () => {
    // v1.9.4 bug fix: resumed sessions reuse session_id, so the marker from
    // the previous run stays on disk and first-prompt-inject silently skips.
    // session-start must delete the marker so the next user prompt re-injects.
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-knowledge-sstart-marker-'));
    const sid = 'sess-resume-rearm';
    const markerDir = join(dataDir, '.first-prompt-seen');
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, sid), new Date().toISOString(), 'utf-8');

    const { json } = await runHook(
      'session-start.js',
      { session_id: sid, source: 'resume' },
      { env: { AGENT_KNOWLEDGE_DATA_DIR: dataDir } },
    );
    const obj = json as { systemMessage?: string };
    expect(obj.systemMessage).toContain('inject rearmed');

    // Marker file must actually be gone from disk.
    const fs = await import('node:fs');
    expect(fs.existsSync(join(markerDir, sid))).toBe(false);
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

  it('emits nudge as top-level systemMessage, not hookSpecificOutput.additionalContext', async () => {
    // Claude Code's PreCompact schema only accepts systemMessage at the top
    // level; hookSpecificOutput.additionalContext is UserPromptSubmit /
    // PostToolUse only. Emitting the latter produces a validation error and
    // the nudge is dropped. Guard against regression.
    const { json } = await runHook('precompact-flush.mjs', {
      session_id: 'sess-precompact-nudge',
      hook_event_name: 'PreCompact',
    });
    const obj = json as {
      systemMessage?: string;
      hookSpecificOutput?: { additionalContext?: string };
    };
    expect(obj.systemMessage).toBeTruthy();
    expect(obj.systemMessage).toContain('knowledge:');
    expect(obj.hookSpecificOutput).toBeUndefined();
  });

  it('suppresses nudge when AGENT_KNOWLEDGE_PRECOMPACT_NUDGE=0', async () => {
    const { json } = await runHook(
      'precompact-flush.mjs',
      { session_id: 'sess-nudge-off', hook_event_name: 'PreCompact' },
      { env: { AGENT_KNOWLEDGE_PRECOMPACT_NUDGE: '0' } },
    );
    const obj = json as { systemMessage?: string };
    expect(obj.systemMessage).toBeUndefined();
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
  // Isolate dashboard POST attempts by pointing at an unused port so every
  // test in this block fails open (ECONNREFUSED) without interfering with
  // any running agent-knowledge dashboard.
  const noDashEnv = {
    ...isolatedEnv,
    AGENT_KNOWLEDGE_PORT: '1',
    AGENT_KNOWLEDGE_DASHBOARD_EVENTS: '1',
  };

  it('exits 0 on empty stdin and reports transcript unavailable', async () => {
    const { code, json } = await runHook('sessionend-distill.mjs', '', { env: noDashEnv });
    expect(code).toBe(0);
    const obj = json as { systemMessage?: string };
    expect(obj.systemMessage).toMatch(/transcript unavailable/);
  });

  it('missing transcript_path → skip message', async () => {
    const { json } = await runHook(
      'sessionend-distill.mjs',
      { session_id: 'abc' },
      { env: noDashEnv },
    );
    const obj = json as { systemMessage?: string };
    expect(obj.systemMessage).toMatch(/transcript unavailable/);
  });

  it('valid transcript emits user-visible systemMessage with turn/tool counts', async () => {
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
      { env: noDashEnv },
    );
    expect(code).toBe(0);
    const obj = json as { systemMessage?: string };
    expect(obj.systemMessage).toMatch(/^knowledge: SessionEnd — 1u\/2a turns, 1 tool uses →/);
    expect(obj.systemMessage).toMatch(/session-.*-testsess\.md$/);
  });

  it('POSTs the receipt to /api/events when the dashboard is reachable', async () => {
    const { createServer } = await import('node:http');
    const received: Array<{ kind: string; message: string }> = [];
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/events') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            received.push(JSON.parse(body));
          } catch {
            // ignore
          }
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: 1, ts: Date.now() }));
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    const port: number = await new Promise((resolveP) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolveP(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    try {
      const file = join(scratch, 'end-transcript-post.jsonl');
      writeFileSync(
        file,
        [
          JSON.stringify({ type: 'user', message: { content: 'hi' } }),
          JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'ok' }] },
          }),
        ].join('\n'),
      );
      const { code } = await runHook(
        'sessionend-distill.mjs',
        {
          transcript_path: file,
          session_id: 'testsess3',
          workspace: { current_dir: scratch },
        },
        {
          env: {
            ...isolatedEnv,
            AGENT_KNOWLEDGE_PORT: String(port),
            AGENT_KNOWLEDGE_DASHBOARD_EVENTS: '1',
          },
        },
      );
      expect(code).toBe(0);
      expect(received).toHaveLength(1);
      expect(received[0].kind).toBe('session-end');
      expect(received[0].message).toMatch(/^1u\/1a turns, 0 tool uses →/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('AGENT_KNOWLEDGE_DASHBOARD_EVENTS=0 suppresses the POST', async () => {
    const { createServer } = await import('node:http');
    let hit = false;
    const server = createServer((_req, res) => {
      hit = true;
      res.writeHead(201);
      res.end('{}');
    });
    const port: number = await new Promise((resolveP) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolveP(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    try {
      const file = join(scratch, 'end-transcript-suppressed.jsonl');
      writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'hi' } }));
      const { code } = await runHook(
        'sessionend-distill.mjs',
        {
          transcript_path: file,
          session_id: 'testsess4',
          workspace: { current_dir: scratch },
        },
        {
          env: {
            ...isolatedEnv,
            AGENT_KNOWLEDGE_PORT: String(port),
            AGENT_KNOWLEDGE_DASHBOARD_EVENTS: '0',
          },
        },
      );
      expect(code).toBe(0);
      expect(hit).toBe(false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// ---------------------------------------------------------------------------
// first-prompt-inject.mjs
// ---------------------------------------------------------------------------

describe('first-prompt-inject.mjs', () => {
  const freshDataDir = () => mkdtempSync(join(tmpdir(), 'agent-knowledge-firstprompt-'));

  it('emits additionalContext when the KB has matching entries (positive path)', async () => {
    // The ONLY test covering the happy path. Without it, every skip-gate test
    // below would keep passing even if the render + search integration silently
    // broke.
    const kb = mkdtempSync(join(tmpdir(), 'agent-knowledge-firstprompt-kb-'));
    // Seed a single entry whose tokens overlap the test prompt.
    const decisionsDir = join(kb, 'decisions');
    mkdirSync(decisionsDir, { recursive: true });
    writeFileSync(
      join(decisionsDir, 'database-choice.md'),
      [
        '---',
        'title: Database choice',
        'tags: [architecture]',
        'updated: 2026-04-18',
        '---',
        '',
        '# Database choice',
        '',
        'We chose PostgreSQL over MySQL for JSONB support and better full-text search.',
        'The connection lives in src/store/database.ts.',
      ].join('\n'),
    );

    const { code, json } = await runHook(
      'first-prompt-inject.mjs',
      {
        session_id: 'sess-positive',
        prompt: 'why did we go with postgres for the database connection',
      },
      { env: { AGENT_KNOWLEDGE_MEMORY_DIR: kb, AGENT_KNOWLEDGE_DATA_DIR: freshDataDir() } },
    );

    expect(code).toBe(0);
    const obj = json as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
      systemMessage?: string;
    };
    expect(obj.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit');
    const ctx = obj.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('Knowledge — top hits');
    expect(ctx).toContain('decisions/database-choice.md');
    // v1.9.4: user-visible one-liner alongside the model-facing context.
    expect(obj.systemMessage).toMatch(/^knowledge: injected \d+ hit/);
    expect(obj.systemMessage).toContain('decisions/database-choice.md');
  });

  it('respects AGENT_KNOWLEDGE_FIRSTPROMPT_BUDGET by dropping hits that would overflow', async () => {
    const kb = mkdtempSync(join(tmpdir(), 'agent-knowledge-firstprompt-budget-'));
    const notesDir = join(kb, 'notes');
    mkdirSync(notesDir, { recursive: true });
    // 6 entries — generous budget picks all; tiny budget must pick 0 renderable.
    for (let i = 0; i < 6; i++) {
      writeFileSync(
        join(notesDir, `postgres-${i}.md`),
        `---\ntitle: Postgres note ${i}\n---\n\nPostgres migration notes about database connection pooling and JSONB fields.\n`,
      );
    }

    const tiny = await runHook(
      'first-prompt-inject.mjs',
      { session_id: 'sess-tiny', prompt: 'postgres database connection pooling' },
      {
        env: {
          AGENT_KNOWLEDGE_MEMORY_DIR: kb,
          AGENT_KNOWLEDGE_DATA_DIR: freshDataDir(),
          AGENT_KNOWLEDGE_FIRSTPROMPT_BUDGET: '100',
        },
      },
    );
    const generous = await runHook(
      'first-prompt-inject.mjs',
      { session_id: 'sess-generous', prompt: 'postgres database connection pooling' },
      {
        env: {
          AGENT_KNOWLEDGE_MEMORY_DIR: kb,
          AGENT_KNOWLEDGE_DATA_DIR: freshDataDir(),
          AGENT_KNOWLEDGE_FIRSTPROMPT_BUDGET: '2000',
        },
      },
    );

    const tinyCtx =
      (tiny.json as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput
        ?.additionalContext ?? '';
    const genCtx =
      (generous.json as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput
        ?.additionalContext ?? '';
    // Count rendered hits (each hit starts with "- **")
    const countHits = (s: string) => (s.match(/^- \*\*/gm) ?? []).length;
    expect(countHits(genCtx)).toBeGreaterThan(countHits(tinyCtx));
  });

  it('fails open on empty + non-JSON stdin', async () => {
    const r1 = await runHook('first-prompt-inject.mjs', '', {
      env: { ...isolatedEnv, AGENT_KNOWLEDGE_DATA_DIR: freshDataDir() },
    });
    const r2 = await runHook('first-prompt-inject.mjs', 'junk', {
      env: { ...isolatedEnv, AGENT_KNOWLEDGE_DATA_DIR: freshDataDir() },
    });
    expect(r1.code).toBe(0);
    expect(r1.json).toEqual({});
    expect(r2.code).toBe(0);
    expect(r2.json).toEqual({});
  });

  it('skips all three prompt-shape gates (too short / slash / bang)', async () => {
    const casesThatMustSkip = [
      { session_id: 'sess-short', prompt: 'hi' },
      { session_id: 'sess-slash', prompt: '/clear' },
      { session_id: 'sess-bang', prompt: '!gcloud auth login' },
    ];
    for (const input of casesThatMustSkip) {
      const { json } = await runHook('first-prompt-inject.mjs', input, {
        env: { ...isolatedEnv, AGENT_KNOWLEDGE_DATA_DIR: freshDataDir() },
      });
      expect(json).toEqual({});
    }
  });

  it('respects the kill switch — AGENT_KNOWLEDGE_FIRSTPROMPT_INJECT=0', async () => {
    const { json } = await runHook(
      'first-prompt-inject.mjs',
      { session_id: 'sess-disabled', prompt: 'where do we configure the database connection' },
      {
        env: {
          ...isolatedEnv,
          AGENT_KNOWLEDGE_DATA_DIR: freshDataDir(),
          AGENT_KNOWLEDGE_FIRSTPROMPT_INJECT: '0',
        },
      },
    );
    expect(json).toEqual({});
  });

  it('fires at most once per session id (marker file idempotency)', async () => {
    const dataDir = freshDataDir();
    const sid = 'sess-once';
    const env = { ...isolatedEnv, AGENT_KNOWLEDGE_DATA_DIR: dataDir };

    await runHook(
      'first-prompt-inject.mjs',
      { session_id: sid, prompt: 'how do we configure the database?' },
      { env },
    );
    const second = await runHook(
      'first-prompt-inject.mjs',
      { session_id: sid, prompt: 'another question about the database' },
      { env },
    );
    expect(second.json).toEqual({});
  });

  it('does NOT burn the marker on skip-gates — next real prompt still fires', async () => {
    // The earlier contract (burn marker on /clear / short / bang) meant a
    // user who typed /clear as their first prompt lost injection for the
    // actual first question. Regression: skip-gates must NOT burn the marker.
    const kb = mkdtempSync(join(tmpdir(), 'agent-knowledge-firstprompt-skip-kb-'));
    mkdirSync(join(kb, 'decisions'), { recursive: true });
    writeFileSync(
      join(kb, 'decisions', 'routing.md'),
      [
        '---',
        'title: Routing decision',
        '---',
        '',
        '# Routing',
        '',
        'We chose the async queue over direct HTTP calls for the webhook gateway.',
      ].join('\n'),
    );
    const dataDir = freshDataDir();
    const sid = 'sess-skip-then-real';
    const env = { AGENT_KNOWLEDGE_MEMORY_DIR: kb, AGENT_KNOWLEDGE_DATA_DIR: dataDir };

    // First prompt is a slash command — must not burn the marker.
    const slashRun = await runHook(
      'first-prompt-inject.mjs',
      { session_id: sid, prompt: '/clear' },
      { env },
    );
    expect(slashRun.json).toEqual({});

    // Second prompt is a real question — marker was preserved, so this
    // invocation must actually search and inject.
    const realRun = await runHook(
      'first-prompt-inject.mjs',
      { session_id: sid, prompt: 'why did we go with the async queue for webhooks' },
      { env },
    );
    const ctx =
      (realRun.json as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput
        ?.additionalContext ?? '';
    expect(ctx).toContain('decisions/routing.md');
  });

  it('fails open when memoryDir does not exist', async () => {
    const { code, json } = await runHook(
      'first-prompt-inject.mjs',
      { session_id: 'sess-no-kb', prompt: 'any question long enough to pass the length gate' },
      {
        env: {
          AGENT_KNOWLEDGE_MEMORY_DIR: join(scratch, 'nonexistent-kb'),
          AGENT_KNOWLEDGE_DATA_DIR: freshDataDir(),
        },
      },
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

// =============================================================================
// Every agent-knowledge MCP tool and action through the real Claude Code CLI
//
// `claude -p` loads only this repo's built server (dist/index.js) from a
// scratch --mcp-config: its own HOME, APPDATA, knowledge dir (a clone of a
// scratch bare repo), data dir with a seeded session, and a free REST port.
// The model is told which calls to make; each test asserts the calls it made
// (stream-json tool_use / tool_result) AND the files, git history and DB rows
// those calls left, never only the model's words.
//
// Skipped unless AGENT_KNOWLEDGE_E2E_CLAUDE=1. Needs `npm run build` and a
// logged-in `claude`. AGENT_KNOWLEDGE_E2E_MODEL picks the model (default haiku).
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const RUN = process.env.AGENT_KNOWLEDGE_E2E_CLAUDE === '1';
const MODEL = process.env.AGENT_KNOWLEDGE_E2E_MODEL || 'haiku';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = path.join(REPO, 'dist', 'index.js');
const CLAUDE = process.platform === 'win32' ? 'claude.exe' : 'claude';
const SERVER = 'agent-knowledge';
const T = (tool: string) => `mcp__${SERVER}__${tool}`;

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'e2e',
  GIT_AUTHOR_EMAIL: 'e2e@example.invalid',
  GIT_COMMITTER_NAME: 'e2e',
  GIT_COMMITTER_EMAIL: 'e2e@example.invalid',
};

interface Call {
  name: string;
  input: Record<string, unknown>;
  result: string;
  isError: boolean;
}

let root: string;
let bare: string;
let kb: string;
let dataDir: string;
let appData: string;
let mcpConfig: string;
let work: string;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  }).trim();
}

function write(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const entry = (title: string, body: string, tags = 'e2e') =>
  `---\ntitle: ${title}\ntags: [${tags}]\n---\n\n${body}\n`;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

function sessionLine(type: 'user' | 'assistant', text: unknown, minute: number): string {
  return JSON.stringify({
    type,
    sessionId: 'sess-e2e-1',
    cwd: '/work/e2e-demo',
    timestamp: `2026-10-01T10:${String(minute).padStart(2, '0')}:00.000Z`,
    message: { role: type, content: text },
  });
}

/** Runs `cmd` without blocking the test worker (a sync spawn starves vitest's RPC). */
function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 300_000);
    child.on('error', reject);
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ stdout, stderr });
    });
  });
}

/** Runs one `claude -p` turn and returns every tool call it made, with its result. */
async function claude(
  steps: Array<[tool: string, args: Record<string, unknown>]>,
): Promise<Call[]> {
  const prompt = [
    'You are exercising an MCP server for an automated test.',
    'Make exactly these tool calls, in this order, one at a time, with exactly these arguments.',
    'Call no other tool. Do not retry a call that returns an error. After the last call reply DONE.',
    '',
    ...steps.map(([tool, args], i) => `${i + 1}. ${T(tool)} ${JSON.stringify(args)}`),
  ].join('\n');
  const r = await run(CLAUDE, [
    '-p',
    prompt,
    '--mcp-config',
    mcpConfig,
    '--strict-mcp-config',
    '--setting-sources',
    'project',
    '--allowedTools',
    `mcp__${SERVER}`,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    MODEL,
    '--no-session-persistence',
    '--max-turns',
    String(steps.length * 2 + 4),
  ]);
  const calls = new Map<string, Call>();
  const order: string[] = [];
  for (const raw of r.stdout.split('\n')) {
    if (!raw.trim()) continue;
    let msg: {
      type?: string;
      message?: { content?: Array<Record<string, unknown>> };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const part of msg.message?.content ?? []) {
      if (msg.type === 'assistant' && part.type === 'tool_use') {
        const id = String(part.id);
        calls.set(id, {
          name: String(part.name),
          input: (part.input ?? {}) as Record<string, unknown>,
          result: '',
          isError: false,
        });
        order.push(id);
      }
      if (msg.type === 'user' && part.type === 'tool_result') {
        const call = calls.get(String(part.tool_use_id));
        if (!call) continue;
        const content = part.content;
        call.result = Array.isArray(content)
          ? content.map((c: { text?: string }) => c.text ?? '').join('\n')
          : String(content ?? '');
        call.isError = part.is_error === true;
      }
    }
  }
  const out = order.map((id) => calls.get(id)!);
  if (out.length === 0) {
    throw new Error(
      `claude made no tool call.\nstdout:\n${r.stdout.slice(-3000)}\nstderr:\n${r.stderr}`,
    );
  }
  return out;
}

/** The one call to `tool` with `action` (and matching `extra` args), which must have succeeded. */
function made(calls: Call[], tool: string, action?: string, extra: Record<string, unknown> = {}) {
  const found = calls.find(
    (c) =>
      c.name === T(tool) &&
      (action === undefined || c.input.action === action) &&
      Object.entries(extra).every(([k, v]) => c.input[k] === v),
  );
  if (!found) {
    throw new Error(
      `no ${tool} ${action ?? ''} call among: ${calls.map((c) => `${c.name} ${JSON.stringify(c.input)}`).join('; ')}`,
    );
  }
  return found;
}

function ok(call: Call): Call {
  expect(call.isError, `${call.name} ${JSON.stringify(call.input)} -> ${call.result}`).toBe(false);
  expect(call.result).not.toMatch(/^Error in /);
  return call;
}

function edges(): Array<{
  source: string;
  target: string;
  rel_type: string;
  strength: number;
  valid_to: string | null;
  origin: string | null;
}> {
  const db = new Database(path.join(dataDir, 'knowledge-scores.db'), { readonly: true });
  try {
    return db.prepare('SELECT * FROM edges').all() as ReturnType<typeof edges>;
  } finally {
    db.close();
  }
}

describe.skipIf(!RUN)(
  'agent-knowledge MCP tools through the real claude -p',
  { timeout: 600_000 },
  () => {
    beforeAll(async () => {
      if (!fs.existsSync(ENTRY))
        throw new Error('run `npm run build` first: dist/index.js is missing');
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-mcp-e2e-'));
      const home = path.join(root, 'home');
      appData = path.join(home, 'AppData', 'Roaming');
      bare = path.join(root, 'remote.git');
      kb = path.join(root, 'kb');
      dataDir = path.join(root, 'data');
      work = path.join(root, 'work');
      for (const d of [home, appData, dataDir, work]) fs.mkdirSync(d, { recursive: true });

      git(['init', '--bare', '--initial-branch=main', bare], root);
      const seed = path.join(root, 'seed');
      git(['clone', bare, seed], root);
      write(
        path.join(seed, 'identity.md'),
        '# Identity\n\nThe e2e person maintains the pelican service.\n',
      );
      write(
        path.join(seed, 'notes/e2e-alpha.md'),
        entry('E2E Alpha', 'The zebrafish deploy recipe.'),
      );
      write(path.join(seed, 'decisions/e2e-beta.md'), entry('E2E Beta', 'We chose loopback only.'));
      write(
        path.join(seed, 'projects/e2e-proj.md'),
        entry('E2E Project', 'Owns the pelican service.'),
      );
      write(path.join(seed, 'notes/e2e-delete-me.md'), entry('E2E Delete Me', 'Short-lived.'));
      git(['add', '-A'], seed);
      git(['commit', '-m', 'seed'], seed);
      git(['push', 'origin', 'HEAD:main'], seed);
      git(['clone', bare, kb], root);

      write(
        path.join(dataDir, 'projects', 'e2e-demo', 'sess-e2e-1.jsonl'),
        [
          sessionLine('user', 'How do we deploy the quokka service?', 0),
          sessionLine(
            'assistant',
            'The deploy failed with TypeError: Cannot read properties of undefined (reading "port") at src/server.ts:42.',
            1,
          ),
          sessionLine(
            'user',
            'Plan: 1. fix the port lookup 2. redeploy quokka 3. verify health.',
            2,
          ),
          sessionLine('assistant', 'Set QUOKKA_PORT=8080 in config/settings.json and restart.', 3),
          sessionLine(
            'user',
            'We decided to use SQLite over Postgres because it needs no server.',
            4,
          ),
          sessionLine(
            'assistant',
            [
              {
                type: 'tool_use',
                id: 'toolu_e2e1',
                name: 'Bash',
                input: { command: 'npm run deploy-quokka' },
              },
            ],
            5,
          ),
          sessionLine(
            'user',
            [{ type: 'tool_result', tool_use_id: 'toolu_e2e1', content: 'quokka deployed' }],
            6,
          ),
        ].join('\n') + '\n',
      );

      const port = await freePort();
      mcpConfig = path.join(root, 'mcp.json');
      write(
        mcpConfig,
        JSON.stringify({
          mcpServers: {
            [SERVER]: {
              command: process.execPath,
              args: [ENTRY],
              env: {
                ...GIT_ENV,
                HOME: home,
                USERPROFILE: home,
                APPDATA: appData,
                XDG_CONFIG_HOME: path.join(home, '.config'),
                AGENT_KNOWLEDGE_MEMORY_DIR: kb,
                AGENT_KNOWLEDGE_DATA_DIR: dataDir,
                AGENT_KNOWLEDGE_PORT: String(port),
                AGENT_KNOWLEDGE_EMBEDDING_PROVIDER: 'openai',
                AGENT_KNOWLEDGE_AUTO_DISTILL: 'false',
              },
            },
          },
        }),
      );
    }, 120_000);

    afterAll(() => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* a server child may still hold a DB file on Windows */
      }
    });

    it('knowledge: list, read, write (committed and pushed), delete (pushed), wakeup', async () => {
      const calls = await claude([
        ['knowledge', { action: 'list' }],
        ['knowledge', { action: 'read', path: 'notes/e2e-alpha.md' }],
        [
          'knowledge',
          {
            action: 'write',
            category: 'decisions',
            filename: 'e2e-written.md',
            content: entry('E2E Written', 'Chose the narwhal plan.'),
          },
        ],
        ['knowledge', { action: 'delete', path: 'notes/e2e-delete-me.md' }],
        ['knowledge', { action: 'wakeup', token_budget: 400 }],
      ]);

      expect(ok(made(calls, 'knowledge', 'list')).result).toContain('notes/e2e-alpha.md');
      expect(ok(made(calls, 'knowledge', 'read')).result).toContain('zebrafish');

      ok(made(calls, 'knowledge', 'write'));
      expect(fs.readFileSync(path.join(kb, 'decisions/e2e-written.md'), 'utf8')).toContain(
        'narwhal',
      );
      expect(git(['--git-dir', bare, 'log', '--name-only', '--format=', 'main'], root)).toContain(
        'decisions/e2e-written.md',
      );

      ok(made(calls, 'knowledge', 'delete'));
      expect(fs.existsSync(path.join(kb, 'notes/e2e-delete-me.md'))).toBe(false);
      expect(git(['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main'], root)).not.toContain(
        'notes/e2e-delete-me.md',
      );

      expect(ok(made(calls, 'knowledge', 'wakeup')).result).toContain('pelican');
    });

    it('knowledge sync pulls what another machine pushed', async () => {
      const other = path.join(root, 'other');
      git(['clone', bare, other], root);
      write(path.join(other, 'notes/e2e-remote.md'), entry('E2E Remote', 'Pushed from elsewhere.'));
      git(['add', '-A'], other);
      git(['commit', '-m', 'from another machine'], other);
      git(['push', 'origin', 'HEAD:main'], other);

      const calls = await claude([['knowledge', { action: 'sync' }]]);
      ok(made(calls, 'knowledge', 'sync'));
      expect(fs.readFileSync(path.join(kb, 'notes/e2e-remote.md'), 'utf8')).toContain('elsewhere');
    });

    it('knowledge_search: general, then every session scope', async () => {
      // One word that sits in the fixture message each scope keeps.
      const scopes = {
        errors: 'TypeError',
        plans: 'redeploy',
        configs: 'QUOKKA_PORT',
        tools: 'quokka',
        files: 'server',
        decisions: 'SQLite',
        all: 'quokka',
      } as const;
      const calls = await claude([
        ['knowledge_search', { query: 'zebrafish' }],
        ...Object.entries(scopes).map(([scope, query]): [string, Record<string, unknown>] => [
          'knowledge_search',
          { query, scope },
        ]),
      ]);
      expect(
        ok(made(calls, 'knowledge_search', undefined, { query: 'zebrafish' })).result,
      ).toContain('notes/e2e-alpha.md');
      for (const scope of Object.keys(scopes)) {
        const call = ok(made(calls, 'knowledge_search', undefined, { scope }));
        expect(call.result, `scope ${scope}`).toContain('sess-e2e-1');
      }
    });

    it('knowledge_session: list, get, summary', async () => {
      const calls = await claude([
        ['knowledge_session', { action: 'list' }],
        ['knowledge_session', { action: 'get', session_id: 'sess-e2e-1', tail: 10 }],
        ['knowledge_session', { action: 'summary', session_id: 'sess-e2e-1' }],
      ]);
      expect(ok(made(calls, 'knowledge_session', 'list')).result).toContain('sess-e2e-1');
      expect(ok(made(calls, 'knowledge_session', 'get')).result).toContain('quokka');
      const summary = JSON.parse(ok(made(calls, 'knowledge_session', 'summary')).result) as {
        meta: { preview: string };
        toolsUsed: string[];
      };
      expect(summary.meta.preview).toContain('quokka');
      expect(summary.toolsUsed).toContain('Bash');
    });

    it('knowledge_graph: link, list, traverse, invalidate, unlink, bulk_link, unlink_by_origin', async () => {
      const alpha = 'notes/e2e-alpha.md';
      const beta = 'decisions/e2e-beta.md';
      const proj = 'projects/e2e-proj.md';
      const linked = await claude([
        [
          'knowledge_graph',
          { action: 'link', source: alpha, target: beta, rel_type: 'related_to', strength: 0.8 },
        ],
        ['knowledge_graph', { action: 'list', entry: alpha }],
        ['knowledge_graph', { action: 'traverse', entry: alpha, depth: 2 }],
        [
          'knowledge_graph',
          {
            action: 'invalidate',
            source: alpha,
            target: beta,
            rel_type: 'related_to',
            valid_to: '2026-10-01',
          },
        ],
      ]);
      ok(made(linked, 'knowledge_graph', 'link'));
      expect(ok(made(linked, 'knowledge_graph', 'list')).result).toContain(beta);
      expect(ok(made(linked, 'knowledge_graph', 'traverse')).result).toContain(beta);
      ok(made(linked, 'knowledge_graph', 'invalidate'));
      const edge = edges().find((e) => e.source === alpha && e.target === beta);
      expect(edge).toMatchObject({ rel_type: 'related_to', strength: 0.8 });
      expect(edge?.valid_to).toContain('2026-10-01');

      const rest = await claude([
        [
          'knowledge_graph',
          { action: 'unlink', source: alpha, target: beta, rel_type: 'related_to' },
        ],
        [
          'knowledge_graph',
          {
            action: 'bulk_link',
            edges: [
              { source: alpha, target: proj, rel_type: 'depends_on', origin: 'e2e' },
              { source: beta, target: proj, rel_type: 'part_of', origin: 'e2e' },
            ],
          },
        ],
      ]);
      ok(made(rest, 'knowledge_graph', 'unlink'));
      ok(made(rest, 'knowledge_graph', 'bulk_link'));
      expect(edges().some((e) => e.source === alpha && e.target === beta)).toBe(false);
      expect(edges().filter((e) => e.origin === 'e2e')).toHaveLength(2);

      ok(
        made(
          await claude([['knowledge_graph', { action: 'unlink_by_origin', origin: 'e2e' }]]),
          'knowledge_graph',
          'unlink_by_origin',
        ),
      );
      expect(edges().filter((e) => e.origin === 'e2e')).toHaveLength(0);
    });

    it('knowledge_analyze: every action', async () => {
      const actions = [
        'consolidate',
        'reflect',
        'god_nodes',
        'bridges',
        'gaps',
        'brief',
        'search_gaps',
        'stale_by_code_activity',
      ];
      const calls = await claude(actions.map((action) => ['knowledge_analyze', { action }]));
      for (const action of actions) ok(made(calls, 'knowledge_analyze', action));
      expect(made(calls, 'knowledge_analyze', 'brief').result).toMatch(/e2e|E2E/);
      expect(made(calls, 'knowledge_analyze', 'reflect').result).toContain('knowledge_graph');
    });

    it('knowledge_admin: status, config view and update, rebuild, prune, vacuum, promote', async () => {
      const calls = await claude([
        ['knowledge_admin', { action: 'status' }],
        ['knowledge_admin', { action: 'config' }],
        ['knowledge_admin', { action: 'config', auto_distill: false }],
        ['knowledge_admin', { action: 'rebuild_embeddings' }],
        ['knowledge_admin', { action: 'prune_orphans' }],
        ['knowledge_admin', { action: 'vacuum' }],
        ['knowledge_admin', { action: 'promote', promote_mode: 'explain' }],
      ]);
      ok(made(calls, 'knowledge_admin', 'status'));
      const configs = calls.filter(
        (c) => c.name === T('knowledge_admin') && c.input.action === 'config',
      );
      expect(configs).toHaveLength(2);
      configs.forEach(ok);
      expect(configs[0]!.result).toContain(path.basename(root));
      const saved = JSON.parse(
        fs.readFileSync(path.join(appData, 'knowledge', 'config.json'), 'utf8'),
      );
      expect(saved.autoDistill).toBe(false);
      // No embedding provider in the scratch world: rebuild says so instead of wiping vectors.
      expect(made(calls, 'knowledge_admin', 'rebuild_embeddings').result).toContain(
        'No embedding provider available',
      );
      ok(made(calls, 'knowledge_admin', 'prune_orphans'));
      ok(made(calls, 'knowledge_admin', 'vacuum'));
      ok(made(calls, 'knowledge_admin', 'promote'));
    });
  },
);

// =============================================================================
// REST routes the mod's session lifecycle calls: who the person is (wakeup),
// the project's ingest freshness, the session snapshot, and the first-prompt
// search with MMR. A scratch knowledge dir, data dir and project folder.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Imported at collection, not in beforeAll: transforming the server's module graph takes seconds
// under load and would count against the hook timeout. Config is read per call, so the env the
// hook sets still applies.
import { startRestServer, type RestServer } from '../src/rest-server.js';

const ENV_KEYS = [
  'AGENT_KNOWLEDGE_MEMORY_DIR',
  'AGENT_KNOWLEDGE_DATA_DIR',
  'AGENT_KNOWLEDGE_EMBEDDING_PROVIDER',
  'AGENT_KNOWLEDGE_EXTRA_SESSION_ROOTS',
  'AGENT_KNOWLEDGE_GIT_URL',
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let root: string;
let memoryDir: string;
let sessionsDir: string;
let server: RestServer;
let base: string;

const get = async (p: string) => {
  const r = await fetch(`${base}${p}`);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const post = async (p: string, body: unknown) => {
  const r = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

/** A Claude Code transcript: one JSON line per row. */
function writeSession(id: string, rows: Array<Record<string, unknown>>) {
  const dir = path.join(sessionsDir, 'C--work-demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.jsonl`),
    rows
      .map((r, i) =>
        JSON.stringify({
          sessionId: id,
          cwd: '/work/demo',
          gitBranch: 'main',
          timestamp: `2026-11-13T10:0${i}:00.000Z`,
          ...r,
        }),
      )
      .join('\n') + '\n',
  );
}

const user = (content: unknown) => ({ type: 'user', message: { role: 'user', content } });
const assistant = (content: unknown) => ({
  type: 'assistant',
  message: { role: 'assistant', content },
});

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-lifecycle-'));
  memoryDir = path.join(root, 'knowledge');
  const dataDir = path.join(root, 'data');
  sessionsDir = path.join(dataDir, 'projects');
  fs.mkdirSync(memoryDir, { recursive: true });
  process.env.AGENT_KNOWLEDGE_MEMORY_DIR = memoryDir;
  process.env.AGENT_KNOWLEDGE_DATA_DIR = dataDir;
  process.env.AGENT_KNOWLEDGE_EMBEDDING_PROVIDER = 'openai';
  delete process.env.AGENT_KNOWLEDGE_EXTRA_SESSION_ROOTS;
  delete process.env.AGENT_KNOWLEDGE_GIT_URL;

  writeSession('sess-full-0001', [
    // After /clear the new transcript opens with the command: run, not asked.
    user(
      '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>',
    ),
    // What the host writes in the person's turn (a skill's instructions) is not asked either.
    { ...user('Base directory for this skill: C:\\skills\\commit'), isMeta: true },
    user('<task-notification>agent finished</task-notification>'),
    user('Make the release ritual a skill, token ghp_' + 'a'.repeat(40)),
    assistant([
      { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: './src/release.ts' } },
      // The knowledge base's own bookkeeping is no file the session worked on.
      {
        type: 'tool_use',
        id: 't0',
        name: 'Write',
        input: { file_path: path.join(memoryDir, '.identity-declined') },
      },
    ]),
    // A path only mentioned is no file changed.
    user([{ type: 'tool_result', tool_use_id: 't1', content: 'see also ./src/other.ts' }]),
    assistant([{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'git commit' } }]),
    // The commit made here; a SHA a log shows was not made here.
    user([
      {
        type: 'tool_result',
        tool_use_id: 't2',
        content: '[main 9a8b7c6] Ship the release skill\n 1 file changed\ncommit 1111111aaaa log',
      },
    ]),
    user('and test it in the real CLI'),
  ]);
  writeSession('sess-none-0002', [user('<task-notification>only noise</task-notification>')]);

  server = await startRestServer(0);
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.close();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* an open database on Windows: left for the OS temp cleanup */
  }
});

describe('GET /api/wakeup (who the person is)', () => {
  it('says the person is to be asked while no identity.md and no decline exist', async () => {
    const { status, body } = await get('/api/wakeup?sections=identity&budget=200');
    expect(status).toBe(200);
    expect(body.onboarding).toBe('pending');
    // The folder as it is on disk: where the model is told to write identity.md.
    expect(body.memory_dir).toBe(memoryDir);
    expect(body.sections).toEqual([expect.objectContaining({ name: 'identity', empty: true })]);
  });

  it('says declined once the person said not now', async () => {
    fs.writeFileSync(path.join(memoryDir, '.identity-declined'), '');
    expect((await get('/api/wakeup?sections=identity')).body.onboarding).toBe('declined');
    fs.rmSync(path.join(memoryDir, '.identity-declined'));
  });

  it('carries identity.md as the identity section once written', async () => {
    fs.writeFileSync(path.join(memoryDir, 'identity.md'), '## L0 — IDENTITY\nMathias, Odoo dev');
    const { body } = await get('/api/wakeup?sections=identity&budget=200');
    expect(body.onboarding).toBe('configured');
    expect(body.sections).toEqual([
      expect.objectContaining({
        name: 'identity',
        empty: false,
        content: '## L0 — IDENTITY\nMathias, Odoo dev',
      }),
    ]);
    fs.rmSync(path.join(memoryDir, 'identity.md'));
  });

  it('ignores section names it does not know', async () => {
    const { body } = await get('/api/wakeup?sections=identity,bogus');
    expect((body.sections as Array<{ name: string }>).map((s) => s.name)).toEqual(['identity']);
  });
});

describe('GET /api/ingest (the project folder against its ingest cache)', () => {
  let dir: string;
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  const cache = (files: Record<string, string>) =>
    fs.writeFileSync(
      path.join(dir, '.knowledge-ingest-cache.json'),
      JSON.stringify({
        project: 'test-proj',
        files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { sha256: v }])),
        entries_created: ['projects/test-proj.md', 'notes/test-proj-core.md'],
      }),
    );
  const ingest = async () => (await get(`/api/ingest?cwd=${encodeURIComponent(dir)}`)).body;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(root, 'proj-'));
  });

  it('says nothing of a folder with fewer than three source files', async () => {
    write('readme.txt', 'hello');
    write('src/a.ts', 'export const a = 1;\n');
    expect(await ingest()).toEqual({ state: 'none' });
  });

  it('offers a first ingest, naming the project from package.json; node_modules is not counted', async () => {
    write('package.json', JSON.stringify({ name: 'my-app' }));
    for (const n of [1, 2, 3]) write(`src/f${n}.ts`, `export const x${n} = ${n};\n`);
    write('node_modules/dep/index.js', 'module.exports = 1;\n');
    expect(await ingest()).toEqual({ state: 'never', project: 'my-app', dir, files: 4 });
  });

  it('is current when every file matches the cache', async () => {
    const files = fs
      .readdirSync(path.join(dir, 'src'))
      .map((f) => `src/${f}`)
      .reduce<Record<string, string>>((m, rel) => {
        m[rel] = sha(fs.readFileSync(path.join(dir, rel), 'utf-8'));
        return m;
      }, {});
    cache(files);
    expect(await ingest()).toMatchObject({
      state: 'current',
      project: 'test-proj',
      files: 4,
      entries: 2,
      changed: 0,
      added: 0,
      removed: 0,
    });
  });

  it('counts changed, new and deleted files since the last ingest', async () => {
    write('src/a.ts', 'export const a = 2;\n');
    write('src/new.ts', 'export const n = 1;\n');
    fs.rmSync(path.join(dir, 'src', 'f3.ts'));
    expect(await ingest()).toMatchObject({ state: 'stale', changed: 1, added: 1, removed: 1 });
  });

  it('is current for a project of more files than 500, every one compared by its cache', async () => {
    const big = fs.mkdtempSync(path.join(root, 'big-'));
    const files: Record<string, { sha256: string }> = {};
    // Written without holding the loop: a loop held past the server's keep-alive leaves the
    // client a pooled connection the server is closing, and the next request is reset.
    for (let d = 0; d < 10; d++) fs.mkdirSync(path.join(big, `m${d}`));
    await Promise.all(
      Array.from({ length: 510 }, (_, i) => {
        const text = `export const v${i} = ${i};\n`;
        files[`m${i % 10}/f${i}.ts`] = { sha256: sha(text) };
        return fs.promises.writeFile(path.join(big, `m${i % 10}`, `f${i}.ts`), text);
      }),
    );
    fs.writeFileSync(path.join(big, '.knowledge-ingest-cache.json'), JSON.stringify({ files }));
    const { ingestFreshness } = await import('../src/knowledge/ingest-freshness.js');
    expect(ingestFreshness(big)).toMatchObject({
      state: 'current',
      files: 510,
      changed: 0,
      added: 0,
      removed: 0,
    });
  }, 60_000);

  it('the walk stops after its budget of folder entries', async () => {
    const { walkSources } = await import('../scripts/source-walk.mjs');
    const at = fs.mkdtempSync(path.join(root, 'walk-'));
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(at, `f${i}.ts`), '');
    expect(walkSources(at)).toHaveLength(10);
    expect(walkSources(at, { maxEntries: 3 })).toHaveLength(3);
  });

  it('a corrupt cache says nothing; a missing cwd is refused', async () => {
    fs.writeFileSync(path.join(dir, '.knowledge-ingest-cache.json'), '{not json');
    expect(await ingest()).toEqual({ state: 'none' });
    expect((await get('/api/ingest')).status).toBe(422);
  });
});

describe('POST /api/sessions/:id/snapshot (the session in the knowledge base)', () => {
  it('writes what was asked, the tools and files, secrets scrubbed and noise dropped', async () => {
    const { status, body } = await post('/api/sessions/sess-full-0001/snapshot', {
      event: 'compact',
      cwd: '/work/demo-app/',
    });
    expect(status).toBe(200);
    expect(body).toEqual({
      path: 'sessions/demo-app/2026-11-13-sess-ful.md',
      title:
        'demo-app · 2026-11-13 · Make the release ritual a skill, token [REDACTED_GITHUB_TOKEN]',
      prompts: 2,
      messages: expect.any(Number),
      tools: 3,
      event: expect.any(Number),
    });
    const text = fs.readFileSync(path.join(memoryDir, body.path as string), 'utf-8');
    // Named by project, day and what was asked; the id in the frontmatter alone.
    expect(text).toContain('title: demo-app · 2026-11-13 · Make the release ritual a skill');
    expect(text).toContain('# demo-app · 2026-11-13 · Make the release ritual a skill');
    expect(text).toContain('session: sess-full-0001');
    expect(text).toContain('branch: main');
    expect(text).toContain('event: compact');
    expect(text).toContain('## What was asked\n\n- Make the release ritual a skill');
    expect(text).toContain('- and test it in the real CLI');
    expect(text).not.toContain('/clear');
    expect(text).not.toContain('Base directory');
    expect(text).toContain('[REDACTED_GITHUB_TOKEN]');
    expect(text).not.toContain('ghp_');
    expect(text).not.toContain('task-notification');
    expect(text).toContain('## Tools used\n\n- Bash\n- Edit\n- Write');
    // The file an Edit changed, as code (a Windows `\.` is no Markdown escape); a path a result
    // only mentions is not one, nor a hidden file of the knowledge base.
    expect(text).toContain('## Files\n\n- `./src/release.ts`\n\n');
    expect(text).not.toContain('other.ts');
    // The commit `git commit` reported; a SHA a log showed is not one made here.
    expect(text).toContain('## Commits\n\n- 9a8b7c6 Ship the release skill\n');
    expect(text).not.toContain('1111111');
  });

  it('a Windows folder keeps its separator under ~; a folder outside git has no branch', async () => {
    writeSession('sess-win-0003', [user('a question about the folder')]);
    const file = path.join(sessionsDir, 'C--work-demo', 'sess-win-0003.jsonl');
    fs.writeFileSync(
      file,
      fs.readFileSync(file, 'utf-8').replace('"gitBranch":"main"', '"gitBranch":"HEAD"'),
    );
    const { body } = await post('/api/sessions/sess-win-0003/snapshot', {
      event: 'end',
      cwd: 'C:\\Users\\someone\\repos\\demo-win',
    });
    const text = fs.readFileSync(path.join(memoryDir, body.path as string), 'utf-8');
    expect(text).toContain('cwd: ~\\repos\\demo-win');
    expect(text).not.toContain('branch:');
  });

  it('the end overwrites the same file and is told as a live event, readable as an entry', async () => {
    const { body } = await post('/api/sessions/sess-full-0001/snapshot', { event: 'end' });
    expect(body.path).toBe('sessions/demo/2026-11-13-sess-ful.md');
    const overview = (await get('/api/overview')).body;
    expect(overview.events).toContainEqual(
      expect.objectContaining({
        kind: 'session-end',
        // The session by its title: what a toast can show whole.
        message:
          'demo · 2026-11-13 · Make the release ritual a skill, token [REDACTED_GITHUB_TOKEN]',
      }),
    );
    const entry = await get(`/api/knowledge/${encodeURIComponent(body.path as string)}`);
    expect(entry.status).toBe(200);
  });

  it('a session where nothing was asked writes nothing', async () => {
    const { status, body } = await post('/api/sessions/sess-none-0002/snapshot', { event: 'end' });
    expect(status).toBe(200);
    expect(body.path).toBeNull();
    expect(fs.existsSync(path.join(memoryDir, 'sessions', 'demo', '2026-11-13-sess-non.md'))).toBe(
      false,
    );
  });

  it('a key where a long prompt is cut is scrubbed whole, not cut below its rule', async () => {
    const key = `sk-ant-api03-${'Zq9-x_'.repeat(15)}`;
    // The key starts a few characters before the 300th: cut there, `sk-an` was left.
    writeSession('sess-long-0005', [user(`${'word '.repeat(58)}key ${key} and more words`)]);
    const { body } = await post('/api/sessions/sess-long-0005/snapshot', { event: 'end' });
    const text = fs.readFileSync(path.join(memoryDir, body.path as string), 'utf-8');
    expect(text).toContain('[REDACTED_API_KEY]');
    expect(text).not.toContain('sk-an');
    expect(text).not.toContain('Zq9');
  });

  it('an unknown session is 404, an unknown event 422', async () => {
    expect((await post('/api/sessions/nope/snapshot', { event: 'end' })).status).toBe(404);
    expect((await post('/api/sessions/sess-full-0001/snapshot', { event: 'x' })).status).toBe(422);
  });
});

describe('GET /api/knowledge/search?mmr=true (the first prompt)', () => {
  it('answers with MMR re-ranking asked for', async () => {
    fs.mkdirSync(path.join(memoryDir, 'workflows'), { recursive: true });
    fs.writeFileSync(
      path.join(memoryDir, 'workflows', 'release.md'),
      '---\ntitle: Release ritual\n---\n\nBump, tag, push the release.\n',
    );
    const r = await fetch(`${base}/api/knowledge/search?q=release%20ritual&max_results=4&mmr=true`);
    const hits = (await r.json()) as Array<{ entry: { path: string } }>;
    expect(hits.map((h) => h.entry.path)).toContain('workflows/release.md');
  });
});

describe('GET /api/sessions/search (a tool call as a hit)', () => {
  it('reads as the call a person would name, not its JSON', async () => {
    const hits = (await (
      await fetch(`${base}/api/sessions/search?q=release.ts&role=all`)
    ).json()) as Array<{ role: string; excerpt: string }>;
    const call = hits.find((h) => h.role === 'tool_use');
    expect(call?.excerpt).toContain('Edit ./src/release.ts');
    for (const h of hits) expect(h.excerpt).not.toMatch(/"name"\s*:|"input"\s*:/);
  });
});

describe('a session as a real store holds it (slash commands, caveats, MCP tools, no git)', () => {
  beforeAll(() => {
    const dir = path.join(sessionsDir, 'C--Users-someone--repos-real-app');
    fs.mkdirSync(dir, { recursive: true });
    const row = (i: number, r: Record<string, unknown>) =>
      JSON.stringify({
        sessionId: 'sess-real-0004',
        cwd: 'C:\\Users\\someone\\repos\\real-app',
        gitBranch: 'HEAD',
        timestamp: `2026-11-13T11:0${i}:00.000Z`,
        ...r,
      });
    fs.writeFileSync(
      path.join(dir, 'sess-real-0004.jsonl'),
      [
        row(0, {
          type: 'user',
          message: {
            role: 'user',
            content:
              '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>',
          },
        }),
        row(1, {
          type: 'user',
          message: {
            role: 'user',
            content:
              '<command-message>plugin-authoring</command-message>\n<command-name>/plugin-authoring</command-name>\n<command-args>do it for agent-tasks</command-args>',
          },
        }),
        row(2, {
          type: 'user',
          message: { role: 'user', content: '<local-command-stdout>done</local-command-stdout>' },
        }),
        // The skill's instructions, written by the host in the person's turn.
        row(3, {
          type: 'user',
          isMeta: true,
          message: { role: 'user', content: 'Base directory for this skill: C:\\skills\\pa' },
        }),
        row(4, {
          type: 'user',
          message: { role: 'user', content: 'now the same for agent-discover' },
        }),
        row(5, {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'm1',
                name: 'mcp__agent-knowledge__knowledge_search',
                input: { query: 'release ritual' },
              },
            ],
          },
        }),
      ].join('\n') + '\n',
    );
  });

  it('the list names the project by its folder, previews what was asked (no command), no branch', async () => {
    const r = (await get('/api/sessions?limit=500')).body as unknown as {
      sessions: Array<Record<string, unknown>>;
    };
    expect(r.sessions.find((s) => s.sessionId === 'sess-real-0004')).toMatchObject({
      project: 'C--Users-someone--repos-real-app',
      name: 'real-app',
      preview: 'now the same for agent-discover',
      userMessageCount: 1,
      branch: '',
    });
  });

  it('the summary: what was asked without wrappers, MCP tool names whole', async () => {
    const s = (await get('/api/sessions/sess-real-0004/summary')).body as {
      name: string;
      topics: Array<{ content: string }>;
      toolsUsed: string[];
      meta: { branch: string; userMessageCount: number };
    };
    expect(s.name).toBe('real-app');
    expect(s.topics.map((t) => t.content)).toEqual(['now the same for agent-discover']);
    expect(s.toolsUsed).toEqual(['mcp__agent-knowledge__knowledge_search']);
    expect(s.meta).toMatchObject({ branch: '', userMessageCount: 1 });
  });
});

describe('a snapshot in a knowledge base under git', () => {
  it('is committed alone, under its own message, so the next pull finds the tree clean', async () => {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: memoryDir, encoding: 'utf-8' }).trim();
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    // Someone else's change in the folder stays theirs: not swept into the snapshot's commit.
    fs.writeFileSync(path.join(memoryDir, 'unrelated.md'), 'draft');
    const { body } = await post('/api/sessions/sess-full-0001/snapshot', { event: 'end' });
    await vi.waitFor(() => expect(git('log', '-1', '--format=%s')).toMatch(/^session end: demo/), {
      timeout: 10_000,
    });
    expect(git('status', '--porcelain', '--', body.path as string)).toBe('');
    expect(git('status', '--porcelain')).toContain('unrelated.md');
  });
});

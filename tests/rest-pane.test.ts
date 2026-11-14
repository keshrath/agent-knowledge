// =============================================================================
// REST routes the /knowledge pane alone calls: the overview it polls, the
// analysis, delete and git sync. A scratch HOME, knowledge dir and data dir:
// nothing reads or writes the real ones.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Imported at collection, not in beforeAll: transforming the server's module graph takes seconds
// under load and would count against the hook timeout. Config is read per call, so the env the
// hook sets still applies.
import { startRestServer, type RestServer } from '../src/rest-server.js';
import { invalidateKnowledgeIndexCache } from '../src/knowledge/search.js';
import { invalidateOverview } from '../src/transport/rest.js';

const ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'AGENT_KNOWLEDGE_MEMORY_DIR',
  'AGENT_KNOWLEDGE_DATA_DIR',
  'AGENT_KNOWLEDGE_EMBEDDING_PROVIDER',
  'KNOWLEDGE_OPENAI_API_KEY',
  'AGENT_KNOWLEDGE_EXTRA_SESSION_ROOTS',
  'AGENT_KNOWLEDGE_GIT_URL',
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let root: string;
let memoryDir: string;
let server: RestServer;
let base: string;

function writeEntryFile(rel: string, title: string, body: string) {
  const file = path.join(memoryDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\ntitle: ${title}\n---\n\n${body}\n`);
}

const get = async (p: string) => {
  const r = await fetch(`${base}${p}`);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const send = async (method: string, p: string) => {
  const r = await fetch(`${base}${p}`, { method });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-pane-'));
  memoryDir = path.join(root, 'knowledge');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(memoryDir, { recursive: true });
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.AGENT_KNOWLEDGE_MEMORY_DIR = memoryDir;
  process.env.AGENT_KNOWLEDGE_DATA_DIR = dataDir;
  process.env.AGENT_KNOWLEDGE_EMBEDDING_PROVIDER = 'openai';
  delete process.env.KNOWLEDGE_OPENAI_API_KEY;
  delete process.env.AGENT_KNOWLEDGE_EXTRA_SESSION_ROOTS;
  delete process.env.AGENT_KNOWLEDGE_GIT_URL;

  writeEntryFile('notes/pane-alpha.md', 'Pane Alpha', 'The zebrafish deploy recipe for the pane.');
  writeEntryFile(
    'notes/pane-alpha-2.md',
    'Pane Alpha 2',
    'The zebrafish deploy recipe for the pane.',
  );
  writeEntryFile('decisions/pane-beta.md', 'Pane Beta', 'We chose loopback only.');
  writeEntryFile('README.md', 'Readme', 'What this folder is.');
  writeEntryFile('projects/pane-gamma.md', 'Pane Gamma', 'Something else entirely.');
  const proj = path.join(dataDir, 'projects', 'demo-project');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(
    path.join(proj, 'sess-pane-1.jsonl'),
    JSON.stringify({
      type: 'user',
      sessionId: 'sess-pane-1',
      cwd: '/work/demo',
      timestamp: '2026-10-01T10:00:00.000Z',
      message: { role: 'user', content: 'hello' },
    }) + '\n',
  );

  // A short session: the whole file fits in the head the list reads.
  fs.writeFileSync(
    path.join(proj, 'sess-pane-2.jsonl'),
    [
      { type: 'user', timestamp: '2026-10-02T08:00:00.000Z', content: 'start' },
      { type: 'assistant', timestamp: '2026-10-02T09:30:00.000Z', content: 'done' },
    ]
      .map((l) =>
        JSON.stringify({
          type: l.type,
          sessionId: 'sess-pane-2',
          cwd: '/work/demo',
          timestamp: l.timestamp,
          message: { role: l.type, content: l.content },
        }),
      )
      .join('\n') + '\n',
  );

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
    /* left for the OS temp cleanup */
  }
});

describe('GET /api/overview (what the pane polls)', () => {
  it('counts entries by folder (one at the top as other) and sessions, says where they live, and carries the events', async () => {
    await fetch(`${base}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'distill', message: '2 entries' }),
    });
    const { status, body } = await get('/api/overview');
    expect(status).toBe(200);
    expect(body).toMatchObject({
      entries: 5,
      categories: { notes: 2, decisions: 1, projects: 1, other: 1 },
      sessions: 2,
      vectors: 0,
      memory_dir: memoryDir,
      has_git: false,
    });
    expect(typeof body.version).toBe('string');
    expect(body.events).toEqual([
      expect.objectContaining({ kind: 'distill', message: '2 entries' }),
    ]);
  });

  it('a write through this server shows at once, not after the cache runs out', async () => {
    await fetch(`${base}/api/knowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'people', filename: 'pane-delta', content: '# Delta' }),
    });
    expect((await get('/api/overview')).body).toMatchObject({
      entries: 6,
      categories: { people: 1 },
    });
  });
});

describe('GET /api/analysis', () => {
  it('answers the most linked entries and the ones with one link or none', async () => {
    const { status, body } = await get('/api/analysis');
    expect(status).toBe(200);
    expect(body.hubs).toEqual([]);
    expect((body.sparse as { path: string }[]).map((g) => g.path)).toContain(
      'decisions/pane-beta.md',
    );
  });

  it('lists an entry in one group only: most linked needs two links or more', async () => {
    const { getKnowledgeGraph } = await import('../src/knowledge/graph.js');
    const graph = getKnowledgeGraph();
    graph.link('notes/pane-alpha.md', 'decisions/pane-beta.md', 'related_to');
    graph.link('notes/pane-alpha.md', 'projects/pane-gamma.md', 'related_to');
    const { body } = await get('/api/analysis');
    const hubs = (body.hubs as { path: string }[]).map((h) => h.path);
    const sparse = (body.sparse as { path: string }[]).map((g) => g.path);
    expect(hubs).toEqual(['notes/pane-alpha.md']);
    expect(sparse).toContain('decisions/pane-beta.md');
    expect(hubs.filter((p) => sparse.includes(p))).toEqual([]);
    graph.unlink('notes/pane-alpha.md', 'decisions/pane-beta.md');
    graph.unlink('notes/pane-alpha.md', 'projects/pane-gamma.md');
  });

  it('pages the sparse ones, fewest links first then by title, every one reachable', async () => {
    const { getKnowledgeGraph } = await import('../src/knowledge/graph.js');
    const graph = getKnowledgeGraph();
    graph.link('notes/pane-alpha.md', 'decisions/pane-beta.md', 'related_to');
    const pages: Array<{ title: string; degree: number }> = [];
    let total = Infinity;
    for (let offset = 0; offset < total; offset += 2) {
      const { body } = await get(`/api/analysis?offset=${offset}&limit=2`);
      expect(body.offset).toBe(offset);
      total = body.sparse_total as number;
      pages.push(...(body.sparse as Array<{ title: string; degree: number }>));
    }
    expect(pages).toHaveLength(total);
    const sorted = [...pages].sort(
      (a, b) =>
        a.degree - b.degree ||
        a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }),
    );
    expect(pages).toEqual(sorted);
    expect(pages.at(-1)!.degree).toBe(1);
    graph.unlink('notes/pane-alpha.md', 'decisions/pane-beta.md');
  });

  it('sorts numbered titles as numbers: Note 2 before Note 10', async () => {
    for (const n of [10, 2, 1]) writeEntryFile(`notes/num-${n}.md`, `Note ${n}`, 'x');
    const { body } = await get('/api/analysis?limit=500');
    const titles = (body.sparse as Array<{ title: string }>)
      .map((g) => g.title)
      .filter((t) => /^Note \d+$/.test(t));
    expect(titles).toEqual(['Note 1', 'Note 2', 'Note 10']);
    for (const n of [10, 2, 1]) fs.rmSync(path.join(memoryDir, 'notes', `num-${n}.md`));
  });
});

describe('session snapshots beside curated knowledge', () => {
  it('a search can leave them out, and Analyze does', async () => {
    writeEntryFile(
      'sessions/demo/2026-11-13-abcd1234.md',
      'demo · 2026-11-13 · zebrafish talk',
      'We talked about the zebrafish deploy recipe.',
    );
    invalidateKnowledgeIndexCache(); // written past the server, as another process would
    const all = (await get('/api/knowledge/search?q=zebrafish')).body as unknown as Array<{
      entry: { path: string };
    }>;
    expect(all.map((h) => h.entry.path)).toContain('sessions/demo/2026-11-13-abcd1234.md');
    const curated = (await get('/api/knowledge/search?q=zebrafish&skip=sessions'))
      .body as unknown as Array<{ entry: { path: string } }>;
    expect(curated.length).toBeGreaterThan(0);
    expect(curated.map((h) => h.entry.path)).not.toContain('sessions/demo/2026-11-13-abcd1234.md');
    const { body } = await get('/api/analysis');
    expect((body.sparse as { path: string }[]).map((g) => g.path)).not.toContain(
      'sessions/demo/2026-11-13-abcd1234.md',
    );
    // The regex fallback (a query of stopwords only) leaves them out too.
    const phrase = (
      await get(`/api/knowledge/search?q=${encodeURIComponent('about the')}&skip=sessions`)
    ).body as unknown as Array<{ entry: { path: string } }>;
    expect(phrase.map((h) => h.entry.path)).not.toContain('sessions/demo/2026-11-13-abcd1234.md');
    fs.rmSync(path.join(memoryDir, 'sessions'), { recursive: true, force: true });
  });

  it('are counted apart from the entries, the same on /health and the overview', async () => {
    writeEntryFile('sessions/demo/2026-11-13-abcd1234.md', 'demo · snapshot', 'A session.');
    invalidateKnowledgeIndexCache();
    invalidateOverview();
    const health = (await get('/health')).body;
    const overview = (await get('/api/overview')).body;
    expect(overview.snapshots).toBe(1);
    expect(overview.categories).not.toHaveProperty('sessions');
    expect(overview.entries).toBe(
      Object.values(overview.categories as Record<string, number>).reduce((a, b) => a + b, 0),
    );
    expect({ entries: health.entries, snapshots: health.snapshots }).toEqual({
      entries: overview.entries,
      snapshots: 1,
    });
    fs.rmSync(path.join(memoryDir, 'sessions'), { recursive: true, force: true });
    invalidateOverview();
  });

  it('says whether the session is on this machine, so it can be opened', async () => {
    const snap = (rel: string, session: string) => {
      const file = path.join(memoryDir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        `---\ntitle: demo\ntype: session-snapshot\nsession: ${session}\n---\n\n# demo\n`,
      );
    };
    snap('sessions/demo/here.md', 'sess-pane-1');
    snap('sessions/demo/elsewhere.md', 'sess-on-another-machine');
    const entry = async (rel: string) =>
      (await get(`/api/knowledge/${encodeURIComponent(rel)}`)).body;
    expect((await entry('sessions/demo/here.md')).session_on_machine).toBe(true);
    expect((await entry('sessions/demo/elsewhere.md')).session_on_machine).toBe(false);
    expect(await entry('decisions/pane-beta.md')).not.toHaveProperty('session_on_machine');
    fs.rmSync(path.join(memoryDir, 'sessions'), { recursive: true, force: true });
  });
});

describe('the first-prompt search (prompt=true, mmr)', () => {
  // A knowledge base where words-only search goes wrong both ways: entries that share one
  // ordinary word with a prompt, a topic named in titles and tags, near-copies.
  const KB: [string, string, string][] = [
    ['workflows/release.md', 'Release ritual', 'Build, prettier, eslint, test, tag.'],
    ['notes/py-runner.md', 'Python script runner', 'How we run a python script in CI.'],
    ['notes/working-agreements.md', 'Working agreements', 'How we start work each day.'],
    ['notes/small-fixes.md', 'Small fixes', 'A small fix gets no ticket; script it today.'],
    ['notes/start-here.md', 'Start here', 'Where to start: the today board.'],
    ['notes/win-paths.md', 'Windows path gotchas', 'Backslashes in paths on windows.'],
    ['notes/win-lock.md', 'Windows file lock', 'A dead process can hold a file lock on windows.'],
    ['notes/css-tokens.md', 'Pane CSS tokens', 'The theme keys the pane draws with.'],
    ['notes/one-line.md', 'One line tools', 'Write one line, use no tools.'],
    ...Array.from({ length: 8 }, (_, i): [string, string, string] => [
      `notes/gotcha-${i}.md`,
      `Gotcha ${i}: npm ci fails on lockfile drift`,
      'The fix is to retry once and then read the error message carefully.',
    ]),
    ...Array.from({ length: 30 }, (_, i): [string, string, string] => [
      `notes/common-${i}.md`,
      `Note ${i}`,
      `topic ${i} and agent knowledge things`,
    ]),
  ];
  beforeAll(() => {
    for (const [rel, title, body] of KB) writeEntryFile(rel, title, body);
    invalidateKnowledgeIndexCache();
  });
  afterAll(() => {
    for (const [rel] of KB) fs.rmSync(path.join(memoryDir, rel), { force: true });
    invalidateKnowledgeIndexCache();
  });
  const hits = async (prompt: string) =>
    (
      (
        await get(
          `/api/knowledge/search?q=${encodeURIComponent(prompt)}&max_results=4&mmr=true&prompt=true`,
        )
      ).body as unknown as Array<{ entry: { path: string } }>
    ).map((h) => h.entry.path);

  it.each([
    {
      prompt: 'hi! I want to start working on a small python script with you today.',
      has: ['notes/py-runner.md'],
      not: ['notes/working-agreements.md', 'notes/small-fixes.md', 'notes/start-here.md'],
    },
    {
      prompt: 'what do we know about windows? one line, no tools',
      has: ['notes/win-paths.md', 'notes/win-lock.md'],
      not: ['notes/one-line.md'],
    },
    {
      prompt: 'how do I release a file lock held by a dead process on windows?',
      has: ['notes/win-lock.md'],
      not: ['workflows/release.md'],
    },
    { prompt: 'why is the css broken?', has: ['notes/css-tokens.md'], not: [] },
    {
      prompt:
        'About our release ritual: quote your context block that starts with agent-knowledge holds',
      has: ['workflows/release.md'],
      not: ['notes/common-0.md'],
    },
    {
      prompt: 'what is the release ritual? one line, do not call tools',
      has: ['workflows/release.md'],
      not: ['notes/one-line.md'],
    },
    { prompt: 'hi, can you help me today?', has: [], not: ['notes/start-here.md'] },
  ])('$prompt', async ({ prompt, has, not }) => {
    const got = await hits(prompt);
    for (const p of has) expect(got).toContain(p);
    for (const p of not) expect(got).not.toContain(p);
    if (has.length === 0) expect(got).toEqual([]);
  });

  it('near-copies come once, even when nothing else is as relevant', async () => {
    const got = await hits('npm ci fails in CI with lockfile drift again');
    expect(got.filter((p) => p.startsWith('notes/gotcha-'))).toHaveLength(1);
  });

  it('without prompt=true a search finds what any of its words find', async () => {
    const q = encodeURIComponent('how do I release a file lock held by a dead process on windows?');
    const all = (await get(`/api/knowledge/search?q=${q}`)).body as unknown as Array<{
      entry: { path: string };
    }>;
    expect(all.map((h) => h.entry.path)).toContain('workflows/release.md');
  });
});

describe('what the 2.x hooks left beside the curated entries', () => {
  const write = (rel: string, text: string) => {
    const file = path.join(memoryDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const FILES: [string, string][] = [
    [
      'projects/session-C--Users-me-repo-3f2a9b1c.md',
      '---\ntype: session-end\nsession: 3f2a9b1c-0000\n---\n\n## Prompts\n\n- zebrafish deploy again',
    ],
    [
      'projects/precompact-C--Users-me-repo-77aa66bb.md',
      '---\ntype: precompact\n---\n\nzebrafish notes before the compaction',
    ],
    ['sessions/repo/PreCompact-20260304-120000-abcd1234.md', 'zebrafish, the old way'],
    ['notes/no-title.md', '# Ledger migration notes\n\nThe ledger moved to the new table.'],
  ];
  beforeAll(() => {
    for (const [rel, text] of FILES) write(rel, text);
    invalidateKnowledgeIndexCache();
    invalidateOverview();
  });
  afterAll(() => {
    for (const [rel] of FILES) fs.rmSync(path.join(memoryDir, rel), { force: true });
    invalidateKnowledgeIndexCache();
    invalidateOverview();
  });

  it('are session records: counted apart, out of the first-prompt hits and Analyze, not out of the folder', async () => {
    const o = (await get('/api/overview')).body as {
      snapshots: number;
      categories: Record<string, number>;
    };
    expect(o.snapshots).toBe(3);
    const list = (await get('/api/knowledge')).body as unknown as Array<{
      path: string;
      category: string;
      title: string;
      updated: string;
      snapshot?: boolean;
    }>;
    const dump = list.find((e) => e.path.startsWith('projects/session-'));
    expect(dump).toMatchObject({ category: 'sessions', snapshot: true });
    expect(list.find((e) => e.path.includes('PreCompact-'))?.updated).toBe('2026-03-04');
    const hits = (
      (await get('/api/knowledge/search?q=zebrafish&skip=sessions')).body as unknown as Array<{
        entry: { path: string };
      }>
    ).map((h) => h.entry.path);
    expect(hits.some((p) => /session-|precompact-|PreCompact-/.test(p))).toBe(false);
    const { body } = await get('/api/analysis?limit=500');
    expect(
      (body.sparse as { path: string }[]).some((g) => /session-|precompact-/.test(g.path)),
    ).toBe(false);
    // Nothing of the person's is moved or deleted.
    for (const [rel] of FILES) expect(fs.existsSync(path.join(memoryDir, rel))).toBe(true);
  });

  it('a 2.x dump without a title is named as the snapshots are: project · day · what', async () => {
    const list = (await get('/api/knowledge')).body as unknown as Array<{
      path: string;
      title: string;
    }>;
    expect(list.find((e) => e.path.startsWith('projects/precompact-'))?.title).toMatch(
      /^repo · \d{4}-\d\d-\d\d · before a compaction$/,
    );
    expect(list.find((e) => e.path.includes('PreCompact-'))?.title).toBe(
      'repo · 2026-03-04 · before a compaction',
    );
  });

  it('an entry without a title is named by its first heading', async () => {
    const list = (await get('/api/knowledge')).body as unknown as Array<{
      path: string;
      title: string;
    }>;
    expect(list.find((e) => e.path === 'notes/no-title.md')?.title).toBe('Ledger migration notes');
  });
});

describe('links to an entry that is not there', () => {
  it('are marked missing, and count for neither end in the analysis', async () => {
    const { getKnowledgeGraph } = await import('../src/knowledge/graph.js');
    const graph = getKnowledgeGraph();
    graph.link('notes/pane-alpha.md', 'notes/ghost.md', 'related_to');
    graph.link('notes/pane-alpha.md', 'notes/ghost-2.md', 'related_to');
    const links = (await get(`/api/knowledge/${encodeURIComponent('notes/pane-alpha.md')}/links`))
      .body as unknown as { target: string; missing: boolean; title: string | null }[];
    expect(links.find((l) => l.target === 'notes/ghost.md')).toMatchObject({
      missing: true,
      title: null,
    });
    // Two dead links do not make pane-alpha most linked: it has none that lead anywhere.
    const { body } = await get('/api/analysis');
    expect((body.hubs as { path: string }[]).map((h) => h.path)).not.toContain(
      'notes/pane-alpha.md',
    );
    expect(body.sparse_total).toBe((body.sparse as unknown[]).length);
    graph.forget('notes/ghost.md');
    graph.forget('notes/ghost-2.md');
  });
});

describe('DELETE /api/knowledge/:path', () => {
  it('drops the links of the entry with it', async () => {
    const { getKnowledgeGraph } = await import('../src/knowledge/graph.js');
    const graph = getKnowledgeGraph();
    graph.link('notes/pane-alpha-2.md', 'decisions/pane-beta.md', 'related_to');
    expect(graph.links('decisions/pane-beta.md')).toHaveLength(1);
    await send('DELETE', `/api/knowledge/${encodeURIComponent('notes/pane-alpha-2.md')}`);
    expect(graph.links('decisions/pane-beta.md')).toEqual([]);
  });

  it('deletes the file and drops it from the overview at once', async () => {
    const { status, body } = await send(
      'DELETE',
      `/api/knowledge/${encodeURIComponent('projects/pane-gamma.md')}`,
    );
    expect(status).toBe(200);
    expect(body.deleted).toBe(true);
    expect(fs.existsSync(path.join(memoryDir, 'projects', 'pane-gamma.md'))).toBe(false);
    expect((await get('/api/overview')).body.entries).toBe(4);
  });

  it('answers 404 for an entry not there and 400 for a path out of the knowledge dir', async () => {
    expect(
      (await send('DELETE', `/api/knowledge/${encodeURIComponent('notes/none.md')}`)).status,
    ).toBe(404);
    expect(
      (await send('DELETE', `/api/knowledge/${encodeURIComponent('../outside.md')}`)).status,
    ).toBe(400);
  });
});

describe('POST /api/knowledge/sync', () => {
  it('answers what pull and push did; without a remote both say why they failed', async () => {
    execFileSync('git', ['init', '-q'], { cwd: memoryDir });
    const { status, body } = await send('POST', '/api/knowledge/sync');
    expect(status).toBe(200);
    expect(body.pull).toMatchObject({ success: false });
    expect(body.push).toMatchObject({ success: false });
    // The sync drops the cached counts: the repository now shows.
    expect((await get('/api/overview')).body.has_git).toBe(true);
  });
});

describe('GET /api/sessions', () => {
  it('a short session ends at its last line, not where it started', async () => {
    const { body } = await get('/api/sessions');
    const s = (body.sessions as { sessionId: string; startTime: string; endTime: string }[]).find(
      (x) => x.sessionId === 'sess-pane-2',
    );
    expect(s).toMatchObject({
      startTime: '2026-10-02T08:00:00.000Z',
      endTime: '2026-10-02T09:30:00.000Z',
    });
  });

  it('counts prompts, not commands: a /clear alone is none; a first prompt past the head is found', async () => {
    const proj = path.join(process.env.AGENT_KNOWLEDGE_DATA_DIR!, 'projects', 'demo-project');
    const line = (id: string, i: number, content: string) =>
      JSON.stringify({
        type: 'user',
        sessionId: id,
        cwd: '/work/demo',
        timestamp: `2026-10-03T10:0${i}:00.000Z`,
        message: { role: 'user', content },
      });
    fs.writeFileSync(
      path.join(proj, 'sess-pane-clear.jsonl'),
      line('sess-pane-clear', 0, '<command-name>/clear</command-name>') + '\n',
    );
    // A pasted log longer than the head the list reads.
    const paste = `why does this fail?\n${'x'.repeat(40_000)}`;
    fs.writeFileSync(
      path.join(proj, 'sess-pane-paste.jsonl'),
      [
        line('sess-pane-paste', 0, '<command-name>/clear</command-name>'),
        line('sess-pane-paste', 1, paste),
      ].join('\n') + '\n',
    );
    const { body } = await get('/api/sessions');
    const row = (id: string) =>
      (body.sessions as Array<Record<string, unknown>>).find((x) => x.sessionId === id);
    expect(row('sess-pane-clear')).toMatchObject({ userMessageCount: 0, preview: '' });
    expect(row('sess-pane-paste')).toMatchObject({ userMessageCount: 1 });
    expect(row('sess-pane-paste')!.preview).toMatch(/^why does this fail\?/);
  });
});

describe('GET /api/sessions/search', () => {
  it('names a hit by its project folder, not the store slug', async () => {
    const hits = (await get('/api/sessions/search?q=hello')).body as unknown as Array<
      Record<string, unknown>
    >;
    expect(hits.find((h) => h.id === 'sess-pane-1')).toMatchObject({
      project: 'demo-project',
      name: 'demo',
    });
  });
});

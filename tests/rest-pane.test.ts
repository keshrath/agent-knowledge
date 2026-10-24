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
import type { RestServer } from '../src/rest-server.js';

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

  const { startRestServer } = await import('../src/rest-server.js');
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
});

describe('DELETE /api/knowledge/:path', () => {
  it('deletes the file and drops it from the overview at once', async () => {
    const { status, body } = await send(
      'DELETE',
      `/api/knowledge/${encodeURIComponent('projects/pane-gamma.md')}`,
    );
    expect(status).toBe(200);
    expect(body.deleted).toBe(true);
    expect(fs.existsSync(path.join(memoryDir, 'projects', 'pane-gamma.md'))).toBe(false);
    expect((await get('/api/overview')).body.entries).toBe(5);
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
});

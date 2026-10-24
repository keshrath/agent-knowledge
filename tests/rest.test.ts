// =============================================================================
// REST server — every kept route against each caller's contract, the request
// guard and the error statuses. A scratch HOME, knowledge dir and data dir:
// nothing reads or writes the real ones.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
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
  fs.writeFileSync(file, `---\ntitle: ${title}\ntags: [rest]\n---\n\n${body}\n`);
}

function line(type: 'user' | 'assistant', text: string, ts: string) {
  return JSON.stringify({
    type,
    sessionId: 'sess-rest-1',
    cwd: '/work/demo',
    timestamp: ts,
    message: { role: type, content: text },
  });
}

/** A raw request, so a test can set Host, Origin and Content-Type itself. */
function raw(
  method: string,
  pathname: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.port, method, path: pathname, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode!, body: data }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const get = (p: string) => fetch(`${base}${p}`);
const post = (p: string, body: unknown) =>
  fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-rest-'));
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

  writeEntryFile('notes/rest-alpha.md', 'Rest Alpha', 'The zebrafish deploy recipe.');
  writeEntryFile('decisions/rest-beta.md', 'Rest Beta', 'We chose loopback only.');

  const proj = path.join(dataDir, 'projects', 'demo-project');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(
    path.join(proj, 'sess-rest-1.jsonl'),
    [
      line('user', 'How do we deploy the quokka service?', '2026-10-01T10:00:00.000Z'),
      line('assistant', 'Run the quokka deploy script.', '2026-10-01T10:00:05.000Z'),
    ].join('\n') + '\n',
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
  // The scoring and vector DBs stay open in this process; Windows keeps their files.
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* left for the OS temp cleanup */
  }
});

describe('request guard', () => {
  it('refuses a foreign Host (DNS rebinding)', async () => {
    const r = await raw('GET', '/health', { Host: `evil.example:${server.port}` });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).error).toBe('Forbidden host');
  });

  it('refuses any Origin, a loopback one too', async () => {
    const r = await raw('GET', '/health', {
      Host: `127.0.0.1:${server.port}`,
      Origin: `http://localhost:${server.port}`,
    });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).error).toBe('Forbidden origin');
  });

  it('refuses a body that is not application/json', async () => {
    const r = await raw(
      'POST',
      '/api/events',
      { Host: `localhost:${server.port}`, 'Content-Type': 'text/plain', 'Content-Length': '2' },
      'hi',
    );
    expect(r.status).toBe(415);
  });

  it('lets a plain loopback request through', async () => {
    const r = await raw('GET', '/health', { Host: `localhost:${server.port}` });
    expect(r.status).toBe(200);
  });
});

describe('GET /health', () => {
  it('reports ok, the package version and the entry count', async () => {
    const res = await get('/health');
    expect(res.status).toBe(200);
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(await res.json()).toMatchObject({
      status: 'ok',
      version: pkg.version,
      knowledge_entries: 2,
    });
  });
});

describe('knowledge entries', () => {
  it('GET /api/knowledge lists entries with their scoring', async () => {
    const rows = (await (await get('/api/knowledge')).json()) as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.path).sort()).toEqual([
      'decisions/rest-beta.md',
      'notes/rest-alpha.md',
    ]);
    expect(rows[0]).toMatchObject({ maturity: 'candidate', access_count: 0, evergreen: false });
  });

  it('GET /api/knowledge?category= narrows to one category', async () => {
    const rows = (await (await get('/api/knowledge?category=decisions')).json()) as Array<{
      path: string;
    }>;
    expect(rows.map((r) => r.path)).toEqual(['decisions/rest-beta.md']);
  });

  it('GET /api/knowledge/:path reads one entry (the slash sent encoded)', async () => {
    const res = await get(`/api/knowledge/${encodeURIComponent('notes/rest-alpha.md')}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string; maturity: string };
    expect(body.content).toContain('zebrafish');
    expect(body.maturity).toBe('candidate');
  });

  it('GET /api/knowledge/:path answers 404 for a missing entry and 400 for traversal', async () => {
    expect((await get(`/api/knowledge/${encodeURIComponent('notes/nope.md')}`)).status).toBe(404);
    expect((await get(`/api/knowledge/${encodeURIComponent('../../etc/passwd')}`)).status).toBe(
      400,
    );
  });

  it('GET /api/knowledge/:path/links answers the edges with the other end titled', async () => {
    const { getKnowledgeGraph } = await import('../src/knowledge/graph.js');
    const graph = getKnowledgeGraph();
    graph.link('notes/rest-alpha.md', 'decisions/rest-beta.md', 'depends_on');
    graph.link('notes/gone.md', 'notes/rest-alpha.md', 'related_to');
    const res = await get(`/api/knowledge/${encodeURIComponent('notes/rest-alpha.md')}/links`);
    expect(res.status).toBe(200);
    const edges = (await res.json()) as Array<{ source: string; target: string; title: unknown }>;
    expect(edges.find((e) => e.target === 'decisions/rest-beta.md')?.title).toBe('Rest Beta');
    // An edge that outlived its entry has no title; the pane shows the file name.
    expect(edges.find((e) => e.source === 'notes/gone.md')?.title).toBeNull();
  });

  it('GET /api/knowledge/search finds by content (the opencode plugin contract)', async () => {
    const hits = (await (
      await get('/api/knowledge/search?q=zebrafish&max_results=5')
    ).json()) as Array<{
      entry: { path: string };
      maturity: string;
    }>;
    expect(hits[0]?.entry.path).toBe('notes/rest-alpha.md');
    expect(hits[0]).toHaveProperty('maturity');
  });
});

describe('POST /api/knowledge (agent-tasks KnowledgeBridge contract)', () => {
  it('writes the entry file and answers 201 with its path', async () => {
    const res = await post('/api/knowledge', {
      category: 'decisions',
      filename: 'from-bridge',
      content: '---\ntitle: From bridge\n---\n\nChose REST over a socket.\n',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { path: string };
    expect(body.path).toBe('decisions/from-bridge.md');
    expect(fs.readFileSync(path.join(memoryDir, 'decisions/from-bridge.md'), 'utf8')).toContain(
      'Chose REST over a socket.',
    );
  });

  it('answers 422 for missing fields or an unknown category', async () => {
    expect((await post('/api/knowledge', { category: 'notes' })).status).toBe(422);
    const bad = await post('/api/knowledge', { category: 'junk', filename: 'x', content: 'y' });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: string }).error).toContain('Invalid category');
  });

  it('answers 400 for a body that is not a JSON object', async () => {
    const res = await fetch(`${base}/api/knowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '[1,2]',
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/events (the session-end hook contract)', () => {
  it('records an event and answers 201 with its id', async () => {
    const res = await post('/api/events', { kind: 'session-end', message: 'distilled 2 entries' });
    expect(res.status).toBe(201);
    const { recentEvents } = await import('../src/events.js');
    expect(recentEvents().at(-1)).toMatchObject({
      kind: 'session-end',
      message: 'distilled 2 entries',
    });
  });

  it('answers 422 for a missing or oversized field and 413 past 4 KB', async () => {
    expect((await post('/api/events', { kind: 'x' })).status).toBe(422);
    expect((await post('/api/events', { kind: 'x', message: 'y'.repeat(600) })).status).toBe(422);
    expect((await post('/api/events', { kind: 'x', message: 'y'.repeat(5_000) })).status).toBe(413);
  });
});

describe('sessions', () => {
  it('GET /api/sessions pages the sessions with their total', async () => {
    const body = (await (await get('/api/sessions?limit=10')).json()) as {
      sessions: Array<{ sessionId?: string; id?: string }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.sessions).toHaveLength(1);
  });

  it('GET /api/sessions/search finds a word said in a session', async () => {
    const res = await get('/api/sessions/search?q=quokka');
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain('quokka');
  });

  it('GET /api/sessions/:id/summary summarizes a session; 404 for an unknown one', async () => {
    const ok = await get('/api/sessions/sess-rest-1/summary');
    expect(ok.status).toBe(200);
    expect((await get('/api/sessions/no-such-session/summary')).status).toBe(404);
  });
});

describe('routing', () => {
  it('answers 404 for an unknown route and for a known path with another method', async () => {
    expect((await get('/api/nope')).status).toBe(404);
    expect((await get('/')).status).toBe(404);
    expect((await fetch(`${base}/health`, { method: 'PUT' })).status).toBe(404);
  });
});

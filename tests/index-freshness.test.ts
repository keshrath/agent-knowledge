// =============================================================================
// The search indexes follow their files: entries other processes write or
// delete, and session files that grow, are found without rebuilding the
// index, and building it gives the event loop back while it reads.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  invalidateKnowledgeIndexCache,
  searchKnowledge,
  warmKnowledgeIndex,
} from '../src/knowledge/search.js';
import { readSessionFile, readSessionTail } from '../src/sessions/parser.js';
import { searchSessions } from '../src/sessions/search.js';

const ENV_KEYS = [
  'AGENT_KNOWLEDGE_MEMORY_DIR',
  'AGENT_KNOWLEDGE_DATA_DIR',
  'AGENT_KNOWLEDGE_EMBEDDING_PROVIDER',
  'AGENT_KNOWLEDGE_EXTRA_SESSION_ROOTS',
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let root: string;
let memoryDir: string;
let sessionDir: string;

/** Past the 2 s in which a search trusts its last look at the files. */
const RECHECK = 2_100;
/**
 * The clock moved past it: only `Date` is faked (from beforeAll on), so the files keep their real
 * times and nothing sleeps, whatever the load on the machine.
 */
const later = () => vi.setSystemTime(Date.now() + RECHECK);

function entry(rel: string, title: string, body: string) {
  const file = path.join(memoryDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\ntitle: ${title}\n---\n\n${body}\n`);
}

const line = (id: string, role: 'user' | 'assistant', text: string, i: number) =>
  JSON.stringify({
    type: role,
    sessionId: id,
    cwd: '/work/demo',
    timestamp: `2026-11-13T10:${String(i).padStart(2, '0')}:00.000Z`,
    message: { role, content: text },
  }) + '\n';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-fresh-'));
  memoryDir = path.join(root, 'knowledge');
  const dataDir = path.join(root, 'data');
  sessionDir = path.join(dataDir, 'projects', 'demo');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  process.env.AGENT_KNOWLEDGE_MEMORY_DIR = memoryDir;
  process.env.AGENT_KNOWLEDGE_DATA_DIR = dataDir;
  process.env.AGENT_KNOWLEDGE_EMBEDDING_PROVIDER = 'openai';
  delete process.env.AGENT_KNOWLEDGE_EXTRA_SESSION_ROOTS;
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
});

afterAll(() => {
  vi.useRealTimers();
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

describe('the knowledge index', () => {
  it('finds an entry another process writes, and forgets one it deletes, without a rebuild', async () => {
    entry('notes/alpha.md', 'Alpha', 'The zebrafish recipe.');
    expect(searchKnowledge(memoryDir, 'zebrafish').map((r) => r.entry.path)).toEqual([
      'notes/alpha.md',
    ]);

    entry('notes/beta.md', 'Beta', 'Another zebrafish note.');
    later();
    expect(
      searchKnowledge(memoryDir, 'zebrafish')
        .map((r) => r.entry.path)
        .sort(),
    ).toEqual(['notes/alpha.md', 'notes/beta.md']);

    fs.rmSync(path.join(memoryDir, 'notes', 'alpha.md'));
    later();
    expect(searchKnowledge(memoryDir, 'zebrafish').map((r) => r.entry.path)).toEqual([
      'notes/beta.md',
    ]);
  });

  it('an edited entry is found by its new words, not its old ones', async () => {
    entry('notes/gamma.md', 'Gamma', 'The quokka plan, a longer text than before.');
    later();
    entry('notes/gamma.md', 'Gamma', 'The narwhal plan.');
    later();
    expect(searchKnowledge(memoryDir, 'quokka')).toEqual([]);
    expect(searchKnowledge(memoryDir, 'narwhal').map((r) => r.entry.path)).toEqual([
      'notes/gamma.md',
    ]);
  });

  it('a write in this process is seen at once', async () => {
    searchKnowledge(memoryDir, 'anything');
    entry('notes/delta.md', 'Delta', 'The axolotl list.');
    invalidateKnowledgeIndexCache();
    expect(searchKnowledge(memoryDir, 'axolotl').map((r) => r.entry.path)).toEqual([
      'notes/delta.md',
    ]);
  });

  it('a long transcript (a snapshot reads it) is parsed giving the event loop back', async () => {
    const file = path.join(root, 'long.jsonl');
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2026-11-13T10:00:00.000Z',
      message: { role: 'user', content: 'word '.repeat(200) },
    });
    fs.writeFileSync(file, `${line}\n`.repeat(60_000));
    let last = performance.now();
    let stall = 0;
    const ticker = setInterval(() => {
      stall = Math.max(stall, performance.now() - last);
      last = performance.now();
    }, 1);
    const t0 = performance.now();
    const entries = await readSessionFile(file);
    clearInterval(ticker);
    const took = performance.now() - t0;
    expect(entries).toHaveLength(60_000);
    expect(stall).toBeLessThan(Math.max(took / 2, 100));
  }, 30_000);

  it('a search during the warm-up joins it instead of reading the rest at once', async () => {
    const dir = path.join(root, 'joined');
    for (let i = 0; i < 20; i++) {
      const file = path.join(dir, 'notes', `j${i}.md`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `---\ntitle: J${i}\n---\n\nThe quetzal note ${i}.\n`);
    }
    const warm = warmKnowledgeIndex(dir);
    // What a search route awaits before it searches: the same update, not a second read.
    expect(warmKnowledgeIndex(dir)).toBe(warm);
    await warm;
    expect(searchKnowledge(dir, 'quetzal', { maxResults: 50 })).toHaveLength(20);
  });

  it('warming gives the event loop back while it reads', async () => {
    const bulk = path.join(root, 'bulk');
    for (let i = 0; i < 300; i++) {
      const file = path.join(bulk, 'notes', `n${i}.md`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `---\ntitle: N${i}\n---\n\n${'word '.repeat(2_000)}${i}\n`);
    }
    // The longest the event loop waited between two turns, while the build ran.
    let last = performance.now();
    let stall = 0;
    const ticker = setInterval(() => {
      stall = Math.max(stall, performance.now() - last);
      last = performance.now();
    }, 1);
    const t0 = performance.now();
    await warmKnowledgeIndex(bulk);
    clearInterval(ticker);
    const took = performance.now() - t0;
    // A build held in one block would stall the loop for all of it.
    expect(stall).toBeLessThan(Math.max(took / 2, 100));
  }, 30_000);
});

describe('the session index', () => {
  it('reads what a live session appends, not the whole file again; a partial line waits', async () => {
    const file = path.join(sessionDir, 'live-1.jsonl');
    fs.writeFileSync(file, line('live-1', 'user', 'first the walrus question', 0));
    const find = async (q: string) =>
      (await searchSessions(q, { semantic: false })).map((r) => r.id);
    expect(await find('walrus')).toEqual(['live-1']);

    // An append, its last line still being written.
    const next = line('live-1', 'assistant', 'the pelican answer', 1);
    fs.appendFileSync(file, next + line('live-1', 'user', 'half a cormorant', 2).slice(0, 30));
    later();
    expect(await find('pelican')).toEqual(['live-1']);
    expect(await find('cormorant')).toEqual([]);

    // The rest of that line arrives.
    fs.appendFileSync(file, line('live-1', 'user', 'half a cormorant', 2).slice(30));
    later();
    expect(await find('cormorant')).toEqual(['live-1']);
    expect(await find('walrus')).toEqual(['live-1']);
  });

  it('a file written anew is read anew; a deleted one is gone', async () => {
    const file = path.join(sessionDir, 'redo-2.jsonl');
    fs.writeFileSync(file, line('redo-2', 'user', 'about the ocelot and much more', 0));
    const find = async (q: string) =>
      (await searchSessions(q, { semantic: false })).map((r) => r.id);
    later();
    expect(await find('ocelot')).toEqual(['redo-2']);

    fs.writeFileSync(file, line('redo-2', 'user', 'the lynx', 0));
    later();
    expect(await find('ocelot')).toEqual([]);
    expect(await find('lynx')).toEqual(['redo-2']);

    fs.rmSync(file);
    later();
    expect(await find('lynx')).toEqual([]);
  });

  it('a session first read while still empty takes its start and folder from its first lines', async () => {
    const file = path.join(sessionDir, 'empty-4.jsonl');
    fs.writeFileSync(file, '');
    later();
    await searchSessions('anything', { semantic: false });
    fs.appendFileSync(file, line('empty-4', 'user', 'the tapir plan', 3));
    later();
    const [hit] = await searchSessions('tapir', { semantic: false });
    expect(hit).toMatchObject({ id: 'empty-4', name: 'demo' });
    expect(hit!.metadata!.sessionDate).toBe('2026-11-13T10:03:00.000Z');
  });

  it('two searches at once share one refresh and agree', async () => {
    fs.writeFileSync(
      path.join(sessionDir, 'pair-3.jsonl'),
      line('pair-3', 'user', 'the capybara meeting', 0),
    );
    later();
    const [a, b] = await Promise.all([
      searchSessions('capybara', { semantic: false }),
      searchSessions('capybara', { semantic: false }),
    ]);
    expect(a.map((r) => r.id)).toEqual(['pair-3']);
    expect(b.map((r) => r.id)).toEqual(['pair-3']);
  });
});

describe('reading a session file from an offset', () => {
  it('a file that ends without a newline keeps its last line; a later append is read on', async () => {
    const file = path.join(root, 'tail.jsonl');
    fs.writeFileSync(file, line('t', 'user', 'one', 0) + line('t', 'user', 'two', 1).trimEnd());
    const first = readSessionTail(file);
    expect(first.entries).toHaveLength(2);
    expect(first.end).toBe(fs.statSync(file).size);
    fs.appendFileSync(file, '\n' + line('t', 'user', 'three', 2));
    const next = readSessionTail(file, first.end);
    expect(next.entries.map((e) => (e.message as { content: string }).content)).toEqual(['three']);
  });

  it('a last line cut mid-write is left for the next read', async () => {
    const file = path.join(root, 'cut.jsonl');
    const whole = line('c', 'user', 'complete', 0);
    fs.writeFileSync(file, whole + line('c', 'user', 'partial', 1).slice(0, 20));
    const r = readSessionTail(file);
    expect(r.entries).toHaveLength(1);
    expect(r.end).toBe(Buffer.byteLength(whole));
  });
});

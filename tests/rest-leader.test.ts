// =============================================================================
// REST leader election — the port's next holder takes over when the server exits
// =============================================================================

import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { serveRestWhenFree, type RestLeader } from '../src/rest-server.js';

const leaders: RestLeader[] = [];
const prevMemory = process.env.AGENT_KNOWLEDGE_MEMORY_DIR;
const scratch = mkdtempSync(join(tmpdir(), 'ak-leader-'));

beforeAll(() => {
  process.env.AGENT_KNOWLEDGE_MEMORY_DIR = scratch;
});

afterEach(() => {
  for (const l of leaders.splice(0)) l.close();
});

afterAll(() => {
  if (prevMemory === undefined) delete process.env.AGENT_KNOWLEDGE_MEMORY_DIR;
  else process.env.AGENT_KNOWLEDGE_MEMORY_DIR = prevMemory;
  rmSync(scratch, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

function lead(port: number, onServe?: () => void): RestLeader {
  const leader = serveRestWhenFree(port, 20, onServe);
  leaders.push(leader);
  return leader;
}

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('serveRestWhenFree', () => {
  it('lets one process serve and another take over once it exits', async () => {
    const port = await freePort();
    let served = 0;
    const first = lead(port, () => served++);
    await until(() => first.server !== null);
    const second = lead(port, () => served++);
    await new Promise((r) => setTimeout(r, 100));
    expect(second.server).toBeNull();
    expect(served).toBe(1);

    first.close();
    await until(() => second.server !== null);
    expect(served).toBe(2);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
  });

  it('stops retrying once closed', async () => {
    const port = await freePort();
    const first = lead(port);
    await until(() => first.server !== null);
    const second = lead(port);
    second.close();
    first.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(second.server).toBeNull();
  });
});

describe('a connection kept alive', () => {
  it('outlives the pane polls (5 s, 30 s hidden): the server never closes one being reused', async () => {
    const port = await freePort();
    const leader = lead(port);
    await until(() => leader.server !== null);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    await res.json();
    expect(res.headers.get('keep-alive')).toMatch(/timeout=(\d+)/);
    const timeout = Number(/timeout=(\d+)/.exec(res.headers.get('keep-alive')!)![1]);
    expect(timeout).toBeGreaterThan(30);
  });
});

describe('the self-check', () => {
  it('asks the address the server is bound to (AGENT_KNOWLEDGE_HOST), not 127.0.0.1', async () => {
    const port = await freePort();
    const asked: string[] = [];
    const prevHost = process.env.AGENT_KNOWLEDGE_HOST;
    process.env.AGENT_KNOWLEDGE_HOST = 'localhost';
    try {
      const leader = serveRestWhenFree(port, 20, undefined, {
        watchMs: 20,
        probe: async (url) => {
          asked.push(url);
          return (await fetch(`${url}/health`).catch(() => null))?.ok ?? false;
        },
      });
      leaders.push(leader);
      await until(() => asked.length >= 3);
      const bound = leader.server!.httpServer.address() as { address: string; family: string };
      const host = bound.family === 'IPv6' ? `[${bound.address}]` : bound.address;
      expect(asked[0]).toBe(`http://${host}:${port}`);
      expect(leader.server!.url).toBe(asked[0]);
    } finally {
      if (prevHost === undefined) delete process.env.AGENT_KNOWLEDGE_HOST;
      else process.env.AGENT_KNOWLEDGE_HOST = prevHost;
    }
  });
});

describe('a holder that stops answering', () => {
  it('lets the port go after two unanswered self-checks and serves again on a fresh listener', async () => {
    const port = await freePort();
    let isWedged = true;
    let served = 0;
    const leader = serveRestWhenFree(port, 20, () => served++, {
      watchMs: 30,
      probe: async () => !isWedged,
    });
    leaders.push(leader);
    await until(() => leader.server !== null);
    const wedged = leader.server!;
    await until(() => leader.server !== null && leader.server !== wedged);
    isWedged = false;
    expect(wedged.httpServer.listening).toBe(false);
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    expect(served).toBe(1);
  });

  it('one unanswered check is not enough; an answered one resets the count', async () => {
    const port = await freePort();
    const answers = [false, true, false, true, false, true];
    const leader = serveRestWhenFree(port, 20, undefined, {
      watchMs: 20,
      probe: async () => answers.shift() ?? true,
    });
    leaders.push(leader);
    await until(() => leader.server !== null);
    const first = leader.server;
    await new Promise((r) => setTimeout(r, 250));
    expect(leader.server).toBe(first);
  });

  it('with another process waiting, the port is held by exactly one after a release', async () => {
    const port = await freePort();
    let isWedged = false;
    const first = serveRestWhenFree(port, 20, undefined, {
      watchMs: 30,
      probe: async () => !isWedged,
    });
    leaders.push(first);
    await until(() => first.server !== null);
    const held = first.server;
    const second = lead(port);
    isWedged = true;
    await until(() => first.server !== held);
    isWedged = false;
    await until(() => (first.server === null) !== (second.server === null));
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
  });

  it('the real self-check: a healthy holder keeps its listener', async () => {
    const port = await freePort();
    const leader = serveRestWhenFree(port, 20, undefined, { watchMs: 30 });
    leaders.push(leader);
    await until(() => leader.server !== null);
    const first = leader.server;
    await new Promise((r) => setTimeout(r, 200));
    expect(leader.server).toBe(first);
  });
});

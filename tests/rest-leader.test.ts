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

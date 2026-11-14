// =============================================================================
// opencode plugin unit tests
//
// Imports scripts/plugins/opencode/agent-knowledge.ts directly, builds mock
// client + event payloads, asserts the plugin fails open, respects the
// first-prompt gating, and emits shape-correct side effects (marker file,
// session snapshot request, compacting context, prepended text part).
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentKnowledgePlugin } from '../../scripts/plugins/opencode/agent-knowledge.ts';

type Hooks = Awaited<ReturnType<typeof AgentKnowledgePlugin>>;

function makeClient(overrides: Partial<Record<string, unknown>> = {}) {
  const toasts: Array<{ title?: string; message: string; variant: string }> = [];
  const client = {
    tui: {
      showToast: vi.fn(
        async (opts: { body?: { title?: string; message: string; variant: string } }) => {
          if (opts.body) toasts.push(opts.body);
          return true;
        },
      ),
    },
    ...overrides,
  };
  return { client, toasts };
}

async function loadPlugin(client: ReturnType<typeof makeClient>['client']): Promise<Hooks> {
  return AgentKnowledgePlugin({
    client: client as never,
    project: { id: 'test' } as never,
    directory: '',
    worktree: '',
    experimental_workspace: { register: () => undefined },
    serverUrl: new URL('http://localhost:0'),
    $: (() => ({})) as never,
  });
}

let scratch: string;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'agent-knowledge-opencode-'));
  process.env.AGENT_KNOWLEDGE_MEMORY_DIR = scratch;
  process.env.AGENT_KNOWLEDGE_DATA_DIR = join(scratch, '.data');
  delete process.env.AGENT_KNOWLEDGE_FIRSTPROMPT_INJECT;
  mkdirSync(join(scratch, '.data', '.first-prompt-seen'), { recursive: true });
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  });
});

afterEach(() => {
  fetchSpy.mockRestore();
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('AgentKnowledgePlugin', () => {
  it('exports a Plugin function with the expected hooks', async () => {
    const { client } = makeClient();
    const hooks = await loadPlugin(client);
    expect(typeof hooks.event).toBe('function');
    expect(typeof hooks['chat.message']).toBe('function');
    expect(typeof hooks['experimental.session.compacting']).toBe('function');
  });
});

describe('event: session.created', () => {
  it('shows a toast naming the knowledge base on session.created and never throws', async () => {
    const { client, toasts } = makeClient();
    const hooks = await loadPlugin(client);

    await hooks.event!({
      event: {
        type: 'session.created',
        properties: { info: { id: 'sess-abc' } },
      } as never,
    });

    expect(toasts.length).toBe(1);
    expect(toasts[0]!.message).toMatch(/^knowledge base: /);
    expect(toasts[0]!.variant).toBe('info');
  });

  it('fails open when client.tui.showToast throws (CLI mode)', async () => {
    const { client } = makeClient();
    client.tui.showToast = vi.fn(async () => {
      throw new Error('no TUI');
    });
    const hooks = await loadPlugin(client);

    await expect(
      hooks.event!({
        event: {
          type: 'session.created',
          properties: { info: { id: 'sess-xyz' } },
        } as never,
      }),
    ).resolves.not.toThrow();
  });
});

describe('chat.message (first-prompt inject)', () => {
  it('skips short prompts', async () => {
    const { client, toasts } = makeClient();
    const hooks = await loadPlugin(client);
    const parts: unknown[] = [{ type: 'text', text: 'hi' }];

    await hooks['chat.message']!({ sessionID: 'sess-short' } as never, {
      message: {} as never,
      parts: parts as never[],
    });

    expect(parts.length).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(toasts.length).toBe(0);
  });

  it('skips slash commands and bash shortcuts', async () => {
    const { client } = makeClient();
    const hooks = await loadPlugin(client);

    const slashParts: unknown[] = [{ type: 'text', text: '/clear the session please' }];
    await hooks['chat.message']!({ sessionID: 'sess-slash' } as never, {
      message: {} as never,
      parts: slashParts as never[],
    });
    expect(slashParts.length).toBe(1);

    const bangParts: unknown[] = [{ type: 'text', text: '!ls -la some-dir' }];
    await hooks['chat.message']!({ sessionID: 'sess-bang' } as never, {
      message: {} as never,
      parts: bangParts as never[],
    });
    expect(bangParts.length).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('prepends a rendered hits block and sets the marker on first real prompt', async () => {
    const { client, toasts } = makeClient();
    fetchSpy.mockImplementation(async () => {
      return new Response(
        JSON.stringify([
          {
            entry: { path: 'decisions/database-choice.md' },
            score: 0.87,
            snippet: 'We picked Postgres over MySQL because of jsonb support.',
          },
          {
            entry: { path: 'projects/etron.md' },
            score: 0.62,
            snippet: 'ETRON runs Odoo 15 at my.etron.info',
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const hooks = await loadPlugin(client);
    const parts: unknown[] = [{ type: 'text', text: 'How did we decide on the database?' }];

    await hooks['chat.message']!({ sessionID: 'sess-real' } as never, {
      message: {} as never,
      parts: parts as never[],
    });

    expect(parts.length).toBe(2);
    const injected = parts[0] as { type: string; text: string };
    expect(injected.type).toBe('text');
    expect(injected.text).toContain('decisions/database-choice.md');
    expect(injected.text).toContain('Knowledge — top hits');

    expect(existsSync(join(scratch, '.data', '.first-prompt-seen', 'sess-real'))).toBe(true);
    // As the Claude Code mod asks: near-copies once, no snapshots, no hit on one shared word.
    const asked = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(Object.fromEntries(asked.searchParams)).toMatchObject({
      mmr: 'true',
      skip: 'sessions',
      prompt: 'true',
    });
    expect(toasts.some((t) => t.message.startsWith('injected 2 hit'))).toBe(true);
  });

  it('sets the marker even on zero-hit so we do not re-search every turn', async () => {
    const { client } = makeClient();
    const hooks = await loadPlugin(client);
    const parts: unknown[] = [{ type: 'text', text: 'What is the meaning of life here?' }];

    await hooks['chat.message']!({ sessionID: 'sess-zero' } as never, {
      message: {} as never,
      parts: parts as never[],
    });

    expect(parts.length).toBe(1);
    expect(existsSync(join(scratch, '.data', '.first-prompt-seen', 'sess-zero'))).toBe(true);
  });

  it('honours AGENT_KNOWLEDGE_FIRSTPROMPT_INJECT=0 to disable inject entirely', async () => {
    process.env.AGENT_KNOWLEDGE_FIRSTPROMPT_INJECT = '0';
    const { client } = makeClient();
    const hooks = await loadPlugin(client);
    const parts: unknown[] = [
      { type: 'text', text: 'Tell me a long and detailed answer to this question.' },
    ];

    await hooks['chat.message']!({ sessionID: 'sess-disabled' } as never, {
      message: {} as never,
      parts: parts as never[],
    });

    expect(parts.length).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not re-inject on a second turn of the same session', async () => {
    const { client } = makeClient();
    fetchSpy.mockImplementation(
      async () =>
        new Response(
          JSON.stringify([{ entry: { path: 'notes/something.md' }, score: 0.5, snippet: 'info' }]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const hooks = await loadPlugin(client);
    const first: unknown[] = [{ type: 'text', text: 'First real question with ten+ characters.' }];
    const second: unknown[] = [
      { type: 'text', text: 'Second real question with ten+ characters.' },
    ];

    await hooks['chat.message']!({ sessionID: 'sess-twice' } as never, {
      message: {} as never,
      parts: first as never[],
    });
    await hooks['chat.message']!({ sessionID: 'sess-twice' } as never, {
      message: {} as never,
      parts: second as never[],
    });

    expect(first.length).toBe(2);
    expect(second.length).toBe(1);
  });
});

describe('experimental.session.compacting', () => {
  it('pushes a save-context nudge into output.context', async () => {
    const { client } = makeClient();
    const hooks = await loadPlugin(client);
    const output = { context: [] as string[] };

    await hooks['experimental.session.compacting']!({ sessionID: 'any' } as never, output as never);

    expect(output.context.length).toBe(1);
    expect(output.context[0]).toContain('Save unsaved knowledge');
  });
});

describe('event: session.deleted → the server snapshots the session', () => {
  it('posts the snapshot for the session, with the folder, and writes nothing itself', async () => {
    const { client } = makeClient();
    const hooks = await AgentKnowledgePlugin({
      client: client as never,
      project: { id: 'test' } as never,
      directory: '/work/app',
      worktree: '',
      experimental_workspace: { register: () => undefined },
      serverUrl: new URL('http://localhost:0'),
      $: (() => ({})) as never,
    });

    await hooks.event!({
      event: {
        type: 'session.deleted',
        properties: { info: { id: 'ses_12345678abcdef' } },
      } as never,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/sessions\/ses_12345678abcdef\/snapshot$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ event: 'end', cwd: '/work/app' });
    // Unscrubbed prompts no longer land in the git-synced knowledge base.
    expect(existsSync(join(scratch, 'projects'))).toBe(false);
  });

  it('fails open when the server is down', async () => {
    const { client } = makeClient();
    fetchSpy.mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    });
    const hooks = await loadPlugin(client);

    await expect(
      hooks.event!({
        event: {
          type: 'session.deleted',
          properties: { info: { id: 'sess-boom' } },
        } as never,
      }),
    ).resolves.not.toThrow();
  });
});

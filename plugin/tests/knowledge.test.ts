import type { On } from 'claude-code';
import { expect, mock, test, type TestBody } from 'claude-code/testing';

import {
  ago,
  bodyParts,
  eventWords,
  fitParts,
  fitTables,
  time,
  homeAsTilde,
  pageBody,
  plain,
  categoryOrder,
  clip,
  cols,
  duration,
  headline,
  isField,
  moveOf,
  packParts,
  when,
} from '../hooks/view';

type Entry = {
  path: string;
  title: string;
  tags: string[];
  updated: string;
  body: string;
  author?: string;
  evergreen?: boolean;
  maturity?: string;
  access_count?: number;
};

type Session = {
  sessionId: string;
  project: string;
  startTime: string;
  endTime: string;
  messageCount: number;
  /** Real prompts (the server's userMessageCount); 1 when left out. */
  prompts?: number;
  branch: string;
  preview: string;
  cwd: string;
  topics: string[];
  files: string[];
  errors: string[];
};

type World = {
  entries: Entry[];
  edges?: { source: string; target: string; rel_type: string; origin: string }[];
  sessions?: Session[];
  events?: { id: number; kind: string; message: string; ts: number }[];
  hasGit?: boolean;
  /** POST /api/knowledge/sync answers this. */
  sync?: {
    pull: { success: boolean; message: string };
    push: { success: boolean; message: string };
  };
  /** DELETE pushes, or fails to with this message. */
  pushFails?: string;
  isDown?: boolean;
  /** The port is held by a process that takes the connection and never answers. */
  isHung?: boolean;
  /** An agent-knowledge from before the pane holds the port: its version. */
  old?: string;
  /** What GET /api/wakeup says of the person: who they are, or that they are to be asked. */
  identity?: { onboarding: 'configured' | 'pending' | 'declined'; content?: string };
  /** What GET /api/ingest answers for the session's folder. */
  ingest?: Record<string, unknown>;
  /** POST /api/sessions/:id/snapshot writes here (null: nothing asked, nothing written). */
  snapshot?: string | null;
  /** What Analyze finds: how many with one link or none it lists, and how many in all. */
  analysis?: { sparse: number; total: number };
  /** Where the server says the entries live (`memory_dir`). */
  memoryDir?: string;
  /** How many searches the server answers 503 (its index still warming up) before it answers. */
  warming?: number;
  /** The session's environment (AGENT_KNOWLEDGE_* switches). */
  env?: Record<string, string>;
};

type Call = { method: string; path: string; query?: string; body?: Record<string, unknown> };

const e = (path: string, title: string, over: Partial<Entry> = {}): Entry => ({
  path,
  title,
  tags: [],
  updated: '2026-10-01',
  body: `# ${title}\n\nSome text.`,
  ...over,
});

const ENTRIES = (): Entry[] => [
  e('projects/agent-tasks.md', 'agent-tasks 2.0', {
    tags: ['release', 'pane'],
    updated: '2026-10-20',
    author: 'claude-code',
    maturity: 'established',
    access_count: 4,
  }),
  e('decisions/rest-only.md', 'REST only, no WebSocket', { updated: '2026-10-18' }),
  e('workflows/release.md', 'Release ritual', {
    tags: ['release'],
    updated: '2026-10-15',
    evergreen: true,
  }),
  e('people/mathias.md', 'Mathias', { updated: '2026-09-01' }),
];

const SESSIONS = (): Session[] => [
  {
    sessionId: 's-1',
    project: 'agent-tasks',
    startTime: '2026-10-22T08:00:00.000Z',
    endTime: '2026-10-22T09:30:00.000Z',
    messageCount: 42,
    branch: 'main',
    preview: 'make the board a pane',
    cwd: 'C:/work/agent-tasks',
    topics: ['make the board a pane', 'test it in the real CLI'],
    files: ['plugin/hooks/view.tsx'],
    errors: ['TypeError: x is undefined'],
  },
  {
    sessionId: 's-2',
    project: 'agent-knowledge',
    startTime: '2026-10-21T08:00:00.000Z',
    endTime: '2026-10-21T08:20:00.000Z',
    messageCount: 3,
    branch: '',
    preview: 'sync broke',
    cwd: '',
    topics: [],
    files: [],
    errors: [],
  },
];

/** The agent-knowledge REST server beneath the plugin, answering from `world`. */
function server(on: On, world: World) {
  const calls: Call[] = [];
  /** Every GET of the lifecycle routes (wakeup, ingest, search), with its query. */
  const gets: Call[] = [];
  const logs: string[] = [];
  const toasts: string[] = [];
  const status: (string | undefined)[] = [];
  const opens: Record<string, unknown>[] = [];
  const placed = { value: { isPlaced: true } as { isPlaced: boolean; reason?: string } };
  const panes = { value: [] as { id: string; isPlaced: boolean; isFocused?: boolean }[] };
  const clock = mock.clock(on);
  mock.env(on, world.env ?? {});
  on('session.start', (_$, ev) => ({ cwd: ev.cwd }));
  on('http.fetch', (_$, ev) => {
    const url = new URL(ev.url);
    const method = ev.init?.method ?? 'GET';
    const body = typeof ev.init?.body === 'string' ? JSON.parse(ev.init.body) : undefined;
    if (method !== 'GET') calls.push({ method, path: decodeURIComponent(url.pathname), body });
    else if (/^\/api\/(wakeup|ingest|knowledge\/search)$/.test(url.pathname))
      gets.push({ method, path: url.pathname, query: decodeURIComponent(url.search) });
    const reply = (data: unknown, code = 200) => ({
      value: { status: code, ok: code < 400, headers: {}, text: JSON.stringify(data) },
    });
    if (world.isHung) return new Promise<never>(() => {});
    if (world.isDown) return reply({ error: 'connection refused' }, 502);
    const p = url.pathname;
    if (world.old)
      return p === '/health'
        ? reply({ status: 'ok', version: world.old })
        : reply({ error: 'Not found' }, 404);
    const row = (x: Entry) => ({
      path: x.path,
      title: x.title,
      tags: x.tags,
      updated: x.updated,
      category: x.path.split('/')[0],
      evergreen: x.evergreen === true,
      maturity: x.maturity ?? 'candidate',
      access_count: x.access_count ?? 0,
    });
    if (p === '/api/overview') {
      // As the server counts: the curated entries by folder, the snapshots apart.
      const categories: Record<string, number> = {};
      let snapshots = 0;
      for (const x of world.entries) {
        const c = x.path.includes('/') ? x.path.split('/')[0]! : 'other';
        if (c === 'sessions') snapshots += 1;
        else categories[c] = (categories[c] ?? 0) + 1;
      }
      return reply({
        version: '2.0.0',
        entries: world.entries.length - snapshots,
        snapshots,
        categories,
        sessions: (world.sessions ?? []).length,
        vectors: 120,
        provider: 'local',
        memory_dir: world.memoryDir ?? 'C:/Users/me/agent-knowledge',
        has_git: world.hasGit ?? true,
        events: world.events ?? [],
      });
    }
    if (p === '/api/knowledge' && method === 'GET') {
      const c = url.searchParams.get('category');
      return reply(world.entries.filter((x) => !c || x.path.startsWith(`${c}/`)).map(row));
    }
    if (p === '/api/knowledge/search') {
      if (world.warming) {
        world.warming -= 1;
        return reply({ error: 'warming up' }, 503);
      }
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      return reply(
        world.entries
          .filter((x) => `${x.title} ${x.body} ${x.tags.join(' ')}`.toLowerCase().includes(q))
          .map((x) => ({ entry: row(x), score: 1, excerpt: `…${x.title} excerpt…` })),
      );
    }
    if (p === '/api/events' && method === 'POST') {
      const evt = { id: (world.events?.at(-1)?.id ?? 0) + 1, ...body, ts: 0 };
      world.events = [...(world.events ?? []), evt];
      return reply({ id: evt.id, ts: 0 }, 201);
    }
    if (p === '/api/knowledge/sync' && method === 'POST')
      return reply(
        world.sync ?? {
          pull: { success: true, message: 'up to date' },
          push: { success: true, message: 'pushed' },
        },
      );
    const k = /^\/api\/knowledge\/([^/]+)(\/links)?$/.exec(p);
    if (k) {
      const path = decodeURIComponent(k[1]!);
      const x = world.entries.find((y) => y.path === path);
      if (!x) return reply({ error: `File not found: ${path}` }, 404);
      // As the server answers: each edge with the title of the entry at the other end.
      if (k[2])
        return reply(
          (world.edges ?? [])
            .filter((d) => d.source === path || d.target === path)
            .map((d) => ({
              ...d,
              title:
                world.entries.find((y) => y.path === (d.source === path ? d.target : d.source))
                  ?.title ?? null,
              missing: !world.entries.some(
                (y) => y.path === (d.source === path ? d.target : d.source),
              ),
            })),
        );
      if (method === 'DELETE') {
        world.entries = world.entries.filter((y) => y !== x);
        return reply({
          deleted: true,
          git: world.pushFails
            ? { success: false, message: world.pushFails }
            : { success: true, message: 'pushed' },
        });
      }
      const of = /^session:\s*(.+)$/m.exec(x.body)?.[1]?.trim();
      return reply({
        entry: { ...row(x), author: x.author },
        ...(of
          ? { session_on_machine: (world.sessions ?? []).some((s) => s.sessionId === of) }
          : {}),
        content: x.body.startsWith('---') ? x.body : `---\ntitle: ${x.title}\n---\n${x.body}`,
        maturity: x.maturity ?? 'candidate',
        access_count: x.access_count ?? 0,
        last_accessed: x.access_count ? '2026-10-22T08:00:00.000Z' : null,
      });
    }
    if (p === '/api/sessions') {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const all = world.sessions ?? [];
      return reply({
        sessions: all.slice(offset, offset + limit).map((s) => ({
          ...s,
          name: s.project,
          userMessageCount: s.prompts ?? 1,
        })),
        total: all.length,
      });
    }
    if (p === '/api/sessions/search') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      return reply(
        (world.sessions ?? [])
          .filter((s) => s.preview.toLowerCase().includes(q))
          .map((s) => ({
            source: 'session',
            id: s.sessionId,
            project: s.project,
            name: s.project,
            role: 'user',
            timestamp: s.startTime,
            excerpt: s.preview,
            score: 1,
          })),
      );
    }
    const sm = /^\/api\/sessions\/([^/]+)\/summary$/.exec(p);
    if (sm) {
      const s = (world.sessions ?? []).find((x) => x.sessionId === decodeURIComponent(sm[1]!));
      if (!s) return reply({ error: 'Session not found' }, 404);
      return reply({
        meta: {
          startTime: s.startTime,
          endTime: s.endTime,
          cwd: s.cwd,
          branch: s.branch,
          messageCount: s.messageCount,
          userMessageCount: s.prompts ?? 1,
          preview: s.preview,
        },
        topicCount: s.topics.length,
        topics: s.topics.map((content) => ({ timestamp: null, content })),
        toolsUsed: ['Read', 'Edit'],
        filesModified: s.files,
        gitCommits: [],
        errorPatterns: s.errors,
        urlsAccessed: [],
        packagesChanged: [],
      });
    }
    if (p === '/api/wakeup') {
      const id = world.identity ?? { onboarding: 'declined' };
      return reply({
        onboarding: id.onboarding,
        memory_dir: world.memoryDir ?? 'C:/Users/me/agent-knowledge',
        sections: [{ name: 'identity', content: id.content ?? '', empty: !id.content }],
      });
    }
    if (p === '/api/ingest') return reply(world.ingest ?? { state: 'none' });
    const snap = /^\/api\/sessions\/([^/]+)\/snapshot$/.exec(p);
    if (snap && method === 'POST' && world.snapshot) {
      // As the server does: the snapshot is a live event too.
      const kind = body?.event === 'end' ? 'session-end' : 'compact';
      world.events = [
        ...(world.events ?? []).filter((x) => x.id !== 7),
        { id: 7, kind, message: 'demo · 2026-11-13 · fix the sync', ts: 0 },
      ];
    }
    if (snap && method === 'POST')
      return reply({
        path: world.snapshot ?? null,
        title: world.snapshot ? 'demo · 2026-11-13 · fix the sync' : null,
        prompts: 3,
        messages: 12,
        tools: 2,
        event: 7,
      });
    if (p === '/api/analysis') {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 30);
      return reply(
        world.analysis
          ? {
              hubs: [],
              sparse: Array.from({ length: world.analysis.total }, (_, i) => ({
                path: `notes/n${i}.md`,
                title: `note ${i}`,
                degree: 0,
              })).slice(offset, offset + limit),
              sparse_total: world.analysis.total,
              offset,
            }
          : {
              hubs: [{ path: 'projects/agent-tasks.md', title: 'agent-tasks 2.0', degree: 3 }],
              sparse: [{ path: 'people/mathias.md', title: 'Mathias', degree: 0 }],
            },
      );
    }

    return reply({ error: 'Not found' }, 404);
  });
  on('command.register', (_$, ev) => ({ value: { command: ev.name } }));
  on('ui.status', (_$, ev) => (status.push(ev.text), { value: undefined }));
  on('ui.toast', (_$, ev) => (toasts.push(ev.text), { value: undefined }));
  on('ui.open', (_$, ev) => (opens.push({ ...ev }), { value: placed.value }) as never);
  on('ui.panes', () => ({ value: panes.value }) as never);
  on('ui.render', ($, ev) => $.ui.resolve(ev).Box({}));
  on('prompt.context', (_$, ev) => ({ blocks: ev.blocks }));
  on('ui.log', (_$, ev) => (logs.push(ev.text), { value: undefined }));
  on('session.id', () => ({ value: 'sess-1' }));
  on('session.cwd', () => ({ value: 'C:/work/demo' }));
  on('session.end', (_$, ev) => ({ sessionId: ev.sessionId }));

  return { calls, gets, logs, toasts, status, opens, placed, panes, clock };
}

const RUN = {
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 134 },
} as const;
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const;
type Engine = Parameters<TestBody>[0];
type Surface = (typeof SURFACES)[number];

function mount<S extends Surface = 'terminal'>(
  $: Engine,
  surface: S = 'terminal' as S,
  columns = 58,
) {
  return $.ui.mount({
    plugin: 'agent-knowledge',
    surface,
    component: 'Pane',
    props: {
      title: 'agent-knowledge',
      isFocused: true,
      bodyColumns: columns,
      placement: 'dock',
      scroll: { bodyRows: 30 },
      view: {},
    } as never,
    requestId: 'agent-knowledge',
  });
}

type Mounted = Awaited<ReturnType<typeof mount<'terminal'>>>;

/** The one text field drawn (Find on Browse, the Search field): its key carries `rev`. */
async function fieldKey(ui: Mounted): Promise<string> {
  const field = (await ui.find({ type: 'Input' })) as { props: { key: string } } | undefined;
  if (!field) throw new Error('no text field drawn');
  return field.props.key;
}

/** The `rev` the drawn text field's key carries: search hits are keyed with it. */
const revOf = async (ui: Mounted) => Number((await fieldKey(ui)).split(':')[1]);

async function start($: Engine, args = '') {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  return $.command.run({ command: 'knowledge', args, ...RUN });
}

test('/knowledge opens a plain sidebar on Browse, newest first, on every surface', async ($, on) => {
  const s = server(on, { entries: ENTRIES(), sessions: SESSIONS() });
  const out = await start($);
  // The reply goes to the model too: nothing is wrong, so it says nothing.
  expect(out.text).toBeUndefined();
  expect(s.status.at(-1)).toBe('4 entries · 2 sessions');
  expect(s.opens).toEqual([expect.objectContaining({ id: 'agent-knowledge', focus: true })]);
  expect(s.opens[0]).not.toHaveProperty('closeOnEscape');
  for (const surface of SURFACES) {
    const ui = await mount($, surface);
    expect(await ui.find({ key: 'open:all:projects/agent-tasks.md' })).toMatchObject({
      props: { autoFocus: true },
    });
    expect(await ui.find({ key: 'cat:projects' })).toBeDefined();
    expect(await ui.find({ key: 'cat:sessions' })).toBeUndefined();
    await ui.unmount();
  }
  const ui = await mount($);
  // A row: category, evergreen, maturity, how long ago, tags (a narrow row cuts the tags first).
  expect(
    await ui.find({ type: 'Text', text: /projects · established · \d+d · #release · #pane/ }),
  ).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /workflows · evergreen/ })).toBeDefined();
});

test('/knowledge says why when the pane is not placed', async ($, on) => {
  const s = server(on, { entries: ENTRIES() });
  s.placed.value = { isPlaced: false, reason: 'below 110 columns' };
  const out = await start($);
  expect(out.text).toContain('pane not shown: below 110 columns');
});

test('a category narrows the list under keys of its own; Find narrows it by title, path or tag', async ($, on) => {
  server(on, { entries: ENTRIES() });
  await start($);
  const ui = await mount($);
  await ui.press({ key: 'cat:workflows' });
  expect(await ui.find({ key: 'open:workflows:workflows/release.md' })).toMatchObject({
    props: { autoFocus: true },
  });
  expect(await ui.find({ key: 'open:all:projects/agent-tasks.md' })).toBeUndefined();
  expect(await ui.find({ type: 'Text', text: /^Workflows$/ })).toBeDefined();
  await ui.press({ key: 'cat:all' });
  await ui.input({ key: await fieldKey(ui), text: 'release' });
  expect(await ui.find({ key: 'open:all:workflows/release.md' })).toBeDefined();
  expect(await ui.find({ key: 'open:all:projects/agent-tasks.md' })).toBeDefined(); // tag release
  expect(await ui.find({ key: 'open:all:people/mathias.md' })).toBeUndefined();
  expect(await ui.find({ type: 'Text', text: /#release/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /^2 matches$/ })).toBeDefined();
  await ui.input({ key: await fieldKey(ui), text: 'people/' });
  expect(await ui.find({ key: 'open:all:people/mathias.md' })).toMatchObject({
    props: { autoFocus: true },
  });
  await ui.input({ key: await fieldKey(ui), text: 'nothing like this' });
  expect(await ui.find({ type: 'Text', text: /No entry matches/ })).toBeDefined();
  expect(await ui.find({ key: 'clear-filter' })).toMatchObject({ props: { autoFocus: true } });
  await ui.press({ key: 'clear-filter' });
  expect(await ui.find({ key: 'open:all:people/mathias.md' })).toBeDefined();
  expect(await ui.find({ key: 'clear-filter' })).toBeUndefined();
});

test('a long list comes a page at a time', async ($, on) => {
  const many = Array.from({ length: 30 }, (_, i) =>
    e(`notes/n${String(i).padStart(2, '0')}.md`, `Note ${i}`, {
      updated: `2026-09-${String(i + 1).padStart(2, '0')}`,
    }),
  );
  server(on, { entries: many });
  await start($);
  const ui = await mount($);
  expect(await ui.find({ key: 'open:all:notes/n29.md' })).toBeDefined(); // newest first
  expect(await ui.find({ key: 'open:all:notes/n04.md' })).toBeUndefined();
  expect(await ui.find({ key: 'more:25' })).toMatchObject({
    props: { label: '▸ 5 more', dimColor: true },
  });
  await ui.press({ key: 'more:25' });
  expect(await ui.find({ key: 'open:all:notes/n00.md' })).toBeDefined();
  expect(await ui.find({ key: 'more:30' })).toBeUndefined();
});

test('an entry: its facts, links both ways, the body as Markdown; links walk and back returns', async ($, on) => {
  const sv = server(on, {
    entries: ENTRIES(),
    edges: [
      {
        source: 'projects/agent-tasks.md',
        target: 'decisions/rest-only.md',
        rel_type: 'depends_on',
        origin: 'manual',
      },
      {
        source: 'workflows/release.md',
        target: 'projects/agent-tasks.md',
        rel_type: 'related_to',
        origin: 'auto-link',
      },
    ],
  });
  await start($);
  const ui = await mount($);
  await ui.press({ key: 'open:all:projects/agent-tasks.md' });
  expect(await ui.find({ key: 'back' })).toMatchObject({
    props: { label: '‹ Browse', autoFocus: true },
  });
  expect(await ui.find({ type: 'Text', text: /^agent-tasks 2\.0$/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: 'projects/agent-tasks.md' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /4 reads/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: 'release, pane' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: 'claude-code' })).toBeDefined();
  expect(await ui.find({ type: 'Markdown' })).toMatchObject({
    props: { text: 'Some text.' }, // no frontmatter, no heading that repeats the title
  });
  const out = await ui.find({ key: 'link:projects/agent-tasks.md:out:decisions/rest-only.md' });
  expect(out).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /→ depends on/ })).toBeDefined();
  // An incoming link reads with the other entry first: `← release ritual · related to this`.
  expect(await ui.find({ type: 'Text', text: /related to this/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /auto-link/ })).toBeDefined();
  await ui.press({ key: 'link:projects/agent-tasks.md:out:decisions/rest-only.md' });
  expect(await ui.find({ key: 'back' })).toMatchObject({ props: { label: '‹ agent-tasks 2.0' } });
  expect(
    await ui.find({ key: 'link:decisions/rest-only.md:in:projects/agent-tasks.md' }),
  ).toBeDefined();
  await sv.clock.advance(500);
  await ui.press({ key: 'back' });
  expect(await ui.find({ type: 'Text', text: /^agent-tasks 2\.0$/ })).toBeDefined();
  await sv.clock.advance(500);
  await ui.press({ key: 'back' });
  expect(await ui.find({ key: 'open:all:projects/agent-tasks.md' })).toBeDefined();
});

test('links and the back label carry titles from the server, not from the Browse list', async ($, on) => {
  server(on, {
    entries: ENTRIES(),
    edges: [
      {
        source: 'projects/agent-tasks.md',
        target: 'decisions/rest-only.md',
        rel_type: 'depends_on',
        origin: 'manual',
      },
    ],
  });
  await start($);
  // Opened by the command first: no Browse list was ever loaded.
  await $.command.run({ command: 'knowledge', args: 'projects/agent-tasks', ...RUN });
  const ui = await mount($);
  expect(
    await ui.find({ key: 'link:projects/agent-tasks.md:out:decisions/rest-only.md' }),
  ).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /REST only, no WebSocket/ })).toBeDefined();
  await ui.press({ key: 'link:projects/agent-tasks.md:out:decisions/rest-only.md' });
  expect(await ui.find({ key: 'back' })).toMatchObject({ props: { label: '‹ agent-tasks 2.0' } });
});

test('a long body folds; the toggle names its state', async ($, on) => {
  const body = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
  server(on, { entries: [e('notes/long.md', 'Long one', { body })] });
  await start($, 'notes/long');
  const ui = await mount($);
  expect(await ui.find({ key: 'body:shut' })).toMatchObject({
    props: { label: '▸ Show all 60 lines' },
  });
  await ui.press({ key: 'body:shut' });
  expect(await ui.find({ key: 'body:open' })).toMatchObject({ props: { label: '▾ Show less' } });
});

test('delete asks first, saying what it does; Keep it keeps it; Delete removes and says so', async ($, on) => {
  const world: World = { entries: ENTRIES(), hasGit: false };
  const s = server(on, world);
  await start($, 'people/mathias.md');
  const ui = await mount($);
  await ui.press({ key: 'ask-delete' });
  expect(
    await ui.find({
      type: 'Text',
      text: 'Delete people/mathias.md? The file goes from this machine for good: there is no undo.',
    }),
  ).toBeDefined();
  // The safe answer first, with the ring; the other names what it deletes.
  expect(await ui.find({ key: 'confirm-no' })).toMatchObject({
    props: { label: 'Keep it', autoFocus: true },
  });
  expect(await ui.find({ key: 'confirm-yes' })).toMatchObject({
    props: { label: 'Delete people/mathias.md' },
  });
  await ui.press({ key: 'confirm-no' });
  expect(await ui.find({ key: 'confirm-yes' })).toBeUndefined();
  expect(s.calls).toEqual([]);
  await ui.press({ key: 'ask-delete' });
  await s.clock.advance(500); // past the press guard
  await ui.press({ key: 'confirm-yes' });
  expect(s.calls).toEqual([{ method: 'DELETE', path: '/api/knowledge/people/mathias.md' }]);
  expect(await ui.find({ type: 'Text', text: '✓ deleted people/mathias.md' })).toBeDefined();
  expect(await ui.find({ key: 'open:all:people/mathias.md' })).toBeUndefined();
  expect(world.entries).toHaveLength(3);
});

test('a delete the remote refused is said with it', async ($, on) => {
  const sv = server(on, { entries: ENTRIES(), pushFails: 'rejected\nhint: pull first' });
  await start($, 'people/mathias.md');
  const ui = await mount($);
  await ui.press({ key: 'ask-delete' });
  await sv.clock.advance(500); // past the press guard
  await ui.press({ key: 'confirm-yes' });
  expect(
    await ui.find({ type: 'Text', text: '! deleted people/mathias.md, not pushed: rejected' }),
  ).toBeDefined();
});

test('/knowledge <words> searches entries and sessions; a hit opens', async ($, on) => {
  const sv = server(on, { entries: ENTRIES(), sessions: SESSIONS() });
  const out = await start($, 'pane');
  expect(out.text).toBeUndefined();
  const ui = await mount($);
  expect(await ui.find({ type: 'Text', text: /^Entries$/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /^In past sessions$/ })).toBeDefined();
  expect(await ui.find({ key: 'tab:search' })).toBeDefined();
  const rev = await revOf(ui);
  expect(await ui.find({ key: `hit:${rev}:e:projects/agent-tasks.md` })).toMatchObject({
    props: { autoFocus: true },
  });
  expect(await ui.find({ type: 'Text', text: /…agent-tasks 2\.0 excerpt…/ })).toBeDefined();
  await ui.press({ key: `hit:${rev}:e:projects/agent-tasks.md` });
  expect(await ui.find({ key: 'back' })).toMatchObject({ props: { label: '‹ Search' } });
  await sv.clock.advance(500);
  await ui.press({ key: 'back' });
  await ui.press({ key: `hit:${rev}:s:s-1:1` });
  expect(await ui.find({ type: 'Text', text: /What was asked/ })).toBeDefined();
});

test('a search with no hit says so; the field keeps the words', async ($, on) => {
  server(on, { entries: ENTRIES(), sessions: SESSIONS() });
  await start($);
  const ui = await mount($);
  await ui.press({ key: 'tab:search' });
  const field = await fieldKey(ui);
  // The view's own start is a button: the ring enters the field only when the person asks
  // (the Search tab moves it there itself; the e2e asserts that).
  expect(await ui.find({ key: field })).not.toMatchObject({ props: { autoFocus: true } });
  expect(await ui.find({ key: 'tab:search' })).toMatchObject({ props: { autoFocus: true } });
  expect(await ui.find({ type: 'Text', text: /Finds words, and close spellings/ })).toBeDefined();
  await ui.input({ key: field, text: 'zzzz' });
  expect(await ui.find({ type: 'Text', text: 'Nothing found for "zzzz".' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /no hits for "zzzz"/ })).toBeUndefined();
  expect(await ui.find({ type: 'Text', text: /Nothing found for "zzzz"/ })).toBeDefined();
  expect(await ui.find({ key: await fieldKey(ui) })).toMatchObject({ props: { value: 'zzzz' } });
  expect(await fieldKey(ui)).not.toBe(field); // a fresh field: the ring waits for it
});

test('a command search with no hit lands on a button, never in the field', async ($, on) => {
  server(on, { entries: ENTRIES(), sessions: SESSIONS() });
  await start($);
  const out = await $.command.run({ command: 'knowledge', args: 'zzzz', ...RUN });
  expect(out.text).toContain('nothing found for "zzzz"');
  const ui = await mount($);
  expect(await ui.find({ key: 'tab:search' })).toMatchObject({ props: { autoFocus: true } });
  expect(await ui.find({ key: await fieldKey(ui) })).not.toMatchObject({
    props: { autoFocus: true },
  });
});

test('Sessions: newest first, a summary with what was asked, files and errors', async ($, on) => {
  const sv = server(on, { entries: ENTRIES(), sessions: SESSIONS() });
  await start($);
  const ui = await mount($);
  await ui.press({ key: 'tab:sessions' });
  expect(await ui.find({ key: 'sess:s-1' })).toMatchObject({ props: { autoFocus: true } });
  expect(await ui.find({ type: 'Text', text: /1h 30m · main/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /make the board a pane/ })).toBeDefined();
  await ui.press({ key: 'sess:s-1' });
  expect(await ui.find({ key: 'back' })).toMatchObject({ props: { label: '‹ Sessions' } });
  expect(await ui.find({ type: 'Text', text: 'C:/work/agent-tasks' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: 'test it in the real CLI' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: 'plugin/hooks/view.tsx' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: 'TypeError: x is undefined' })).toMatchObject({
    props: { color: 'error' },
  });
  expect(await ui.find({ type: 'Text', text: 'Read, Edit' })).toBeDefined();
  // The heading counts the tools, not the line they are listed on.
  expect(await ui.find({ type: 'Text', text: ' 2' })).toBeDefined();
  await sv.clock.advance(500);
  await ui.press({ key: 'back' });
  await ui.press({ key: 'sess:s-2' });
  expect(await ui.find({ type: 'Text', text: /Nothing to summarise/ })).toBeDefined();
});

test('Health: counts, search index, folder and git; Sync and Analyze', async ($, on) => {
  const world: World = { entries: ENTRIES(), sessions: SESSIONS() };
  const s = server(on, world);
  await start($);
  const ui = await mount($);
  await ui.press({ key: 'tab:health' });
  expect(await ui.find({ key: 'sync' })).not.toMatchObject({ props: { autoFocus: true } });
  expect(await ui.find({ key: 'analyze:first' })).toMatchObject({ props: { autoFocus: true } });
  expect(
    await ui.find({ type: 'Text', text: /words and meaning: 120 vectors \(local\)/ }),
  ).toBeDefined();
  expect(await ui.find({ type: 'Text', text: 'C:/Users/me/agent-knowledge' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /synced with a remote/ })).toBeDefined();
  await s.clock.advance(500); // past the press guard
  await ui.press({ key: 'sync' });
  expect(s.calls.at(-1)).toEqual({ method: 'POST', path: '/api/knowledge/sync' });
  expect(await ui.find({ type: 'Text', text: '✓ synced with the remote' })).toBeDefined();
  world.sync = {
    pull: { success: false, message: 'could not resolve host\nmore' },
    push: { success: true, message: 'pushed' },
  };
  await s.clock.advance(500); // past the press guard
  await ui.press({ key: 'sync' });
  expect(
    await ui.find({ type: 'Text', text: '✗ sync failed: pull: could not resolve host' }),
  ).toBeDefined();
  await ui.press({ key: 'analyze:first' });
  expect(
    await ui.find({ type: 'Text', text: '✓ 1 most linked, 1 with one link or none' }),
  ).toBeDefined();
  expect(await ui.find({ key: 'hub:projects/agent-tasks.md' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: '3 links' })).toBeDefined();
  expect(await ui.find({ key: 'sparse:people/mathias.md' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: 'no links' })).toBeDefined();
  expect(await ui.find({ key: 'analyze:again' })).toBeDefined();
  await ui.press({ key: 'hub:projects/agent-tasks.md' });
  expect(await ui.find({ key: 'back' })).toMatchObject({ props: { label: '‹ Health' } });
});

test('Health without git offers no Sync and says entries stay on this machine', async ($, on) => {
  server(on, { entries: ENTRIES(), hasGit: false });
  await start($);
  const ui = await mount($);
  await ui.press({ key: 'tab:health' });
  expect(await ui.find({ key: 'sync' })).toBeUndefined();
  expect(await ui.find({ key: 'analyze:first' })).toMatchObject({ props: { autoFocus: true } });
  expect(
    await ui.find({ type: 'Text', text: /no remote: entries stay on this machine/ }),
  ).toMatchObject({
    props: { color: 'warning' },
  });
});

test('live events toast once, the news first; the first poll is quiet; Health lists them', async ($, on) => {
  const world: World = {
    entries: ENTRIES(),
    events: [
      { id: 1, kind: 'session-end', message: 'old news', ts: Date.parse('2026-10-22T08:00:00Z') },
    ],
  };
  const s = server(on, world);
  s.panes.value = [{ id: 'agent-knowledge', isPlaced: true }];
  await start($);
  await s.clock.advance(5_000);
  expect(s.toasts).toEqual([]);
  world.events = [
    ...world.events!,
    {
      id: 2,
      kind: 'distill',
      message: '2 entries from s-1',
      ts: Date.parse('2026-10-22T09:00:00Z'),
    },
    { id: 3, kind: 'session-end', message: 's-2 saved', ts: Date.parse('2026-10-22T09:01:00Z') },
  ];
  await s.clock.advance(5_000);
  expect(s.toasts).toEqual(['Session saved: s-2 saved · Distilled: 2 entries from s-1']);
  await s.clock.advance(5_000);
  expect(s.toasts).toHaveLength(1);
  const ui = await mount($);
  await ui.press({ key: 'tab:health' });
  expect(await ui.find({ type: 'Text', text: /Recent activity/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /Session saved: s-2 saved/ })).toBeDefined();
});

test('the status entry follows the counts other sessions change', async ($, on) => {
  const world: World = { entries: ENTRIES() };
  const s = server(on, world);
  await start($);
  expect(s.status.at(-1)).toBe('4 entries · 0 sessions');
  world.entries = [...world.entries, e('notes/new.md', 'New one')];
  await s.clock.advance(30_000); // the pane closed: every 30 s
  expect(s.status.at(-1)).toBe('5 entries · 0 sessions');
});

test('server down: what to do, offline in the status line, a Refresh that says it tried', async ($, on) => {
  const world: World = { entries: ENTRIES(), isDown: true };
  const s = server(on, world);
  const out = await start($);
  expect(out.text).toContain('nothing answers at http://127.0.0.1:3423');
  expect(s.status.at(-1)).toBe('offline');
  const ui = await mount($);
  expect(await ui.find({ type: 'Text', text: /not reachable/ })).toBeDefined();
  // The digits stay the pane's while down: the tabs keep their hotkeys.
  expect(await ui.find({ key: 'tab:sessions' })).toMatchObject({ props: { hotkey: '3' } });
  expect(await ui.find({ key: 'retry' })).toMatchObject({ props: { autoFocus: true } });
  await ui.press({ key: 'retry' });
  expect(
    await ui.find({
      type: 'Text',
      text: /✗ still nothing answers at http:\/\/127\.0\.0\.1:3423 \(\d\d:\d\d:\d\d\)/,
    }),
  ).toBeDefined();
  world.isDown = false;
  await ui.press({ key: 'retry' });
  expect(await ui.find({ key: 'open:all:projects/agent-tasks.md' })).toMatchObject({
    props: { autoFocus: true },
  });
});

test('an agent-knowledge from before the pane on the port is named', async ($, on) => {
  const s = server(on, { entries: ENTRIES(), old: '1.9.8' });
  const out = await start($);
  expect(out.text).toContain('version 1.9.8 holds http://127.0.0.1:3423');
  expect(s.status.at(-1)).toBe('old server 1.9.8 on the port');
  const ui = await mount($);
  expect(
    await ui.find({ type: 'Text', text: /An older agent-knowledge \(1\.9\.8\)/ }),
  ).toBeDefined();
});

test('/knowledge <path> opens the entry; one not there is said, and the list shows', async ($, on) => {
  server(on, { entries: ENTRIES() });
  await start($, 'decisions/rest-only');
  let ui = await mount($);
  expect(await ui.find({ type: 'Text', text: /^REST only, no WebSocket$/ })).toBeDefined();
  // Never read by an agent: no read count and no last-read row.
  expect(await ui.find({ type: 'Text', text: /\d+ reads?/ })).toBeUndefined();
  expect(await ui.find({ type: 'Text', text: 'Last read' })).toBeUndefined();
  await ui.unmount();
  const out = await $.command.run({ command: 'knowledge', args: 'notes/gone.md', ...RUN });
  expect(out.text).toContain('there is no entry notes/gone.md');
  ui = await mount($);
  expect(await ui.find({ key: 'open:all:projects/agent-tasks.md' })).toBeDefined();
});

test('an empty knowledge base says what lands here, and offers the next step', async ($, on) => {
  const sv = server(on, {
    entries: [],
    ingest: { state: 'never', project: 'demo', dir: 'C:/work/demo', files: 12 },
  });
  const filled: string[] = [];
  on('prompt.fill', (_$, ev) => (filled.push(ev.text), { isFilled: true }));
  const ran: string[] = [];
  on('command.run', { command: 'agent-knowledge:knowledge-ingest' }, (_$, ev) => {
    ran.push(ev.args);
    return { text: 'ingesting' };
  });
  const out = await start($);
  expect(out.text).toBeUndefined();
  const ui = await mount($);
  expect(await ui.find({ type: 'Text', text: 'The knowledge base is empty.' })).toBeDefined();
  // The next step: the project's code ingested, put in the prompt for the person to run.
  expect(await ui.find({ key: 'ingest' })).toMatchObject({
    props: { label: 'Ingest demo ›', autoFocus: true },
  });
  await sv.clock.advance(500); // past the press guard
  await ui.press({ key: 'ingest' });
  expect(filled).toEqual(['/knowledge-ingest C:/work/demo']);
  expect(
    await ui.find({
      type: 'Text',
      text: '– /knowledge-ingest is in the prompt: Enter runs it',
    }),
  ).toBeDefined();
  // The prompt has the keys now: the second Enter of the same burst runs the command there,
  // and is held; the command goes back in the prompt for the person to read.
  const enter = () =>
    $.command.run({ command: 'agent-knowledge:knowledge-ingest', args: 'C:/work/demo', ...RUN });
  expect(await enter()).toMatchObject({
    text: 'Not run: that Enter came with the command. Read it, then press Enter.',
  });
  expect(ran).toEqual([]);
  expect(filled).toEqual(['/knowledge-ingest C:/work/demo', '/knowledge-ingest C:/work/demo']);
  // Every Enter of the burst is held, each keeping the window open, and said only once.
  await sv.clock.advance(300);
  expect((await enter()).text).toBeUndefined();
  await sv.clock.advance(300);
  expect((await enter()).text).toBeUndefined();
  expect(ran).toEqual([]);
  expect(filled).toHaveLength(4);
  // Read, then Enter: it runs.
  await sv.clock.advance(500);
  expect(await enter()).toMatchObject({ text: 'ingesting' });
  expect(ran).toEqual(['C:/work/demo']);
});

test('an empty knowledge base with nothing to ingest lands on its tab', async ($, on) => {
  server(on, { entries: [] });
  await start($);
  const ui = await mount($);
  expect(await ui.find({ key: 'ingest' })).toBeUndefined();
  expect(await ui.find({ key: 'tab:browse' })).toMatchObject({ props: { autoFocus: true } });
});

test('the model starts with what the knowledge base holds', async ($, on) => {
  server(on, { entries: ENTRIES(), sessions: SESSIONS() });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  const r = await $.prompt.context({ blocks: [] });
  expect(r.blocks).toEqual([
    {
      name: 'agent-knowledge',
      text: expect.stringMatching(
        /^agent-knowledge holds 4 entries · 2 sessions \(projects 1, people 1, decisions 1, workflows 1\)\. Before saying something is unknown.*knowledge_search.*\/knowledge\.$/,
      ),
    },
  ]);
});

test('widths count terminal columns; parts pack between themselves', () => {
  expect(cols('设计书')).toBe(6);
  expect(cols('ship 🚀')).toBe(7);
  expect(clip('设计书的评审记录', 7)).toBe('设计书…');
  expect(packParts(['4 entries', '2 sessions', 'local'], 22)).toEqual([
    ['4 entries', '2 sessions'],
    ['local'],
  ]);
  expect(packParts(['设计', '实装'], 9)).toEqual([['设计'], ['实装']]);
});

test('times: a bare day is a local day; sessions run for a duration', () => {
  const now = new Date(2026, 9, 23, 12, 0);
  expect(when('2026-10-23', now)).toBe('today');
  expect(when('2026-10-22', now)).toBe('1d ago');
  expect(when('2026-10-21', now)).toBe('2d ago'); // as the row says: 2d
  expect(when('2026-10-21T11:00:00Z', now)).toMatch(/^\d+[hd] ago$/);
  expect(when('2026-10-01', now)).toBe('2026-10-01');
  expect(ago('2026-10-20', now.getTime())).toBe('3d');
  expect(duration('2026-10-22T08:00:00Z', '2026-10-22T09:30:00Z')).toBe('1h 30m');
  expect(duration('2026-10-22T08:00:00Z', '2026-10-22T08:20:00Z')).toBe('20m');
  expect(duration('unknown', 'unknown')).toBe('');
  expect(duration('2026-10-22T08:00:00Z', '2026-10-22T08:00:20Z')).toBe(''); // no 0m
});

test('categories in the knowledge base order, then other folders; one headline for both', () => {
  expect(categoryOrder({ other: 1, notes: 2, projects: 5, sessions: 9, people: 0 })).toEqual([
    'projects',
    'notes',
    'sessions',
    'other',
  ]);
  // The server counts the curated entries (no snapshot among them); the headline says them.
  expect(headline({ entries: 1, sessions: 1 })).toBe('1 entry · 1 session');
  expect(headline({ entries: 2, sessions: 2 })).toBe('2 entries · 2 sessions');
  expect(isField('filter:3')).toBe(true);
  expect(isField('find:0')).toBe(true);
  expect(isField('open:all:x.md')).toBe(false);
});

test('an excerpt is plain text: no Markdown marks, a link keeps its words', () => {
  expect(
    plain('# agent-tasks 2.0\n\nThe board moved into the **/pipeline** pane.\n- REST `3422`'),
  ).toBe('agent-tasks 2.0 The board moved into the /pipeline pane. REST 3422');
  expect(plain('> see [the manual](docs/USER-MANUAL.md) first')).toBe('see the manual first');
});

test('a page or excerpt drops a first heading that repeats the title, and the frontmatter', () => {
  expect(pageBody('---\ntitle: T\n---\n# T\n\nBody.', 'T').trim()).toBe('Body.');
  expect(pageBody('# Other\n\nBody.', 'T')).toBe('# Other\n\nBody.');
  expect(plain(pageBody('# agent-tasks 2.0\nThe board moved', 'agent-tasks 2.0'))).toBe(
    'The board moved',
  );
});

test('without git a delete says nothing of pushing', async ($, on) => {
  const sv = server(on, {
    entries: ENTRIES(),
    hasGit: false,
    pushFails: 'fatal: not a git repository',
  });
  await start($, 'people/mathias.md');
  const ui = await mount($);
  await ui.press({ key: 'ask-delete' });
  await sv.clock.advance(500); // past the press guard
  await ui.press({ key: 'confirm-yes' });
  expect(await ui.find({ type: 'Text', text: '✓ deleted people/mathias.md' })).toBeDefined();
});

test('a folder under the home directory is written from ~', () => {
  expect(homeAsTilde('C:\\Users\\me\\agent-knowledge', 'C:\\Users\\me')).toBe('~\\agent-knowledge');
  expect(homeAsTilde('c:/users/ME/kb', 'C:\\Users\\me')).toBe('~/kb');
  expect(homeAsTilde('/home/me/agent-knowledge', '/home/me/')).toBe('~/agent-knowledge');
  expect(homeAsTilde('/home/meet/kb', '/home/me')).toBe('/home/meet/kb');
  expect(homeAsTilde('/srv/kb', undefined)).toBe('/srv/kb');
});

test('Browse follows entries other sessions write, without a key', async ($, on) => {
  const world: World = { entries: ENTRIES() };
  const s = server(on, world);
  s.panes.value = [{ id: 'agent-knowledge', isPlaced: true }]; // shown: polled every 5 s
  await start($);
  const ui = await mount($);
  expect(await ui.find({ key: 'open:all:notes/new.md' })).toBeUndefined();
  world.entries = [e('notes/new.md', 'New one', { updated: '2026-10-23' }), ...world.entries];
  await s.clock.advance(5_000);
  expect(await ui.find({ key: 'open:all:notes/new.md' })).toBeDefined();
});

test('a filtered list is headed as matches, in the category picked', async ($, on) => {
  server(on, { entries: ENTRIES() });
  await start($);
  const ui = await mount($);
  expect(await ui.find({ type: 'Text', text: 'Every entry' })).toBeDefined();
  await ui.input({ key: await fieldKey(ui), text: 'release' });
  expect(await ui.find({ type: 'Text', text: 'Matches' })).toBeDefined();
  await ui.press({ key: 'cat:workflows' });
  expect(await ui.find({ type: 'Text', text: 'Matches in workflows' })).toBeDefined();
});

test('the delete confirmation says what happens with and without a remote', async ($, on) => {
  server(on, { entries: ENTRIES(), hasGit: true });
  await start($, 'people/mathias.md');
  const ui = await mount($);
  await ui.press({ key: 'ask-delete' });
  expect(await ui.find({ type: 'Text', text: /deletion is pushed to the remote/ })).toBeDefined();
});

test('without a remote the delete confirmation says the file goes from this machine', async ($, on) => {
  server(on, { entries: ENTRIES(), hasGit: false });
  await start($, 'people/mathias.md');
  const ui = await mount($);
  await ui.press({ key: 'ask-delete' });
  expect(await ui.find({ type: 'Text', text: /goes from this machine/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /pushed/ })).toBeUndefined();
});

test('/knowledge <path> says what it opened', async ($, on) => {
  server(on, { entries: ENTRIES() });
  const out = await start($, 'decisions/rest-only');
  expect(out.text).toBeUndefined();
});

// ── The session's lifecycle: context, first prompt, compaction, end ─────────

const contextOf = async ($: Engine) => {
  await $.session.start({ cwd: 'C:/work/demo', surface: 'terminal', isInteractive: true });
  const r = await $.prompt.context({ blocks: [] });
  return r.blocks.find((b) => b.name === 'agent-knowledge')?.text ?? '';
};

const begin = ($: Engine) =>
  $.session.start({ cwd: 'C:/work/demo', surface: 'terminal', isInteractive: true });

test('the context carries who the person is, once they said', async ($, on) => {
  const w = server(on, {
    entries: ENTRIES(),
    identity: { onboarding: 'configured', content: '## L0 — IDENTITY\nMathias, Odoo developer' },
  });
  const text = await contextOf($);
  expect(text).toContain('agent-knowledge holds 4 entries');
  expect(text).toContain(
    '--- Knowledge wakeup (identity only; call `knowledge action=wakeup` for L1 facts) ---\n## L0 — IDENTITY\nMathias, Odoo developer',
  );
  expect(w.gets.find((g) => g.path === '/api/wakeup')?.query).toBe('?sections=identity&budget=200');
});

test('the context asks who the person is while nobody said, in the knowledge base folder', async ($, on) => {
  server(on, { entries: ENTRIES(), identity: { onboarding: 'pending' } });
  const text = await contextOf($);
  expect(text).toContain('--- Identity onboarding (no identity.md yet) ---');
  expect(text).toContain('`C:/Users/me/agent-knowledge/identity.md`');
  expect(text).toContain('`C:/Users/me/agent-knowledge/.identity-declined`');
});

test('a declined identity adds nothing of the person', async ($, on) => {
  server(on, { entries: ENTRIES(), identity: { onboarding: 'declined' } });
  const text = await contextOf($);
  expect(text).not.toContain('Identity onboarding');
  expect(text).not.toContain('Knowledge wakeup');
});

test('AGENT_KNOWLEDGE_AUTOWAKE=0 does not ask the server who the person is', async ($, on) => {
  const w = server(on, {
    entries: ENTRIES(),
    identity: { onboarding: 'pending' },
    env: { AGENT_KNOWLEDGE_AUTOWAKE: '0' },
  });
  expect(await contextOf($)).not.toContain('Identity onboarding');
  expect(w.gets.some((g) => g.path === '/api/wakeup')).toBe(false);
});

test('the context says when the project changed since its ingest', async ($, on) => {
  const w = server(on, {
    entries: ENTRIES(),
    ingest: {
      state: 'stale',
      project: 'demo',
      dir: 'C:/work/demo',
      files: 40,
      changed: 2,
      added: 1,
      removed: 0,
    },
  });
  expect(await contextOf($)).toContain(
    'knowledge-ingest: project "demo" has 3 file changes since the last ingest (2 changed, 1 new). Run `/knowledge-ingest C:/work/demo` to update.',
  );
  expect(w.gets.find((g) => g.path === '/api/ingest')?.query).toBe('?cwd=C:/work/demo');
});

test('a project never ingested is offered the ingest; a current one is not mentioned', async ($, on) => {
  const world: World = {
    entries: ENTRIES(),
    ingest: { state: 'never', project: 'demo', dir: 'C:/work/demo', files: 12 },
  };
  server(on, world);
  expect(await contextOf($)).toContain(
    'knowledge-ingest: project "demo" (12+ source files) has not been ingested yet. Run `/knowledge-ingest C:/work/demo` to bootstrap the knowledge base.',
  );
});

test('a current ingest is not mentioned', async ($, on) => {
  server(on, { entries: ENTRIES(), ingest: { state: 'current', project: 'demo' } });
  expect(await contextOf($)).not.toContain('knowledge-ingest');
});

/** The person typing `text` and pressing Enter. */
const submit = ($: Engine, text: string) =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } });

/** What the prompt carries on to the engine: its text and the context added beside it. */
function submitted(on: On) {
  const seen: { text: string; context?: readonly string[] }[] = [];
  on('prompt.submit', (_$, ev) => {
    seen.push({ text: ev.text, context: ev.context });
    return { text: ev.text };
  });
  return seen;
}

const searches = (w: { gets: Call[] }) => w.gets.filter((g) => g.path === '/api/knowledge/search');

test('the first real prompt carries the matching entries, once per conversation', async ($, on) => {
  const w = server(on, { entries: ENTRIES() });
  const seen = submitted(on);
  await begin($);
  await submit($, 'release ritual');
  await submit($, 'release notes for it');

  expect(seen[0]!.context).toEqual([
    expect.stringMatching(
      /^## Knowledge — top hits for your first prompt\n\n_Injected automatically by agent-knowledge\..*\n\n- \*\*Release ritual\*\* \(`workflows\/release\.md`, score 1\.00\) — …Release ritual excerpt…\n$/s,
    ),
  ]);
  expect(seen[1]!.context).toBeUndefined();
  expect(w.logs).toEqual(['1 entry for this prompt: Release ritual']);
  expect(searches(w)).toEqual([
    expect.objectContaining({
      query: '?q=release ritual&max_results=2&mmr=true&skip=sessions&prompt=true',
    }),
  ]);
});

test('short prompts, commands and shell lines leave the injection for the next prompt', async ($, on) => {
  const w = server(on, { entries: ENTRIES() });
  const seen = submitted(on);
  await begin($);
  for (const text of ['hi there', '/clear the board please', '!git status --short'])
    await submit($, text);
  await submit($, 'release ritual');

  expect(seen.map((x) => x.context?.length ?? 0)).toEqual([0, 0, 0, 1]);
  expect(searches(w)).toHaveLength(1);
});

test('a prompt with no hit adds nothing and spends the injection', async ($, on) => {
  const w = server(on, { entries: ENTRIES() });
  const seen = submitted(on);
  await begin($);
  await submit($, 'something nobody wrote down');
  await submit($, 'the release ritual then');
  expect(seen.map((x) => x.context)).toEqual([undefined, undefined]);
  expect(searches(w)).toHaveLength(1);
  expect(w.logs).toEqual([]);
});

test('AGENT_KNOWLEDGE_FIRSTPROMPT_INJECT=off never searches', async ($, on) => {
  const w = server(on, { entries: ENTRIES(), env: { AGENT_KNOWLEDGE_FIRSTPROMPT_INJECT: 'off' } });
  const seen = submitted(on);
  await begin($);
  await submit($, 'release ritual');
  expect(seen[0]!.context).toBeUndefined();
  expect(searches(w)).toHaveLength(0);
});

test('the hits keep to AGENT_KNOWLEDGE_FIRSTPROMPT_BUDGET and _MAX_HITS', async ($, on) => {
  const many = ENTRIES().map((x) => ({ ...x, body: `${x.body} shared words` }));
  const w = server(on, {
    entries: many,
    env: { AGENT_KNOWLEDGE_FIRSTPROMPT_MAX_HITS: '1', AGENT_KNOWLEDGE_FIRSTPROMPT_BUDGET: '100' },
  });
  const seen = submitted(on);
  await begin($);
  await submit($, 'shared words');
  const context = seen[0]!.context?.[0] ?? '';
  const lines = context.split('\n').filter((l) => l.startsWith('- **'));
  expect(lines).toHaveLength(1);
  expect(context.length).toBeLessThanOrEqual(400);
  expect(searches(w)[0]?.query).toContain('max_results=1');
});

test('the server down: the prompt goes on bare and the injection waits for it', async ($, on) => {
  const world: World = { entries: ENTRIES(), isDown: true };
  const w = server(on, world);
  const seen = submitted(on);
  await begin($);
  await submit($, 'release ritual');
  expect(seen[0]!.context).toBeUndefined();
  world.isDown = false;
  await submit($, 'release ritual');
  expect(seen[1]!.context).toHaveLength(1);
  expect(w.logs).toHaveLength(1);
});

/** The person's `/compact`, with what they typed after it. */
const compact = ($: Engine, instructions?: string) =>
  $.session.compact({
    trigger: 'manual',
    messages: [{ role: 'user', text: 'the release ritual, written down', toolUses: [] }],
    ...(instructions === undefined ? {} : { instructions }),
  });

/** What the compaction beneath was asked to keep. */
function compacted(on: On) {
  const seen: { instructions?: string }[] = [];
  on('session.compact', (_$, ev) => {
    seen.push({ instructions: ev.instructions });
    return { skip: 'seen by the test' };
  });
  return seen;
}

const SNAP = 'sessions/demo/2026-11-13-sess-1.md';

test('a compaction takes the snapshot and asks the summary to keep what is still to be saved', async ($, on) => {
  const w = server(on, { entries: ENTRIES(), snapshot: SNAP });
  const seen = compacted(on);
  await begin($);
  await compact($, 'focus on the API');

  expect(seen[0]!.instructions).toMatch(
    /^focus on the API\n\nKeep, under a heading "Knowledge to save"/,
  );
  expect(w.calls).toContainEqual({
    method: 'POST',
    path: '/api/sessions/sess-1/snapshot',
    body: { event: 'compact', cwd: 'C:/work/demo' },
  });
  // A toast: a transcript line would land in the middle of the turn.
  expect(w.toasts).toContain('Session saved at compaction: demo · 2026-11-13 · fix the sync');
  expect(w.logs).toEqual([]);
});

test('AGENT_KNOWLEDGE_PRECOMPACT_NUDGE=0 keeps the summary as asked and still takes the snapshot', async ($, on) => {
  const w = server(on, { entries: ENTRIES(), env: { AGENT_KNOWLEDGE_PRECOMPACT_NUDGE: '0' } });
  const seen = compacted(on);
  await begin($);
  await compact($);
  expect(seen[0]!.instructions).toBeUndefined();
  expect(w.calls.some((c) => c.path.endsWith('/snapshot'))).toBe(true);
});

test('AGENT_KNOWLEDGE_PRECOMPACT_NUDGE=off: no snapshot, the summary as asked', async ($, on) => {
  const w = server(on, { entries: ENTRIES(), env: { AGENT_KNOWLEDGE_PRECOMPACT_NUDGE: 'off' } });
  const seen = compacted(on);
  await begin($);
  await compact($, 'as typed');
  expect(seen[0]!.instructions).toBe('as typed');
  expect(w.calls.some((c) => c.path.endsWith('/snapshot'))).toBe(false);
});

test('the session ending takes its last snapshot; after a /clear the line says where it went', async ($, on) => {
  const w = server(on, { entries: ENTRIES(), snapshot: SNAP });
  await begin($);
  const resume = { id: 'old-sess' } as never;
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'old-sess', resume });
  expect(w.calls).toContainEqual({
    method: 'POST',
    path: '/api/sessions/old-sess/snapshot',
    body: { event: 'end', cwd: 'C:/work/demo' },
  });
  expect(w.toasts).toEqual([]);
  await $.session.end({ reason: 'clear', sessionId: 'old-sess', resume });
  // Not from the conversation ending (it is not shown), nor as a toast in the one /clear
  // starts (its screen is new, a toast is not drawn): that one's first line.
  expect(w.toasts).toEqual([]);
  await begin($);
  await w.clock.advance(5_000);
  expect(w.toasts).toEqual([]);
  expect(w.logs).toContain('Session saved: demo · 2026-11-13 · fix the sync');
});

test('a session with nothing asked writes nothing and says nothing', async ($, on) => {
  const w = server(on, { entries: ENTRIES(), snapshot: null });
  await begin($);
  await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } as never });
  expect(w.logs).toEqual([]);
});

test('a background task notice or a peer message is no one asking: no search', async ($, on) => {
  const w = server(on, { entries: ENTRIES() });
  submitted(on);
  await begin($);
  for (const kind of ['task-notification', 'peer'] as const)
    await $.prompt.submit({
      text: 'release ritual',
      wait: false,
      origin: { kind } as never,
    });
  expect(searches(w)).toHaveLength(0);
});

// ── A server that takes the connection and never answers ────────────────────

/** Settles `p` while the clock runs on: what waits on the mock clock gets its time. */
async function withClock<T>(clock: { advance: (ms: number) => Promise<void> }, p: Promise<T>) {
  let done = false;
  void p.finally(() => (done = true));
  for (let i = 0; i < 20 && !done; i++) await clock.advance(1_000);
  return p;
}

test('a stuck server: the first prompt goes on bare within 2 s, and the next one tries again', async ($, on) => {
  const world: World = { entries: ENTRIES(), isHung: true };
  const w = server(on, world);
  const seen = submitted(on);
  await begin($);
  const t0 = w.clock.now();
  await withClock(w.clock, submit($, 'release ritual'));
  expect(w.clock.now() - t0).toBeLessThanOrEqual(2_000);
  expect(seen[0]!.context).toBeUndefined();
  world.isHung = false;
  await submit($, 'release ritual');
  expect(seen[1]!.context).toHaveLength(1);
});

test('a stuck server: the first message carries no block of ours, within 2 s', async ($, on) => {
  const w = server(on, { entries: ENTRIES(), isHung: true });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  const t0 = w.clock.now();
  const r = await withClock(w.clock, $.prompt.context({ blocks: [] }));
  expect(w.clock.now() - t0).toBeLessThanOrEqual(2_000);
  expect(r.blocks).toEqual([]);
});

test('a stuck server: the pane says nothing answers, the status line says offline', async ($, on) => {
  const w = server(on, { entries: ENTRIES(), isHung: true });
  const r = await withClock(w.clock, start($));
  expect(r.text).toMatch(/nothing answers at http:\/\/127\.0\.0\.1:3423/);
  expect(w.status.at(-1)).toBe('offline');
});

test('a stuck server: a compaction and the end go on without the snapshot', async ($, on) => {
  const w = server(on, { entries: ENTRIES(), isHung: true, snapshot: SNAP });
  const seen = compacted(on);
  await begin($);
  await withClock(w.clock, compact($, 'as typed'));
  expect(seen[0]!.instructions).toMatch(/^as typed\n\nKeep, under a heading/);
  await withClock(
    w.clock,
    $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } as never }),
  );
  expect(w.logs).toEqual([]);
});

test("the onboarding names its files with the folder's own separator", async ($, on) => {
  server(on, {
    entries: ENTRIES(),
    identity: { onboarding: 'pending' },
    memoryDir: 'C:\\Users\\me\\agent-knowledge',
    env: { USERPROFILE: 'C:\\Users\\me' },
  });
  const text = await contextOf($);
  // The folder as it is on disk, not the ~ form the pane shows: the model writes there.
  expect(text).toContain('`C:\\Users\\me\\agent-knowledge\\identity.md`');
  expect(text).toContain('`C:\\Users\\me\\agent-knowledge\\.identity-declined`');
});

// ── UX review round 1 ───────────────────────────────────────────────────────

/** Whether the tabs answer their hotkeys: not while the ring is in a text field. */
const hotkeys = async (ui: Mounted) =>
  ((await ui.find({ key: 'tab:browse' })) as unknown as { props: { hotkey?: string } }).props
    .hotkey;

test('a link to an entry that is gone is drawn, not pressed', async ($, on) => {
  server(on, {
    entries: ENTRIES(),
    edges: [
      {
        source: 'projects/agent-tasks.md',
        target: 'notes/ghost.md',
        rel_type: 'related_to',
        origin: 'auto-link',
      },
    ],
  });
  await start($, 'projects/agent-tasks.md');
  const ui = await mount($);
  expect(await ui.find({ type: 'Text', text: 'ghost · auto-link · gone' })).toBeDefined();
  // The heading counts the rows drawn, and says how many of them lead nowhere.
  expect(await ui.find({ type: 'Text', text: ' 1, 1 gone' })).toBeDefined();
  expect(await ui.find({ key: 'link:projects/agent-tasks.md:out:notes/ghost.md' })).toBeUndefined();
});

test('an entry deleted elsewhere, opened from a page: said there, the page and its trail stay', async ($, on) => {
  const world: World = {
    entries: ENTRIES(),
    edges: [
      {
        source: 'projects/agent-tasks.md',
        target: 'decisions/rest-only.md',
        rel_type: 'depends_on',
        origin: 'manual',
      },
    ],
  };
  server(on, world);
  await start($, 'projects/agent-tasks.md');
  const ui = await mount($);
  const link = (await ui.find({ type: 'Button', text: /REST only/ })) as unknown as {
    props: { key: string };
  };
  world.entries = world.entries.filter((x) => x.path !== 'decisions/rest-only.md');
  await ui.press({ key: link.props.key });
  expect(
    await ui.find({ type: 'Text', text: /! decisions\/rest-only\.md is no longer there/ }),
  ).toBeDefined();
  expect(await ui.find({ type: 'Text', text: 'projects/agent-tasks.md' })).toBeDefined();
  expect(await ui.find({ key: 'back' })).toMatchObject({ props: { label: '‹ Browse' } });
});

test('a deleted entry leaves the search hits it was in', async ($, on) => {
  const sv = server(on, { entries: ENTRIES(), sessions: SESSIONS() });
  await start($, 'release');
  const ui = await mount($);
  const rev = await revOf(ui);
  await ui.press({ key: `hit:${rev}:e:workflows/release.md` });
  await ui.press({ key: 'ask-delete' });
  await sv.clock.advance(500); // past the press guard
  await ui.press({ key: 'confirm-yes' });
  await ui.press({ key: 'tab:search' });
  expect(await ui.find({ key: `hit:${rev}:e:workflows/release.md` })).toBeUndefined();
  expect(await ui.find({ type: 'Text', text: 'Release ritual' })).toBeUndefined();
});

test('2 lands on the Search tab, its hotkeys still working, and says how to type', async ($, on) => {
  server(on, { entries: ENTRIES() });
  await start($);
  const ui = await mount($);
  await ui.press({ key: 'tab:search' });
  expect(await hotkeys(ui)).toBe('1');
  expect(
    await ui.find({ type: 'Text', text: /Press 2 again, or Enter on Search, to type a search\./ }),
  ).toBeDefined();
  // 2 again moving the ring into the field is the e2e's (the kit draws no focus moves).
});

test('session snapshots are their own category, not in all', async ($, on) => {
  const snap = e('sessions/demo/2026-11-13-abcd1234.md', 'demo · 2026-11-13 · fix the sync', {
    updated: '2026-11-13',
  });
  server(on, { entries: [...ENTRIES(), snap] });
  await start($);
  const ui = await mount($);
  expect(await ui.find({ key: 'open:all:sessions/demo/2026-11-13-abcd1234.md' })).toBeUndefined();
  await ui.press({ key: 'cat:sessions' });
  expect(
    await ui.find({ key: 'open:sessions:sessions/demo/2026-11-13-abcd1234.md' }),
  ).toBeDefined();
});

test('a capped hit list says it shows the best; Analyze says how many have one link or none', async ($, on) => {
  const many = Array.from({ length: 20 }, (_, i) =>
    e(`notes/n${i}.md`, `note ${i}`, { body: 'common words' }),
  );
  server(on, { entries: many, analysis: { sparse: 30, total: 68 } });
  await start($, 'common');
  const ui = await mount($);
  expect(await ui.find({ type: 'Text', text: ' 15, the best' })).toBeDefined();
  await ui.press({ key: 'tab:health' });
  await ui.press({ key: 'analyze:first' });
  expect(await ui.find({ type: 'Text', text: ' 30 of 68' })).toBeDefined();
  // The rest a page at a time: none is out of reach (the ring's landing: pane.e2e).
  expect(await ui.find({ key: 'sparse-more:30' })).toMatchObject({
    props: { label: '▸ 30 more', dimColor: true },
  });
  await ui.press({ key: 'sparse-more:30' });
  expect(await ui.find({ key: 'sparse:notes/n30.md' })).toBeDefined();
  await ui.press({ key: 'sparse-more:60' });
  expect(await ui.find({ key: 'sparse:notes/n67.md' })).toBeDefined();
  expect(await ui.find({ key: 'sparse-more:68' })).toBeUndefined();
  expect(await ui.find({ type: 'Text', text: ' 68' })).toBeDefined();
});

test('an empty knowledge base has nothing to analyze', async ($, on) => {
  server(on, { entries: [], analysis: { sparse: 0, total: 0 } });
  await start($);
  const ui = await mount($);
  await ui.press({ key: 'tab:health' });
  await ui.press({ key: 'analyze:first' });
  expect(await ui.find({ type: 'Text', text: 'No entries to analyze.' })).toBeDefined();
});

test('the first prompt line comes after the prompt entered', async ($, on) => {
  const w = server(on, { entries: ENTRIES() });
  // How many lines were logged when the prompt entered: none yet.
  const atEntry: number[] = [];
  on('prompt.submit', (_$, ev) => {
    atEntry.push(w.logs.length);
    return { text: ev.text };
  });
  await begin($);
  await submit($, 'release ritual');
  expect(atEntry).toEqual([0]);
  expect(w.logs).toEqual(['1 entry for this prompt: Release ritual']);
});

test('an outcome stays its ten seconds through the polls, then goes', async ($, on) => {
  const s = server(on, { entries: ENTRIES(), sessions: SESSIONS() });
  await start($, 'release');
  const ui = await mount($);
  expect(await ui.find({ type: 'Text', text: /✓ \d+ hits? for "release"/ })).toBeDefined();
  await s.clock.advance(5_000);
  await s.clock.advance(4_000);
  expect(await ui.find({ type: 'Text', text: /✓ \d+ hits? for "release"/ })).toBeDefined();
  await s.clock.advance(2_000);
  expect(await ui.find({ type: 'Text', text: /✓ \d+ hits? for "release"/ })).toBeUndefined();
});

test('an outcome outlives one poll the server did not answer', async ($, on) => {
  const world: World = { entries: ENTRIES(), sessions: SESSIONS() };
  const s = server(on, world);
  await start($);
  // Polls run every 5 s from the start; the outcome is said at 3 s.
  await s.clock.advance(3_000);
  await $.command.run({ command: 'knowledge', args: 'release', ...RUN });
  const ui = await mount($);
  world.isDown = true;
  await s.clock.advance(2_000); // the 5 s poll: no answer
  world.isDown = false;
  await s.clock.advance(5_000); // the 10 s poll: back; the outcome is 7 s old
  expect(await ui.find({ type: 'Text', text: /✓ \d+ hits? for "release"/ })).toBeDefined();
});

// ── UX review round 2 ───────────────────────────────────────────────────────

const snapEntry = (over: Partial<Entry> = {}) =>
  e('sessions/demo/2026-11-13-abcd1234.md', 'demo · 2026-11-13 · fix the sync', {
    updated: '2026-11-13',
    body: '---\ntype: session-snapshot\nsession: abcd1234-0000\ncwd: ~\\repos\\demo\nbranch: main\nstarted: 2026-11-13T10:00:00.000Z\n---\n\n## What was asked\n\n- fix the sync',
    ...over,
  });

test('only snapshots so far: the empty state says what lands here, the ring on the snapshots', async ($, on) => {
  const s = server(on, { entries: [snapEntry()] });
  const out = await start($);
  // The headline counts knowledge, as Browse all does: no snapshot is an entry of it.
  expect(out.text).toBeUndefined();
  expect(s.status.at(-1)).toBe('0 entries · 0 sessions');
  const ui = await mount($);
  expect(await ui.find({ type: 'Text', text: 'The knowledge base is empty.' })).toBeDefined();
  expect(await ui.find({ key: 'cat:sessions' })).toMatchObject({
    props: { label: '1 session snapshot ›', autoFocus: true },
  });
  await ui.press({ key: 'cat:sessions' });
  expect(
    await ui.find({ key: 'open:sessions:sessions/demo/2026-11-13-abcd1234.md' }),
  ).toBeDefined();
});

test('the snapshots category is named snapshots, its count apart from all', async ($, on) => {
  server(on, { entries: [...ENTRIES(), snapEntry()] });
  await start($);
  const ui = await mount($);
  expect(await ui.find({ type: 'Text', text: /^all 4$/ })).toBeDefined();
  expect(await ui.find({ key: 'cat:sessions', text: /snapshots 1/ })).toBeDefined();
});

test('a snapshot page: its session facts, and the way to its session and back', async ($, on) => {
  const here = { ...SESSIONS()[0]!, sessionId: 'abcd1234-0000', project: 'demo' };
  const sv = server(on, { entries: [...ENTRIES(), snapEntry()], sessions: [...SESSIONS(), here] });
  await start($, 'sessions/demo/2026-11-13-abcd1234.md');
  const ui = await mount($);
  expect(await ui.find({ type: 'Text', text: 'abcd1234-0000' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: '~\\repos\\demo' })).toBeDefined();
  await sv.clock.advance(500);
  await ui.press({ key: 'open-session' });
  // Back leads to the snapshot it was opened from, by its title, onto the button pressed.
  expect(await ui.find({ key: 'back' })).toMatchObject({
    props: { label: '‹ demo · 2026-11-13 · fix the sync' },
  });
  // An Enter of the same burst reaching back as the session opened: held, the page stays.
  await sv.clock.advance(80);
  await ui.press({ key: 'back' });
  expect(
    await ui.find({ type: 'Text', text: /that press came as the view changed/ }),
  ).toBeDefined();
  expect(await ui.find({ key: 'open-session' })).toBeUndefined();
  await sv.clock.advance(500);
  await ui.press({ key: 'back' });
  expect(await ui.find({ key: 'open-session' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: 'abcd1234-0000' })).toBeDefined();
});

test('a snapshot whose transcript is not on this machine offers no way to it', async ($, on) => {
  server(on, { entries: [...ENTRIES(), snapEntry()], sessions: SESSIONS() });
  await start($, 'sessions/demo/2026-11-13-abcd1234.md');
  const ui = await mount($);
  expect(await ui.find({ key: 'open-session' })).toBeUndefined();
  expect(
    await ui.find({ type: 'Text', text: /The session's transcript is not on this machine/ }),
  ).toBeDefined();
});

test('a session summary says its id and how to resume it, by its folder name', async ($, on) => {
  server(on, { entries: ENTRIES(), sessions: SESSIONS() });
  await start($);
  const ui = await mount($);
  await ui.press({ key: 'tab:sessions' });
  await ui.press({ key: 'sess:s-1' });
  expect(await ui.find({ type: 'Text', text: 'claude --resume s-1' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /1 prompt/ })).toBeDefined();
});

test('an incoming link reads with the other entry first; a body link is listed, the text plain', async ($, on) => {
  server(on, {
    entries: [
      ...ENTRIES().map((x) =>
        x.path === 'decisions/rest-only.md'
          ? { ...x, body: 'See [the ritual](workflows/release.md) and [gone](notes/none.md).' }
          : x,
      ),
    ],
    edges: [
      {
        source: 'projects/agent-tasks.md',
        target: 'decisions/rest-only.md',
        rel_type: 'depends_on',
        origin: 'manual',
      },
    ],
  });
  await start($);
  await $.command.run({ command: 'knowledge', args: 'decisions/rest-only.md', ...RUN });
  const ui = await mount($);
  expect(await ui.find({ type: 'Text', text: /depends on this/ })).toBeDefined();
  expect(
    await ui.find({ key: 'mention:decisions/rest-only.md:workflows/release.md' }),
  ).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /none · gone/ })).toBeDefined();
  expect(await ui.find({ type: 'Markdown' })).toMatchObject({
    props: { text: 'See the ritual and gone.' },
  });
  // Followed, a mention leads back by the title of the page it was in, as a link does.
  await ui.press({ key: 'mention:decisions/rest-only.md:workflows/release.md' });
  expect(await ui.find({ key: 'back' })).toMatchObject({
    props: { label: '‹ REST only, no WebSocket' },
  });
});

test('a table wider than the pane reads a row a line, each value with its header; one that fits stays a table', () => {
  const md = '| Phase | Owner | Status |\n|---|---|---|\n| 1 ledger | alice | done |';
  expect(fitTables(md, 80)).toBe(md);
  expect(fitTables(md, 20)).toBe('**Phase:** 1 ledger · **Owner:** alice · **Status:** done\n');
});

test('a body is its prose and its code apart; a fence the fold cut runs to the end', () => {
  const body = ['Run it:', '', '```sh', 'npm ci', 'npm test', '```', '', 'Then tag.'];
  expect(bodyParts(body)).toEqual([
    { code: false, text: 'Run it:' },
    { code: true, lines: ['npm ci', 'npm test'] },
    { code: false, text: 'Then tag.' },
  ]);
  expect(bodyParts(body.slice(0, 4))).toEqual([
    { code: false, text: 'Run it:' },
    { code: true, lines: ['npm ci'] },
  ]);
});

test('a row drops facts that do not fit whole, never cutting one', () => {
  expect(fitParts(['projects', '22d', '#release', '#pane'], 25)).toEqual([
    'projects',
    '22d',
    '#release',
  ]);
  expect(fitParts(['projects', '22d', '#release', '#pane'], 24)).toEqual(['projects', '22d']);
  expect(fitParts(['projects', '22d', '#release', '#pane'], 12)).toEqual(['projects']);
});

test('one way of saying when: a day on in days, a past time with its year', () => {
  const now = new Date('2026-11-13T12:00:00Z');
  expect(ago('2026-11-12T10:00:00Z', now.getTime())).toBe('1d');
  expect(ago('2026-11-13T09:00:00Z', now.getTime())).toBe('3h');
  expect(time('2026-11-11T19:56:00Z', now)).toMatch(/^2026-11-1[12] \d\d:\d\d$/);
});

test('an event kind not known reads as words', () => {
  expect(eventWords('weird-kind')).toBe('Weird kind');
  expect(eventWords('session-end')).toBe('Session saved');
});

test('/knowledge README.md opens the entry, not a search', async ($, on) => {
  server(on, { entries: [...ENTRIES(), e('README.md', 'About this folder')] });
  const out = await start($, 'README.md');
  expect(out.text).toBeUndefined();
  expect(await (await mount($)).find({ type: 'Text', text: 'About this folder' })).toBeDefined();
});

test('Find narrows as the person types', async ($, on) => {
  server(on, { entries: ENTRIES() });
  await start($);
  const ui = await mount($);
  const field = (await ui.findAll({ type: 'Input' })).find((x) =>
    String((x.props as { key?: string }).key).startsWith('filter:'),
  ) as unknown as { props: { key: string } };
  // A keystroke's change, not a submit: onInput.
  await ui.input({ key: field.props.key, text: 'ritual', kind: 'change' });
  expect(await ui.find({ key: 'open:all:workflows/release.md' })).toBeDefined();
  expect(await ui.find({ key: 'open:all:projects/agent-tasks.md' })).toBeUndefined();
});

test('first-prompt hits leave the snapshots out, two at most by default', async ($, on) => {
  const w = server(on, { entries: ENTRIES() });
  const seen = submitted(on);
  await begin($);
  await submit($, 'release ritual');
  expect(searches(w)[0]?.query).toContain('skip=sessions');
  expect(searches(w)[0]?.query).toContain('max_results=2');
  expect(seen[0]!.context).toHaveLength(1);
});

test('Analyze on an empty knowledge base says there is nothing, not a green tick', async ($, on) => {
  server(on, { entries: [], analysis: { sparse: 0, total: 0 } });
  await start($);
  const ui = await mount($);
  await ui.press({ key: 'tab:health' });
  await ui.press({ key: 'analyze:first' });
  expect(await ui.find({ type: 'Text', text: /no entries to analyze/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /✓ 0 most linked/ })).toBeUndefined();
});

test('the snapshot this session made is toasted once, not again by the next poll', async ($, on) => {
  const w = server(on, {
    entries: ENTRIES(),
    snapshot: SNAP,
    events: [{ id: 7, kind: 'compact', message: 'demo · 2026-11-13 · fix the sync', ts: 0 }],
  });
  compacted(on);
  await begin($);
  await compact($, 'as typed');
  await w.clock.advance(30_000);
  expect(w.toasts.filter((t) => t.includes('fix the sync'))).toHaveLength(1);
});

test('an open entry follows its file: an edit elsewhere shows, a delete elsewhere is said', async ($, on) => {
  const world: World = { entries: ENTRIES() };
  const s = server(on, world);
  s.panes.value = [{ id: 'agent-knowledge', isPlaced: true }];
  await start($, 'workflows/release.md');
  const ui = await mount($);
  world.entries = world.entries.map((x) =>
    x.path === 'workflows/release.md' ? { ...x, body: 'Build, then tag the release.' } : x,
  );
  await s.clock.advance(5_000);
  expect(await ui.find({ type: 'Markdown' })).toMatchObject({
    props: { text: 'Build, then tag the release.' },
  });
  world.entries = world.entries.filter((x) => x.path !== 'workflows/release.md');
  await s.clock.advance(5_000);
  expect(
    await ui.find({ type: 'Text', text: '! workflows/release.md was deleted elsewhere' }),
  ).toBeDefined();
  expect(await ui.find({ key: 'delete' })).toBeUndefined();
  expect(await ui.find({ key: 'open:all:projects/agent-tasks.md' })).toBeDefined();
});

test('Sessions: this session marked, sessions where nothing was asked folded away', async ($, on) => {
  const me = { ...SESSIONS()[1]!, sessionId: 'sess-1', preview: 'this very session' };
  const blank = { ...SESSIONS()[1]!, sessionId: 's-blank', prompts: 0, preview: '' };
  server(on, { entries: ENTRIES(), sessions: [me, ...SESSIONS(), blank] });
  await start($);
  const ui = await mount($);
  await ui.press({ key: 'tab:sessions' });
  expect(await ui.find({ type: 'Button', text: /agent-knowledge \(this session\)/ })).toBeDefined();
  // The ring goes to the first past session, not to the one the person is in.
  expect(await ui.find({ key: 'sess:s-1' })).toMatchObject({ props: { autoFocus: true } });
  expect(await ui.find({ key: 'sess:s-blank' })).toBeUndefined();
  await ui.press({ key: 'promptless:shut' });
  expect(await ui.find({ key: 'sess:s-blank' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /nothing asked/ })).toBeDefined();
});

test('while the pane holds the keyboard, Browse keeps its order: an entry written meanwhile comes last', async ($, on) => {
  const world: World = { entries: ENTRIES() };
  const s = server(on, world);
  s.panes.value = [{ id: 'agent-knowledge', isPlaced: true, isFocused: true }];
  await start($);
  await s.clock.advance(5_000);
  const ui = await mount($);
  const before = (await ui.findAll({ type: 'Button' }))
    .map((b) => (b as unknown as { key?: string }).key)
    .filter((k): k is string => !!k && k.startsWith('open:all:'));
  world.entries = [e('notes/new.md', 'Newest of all', { updated: '2026-11-13' }), ...world.entries];
  await s.clock.advance(5_000);
  const after = (await ui.findAll({ type: 'Button' }))
    .map((b) => (b as unknown as { key?: string }).key)
    .filter((k): k is string => !!k && k.startsWith('open:all:'));
  expect(after).toEqual([...before, 'open:all:notes/new.md']);
  // Given back to the prompt, it sorts afresh: the newest first.
  s.panes.value = [{ id: 'agent-knowledge', isPlaced: true, isFocused: false }];
  await s.clock.advance(5_000);
  await s.clock.advance(5_000);
  const fresh = (await ui.findAll({ type: 'Button' }))
    .map((b) => (b as unknown as { key?: string }).key)
    .filter((k): k is string => !!k && k.startsWith('open:all:'));
  expect(fresh[0]).toBe('open:all:notes/new.md');
});

test('an outcome is mirrored in the status entry while the pane shows, then the headline again', async ($, on) => {
  const s = server(on, { entries: ENTRIES(), analysis: { sparse: 0, total: 0 } });
  s.panes.value = [{ id: 'agent-knowledge', isPlaced: true }];
  await start($);
  const ui = await mount($);
  await ui.press({ key: 'tab:health' });
  await ui.press({ key: 'analyze:first' });
  expect(s.status.at(-1)).toMatch(/^✓ \d+ most linked/);
  await s.clock.advance(10_000);
  expect(s.status.at(-1)).toBe('4 entries · 0 sessions');
});

test('a project never ingested is told to the person, and Health offers the ingest', async ($, on) => {
  const s = server(on, {
    entries: ENTRIES(),
    ingest: { state: 'stale', project: 'demo', dir: 'C:/work/demo', changed: 3, added: 1 },
  });
  await contextOf($);
  expect(s.toasts).toContain('Ingest behind: demo, 4 files changed since');
  await start($);
  const ui = await mount($);
  await ui.press({ key: 'tab:health' });
  expect(
    await ui.find({ type: 'Text', text: 'demo: 4 files changed since (3 changed, 1 new)' }),
  ).toBeDefined();
  expect(await ui.find({ key: 'ingest' })).toMatchObject({ props: { label: 'Ingest demo ›' } });
});

test('code in a body is drawn apart from the prose: a bar before each line', async ($, on) => {
  server(on, {
    entries: [
      e('workflows/ship.md', 'Ship', {
        body: 'Run it:\n\n```sh\nnpm ci && npm test\n```\n\nThen tag.',
      }),
    ],
  });
  await start($, 'workflows/ship.md');
  const ui = await mount($);
  expect(await ui.find({ type: 'Markdown', text: 'Run it:' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: 'npm ci && npm test' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: '│' })).toBeDefined();
  expect(await ui.find({ type: 'Markdown', text: 'Then tag.' })).toBeDefined();
});

test('a toast says three events at most, then how many more', async ($, on) => {
  const world: World = { entries: ENTRIES(), events: [] };
  const s = server(on, world);
  s.panes.value = [{ id: 'agent-knowledge', isPlaced: true }];
  await start($);
  await s.clock.advance(5_000);
  world.events = [1, 2, 3, 4, 5].map((id) => ({ id, kind: 'distill', message: `n${id}`, ts: 0 }));
  await s.clock.advance(5_000);
  expect(s.toasts).toEqual(['Distilled: n5 · Distilled: n4 · Distilled: n3 · +2 more']);
});

test('a sync that failed is kept under Recent activity, and not toasted back to this session', async ($, on) => {
  const world: World = {
    entries: ENTRIES(),
    hasGit: true,
    sync: {
      pull: { success: true, message: 'up to date' },
      push: { success: false, message: 'rejected: non-fast-forward' },
    },
  };
  const s = server(on, world);
  s.panes.value = [{ id: 'agent-knowledge', isPlaced: true }];
  await start($);
  const ui = await mount($);
  await ui.press({ key: 'tab:health' });
  await s.clock.advance(500); // past the press guard
  await ui.press({ key: 'sync' });
  expect(
    await ui.find({ type: 'Text', text: '✗ sync failed: push: rejected: non-fast-forward' }),
  ).toBeDefined();
  await s.clock.advance(10_000);
  expect(await ui.find({ type: 'Text', text: /Sync failed: push: rejected/ })).toBeDefined();
  expect(s.toasts.filter((t) => t.includes('Sync failed'))).toEqual([]);
});

test('/knowledge with a slash in its words searches them when no folder of the base is named', async ($, on) => {
  const w = server(on, {
    entries: [...ENTRIES(), e('notes/gitbook.md', 'tools/gitbook-sync runs nightly')],
  });
  const out = await start($, 'tools/gitbook-sync');
  expect(out.text).toBeUndefined();
  expect(searches(w)[0]?.query).toContain('q=tools/gitbook-sync');
  // A folder of the base first: a path, said when it is not there.
  const typo = await $.command.run({ command: 'knowledge', args: 'notes/never', ...RUN });
  expect(typo.text).toContain('there is no entry notes/never.md');
});

test('the snapshots category is named snapshots on its page and in its heading', async ($, on) => {
  server(on, { entries: [...ENTRIES(), snapEntry()] });
  await start($);
  const ui = await mount($);
  await ui.press({ key: 'cat:sessions' });
  expect(await ui.find({ type: 'Text', text: /^Snapshots$/ })).toBeDefined();
  await ui.press({ key: 'open:sessions:sessions/demo/2026-11-13-abcd1234.md' });
  expect(await ui.find({ type: 'Text', text: /^snapshots$/ })).toBeDefined();
});

test('Sessions go on past the ones loaded: more loads the next from the server', async ($, on) => {
  const many = Array.from({ length: 130 }, (_, i) => ({
    ...SESSIONS()[0]!,
    sessionId: `s-${String(i).padStart(3, '0')}`,
  }));
  server(on, { entries: ENTRIES(), sessions: many });
  await start($);
  const ui = await mount($);
  await ui.press({ key: 'tab:sessions' });
  for (let shown = 25; shown < 100; shown += 25) await ui.press({ key: `more:${shown}` });
  // 100 loaded, 130 there: the button goes on, and the next come from the server.
  expect(await ui.find({ key: 'more:100' })).toMatchObject({ props: { label: '▸ 25 more' } });
  await ui.press({ key: 'more:100' });
  expect(await ui.find({ key: 'sess:s-100' })).toBeDefined();
  await ui.press({ key: 'more:125' });
  expect(await ui.find({ key: 'sess:s-129' })).toBeDefined();
  expect(await ui.find({ key: 'more:130' })).toBeUndefined();
});

test('an edit made elsewhere to the open entry is said, not only drawn', async ($, on) => {
  const world: World = { entries: ENTRIES() };
  const s = server(on, world);
  s.panes.value = [{ id: 'agent-knowledge', isPlaced: true }];
  await start($, 'workflows/release.md');
  const ui = await mount($);
  await s.clock.advance(5_000);
  expect(await ui.find({ type: 'Text', text: /changed elsewhere/ })).toBeUndefined();
  world.entries = world.entries.map((x) =>
    x.path === 'workflows/release.md' ? { ...x, body: 'Build, then tag.' } : x,
  );
  await s.clock.advance(5_000);
  expect(
    await ui.find({ type: 'Text', text: '! workflows/release.md changed elsewhere' }),
  ).toBeDefined();
});

test('Health: the folder whole; a search with no entry hit says so beside the session hits', async ($, on) => {
  server(on, {
    entries: ENTRIES(),
    sessions: SESSIONS(),
    memoryDir: 'C:/Users/me/AppData/Local/Temp/agent-knowledge-e2e/knowledge',
  });
  await start($, 'board');
  const ui = await mount($);
  expect(await ui.find({ type: 'Text', text: 'No entry has these words.' })).toBeDefined();
  await ui.press({ key: 'tab:health' });
  expect(
    await ui.find({ type: 'Text', text: /AppData.Local.Temp.agent-knowledge-e2e.knowledge$/ }),
  ).toBeDefined();
});

test('a snapshot page says when its session was last active', async ($, on) => {
  server(on, {
    entries: [
      ...ENTRIES(),
      snapEntry({
        body: '---\ntype: session-snapshot\nsession: abcd1234-0000\nstarted: 2026-11-13T10:00:00.000Z\nlast_activity: 2026-11-13T11:30:00.000Z\n---\n\nx',
      }),
    ],
  });
  await start($, 'sessions/demo/2026-11-13-abcd1234.md');
  const ui = await mount($);
  expect(await ui.find({ type: 'Text', text: 'Last seen' })).toBeDefined();
});

test('/knowledge <path> clears a Find left from before: back is every entry', async ($, on) => {
  const sv = server(on, { entries: ENTRIES() });
  await start($);
  let ui = await mount($);
  await ui.input({ key: await fieldKey(ui), text: 'ritual' });
  await ui.unmount();
  await $.command.run({ command: 'knowledge', args: 'people/mathias', ...RUN });
  ui = await mount($);
  await sv.clock.advance(500);
  await ui.press({ key: 'back' });
  expect(await ui.find({ key: 'open:all:projects/agent-tasks.md' })).toBeDefined();
});

test('typing in Find narrows the list but never draws the typing back into the field', async ($, on) => {
  server(on, { entries: ENTRIES() });
  await start($);
  const ui = await mount($);
  const key = await fieldKey(ui);
  await ui.input({ key, text: 'ritual ', kind: 'change' });
  expect(await ui.find({ key: 'open:all:projects/agent-tasks.md' })).toBeUndefined();
  // Fed back, a trailing space trimmed or a late redraw would drop the person's next keys.
  expect(await ui.find({ key: await fieldKey(ui) })).toMatchObject({ props: { value: '' } });
});

test('Find wants every word it is given, in the title, path or tags', async ($, on) => {
  server(on, { entries: ENTRIES() });
  await start($);
  const ui = await mount($);
  await ui.input({ key: await fieldKey(ui), text: 'release pane', kind: 'change' });
  expect(await ui.find({ key: 'open:all:projects/agent-tasks.md' })).toBeDefined();
  expect(await ui.find({ key: 'open:all:workflows/release.md' })).toBeUndefined();
});

test('/knowledge projects/ opens Browse on that folder; plain /knowledge is Browse after a search', async ($, on) => {
  server(on, { entries: ENTRIES() });
  await start($, 'projects/');
  let ui = await mount($);
  expect(await ui.find({ key: 'open:projects:projects/agent-tasks.md' })).toBeDefined();
  expect(await ui.find({ key: 'open:projects:workflows/release.md' })).toBeUndefined();
  await ui.unmount();
  await $.command.run({ command: 'knowledge', args: 'ritual', ...RUN });
  await $.command.run({ command: 'knowledge', args: '', ...RUN });
  ui = await mount($);
  expect(await ui.find({ key: 'open:all:workflows/release.md' })).toBeDefined();
});

test('a tab key while the server is down is said, not taken in silence', async ($, on) => {
  server(on, { entries: ENTRIES(), isDown: true });
  await start($);
  const ui = await mount($);
  await ui.press({ key: 'tab:sessions' });
  expect(
    await ui.find({ type: 'Text', text: '– Sessions shows once the server answers' }),
  ).toBeDefined();
});

test('a search while the server warms its index up waits and tries again, not a failure', async ($, on) => {
  const s = server(on, { entries: ENTRIES(), warming: 2 });
  await start($);
  const ui = await mount($);
  await ui.press({ key: 'tab:search' });
  const run = $.command.run({ command: 'knowledge', args: 'ritual', ...RUN });
  await s.clock.advance(10_000);
  await run;
  expect(await ui.find({ type: 'Text', text: /search failed/ })).toBeUndefined();
  const keys = (await ui.findAll({ type: 'Button' })).map(
    (x) => (x as unknown as { key?: string }).key,
  );
  expect(keys.some((k) => k?.startsWith('hit:'))).toBe(true);
});

test('a Find field drawn anew shows the filter that narrows the list', async ($, on) => {
  server(on, { entries: ENTRIES() });
  await start($);
  const ui = await mount($);
  await ui.input({ key: await fieldKey(ui), text: 'ritual', kind: 'change' });
  // Away and back, Enter never pressed: the list still narrowed, so the field says by what.
  await ui.press({ key: 'tab:search' });
  await ui.press({ key: 'tab:browse' });
  expect(await ui.find({ key: 'open:all:projects/agent-tasks.md' })).toBeUndefined();
  expect(await ui.find({ key: await fieldKey(ui) })).toMatchObject({ props: { value: 'ritual' } });
});

test('words typed into Search and not searched come back with the field', async ($, on) => {
  server(on, { entries: ENTRIES() });
  await start($);
  const ui = await mount($);
  await ui.press({ key: 'tab:search' });
  await ui.press({ key: 'tab:search' }); // 2 again: into the field
  const field = (await ui.findAll({ type: 'Input' })).find(
    (x) => (x as unknown as { props: { label: string } }).props.label === 'Search',
  ) as unknown as { props: { key: string } };
  await ui.input({ key: field.props.key, text: 'half a que', kind: 'change' });
  await ui.press({ key: 'tab:browse' });
  await ui.press({ key: 'tab:search' });
  const back = (await ui.findAll({ type: 'Input' })).find(
    (x) => (x as unknown as { props: { label: string } }).props.label === 'Search',
  );
  expect(back).toMatchObject({ props: { value: 'half a que' } });
});

test('text with terminal control in it (a coloured tool output, a bell) draws everywhere, cleaned', async ($, on) => {
  const RED = '\x1b[31m';
  const OFF = '\x1b[0m';
  const dirty = (x: string) => `${RED}${x}${OFF}\x07`;
  const s = server(on, {
    entries: ENTRIES().map((x) => ({
      ...x,
      title: dirty(x.title),
      body: `${x.body}\n\n${RED}error${OFF}: \x1b]0;title\x07 done \x9d8;;https://hidden.test/\x9c\r\n`,
      tags: x.tags.map(dirty),
    })),
    sessions: SESSIONS().map((x) => ({
      ...x,
      preview: dirty(x.preview),
      topics: x.topics.map(dirty),
      errors: x.errors.map(dirty),
    })),
    events: [{ id: 1, kind: 'session-end', message: dirty('saved'), ts: 0 }],
  });
  s.panes.value = [{ id: 'agent-knowledge', isPlaced: true }];
  await start($);
  const ui = await mount($);
  const drawn = async () =>
    (await ui.findAll({ type: 'Text' }))
      .map((t) => (t as unknown as { text: string }).text)
      .concat(
        (await ui.findAll({ type: 'Button' })).map(
          (b) => (b as unknown as { props: { label?: string } }).props.label ?? '',
        ),
        (await ui.findAll({ type: 'Markdown' })).map(
          (m) => (m as unknown as { props: { text: string } }).props.text,
        ),
      );
  const clean = async (where: string) => {
    // eslint-disable-next-line no-control-regex
    const bad = (await drawn()).filter((t) => /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(t));
    expect(bad, where).toEqual([]);
  };
  await clean('Browse');
  await ui.press({ key: 'open:all:workflows/release.md' });
  await clean('an entry');
  // A C1 OSC goes whole, its payload with it.
  expect((await drawn()).some((t) => t.includes('hidden.test'))).toBe(false);
  await ui.press({ key: 'tab:sessions' });
  await clean('Sessions');
  await ui.press({ key: 'sess:s-1' });
  await clean('a session');
  await ui.press({ key: 'tab:health' });
  await clean('Health');
  await ui.unmount();
  await $.command.run({ command: 'knowledge', args: 'board', ...RUN });
  const found = await mount($);
  const texts = (await found.findAll({ type: 'Text' })).map(
    (t) => (t as unknown as { text: string }).text,
  );
  expect(texts.some((t) => t.includes('\u001b'))).toBe(false);
});

test('a press whose button was drawn again is made by its key when it only moves', () => {
  expect(moveOf('tab:sessions')).toEqual({ tab: 'sessions' });
  expect(moveOf('open:all:projects/agent-tasks.md')).toEqual({ entry: 'projects/agent-tasks.md' });
  expect(moveOf('hit:3:e:notes/a.md')).toEqual({ entry: 'notes/a.md' });
  expect(moveOf('link:notes/a.md:in:notes/b.md')).toEqual({ entry: 'notes/b.md' });
  expect(moveOf('mention:notes/a.md:notes/c.md')).toEqual({ entry: 'notes/c.md' });
  expect(moveOf('sparse:people/x.md')).toEqual({ entry: 'people/x.md' });
  expect(moveOf('sess:abc-1')).toEqual({ session: 'abc-1' });
  expect(moveOf('hit:3:s:abc-1:4')).toEqual({ session: 'abc-1' });
  expect(moveOf('open-session')).toEqual({ pageSession: true });
  expect(moveOf('cat:notes')).toEqual({ category: 'notes' });
  expect(moveOf('more:25')).toEqual({ more: true });
  expect(moveOf('sparse-more:30')).toEqual({ analyzeMore: true });
  expect(moveOf('body:shut')).toEqual({ fold: 'body' });
  expect(moveOf('back')).toEqual({ back: true });
  expect(moveOf('refresh:7')).toEqual({ refresh: true });
  expect(moveOf('retry')).toEqual({ refresh: true });
  // Those that change something are said, never guessed at.
  for (const k of ['sync', 'ingest', 'confirm-yes', 'confirm-no', 'ask-delete', 'analyze:first'])
    expect(moveOf(k)).toBeNull();
  expect(moveOf('clear-filter')).toBeNull();
});

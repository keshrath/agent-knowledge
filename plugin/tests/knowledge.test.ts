import type { On } from 'claude-code';
import { expect, mock, test, type TestBody } from 'claude-code/testing';

import {
  ago,
  homeAsTilde,
  pageBody,
  plain,
  categoryOrder,
  clip,
  clipPath,
  cols,
  duration,
  headline,
  isField,
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
  /** An agent-knowledge from before the pane holds the port: its version. */
  old?: string;
};

type Call = { method: string; path: string };

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
  const toasts: string[] = [];
  const status: (string | undefined)[] = [];
  const opens: Record<string, unknown>[] = [];
  const placed = { value: { isPlaced: true } as { isPlaced: boolean; reason?: string } };
  const panes = { value: [] as { id: string; isPlaced: boolean }[] };
  const clock = mock.clock(on);
  mock.env(on, {});
  on('session.start', (_$, ev) => ({ cwd: ev.cwd }));
  on('http.fetch', (_$, ev) => {
    const url = new URL(ev.url);
    const method = ev.init?.method ?? 'GET';
    if (method !== 'GET') calls.push({ method, path: decodeURIComponent(url.pathname) });
    const reply = (data: unknown, code = 200) => ({
      value: { status: code, ok: code < 400, headers: {}, text: JSON.stringify(data) },
    });
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
      const categories: Record<string, number> = {};
      for (const x of world.entries) {
        const c = x.path.split('/')[0]!;
        categories[c] = (categories[c] ?? 0) + 1;
      }
      return reply({
        version: '2.0.0',
        entries: world.entries.length,
        categories,
        sessions: (world.sessions ?? []).length,
        vectors: 120,
        provider: 'local',
        memory_dir: 'C:/Users/me/agent-knowledge',
        has_git: world.hasGit ?? true,
        events: world.events ?? [],
      });
    }
    if (p === '/api/knowledge' && method === 'GET') {
      const c = url.searchParams.get('category');
      return reply(world.entries.filter((x) => !c || x.path.startsWith(`${c}/`)).map(row));
    }
    if (p === '/api/knowledge/search') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      return reply(
        world.entries
          .filter((x) => `${x.title} ${x.body} ${x.tags.join(' ')}`.toLowerCase().includes(q))
          .map((x) => ({ entry: row(x), score: 1, excerpt: `…${x.title} excerpt…` })),
      );
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
      return reply({
        entry: { ...row(x), author: x.author },
        content: `---\ntitle: ${x.title}\n---\n${x.body}`,
        maturity: x.maturity ?? 'candidate',
        access_count: x.access_count ?? 0,
        last_accessed: x.access_count ? '2026-10-22T08:00:00.000Z' : null,
      });
    }
    if (p === '/api/sessions') return reply({ sessions: world.sessions ?? [], total: 2 });
    if (p === '/api/sessions/search') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      return reply(
        (world.sessions ?? [])
          .filter((s) => s.preview.toLowerCase().includes(q))
          .map((s) => ({
            source: 'session',
            id: s.sessionId,
            project: s.project,
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
          userMessageCount: 1,
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
    if (p === '/api/analysis')
      return reply({
        hubs: [{ path: 'projects/agent-tasks.md', title: 'agent-tasks 2.0', degree: 3 }],
        sparse: [{ path: 'people/mathias.md', title: 'Mathias', degree: 0 }],
      });

    return reply({ error: 'Not found' }, 404);
  });
  on('command.register', (_$, ev) => ({ value: { command: ev.name } }));
  on('ui.status', (_$, ev) => (status.push(ev.text), { value: undefined }));
  on('ui.toast', (_$, ev) => (toasts.push(ev.text), { value: undefined }));
  on('ui.open', (_$, ev) => (opens.push({ ...ev }), { value: placed.value }) as never);
  on('ui.panes', () => ({ value: panes.value }) as never);
  on('ui.render', ($, ev) => $.ui.resolve(ev).Box({}));
  on('prompt.context', (_$, ev) => ({ blocks: ev.blocks }));

  return { calls, toasts, status, opens, placed, panes, clock };
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
  expect(out.text).toBe('4 entries · 2 sessions');
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
  // A row: category, evergreen, maturity, tags, how long ago.
  expect(
    await ui.find({ type: 'Text', text: /projects · established · #release · #pane/ }),
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
  expect(await ui.find({ type: 'Text', text: /tag release/ })).toBeDefined();
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
    props: { label: '▸ 5 more (5 left)' },
  });
  await ui.press({ key: 'more:25' });
  expect(await ui.find({ key: 'open:all:notes/n00.md' })).toBeDefined();
  expect(await ui.find({ key: 'more:30' })).toBeUndefined();
});

test('an entry: its facts, links both ways, the body as Markdown; links walk and back returns', async ($, on) => {
  server(on, {
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
  expect(await ui.find({ type: 'Text', text: /← related to/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /auto-link/ })).toBeDefined();
  await ui.press({ key: 'link:projects/agent-tasks.md:out:decisions/rest-only.md' });
  expect(await ui.find({ key: 'back' })).toMatchObject({ props: { label: '‹ agent-tasks 2.0' } });
  expect(
    await ui.find({ key: 'link:decisions/rest-only.md:in:projects/agent-tasks.md' }),
  ).toBeDefined();
  await ui.press({ key: 'back' });
  expect(await ui.find({ type: 'Text', text: /^agent-tasks 2\.0$/ })).toBeDefined();
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

test('delete asks first; Never mind keeps it; Delete removes and says so', async ($, on) => {
  const world: World = { entries: ENTRIES() };
  const s = server(on, world);
  await start($, 'people/mathias.md');
  const ui = await mount($);
  await ui.press({ key: 'ask-delete' });
  expect(await ui.find({ type: 'Text', text: /Delete people\/mathias\.md\?/ })).toBeDefined();
  expect(await ui.find({ key: 'confirm-no' })).toMatchObject({ props: { autoFocus: true } });
  await ui.press({ key: 'confirm-no' });
  expect(await ui.find({ key: 'confirm-yes' })).toBeUndefined();
  expect(s.calls).toEqual([]);
  await ui.press({ key: 'ask-delete' });
  await ui.press({ key: 'confirm-yes' });
  expect(s.calls).toEqual([{ method: 'DELETE', path: '/api/knowledge/people/mathias.md' }]);
  expect(await ui.find({ type: 'Text', text: '✓ deleted people/mathias.md' })).toBeDefined();
  expect(await ui.find({ key: 'open:all:people/mathias.md' })).toBeUndefined();
  expect(world.entries).toHaveLength(3);
});

test('a delete the remote refused is said with it', async ($, on) => {
  server(on, { entries: ENTRIES(), pushFails: 'rejected\nhint: pull first' });
  await start($, 'people/mathias.md');
  const ui = await mount($);
  await ui.press({ key: 'ask-delete' });
  await ui.press({ key: 'confirm-yes' });
  expect(
    await ui.find({ type: 'Text', text: '✓ deleted people/mathias.md (not pushed: rejected)' }),
  ).toBeDefined();
});

test('/knowledge <words> searches entries and sessions; a hit opens', async ($, on) => {
  server(on, { entries: ENTRIES(), sessions: SESSIONS() });
  const out = await start($, 'pane');
  expect(out.text).toContain('1 entry and 1 session moment match "pane"');
  const ui = await mount($);
  expect(await ui.find({ type: 'Text', text: /^Entries$/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /^Sessions$/ })).toBeDefined();
  expect(await ui.find({ key: 'tab:search' })).toBeDefined();
  const rev = await revOf(ui);
  expect(await ui.find({ key: `hit:${rev}:e:projects/agent-tasks.md` })).toMatchObject({
    props: { autoFocus: true },
  });
  expect(await ui.find({ type: 'Text', text: /…agent-tasks 2\.0 excerpt…/ })).toBeDefined();
  await ui.press({ key: `hit:${rev}:e:projects/agent-tasks.md` });
  expect(await ui.find({ key: 'back' })).toMatchObject({ props: { label: '‹ Search' } });
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
  expect(await ui.find({ type: 'Text', text: /no hits for "zzzz"/ })).toBeDefined();
  expect(await ui.find({ key: await fieldKey(ui) })).toMatchObject({ props: { value: 'zzzz' } });
  expect(await fieldKey(ui)).not.toBe(field); // a fresh field: the ring waits for it
});

test('a command search with no hit lands on a button, never in the field', async ($, on) => {
  server(on, { entries: ENTRIES(), sessions: SESSIONS() });
  await start($);
  const out = await $.command.run({ command: 'knowledge', args: 'zzzz', ...RUN });
  expect(out.text).toContain('0 entries and 0 session moments match "zzzz"');
  const ui = await mount($);
  expect(await ui.find({ key: 'tab:search' })).toMatchObject({ props: { autoFocus: true } });
  expect(await ui.find({ key: await fieldKey(ui) })).not.toMatchObject({
    props: { autoFocus: true },
  });
});

test('Sessions: newest first, a summary with what was asked, files and errors', async ($, on) => {
  server(on, { entries: ENTRIES(), sessions: SESSIONS() });
  await start($);
  const ui = await mount($);
  await ui.press({ key: 'tab:sessions' });
  expect(await ui.find({ key: 'sess:s-1' })).toMatchObject({ props: { autoFocus: true } });
  expect(await ui.find({ type: 'Text', text: /1h 30m · main/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /make the board a pane/ })).toBeDefined();
  await ui.press({ key: 'sess:s-1' });
  expect(await ui.find({ key: 'back' })).toMatchObject({ props: { label: '‹ Sessions' } });
  expect(await ui.find({ type: 'Text', text: 'C:/work/agent-tasks' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: '· test it in the real CLI' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: '· plugin/hooks/view.tsx' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: '· TypeError: x is undefined' })).toMatchObject({
    props: { color: 'error' },
  });
  expect(await ui.find({ type: 'Text', text: '· Read, Edit' })).toBeDefined();
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
  expect(await ui.find({ key: 'sync' })).toMatchObject({ props: { autoFocus: true } });
  expect(
    await ui.find({ type: 'Text', text: /words and meaning: 120 vectors \(local\)/ }),
  ).toBeDefined();
  expect(await ui.find({ type: 'Text', text: 'C:/Users/me/agent-knowledge' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /synced with a remote/ })).toBeDefined();
  await ui.press({ key: 'sync' });
  expect(s.calls.at(-1)).toEqual({ method: 'POST', path: '/api/knowledge/sync' });
  expect(await ui.find({ type: 'Text', text: '✓ synced with the remote' })).toBeDefined();
  world.sync = {
    pull: { success: false, message: 'could not resolve host\nmore' },
    push: { success: true, message: 'pushed' },
  };
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
  expect(s.toasts).toEqual(['session-end: s-2 saved · distill: 2 entries from s-1']);
  await s.clock.advance(5_000);
  expect(s.toasts).toHaveLength(1);
  const ui = await mount($);
  await ui.press({ key: 'tab:health' });
  expect(await ui.find({ type: 'Text', text: /Recent activity/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /session-end: s-2 saved/ })).toBeDefined();
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
  expect(await ui.find({ key: 'tab:browse' })).toBeUndefined(); // only Refresh while down
  expect(await ui.find({ key: 'retry' })).toMatchObject({ props: { autoFocus: true } });
  await ui.press({ key: 'retry' });
  expect(
    await ui.find({ type: 'Text', text: /still nothing at the port \(\d\d:\d\d:\d\d\)/ }),
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

test('an empty knowledge base says what lands here', async ($, on) => {
  server(on, { entries: [] });
  const out = await start($);
  expect(out.text).toBe('0 entries · 0 sessions');
  const ui = await mount($);
  expect(await ui.find({ type: 'Text', text: 'The knowledge base is empty.' })).toBeDefined();
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
  expect(clipPath('C:\\Users\\me\\agent-knowledge-e2e\\knowledge', 24)).toBe('…\\knowledge');
  expect(cols(clipPath('C:\\Users\\me\\agent-knowledge-e2e\\knowledge', 24))).toBeLessThanOrEqual(
    24,
  );
  expect(clipPath('~/agent-knowledge', 40)).toBe('~/agent-knowledge');
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
  expect(headline({ entries: 1, sessions: 1 })).toBe('1 entry · 1 session');
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
  server(on, { entries: ENTRIES(), hasGit: false, pushFails: 'fatal: not a git repository' });
  await start($, 'people/mathias.md');
  const ui = await mount($);
  await ui.press({ key: 'ask-delete' });
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
  expect(out.text).toContain('opened REST only, no WebSocket');
});

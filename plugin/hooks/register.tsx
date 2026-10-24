// agent-knowledge inside Claude Code: the /knowledge pane (entries by category with their
// pages and links, search across entries and past sessions, recent sessions with their
// summaries, and the knowledge base's health: counts, git sync, link analysis, live
// events), a status line entry, toasts for live events (a session distilled), and one
// context block telling the model what the knowledge base holds. Everything goes through
// the REST server every agent-knowledge MCP process shares (127.0.0.1:3423).
import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register } from 'claude-code';

import type {
  AgentKnowledgeAnalysis,
  AgentKnowledgeEntry,
  AgentKnowledgeHit,
  AgentKnowledgeLink,
  AgentKnowledgeOverview,
  AgentKnowledgePage,
  AgentKnowledgeSessionPage,
  AgentKnowledgeSessionRow,
  AgentKnowledgeTab,
} from '../types';
import {
  PAGE,
  Pane,
  baseName,
  browseRows,
  homeAsTilde,
  categoryOrder,
  foldKey,
  headline,
  hitKey,
  linkKey,
  pageBody,
  count,
  plural,
  refreshKey,
  rowKey,
  type Actions,
} from './view';

const PANE = 'agent-knowledge';
const TICK_MS = 5_000;
const IDLE_TICKS = 6; // 30 s between polls while the pane is closed
const PANE_ROWS = 40;
const ENTRY_HITS = 15;
const SESSION_HITS = 10;
const SESSIONS = 100;

const overview = atom({ plugin: 'agent-knowledge', key: 'overview' } as const, null);
const route = atom({ plugin: 'agent-knowledge', key: 'route' } as const, {
  tab: 'browse',
  entry: null,
  session: null,
  trail: [],
});
const category = atom({ plugin: 'agent-knowledge', key: 'category' } as const, 'all');
const filter = atom({ plugin: 'agent-knowledge', key: 'filter' } as const, '');
const list = atom({ plugin: 'agent-knowledge', key: 'list' } as const, null);
const shown = atom({ plugin: 'agent-knowledge', key: 'shown' } as const, PAGE);
const search = atom({ plugin: 'agent-knowledge', key: 'search' } as const, null);
const sessions = atom({ plugin: 'agent-knowledge', key: 'sessions' } as const, null);
const page = atom({ plugin: 'agent-knowledge', key: 'page' } as const, null);
const sessionPage = atom({ plugin: 'agent-knowledge', key: 'sessionPage' } as const, null);
const analysis = atom({ plugin: 'agent-knowledge', key: 'analysis' } as const, null);
const expanded = atom({ plugin: 'agent-knowledge', key: 'expanded' } as const, []);
const confirm = atom({ plugin: 'agent-knowledge', key: 'confirm' } as const, null);
const rev = atom({ plugin: 'agent-knowledge', key: 'rev' } as const, 0);
const busy = atom({ plugin: 'agent-knowledge', key: 'busy' } as const, null);
const notice = atom({ plugin: 'agent-knowledge', key: 'notice' } as const, null);
const focused = atom({ plugin: 'agent-knowledge', key: 'focused' } as const, null);

// REST bodies are server JSON; read defensively, never trusted for shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : String(x?.content ?? x))) : [];

const origin = async ($: EngineInterface) =>
  `http://127.0.0.1:${(await $.env.get('AGENT_KNOWLEDGE_PORT')) ?? '3423'}`;

const enc = encodeURIComponent;

async function api(
  $: EngineInterface,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<Json> {
  const res = await $.http.fetch(`${await origin($)}${path}`, {
    method,
    ...(body !== undefined
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
  let data: Json = {};
  try {
    data = JSON.parse(res.text) as Json;
  } catch {
    /* not JSON: the status says enough */
  }
  if (!res.ok)
    throw Object.assign(new Error(text(data.error) ?? `${method} ${path}: ${res.status}`), {
      status: res.status,
    });

  return data;
}

const DOWN = { categories: {}, entries: 0, sessions: 0, vectors: 0, provider: null, events: [] };

async function poll($: EngineInterface): Promise<AgentKnowledgeOverview> {
  const base = await origin($);
  try {
    const o = await api($, '/api/overview');
    const categories = Object.fromEntries(
      Object.entries((o.categories ?? {}) as Record<string, unknown>).map(([k, v]) => [
        k,
        Number(v),
      ]),
    );
    return {
      isUp: true,
      origin: base,
      old: null,
      version: String(o.version ?? ''),
      categories,
      entries: Number(o.entries ?? 0),
      sessions: Number(o.sessions ?? 0),
      vectors: Number(o.vectors ?? 0),
      provider: text(o.provider),
      memoryDir: homeAsTilde(
        String(o.memory_dir ?? ''),
        (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')),
      ),
      hasGit: Boolean(o.has_git),
      events: arr(o.events).map((e) => ({
        id: Number(e.id),
        kind: String(e.kind ?? ''),
        message: String(e.message ?? ''),
        ts: Number(e.ts ?? 0),
      })),
    };
  } catch (err) {
    // An agent-knowledge from before the pane (1.x) answers /health but not the overview.
    const old =
      (err as { status?: number }).status === 404
        ? await api($, '/health')
            .then((health) => text(health.version))
            .catch(() => null)
        : null;
    return { isUp: false, origin: base, old, version: '', memoryDir: '', hasGit: false, ...DOWN };
  }
}

/** The context block the model starts with: what the knowledge base holds and how to reach it. */
function contextText(o: AgentKnowledgeOverview) {
  const cats = categoryOrder(o.categories)
    .map((c) => `${c} ${o.categories[c]}`)
    .join(', ');
  return (
    `agent-knowledge holds ${headline(o)}${cats ? ` (${cats})` : ''}. ` +
    'Before saying something is unknown or deciding how something was done, search it with knowledge_search; read an entry with knowledge (action "read"). ' +
    'The person browses it in /knowledge.'
  );
}

/** The newest events since `seen`, as one toast: the news first (a toast cut short keeps it). */
function news(o: AgentKnowledgeOverview, seen: number): string | null {
  const fresh = o.events.filter((e) => e.id > seen).reverse();
  if (fresh.length === 0) return null;
  const said = fresh.slice(0, 2).map((e) => `${e.kind}: ${e.message}`);
  return `${said.join(' · ')}${fresh.length > 2 ? ` · +${fresh.length - 2} more` : ''}`;
}

/** Polls by number: one that answers after a later one was drawn is dropped, not drawn over it. */
let polls = 0;
let drawnPoll = 0;
/** The newest event already seen: events after it are toasted. Null until the first poll. */
let seenEvent: number | null = null;

/**
 * Polls the overview and draws it; new live events become one toast. Going down puts the ring
 * on Refresh, and coming back up drops what a Refresh while down said.
 */
async function refresh($: EngineInterface) {
  const n = ++polls;
  const next = await poll($);
  const prev = await read($, overview);
  if (n < drawnPoll) return prev ?? next;
  drawnPoll = n;
  await update($, overview, () => next);
  $.ui.status(
    next.isUp ? headline(next) : next.old ? `old server ${next.old} on the port` : 'offline',
  );
  if (next.isUp) {
    const newest = next.events.at(-1)?.id ?? 0;
    if (seenEvent !== null) {
      const said = news(next, seenEvent);
      if (said) $.ui.toast(said);
    }
    seenEvent = Math.max(seenEvent ?? 0, newest);
  }
  if (prev?.isUp && next.isUp && countsMoved(prev, next)) await followList($);
  if (prev?.isUp && !next.isUp) void land($);
  if (prev && !prev.isUp && next.isUp) {
    await say($, null);
    await loadTab($).catch(() => {});
    void land($);
  }

  return next;
}

const countsMoved = (a: AgentKnowledgeOverview, b: AgentKnowledgeOverview) =>
  a.entries !== b.entries || JSON.stringify(a.categories) !== JSON.stringify(b.categories);

/**
 * An entry written or deleted elsewhere shows in Browse without a key; the ring stays on the
 * row it held (a new row above it would otherwise move it, kept by its place), or lands anew
 * when that row is gone or off the page. A ring the person moved meanwhile is left alone.
 */
async function followList($: EngineInterface) {
  const r = await read($, route);
  if (r.tab !== 'browse' || r.entry !== null || (await read($, list)) === null) return;
  const held = await read($, focused);
  await loadList($).catch(() => {});
  if (!held?.startsWith('open:') || (await read($, focused)) !== held) return;
  await awaitDrawing($);
  const c = await read($, category);
  const rows = browseRows((await read($, list)) ?? [], c, await read($, filter));
  const isShown = rows.slice(0, await read($, shown)).some((e) => rowKey(c, e.path) === held);
  if (!isShown || !(await focusOn($, held))) await land($);
}

/**
 * Waits for the drawing of what was just set: the held key is drawn already, so focusing it
 * alone would land before the redraw that moves it. Refresh's fresh key (a button, never a
 * text field) exists only in the next drawing; focusing it waits for that.
 */
async function awaitDrawing($: EngineInterface) {
  await update($, rev, (n) => n + 1);
  await focusOn($, refreshKey(true, await read($, rev)));
}

const entry = (e: Json): AgentKnowledgeEntry => ({
  path: String(e.path ?? ''),
  title: String(e.title ?? e.path ?? ''),
  // A file at the top of the knowledge folder has no category folder: `other`, as the overview counts it.
  category: String(e.path ?? '').includes('/') ? String(e.path).split('/')[0]! : 'other',
  tags: arr(e.tags).map(String),
  updated: String(e.updated ?? ''),
  maturity: String(e.maturity ?? 'candidate'),
  reads: Number(e.access_count ?? 0),
  isEvergreen: e.evergreen === true,
});

/** Newest first; an entry with no `updated` goes last. */
const byUpdated = (a: AgentKnowledgeEntry, b: AgentKnowledgeEntry) =>
  b.updated.localeCompare(a.updated) || a.title.localeCompare(b.title);

/** Every entry: a category is a filter over it, switched without asking again. */
async function loadList($: EngineInterface) {
  const rows = await api($, '/api/knowledge');
  await update($, list, () => arr(rows).map(entry).sort(byUpdated));
}

async function loadSessions($: EngineInterface) {
  const r = await api($, `/api/sessions?limit=${SESSIONS}`);
  await update($, sessions, () =>
    arr(r.sessions).map(
      (s): AgentKnowledgeSessionRow => ({
        id: String(s.sessionId ?? ''),
        project: String(s.project ?? ''),
        start: String(s.startTime ?? 'unknown'),
        end: String(s.endTime ?? 'unknown'),
        messages: Number(s.messageCount ?? 0),
        branch: String(s.branch ?? ''),
        preview: String(s.preview ?? ''),
      }),
    ),
  );
}

async function loadPage($: EngineInterface, path: string) {
  const [e, links] = await Promise.all([
    api($, `/api/knowledge/${enc(path)}`),
    api($, `/api/knowledge/${enc(path)}/links`).catch(() => [] as unknown as Json),
  ]);
  const meta = (e.entry ?? e) as Json;
  const next: AgentKnowledgePage = {
    ...entry({ ...meta, access_count: e.access_count, maturity: e.maturity }),
    path,
    author: text(meta.author),
    lastRead: text(e.last_accessed),
    body: pageBody(String(e.content ?? ''), String(meta.title ?? '')),
    links: arr(links)
      .map(
        (l): AgentKnowledgeLink => ({
          path: String(l.source === path ? l.target : l.source),
          title: text(l.title) ?? baseName(String(l.source === path ? l.target : l.source)),
          rel: String(l.rel_type ?? 'related_to'),
          direction: l.source === path ? 'out' : 'in',
          origin: String(l.origin ?? 'manual'),
        }),
      )
      .filter((l, i, all) => all.findIndex((x) => x.path === l.path && x.rel === l.rel) === i),
  };
  await update($, page, () => next);
}

async function loadSession($: EngineInterface, id: string, project: string) {
  const s = await api($, `/api/sessions/${enc(id)}/summary?project=${enc(project)}`);
  const m = (s.meta ?? {}) as Json;
  const next: AgentKnowledgeSessionPage = {
    id,
    project,
    start: String(m.startTime ?? 'unknown'),
    end: String(m.endTime ?? 'unknown'),
    messages: Number(m.messageCount ?? 0),
    branch: String(m.branch ?? ''),
    preview: String(m.preview ?? ''),
    cwd: String(m.cwd ?? ''),
    topics: strings(s.topics),
    tools: strings(s.toolsUsed),
    files: strings(s.filesModified),
    commits: strings(s.gitCommits),
    errors: strings(s.errorPatterns),
  };
  await update($, sessionPage, () => next);
}

/** Loads what the shown tab or page needs; a page gone elsewhere returns to its tab. */
async function loadTab($: EngineInterface) {
  if (!(await read($, overview))?.isUp) return;
  const r = await read($, route);
  if (r.entry !== null) {
    try {
      await loadPage($, r.entry);
    } catch (err) {
      if ((err as { status?: number }).status !== 404) throw err;
      // Gone (or never there): back to its tab, which is loaded below.
      await update($, route, (x) => ({ ...x, entry: null, trail: [] }));
      await say($, `✗ there is no entry ${r.entry}`);
    }
    if ((await read($, route)).entry !== null) return;
  }
  if (r.session !== null) {
    try {
      await loadSession($, r.session.id, r.session.project);
    } catch (err) {
      if ((err as { status?: number }).status !== 404) throw err;
      await update($, route, (x) => ({ ...x, session: null }));
      await say($, '✗ that session is gone');
    }
    if ((await read($, route)).session !== null) return;
  }
  if (r.tab === 'browse') await loadList($);
  if (r.tab === 'sessions') await loadSessions($);
}

const NOTICE_MS = 10_000;
/** Notices by number: only the one still shown when its time is up is taken away. */
let notices = 0;

/** Puts an outcome in the status line, or takes it away; it goes by itself after NOTICE_MS. */
async function say($: EngineInterface, said: string | null) {
  const n = ++notices;
  await update($, notice, () => said);
  if (said)
    void $.clock
      .sleep(NOTICE_MS)
      .then(async () => (n === notices ? say($, null) : undefined))
      .catch(() => undefined);
}

/** Runs one action with its busy line and outcome, then reloads and lands the focus. */
async function act($: EngineInterface, label: string, fn: () => Promise<string>) {
  await update($, busy, () => label);
  await say($, null);
  try {
    await say($, (await fn()) || null);
  } catch (err) {
    await say($, `✗ ${label} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const o = await refresh($);
  if (!o.isUp && !(await read($, notice)))
    await say($, `✗ still nothing at the port (${new Date().toTimeString().slice(0, 8)})`);
  await loadTab($).catch(() => {});
  await update($, busy, () => null);
  void land($);
}

/**
 * Where the focus ring lands: the control the person most likely wants next, always a button.
 * The ring enters a text field only when the person asks for it (the Search tab, Find).
 */
async function landing($: EngineInterface): Promise<string | null> {
  const o = await read($, overview);
  if (!o?.isUp) return refreshKey(false);
  const r = await read($, route);
  if (r.entry !== null) return (await read($, confirm)) ? 'confirm-no' : 'back';
  if (r.session !== null) return 'back';
  const v = await read($, rev);
  if (r.tab === 'search') {
    const s = await read($, search);
    const first: AgentKnowledgeHit | undefined = s?.entries[0] ?? s?.sessions[0];
    return first ? hitKey(v, first, 0) : 'tab:search';
  }
  if (r.tab === 'sessions') {
    const all = await read($, sessions);
    return all?.[0] ? `sess:${all[0].id}` : 'tab:sessions';
  }
  if (r.tab === 'health') {
    if (o.hasGit) return 'sync';
    return (await read($, analysis)) ? 'analyze:again' : 'analyze:first';
  }
  if (o.entries === 0) return 'tab:browse';
  const c = await read($, category);
  const q = await read($, filter);
  const first = browseRows((await read($, list)) ?? [], c, q)[0];
  if (first) return rowKey(c, first.path);
  return q ? 'clear-filter' : `cat:${c}`;
}

/**
 * The keys the pane is moving the ring to right now (moves can overlap). Its own moves and its
 * autoFocus taking the ring both reach `ui.focus` as origin `plugin`; this tells the two apart.
 */
const ownMoves = new Set<string>();

/**
 * Moves the ring and keeps where it went (the header says when the keys go into a text field);
 * says whether it moved: a key never drawn is refused once the bounded wait is over.
 */
async function focusOn($: EngineInterface, key: string): Promise<boolean> {
  ownMoves.add(key);
  try {
    const r = await $.ui.focus({ requestId: PANE, key }).catch(() => ({ deny: 'not drawn' }));
    if ('deny' in r) return false;
    await update($, focused, () => key);
    return true;
  } finally {
    ownMoves.delete(key);
  }
}

async function land($: EngineInterface) {
  const key = await landing($);
  if (key) await focusOn($, key);
}

async function reset($: EngineInterface) {
  await update($, confirm, () => null);
  await update($, expanded, () => []);
  await say($, null);
}

async function go($: EngineInterface, tab: AgentKnowledgeTab) {
  await update($, route, () => ({ tab, entry: null, session: null, trail: [] }));
  await reset($);
  await update($, shown, () => PAGE);
  await update($, rev, (n) => n + 1);
  await loadTab($).catch(async (err: Error) => say($, `✗ ${err.message}`));
  // The person asked for Search: with nothing found yet, the ring goes into its field.
  const s = tab === 'search' ? await read($, search) : null;
  if (tab === 'search' && !(s && s.entries.length + s.sessions.length > 0))
    return void focusOn($, `find:${await read($, rev)}`);
  void land($);
}

async function open($: EngineInterface, path: string) {
  const r = await read($, route);
  const trail = r.entry !== null && r.entry !== path ? [...r.trail, r.entry] : r.trail;
  await update($, route, () => ({ ...r, entry: path, session: null, trail }));
  await reset($);
  if ((await read($, page))?.path !== path) await update($, page, () => null);
  await loadTab($).catch(async (err: Error) => say($, `✗ ${err.message}`));
  void land($);
}

async function openSession($: EngineInterface, id: string, project: string) {
  await update($, route, (r) => ({ ...r, entry: null, session: { id, project }, trail: [] }));
  await reset($);
  if ((await read($, sessionPage))?.id !== id) await update($, sessionPage, () => null);
  await loadTab($).catch(async (err: Error) => say($, `✗ ${err.message}`));
  void land($);
}

async function back($: EngineInterface) {
  const r = await read($, route);
  const prev = r.trail.at(-1);
  await reset($);
  const from = r.entry;
  if (prev !== undefined) {
    await update($, route, () => ({ ...r, entry: prev, trail: r.trail.slice(0, -1) }));
    await loadTab($).catch(() => {});
    // Back on the page it came from, the ring goes to the link it followed.
    const pg = await read($, page);
    const link = pg?.path === prev ? pg.links.find((l) => l.path === from) : undefined;
    if (!link || !(await focusOn($, linkKey(prev, link)))) await land($);
    return;
  }
  await update($, route, () => ({ ...r, entry: null, session: null, trail: [] }));
  // Back on the list, the ring goes to the row it came from, when the shown page has it.
  if (from !== null && r.tab === 'browse') {
    const c = await read($, category);
    const rows = browseRows((await read($, list)) ?? [], c, await read($, filter));
    const isShown = rows.slice(0, await read($, shown)).some((e) => e.path === from);
    if (isShown && (await focusOn($, rowKey(c, from)))) return;
  }
  await land($);
}

/**
 * Searches entries and sessions for `q` and lands on the best hit. With none, a search typed
 * in the field (`fromField`) keeps the ring there to try again; one a command ran lands on a
 * button, so the next command typed never goes into the field.
 */
async function runSearch($: EngineInterface, q: string, fromField = false) {
  const query = q.trim();
  if (!query) return;
  await update($, busy, () => `searching "${query}"`);
  await say($, null);
  try {
    const [e, s] = await Promise.all([
      api($, `/api/knowledge/search?q=${enc(query)}&max_results=${ENTRY_HITS}`),
      api($, `/api/sessions/search?q=${enc(query)}&max_results=${SESSION_HITS}`).catch(() => []),
    ]);
    await update($, search, () => ({
      query,
      entries: arr(e).map((hit): AgentKnowledgeHit => {
        const x = (hit.entry ?? {}) as Json;
        return {
          kind: 'entry',
          path: String(x.path ?? ''),
          title: String(x.title ?? x.path ?? ''),
          category: String(x.category ?? ''),
          excerpt: String(hit.excerpt ?? ''),
        };
      }),
      sessions: arr(s).map(
        (hit): AgentKnowledgeHit => ({
          kind: 'session',
          id: String(hit.id ?? ''),
          project: String(hit.project ?? ''),
          when: String(hit.timestamp ?? ''),
          role: String(hit.role ?? 'unknown'),
          excerpt: String(hit.excerpt ?? ''),
        }),
      ),
    }));
  } catch (err) {
    await say($, `✗ search failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  await update($, rev, (n) => n + 1);
  await update($, busy, () => null);
  const found = await read($, search);
  const n = found ? found.entries.length + found.sessions.length : 0;
  if (found)
    await say($, n > 0 ? `✓ ${plural(n, 'hit')} for "${query}"` : `– no hits for "${query}"`);
  if (n === 0 && fromField) return void focusOn($, `find:${await read($, rev)}`);
  await land($);
}

/** Narrows the Browse list to `text` and lands on its first row. */
async function refilter($: EngineInterface, value: string) {
  await update($, filter, () => value.trim());
  await update($, shown, () => PAGE);
  await say($, null);
  await awaitDrawing($);
  await land($);
}

/**
 * Unfolds or folds a part of a page; the ring stays on its toggle (see `foldKey`).
 */
async function toggle($: EngineInterface, part: string) {
  await update($, expanded, (x) => (x.includes(part) ? x.filter((p) => p !== part) : [...x, part]));
  await focusOn($, foldKey(part, (await read($, expanded)).includes(part)));
}

/**
 * Opens the pane with the keys; an open one keeps its drawing (closing it first would draw
 * it empty until the next render). The command lands the ring itself afterwards, and the
 * cleared `focused` keeps the take from sending the ring back to where it was.
 */
async function openPane($: EngineInterface) {
  await update($, focused, () => null);
  return $.ui.open({ id: PANE, title: 'agent-knowledge', focus: true, rows: PANE_ROWS });
}

function actions($: EngineInterface): Actions {
  return {
    refresh: () => void act($, 'refresh', async () => ''),
    go: (tab) => void go($, tab),
    open: (path) => void open($, path),
    openSession: (id, project) => void openSession($, id, project),
    back: () => void back($),
    // Rows are keyed by their category: landing on the new list's first waits for its drawing.
    pickCategory: (c) =>
      void (async () => {
        await update($, category, () => c);
        await update($, shown, () => PAGE);
        await say($, null);
        if (!(await read($, list)))
          await loadList($).catch(async (err: Error) => say($, `✗ ${err.message}`));
        await land($);
      })(),
    filter: (v) => void refilter($, v),
    clearFilter: () => void refilter($, ''),
    more: () =>
      void (async () => {
        const before = await read($, shown);
        await update($, shown, (n) => n + PAGE);
        // The first row the page adds: the button's next key names the new state.
        let key: string | undefined;
        if ((await read($, route)).tab === 'sessions') {
          const s = ((await read($, sessions)) ?? [])[before];
          if (s) key = `sess:${s.id}`;
        } else {
          const c = await read($, category);
          const row = browseRows((await read($, list)) ?? [], c, await read($, filter))[before];
          if (row) key = rowKey(c, row.path);
        }
        if (!key || !(await focusOn($, key))) await land($);
      })(),
    search: (q) => void runSearch($, q, true),
    toggle: (part) => void toggle($, part),
    askDelete: (path) =>
      void (async () => {
        await update($, confirm, () => `delete:${path}`);
        await land($);
        // Delete is the page's last control: the end shows its confirmation whole.
        await $.ui.scroll({ in: PANE, to: 'end' }).catch(() => undefined);
      })(),
    remove: (path) =>
      void act($, `delete ${path}`, async () => {
        const r = await api($, `/api/knowledge/${enc(path)}`, 'DELETE');
        await update($, confirm, () => null);
        const rt = await read($, route);
        await update($, route, () => ({ ...rt, entry: null, trail: [] }));
        await update($, page, () => null);
        await update($, list, (l) => l && l.filter((e) => e.path !== path));
        // Without git there is nothing to push to: only a remote that refused is news.
        const git = r.git as Json | undefined;
        return git && git.success === false && (await read($, overview))?.hasGit
          ? `✓ deleted ${path} (not pushed: ${String(git.message ?? '').split('\n')[0]})`
          : `✓ deleted ${path}`;
      }),
    dismiss: () =>
      void (async () => {
        await update($, confirm, () => null);
        await focusOn($, 'ask-delete');
      })(),
    sync: () =>
      void act($, 'sync', async () => {
        const r = await api($, '/api/knowledge/sync', 'POST');
        const pull = (r.pull ?? {}) as Json;
        const push = (r.push ?? {}) as Json;
        if (pull.success === false || push.success === false) {
          const why = String((pull.success === false ? pull : push).message ?? '').split('\n')[0];
          throw new Error(`${pull.success === false ? 'pull' : 'push'}: ${why}`);
        }
        return '✓ synced with the remote';
      }),
    analyze: () =>
      void act($, 'analyzing links', async () => {
        const a = await api($, '/api/analysis');
        const next: AgentKnowledgeAnalysis = {
          hubs: arr(a.hubs).map((hub) => ({
            path: String(hub.path),
            title: String(hub.title ?? hub.path),
            edges: Number(hub.degree ?? 0),
          })),
          sparse: arr(a.sparse).map((g) => ({
            path: String(g.path),
            title: String(g.title ?? g.path),
            edges: Number(g.degree ?? 0),
          })),
        };
        await update($, analysis, () => next);
        return `✓ ${next.hubs.length} most linked, ${next.sparse.length} with one link or none`;
      }),
  };
}

/** A path that names an entry: has a category folder and ends in .md (or names one without). */
const isPath = (arg: string) => /^[\w.-]+\/.+/.test(arg) && !/\s/.test(arg);

export const register: Register = (on) => {
  let isPolling = false;
  let ticks = 0;
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'knowledge',
      description: 'The agent-knowledge base: browse entries, search, sessions, health',
      argumentHint: '[words to search, or an entry path]',
    });
    void refresh($);
    $.clock.every(TICK_MS, async () => {
      ticks += 1;
      const isShown = (await $.ui.panes()).some((p) => p.id === PANE && p.isPlaced);
      if (isPolling || !(isShown || ticks % IDLE_TICKS === 0)) return;
      isPolling = true;
      try {
        await refresh($);
      } finally {
        isPolling = false;
      }
    });

    return next(e);
  });

  on('command.run', { command: 'knowledge' }, async ($, e) => {
    const o = await refresh($);
    const lines = [
      o.isUp
        ? headline(o)
        : o.old
          ? `version ${o.old} holds ${o.origin} and cannot serve the pane: end the sessions still running it`
          : `nothing answers at ${o.origin}: is the agent-knowledge MCP server connected (/mcp)?`,
    ];
    const arg = e.args.trim();
    if (o.isUp && arg && isPath(arg)) {
      const path = arg.endsWith('.md') ? arg : `${arg}.md`;
      await update($, route, () => ({
        tab: 'browse' as const,
        entry: null,
        session: null,
        trail: [],
      }));
      await open($, path);
      const n = await read($, notice);
      const pg = await read($, page);
      if (n?.startsWith('✗')) lines.push(n.slice(2));
      else if (pg?.path === path) lines.push(`opened ${pg.title}`);
    } else if (o.isUp && arg) {
      await update($, route, () => ({
        tab: 'search' as const,
        entry: null,
        session: null,
        trail: [],
      }));
      await reset($);
      await runSearch($, arg);
      const s = await read($, search);
      if (s)
        lines.push(
          `${count(s.entries.length, 'entry', 'entries')} and ${count(s.sessions.length, 'session moment')} match "${arg}"`,
        );
    } else if (o.isUp) {
      const r = await read($, route);
      await update($, route, () => ({ ...r, entry: null, session: null, trail: [] }));
      await reset($);
      await update($, rev, (n) => n + 1);
      await loadTab($).catch(() => {});
    }
    const opened = await openPane($);
    if (!opened.isPlaced) lines.push(`pane not shown: ${opened.reason}`);
    else await land($);

    return { text: lines.join('\n') };
  });

  // Where the person moves the ring (Tab, a click): the header says when keys go into a field.
  // The pane taking the keyboard back (ctrl+x tab) puts the ring where it was, while drawn;
  // its autoFocus element is only where a fresh view starts.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const last = await read($, focused);
    if (
      e.origin.kind === 'plugin' &&
      !ownMoves.has(e.element ?? '') &&
      last &&
      last !== e.element
    ) {
      const backTo = await next({ ...e, element: last });
      if (!('deny' in backTo)) return backTo;
    }
    const r = await next(e);
    if (!('deny' in r)) await update($, focused, () => e.element ?? null);
    return r;
  });

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e);
    // Read at once, not one after another: the pane is drawn when the last read answers.
    const [o, ...rest] = await Promise.all([
      read($, overview),
      read($, route),
      read($, category),
      read($, filter),
      read($, list),
      read($, shown),
      read($, search),
      read($, sessions),
      read($, page),
      read($, sessionPage),
      read($, analysis),
      read($, expanded),
      read($, confirm),
      read($, rev),
      read($, busy),
      read($, notice),
      read($, focused),
      landing($),
    ] as const);
    if (!o) return <el.Text dimColor>Loading…</el.Text>;
    const [r, c, f, l, sh, se, ss, pg, sp, an, ex, cf, rv, bz, nt, fo, ld] = rest;

    return (
      <Pane
        el={el}
        overview={o}
        route={r}
        category={c}
        filter={f}
        list={l}
        shown={sh}
        search={se}
        sessions={ss}
        page={pg}
        sessionPage={sp}
        analysis={an}
        expanded={ex}
        confirm={cf}
        rev={rv}
        busy={bz}
        notice={nt}
        focused={fo}
        isFocused={e.props.isFocused}
        columns={e.props.bodyColumns}
        landing={ld}
        on={actions($)}
      />
    );
  });

  on('prompt.context', async ($, e, next) => {
    const r = await next(e);
    const o = (await read($, overview)) ?? (await refresh($));
    if (!o.isUp) return r;

    return { ...r, blocks: [...r.blocks, { name: 'agent-knowledge', text: contextText(o) }] };
  });
};

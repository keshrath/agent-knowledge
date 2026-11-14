// agent-knowledge inside Claude Code: the /knowledge pane (entries by category with their
// pages and links, search across entries and past sessions, recent sessions with their
// summaries, and the knowledge base's health: counts, git sync, link analysis, live
// events), a status line entry, toasts for live events (a session distilled), and the
// session's lifecycle: a context block with what the knowledge base holds, who the person is
// and whether the project's ingest is current; the knowledge hits for the first real prompt;
// a snapshot of the session when it is compacted and when it ends. Everything goes through
// the REST server every agent-knowledge MCP process shares (127.0.0.1:3423).
import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register } from 'claude-code';

import type {
  AgentKnowledgeAnalysis,
  AgentKnowledgeIngest,
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
  SNAPSHOTS,
  CATEGORIES,
  ENTRY_HITS,
  eventWords,
  drawable,
  sessionRows,
  isField,
  pinView,
  SESSION_HITS,
  ANALYSIS_PAGE,
  oneLine,
  browseRows,
  homeAsTilde,
  categoryOrder,
  foldKey,
  moveOf,
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
const sessionsTotal = atom({ plugin: 'agent-knowledge', key: 'sessionsTotal' } as const, 0);
const page = atom({ plugin: 'agent-knowledge', key: 'page' } as const, null);
const sessionPage = atom({ plugin: 'agent-knowledge', key: 'sessionPage' } as const, null);
const analysis = atom({ plugin: 'agent-knowledge', key: 'analysis' } as const, null);
const expanded = atom({ plugin: 'agent-knowledge', key: 'expanded' } as const, []);
const confirm = atom({ plugin: 'agent-knowledge', key: 'confirm' } as const, null);
const rev = atom({ plugin: 'agent-knowledge', key: 'rev' } as const, 0);
const busy = atom({ plugin: 'agent-knowledge', key: 'busy' } as const, null);
const notice = atom({ plugin: 'agent-knowledge', key: 'notice' } as const, null);
const focused = atom({ plugin: 'agent-knowledge', key: 'focused' } as const, null);
const injected = atom({ plugin: 'agent-knowledge', key: 'injected' } as const, null);
const draft = atom({ plugin: 'agent-knowledge', key: 'draft' } as const, null);
const pinned = atom({ plugin: 'agent-knowledge', key: 'pinned' } as const, null);
const findValue = atom({ plugin: 'agent-knowledge', key: 'findValue' } as const, '');
const ingest = atom({ plugin: 'agent-knowledge', key: 'ingest' } as const, null);

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

/** How long a call waits for the server by default; a git push or pull gets `GIT_MS`. */
const WAIT_MS = 10_000;
const GIT_MS = 60_000;
/** What the session's lifecycle waits: a prompt or the session's first message never waits more. */
const LIFECYCLE_MS = 2_000;

/**
 * A REST call that gives up after `waitMs`: a server that takes the connection and never
 * answers (a stuck process holding the port) reads as one that is not there.
 */
async function api(
  $: EngineInterface,
  path: string,
  method = 'GET',
  body?: unknown,
  waitMs = WAIT_MS,
): Promise<Json> {
  const request = $.http.fetch(`${await origin($)}${path}`, {
    method,
    ...(body !== undefined
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
  // Whichever loses the race settles unseen.
  request.catch(() => {});
  const timeout = $.clock.sleep(waitMs).then(
    () => null,
    () => null,
  );
  const res = await Promise.race([request, timeout]);
  if (res === null) throw new Error(`${method} ${path}: no answer in ${waitMs / 1000} s`);
  let data: Json = {};
  try {
    // The one door the server's text comes in by: nothing the pane cannot draw gets past it.
    data = JSON.parse(res.text, (_k, v: unknown) =>
      typeof v === 'string' ? drawable(v) : v,
    ) as Json;
  } catch {
    /* not JSON: the status says enough */
  }
  if (!res.ok)
    throw Object.assign(new Error(text(data.error) ?? `${method} ${path}: ${res.status}`), {
      status: res.status,
    });

  return data;
}

const DOWN = {
  categories: {},
  entries: 0,
  snapshots: 0,
  sessions: 0,
  vectors: 0,
  provider: null,
  events: [],
};

/** The overview, waiting `waitMs` at most (the pane polls every 5 s; a first message waits less). */
async function poll($: EngineInterface, waitMs = 5_000): Promise<AgentKnowledgeOverview> {
  const base = await origin($);
  try {
    const o = await api($, '/api/overview', 'GET', undefined, waitMs);
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
      snapshots: Number(o.snapshots ?? 0),
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
  const cats = [
    ...categoryOrder(o.categories).map((c) => `${c} ${o.categories[c]}`),
    ...(o.snapshots ? [`session snapshots ${o.snapshots}`] : []),
  ].join(', ');
  return (
    `agent-knowledge holds ${headline(o)}${cats ? ` (${cats})` : ''}. ` +
    'Before saying something is unknown or deciding how something was done, search it with knowledge_search; read an entry with knowledge (action "read"). ' +
    'The person browses it in /knowledge.'
  );
}

/** An AGENT_KNOWLEDGE_* switch set to 0, false or off. */
const isOff = (v: string | undefined) =>
  ['0', 'false', 'off'].includes((v ?? '').trim().toLowerCase());

/** A whole number from the environment, or `fallback` when unset or outside `lo`..`hi`. */
const envInt = (v: string | undefined, fallback: number, lo: number, hi: number) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : fallback;
};

/** The question the model asks once when the person has not said who they are. */
const onboarding = (dir: string) => {
  // A file in the folder, written with the folder's own separator.
  const at = (name: string) => `${dir}${/\\/.test(dir) && !/\//.test(dir) ? '\\' : '/'}${name}`;
  return [
    '--- Identity onboarding (no identity.md yet) ---',
    'The person has not said who they are. Before diving into their request, briefly ask:',
    '  1. Name + primary role',
    '  2. Main stack / tech focus',
    '  3. Projects they maintain',
    `Then use the Write tool to save their answers to \`${at('identity.md')}\` as short markdown.`,
    `If they say "skip" / "not now" / decline, use Write to create an empty file at \`${at('.identity-declined')}\` so this is not asked again.`,
    'Do not invent facts — only record what the person actually says.',
  ].join('\n');
};

/**
 * Who the person is (the wakeup's identity section), or the onboarding question while they
 * have not said; nothing once they declined or with AGENT_KNOWLEDGE_AUTOWAKE=0.
 */
async function identityText($: EngineInterface): Promise<string | null> {
  if (isOff(await $.env.get('AGENT_KNOWLEDGE_AUTOWAKE'))) return null;
  const budget = envInt(await $.env.get('AGENT_KNOWLEDGE_WAKEUP_BUDGET'), 200, 50, 4000);
  const w = await api(
    $,
    `/api/wakeup?sections=identity&budget=${budget}`,
    'GET',
    undefined,
    LIFECYCLE_MS,
  );
  if (w.onboarding === 'pending') return onboarding(String(w.memory_dir ?? '~/agent-knowledge'));
  const section = arr(w.sections).find((x) => x.name === 'identity');
  if (w.onboarding !== 'configured' || !section || section.empty) return null;

  return `--- Knowledge wakeup (identity only; call \`knowledge action=wakeup\` for L1 facts) ---\n${String(section.content)}`;
}

/**
 * The session's project against its knowledge-ingest, kept for the pane (Health, the empty
 * Browse); null for a folder too small to ingest or a server that did not answer.
 */
async function ingestState($: EngineInterface): Promise<AgentKnowledgeIngest | null> {
  const f = await api(
    $,
    `/api/ingest?cwd=${enc(await $.session.cwd())}`,
    'GET',
    undefined,
    LIFECYCLE_MS,
  ).catch(() => null);
  const state = f?.state;
  if (state !== 'never' && state !== 'stale' && state !== 'current') return null;
  const moved: Array<[number, string]> = [
    [Number(f!.changed ?? 0), 'changed'],
    [Number(f!.added ?? 0), 'new'],
    [Number(f!.removed ?? 0), 'deleted'],
  ];
  const next: AgentKnowledgeIngest = {
    state,
    project: String(f!.project ?? ''),
    dir: String(f!.dir ?? ''),
    files: state === 'never' ? Number(f!.files ?? 0) : moved.reduce((sum, [n]) => sum + n, 0),
    changes: moved
      .filter(([n]) => n > 0)
      .map(([n, what]) => `${n} ${what}`)
      .join(', '),
  };
  await update($, ingest, () => next);
  return next;
}

/** The project's ingest for the model: never done, or files changed since; else nothing. */
function ingestText(f: AgentKnowledgeIngest | null): string | null {
  if (f?.state === 'never')
    return `knowledge-ingest: project "${f.project}" (${f.files}+ source files) has not been ingested yet. Run \`/knowledge-ingest ${f.dir}\` to bootstrap the knowledge base.`;
  if (f?.state !== 'stale') return null;
  return `knowledge-ingest: project "${f.project}" has ${f.files} file changes since the last ingest (${f.changes}). Run \`/knowledge-ingest ${f.dir}\` to update.`;
}

/**
 * The same, for the person: the model is told not to narrate its context, so a project never
 * ingested, or behind, is said in a toast too (once, with the conversation's first message).
 */
function ingestToast(f: AgentKnowledgeIngest | null): string | null {
  if (f?.state === 'never')
    return `Not ingested: ${f.project} (/knowledge-ingest puts its code in the knowledge base)`;
  if (f?.state === 'stale') return `Ingest behind: ${f.project}, ${f.files} files changed since`;
  return null;
}

/** A prompt worth searching for: ten characters or more, not a command or a shell line. */
const isAsking = (t: string) => t.trim().length >= 10 && !/^[/!]/.test(t.trim());

/**
 * The knowledge hits for the conversation's first real prompt, as the model reads them, and
 * the line telling the person so. Once per conversation, spent by the first search answered:
 * a prompt the gates skip leaves it for the next one. Null when nothing is added.
 */
async function firstPromptHits(
  $: EngineInterface,
  prompt: string,
): Promise<{ context: string; receipt: string } | null> {
  if (isOff(await $.env.get('AGENT_KNOWLEDGE_FIRSTPROMPT_INJECT')) || !isAsking(prompt))
    return null;
  const id = await $.session.id();
  if ((await read($, injected)) === id) return null;
  const max = envInt(await $.env.get('AGENT_KNOWLEDGE_FIRSTPROMPT_MAX_HITS'), 2, 1, 2);
  const budget = envInt(await $.env.get('AGENT_KNOWLEDGE_FIRSTPROMPT_BUDGET'), 600, 100, 8000) * 4;
  // A pasted log or file is searched by its head: enough words to match on. `prompt=true`: the
  // server leaves out how the answer is to look ("one line, no tools").
  const q = enc(prompt.trim().slice(0, 1000));
  // A server down or failing leaves the injection for the next prompt (the caller fails open).
  const hits = arr(
    await api(
      $,
      `/api/knowledge/search?q=${q}&max_results=${max}&mmr=true&skip=sessions&prompt=true`,
      'GET',
      undefined,
      LIFECYCLE_MS,
    ),
  );
  await update($, injected, () => id);
  // Which hits answer the prompt the server decides (`prompt=true`: two at most, each near the
  // best, measured in tests/first-prompt-eval.test.ts).

  const header =
    '## Knowledge — top hits for your first prompt\n\n' +
    '_Injected automatically by agent-knowledge. Query these entries with `knowledge` (action=read, path=…) before deciding whether to issue a wider `knowledge_search`._\n\n';
  const lines: string[] = [];
  const titles: string[] = [];
  let used = header.length;
  for (const h of hits) {
    const path = String(h.entry?.path ?? '');
    if (lines.length === max) break;
    const score = typeof h.score === 'number' ? h.score.toFixed(2) : '?';
    const excerpt = String(h.excerpt ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 220);
    const line = `- **${h.entry?.title || path || '(untitled)'}** (\`${path}\`, score ${score}) — ${excerpt}`;
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    titles.push(oneLine(String(h.entry?.title || baseName(path))));
    used += line.length + 1;
  }
  if (lines.length === 0) return null;
  const more = titles.length > 2 ? `, +${titles.length - 2} more` : '';

  return {
    context: `${header}${lines.join('\n')}\n`,
    receipt: `${count(lines.length, 'entry', 'entries')} for this prompt: ${titles.slice(0, 2).join(', ')}${more}`,
  };
}

/** What a compaction's summary is asked to keep, so what was learnt can still be saved. */
const KEEP_KNOWLEDGE =
  'Keep, under a heading "Knowledge to save", each durable fact from this conversation not yet written to agent-knowledge: decisions, non-obvious gotchas, hard-won commands, people and ownership, project state. Leave out transient things (diffs, TODO lists, plans in flight). After the compaction they can be saved with knowledge (action "write").';

/** The session's snapshot in the knowledge base; the line saying where it went, or null. */
async function snapshot(
  $: EngineInterface,
  event: 'compact' | 'end',
  sessionId?: string,
): Promise<string | null> {
  const id = sessionId ?? (await $.session.id());
  const s = await api($, `/api/sessions/${enc(id)}/snapshot`, 'POST', {
    event,
    cwd: await $.session.cwd(),
  });
  if (typeof s.path !== 'string') return null;
  // A compaction's toast is shown here: the poll would say it again, so it is seen. The end's
  // is not: a toast from the conversation ending is not shown, so the next conversation's
  // first poll says it (as any other session's end).
  if (event === 'compact' && typeof s.event === 'number')
    seenEvent = Math.max(seenEvent ?? 0, s.event);

  // Worded as its live event is (eventWords), so a compaction and an end never read alike.
  return `${eventWords(event === 'end' ? 'session-end' : 'compact')}: ${String(s.title ?? s.path)}`;
}

/** The newest events since `seen`, as one toast: the news first (a toast cut short keeps it). */
function news(o: AgentKnowledgeOverview, seen: number): string | null {
  const fresh = o.events.filter((e) => e.id > seen).reverse();
  if (fresh.length === 0) return null;
  const said = fresh.slice(0, 3).map((e) => `${eventWords(e.kind)}: ${e.message}`);
  return `${said.join(' · ')}${fresh.length > 3 ? ` · +${fresh.length - 3} more` : ''}`;
}

/**
 * The overview's number (bumped with each one written) and the number the latest drawing read:
 * a move of the ring can wait for the drawing that shows the change (as /pipeline does).
 */
let version = 0;
let drawnVersion = 0;
const DRAW_WAIT_MS = 1_000;

async function drawingOf($: EngineInterface, v: number) {
  for (let waited = 0; drawnVersion < v && waited < DRAW_WAIT_MS; waited += 50)
    await $.clock.sleep(50);
}

/** The controls Browse draws above Find: the category buttons, by the folders there are. */
const barOf = (o: AgentKnowledgeOverview) =>
  JSON.stringify([categoryOrder(o.categories), o.snapshots > 0, o.entries === 0]);

/** When a key was last typed into a text field of the pane (Find, Search). */
let typedAt = 0;
/** A field is held and typed in this recently: the person is typing. */
const TYPING_MS = 1_500;

async function isTyping($: EngineInterface): Promise<boolean> {
  return isField(await read($, focused)) && (await $.clock.now()) - typedAt < TYPING_MS;
}

/** Where a conversation ended by /clear leaves the newest event it saw, for the next one. */
const SEEN_KEY = 'seen-event';
/** When a /clear last ended the conversation: news soon after it is the new one's line. */
let clearedAt = -Infinity;
const CLEARED_MS = 15_000;

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
  // The person is typing in a field: nothing drawn above it may change (a category's button
  // appearing would move the ring off the field, the next letters to the prompt). The next
  // poll draws it.
  if (prev?.isUp && next.isUp && (await isTyping($))) return prev;
  drawnPoll = n;
  // The ring in a field (Find), with the category bar above it about to change (a folder
  // written or emptied elsewhere): the engine keeps the ring by place, so it would land on a
  // button and the next keys on the prompt. Once the drawing is up it goes back to the field.
  const ring = await read($, focused);
  const isShifting =
    isField(ring) && prev?.isUp === true && next.isUp && barOf(prev) !== barOf(next);
  await update($, overview, () => next);
  version += 1;
  if (isShifting) {
    await drawingOf($, version);
    await focusOn($, ring!);
  }
  await showStatus($);
  if (next.isUp) {
    const newest = next.events.at(-1)?.id ?? 0;
    // A conversation's first poll is quiet (what happened before it is no news), unless the
    // one before it in this session (a /clear) left the mark it had seen: what came after
    // that, its own last snapshot among it, is news.
    // Started anew after a /clear: the ended conversation left what it had seen, and when.
    if (seenEvent === null) {
      const kept = (await $.store.get(SEEN_KEY).catch(() => undefined)) as
        | { seen?: unknown; at?: unknown }
        | undefined;
      if (typeof kept?.seen === 'number' && typeof kept.at === 'number') {
        seenEvent = kept.seen;
        clearedAt = kept.at;
        await $.store.delete(SEEN_KEY).catch(() => undefined);
      }
    }
    const isNew = (await $.clock.now()) - clearedAt < CLEARED_MS;
    if (seenEvent !== null) {
      const said = news(next, seenEvent);
      // In the conversation a /clear just started a toast is not drawn (the screen is new and
      // empty): what came meanwhile, the ended one's last snapshot, is its first line instead.
      if (said && isNew) $.ui.log(said);
      else if (said) $.ui.toast(said);
    }
    seenEvent = Math.max(seenEvent ?? 0, newest);
  }
  if (prev?.isUp && next.isUp && countsMoved(prev, next)) await followList($);
  if (prev?.isUp && next.isUp) await followPage($);
  if (prev?.isUp && !next.isUp) void land($);
  if (prev && !prev.isUp && next.isUp) {
    // What a Refresh said while down is past; an outcome said before a moment down still holds
    // (one slow poll reads as down: wiping it then took a fresh result line away).
    if ((await read($, notice))?.startsWith('✗')) await say($, null);
    await loadTab($).catch(() => {});
    void land($);
  } else if (next.isUp && (await isUnloaded($))) {
    // The view shown has nothing to draw yet: a new conversation (/clear) starts with the
    // pane's state anew, its list unread, while the pane stays open on it.
    await loadTab($).catch(() => {});
    await land($).catch(() => undefined);
  }

  return next;
}

/**
 * Whether the list shown waits for what it draws, and nothing is loading it (a page opening
 * loads itself: `open`, `openSession`; an open one follows its file: `followPage`).
 */
async function isUnloaded($: EngineInterface): Promise<boolean> {
  if (await read($, busy)) return false;
  const r = await read($, route);
  if (r.entry !== null || r.session !== null) return false;
  if (r.tab === 'browse') return (await read($, list)) === null;
  if (r.tab === 'sessions') return (await read($, sessions)) === null;
  return false;
}

const countsMoved = (a: AgentKnowledgeOverview, b: AgentKnowledgeOverview) =>
  a.entries !== b.entries ||
  a.snapshots !== b.snapshots ||
  JSON.stringify(a.categories) !== JSON.stringify(b.categories);

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
  const rows = await drawnRows($, c);
  const isShown = rows.slice(0, await read($, shown)).some((e) => rowKey(c, e.path) === held);
  if (!isShown || !(await focusOn($, held))) await land($);
}

/**
 * An open entry page follows its file: an edit made elsewhere shows on the next poll (its keys
 * unchanged, so the ring stays), and one deleted elsewhere takes the pane back to its tab,
 * said, rather than leaving a page whose Delete finds nothing. A pending Delete is left alone.
 */
async function followPage($: EngineInterface) {
  const r = await read($, route);
  if (r.entry === null || (await read($, page))?.path !== r.entry) return;
  if (await read($, busy)) return;
  // What an edit changes (an agent reading the entry changes only its reads).
  const written = (p: AgentKnowledgePage | null) => p && JSON.stringify([p.title, p.body, p.tags]);
  const was = written(await read($, page));
  try {
    await loadPage($, r.entry);
    if (written(await read($, page)) !== was) await say($, `! ${r.entry} changed elsewhere`);
  } catch (err) {
    if ((err as { status?: number }).status !== 404) return;
    await update($, route, (x) => ({ ...x, entry: null, trail: [] }));
    await update($, confirm, () => null);
    await say($, `! ${r.entry} was deleted elsewhere`);
    await loadTab($).catch(() => {});
    void land($);
  }
}

/** Browse's rows as drawn: the category, the Find and the order kept while the pane is held. */
async function drawnRows($: EngineInterface, c: string) {
  return browseRows((await read($, list)) ?? [], c, await read($, filter), await read($, pinned));
}

/**
 * Shows the row holding the ring whole: focusing a row's button scrolls only that line into
 * view, its facts beneath it left below the window.
 */
async function reveal($: EngineInterface, key: string) {
  await $.ui.scroll({ in: PANE, to: { key }, block: 'center' }).catch(() => undefined);
}

/** How often a search is tried while the server warms its index up, and how far apart. */
const WARM_TRIES = 4;
const WARM_WAIT_MS = 2_500;

/**
 * A search, asked again while the server says its index is still warming up (503, a server
 * just started on a large knowledge base): said meanwhile, not a failure.
 */
async function warmed($: EngineInterface, url: string): Promise<Json> {
  for (let n = 1; ; n++) {
    try {
      return await api($, url);
    } catch (err) {
      if ((err as { status?: number }).status !== 503 || n === WARM_TRIES) throw err;
      await update($, busy, () => 'Warming up the search index');
      await $.clock.sleep(WARM_WAIT_MS);
    }
  }
}

/**
 * Parks the ring on Refresh (harmless to press: it polls) before an action takes away the
 * control it is on, as /discover does: left in place, the ring would rest on whatever is drawn
 * there next, where Enter does something else.
 */
async function park($: EngineInterface) {
  await focusOn($, refreshKey(true, await read($, rev))).catch(() => undefined);
}

/**
 * A new drawing number: every control keyed by it (Find, the Search field, the rows' hit keys,
 * Refresh) is drawn anew. A field drawn anew shows what is applied (D1: never fed back while
 * typed in, seeded when made): Find the filter that narrows the list, Search the words typed
 * and not yet searched.
 */
async function bumpRev($: EngineInterface) {
  const f = await read($, filter);
  await update($, findValue, () => f);
  if (searchTyped !== null) {
    const t = searchTyped;
    await update($, draft, () => t);
  }
  await update($, rev, (n) => n + 1);
}

/** What was typed into the Search field and not searched yet: put back when it is drawn anew. */
let searchTyped: string | null = null;

/**
 * Waits for the drawing of what was just set: the held key is drawn already, so focusing it
 * alone would land before the redraw that moves it. Refresh's fresh key (a button, never a
 * text field) exists only in the next drawing; focusing it waits for that.
 */
async function awaitDrawing($: EngineInterface) {
  await bumpRev($);
  await focusOn($, refreshKey(true, await read($, rev)));
}

const entry = (e: Json): AgentKnowledgeEntry => ({
  path: String(e.path ?? ''),
  title: String(e.title ?? e.path ?? ''),
  // A session's record (a snapshot, a 2.x dump beside the entries) is a snapshot, as the server
  // counts it; a file at the top of the knowledge folder has no category folder: `other`.
  category:
    e.snapshot === true
      ? SNAPSHOTS
      : String(e.path ?? '').includes('/')
        ? String(e.path).split('/')[0]!
        : 'other',
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

/** The sessions, newest first: the first SESSIONS, or (`from` on) the next to add to them. */
async function loadSessions($: EngineInterface, from = 0) {
  const r = await api($, `/api/sessions?limit=${SESSIONS}&offset=${from}`);
  await update($, sessionsTotal, () => Number(r.total ?? 0));
  const before = from > 0 ? ((await read($, sessions)) ?? []) : [];
  await update($, sessions, () => [
    ...before,
    ...arr(r.sessions).map(
      (s): AgentKnowledgeSessionRow => ({
        id: String(s.sessionId ?? ''),
        project: String(s.project ?? ''),
        name: String(s.name ?? s.project ?? ''),
        start: String(s.startTime ?? 'unknown'),
        end: String(s.endTime ?? 'unknown'),
        messages: Number(s.messageCount ?? 0),
        prompts: Number(s.userMessageCount ?? 0),
        branch: String(s.branch ?? ''),
        preview: String(s.preview ?? ''),
      }),
    ),
  ]);
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
    session: snapshotOf(String(e.content ?? ''), e.session_on_machine !== false),
    links: arr(links)
      .map(
        (l): AgentKnowledgeLink => ({
          path: String(l.source === path ? l.target : l.source),
          title: text(l.title) ?? baseName(String(l.source === path ? l.target : l.source)),
          rel: String(l.rel_type ?? 'related_to'),
          direction: l.source === path ? 'out' : 'in',
          origin: String(l.origin ?? 'manual'),
          isMissing: l.missing === true,
        }),
      )
      .filter((l, i, all) => all.findIndex((x) => x.path === l.path && x.rel === l.rel) === i),
  };
  await update($, page, () => next);
}

/** A session snapshot's session, from its frontmatter; null for any other entry. */
function snapshotOf(content: string, isHere: boolean): AgentKnowledgePage['session'] {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? '';
  const field = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(fm)?.[1]?.trim() ?? '';
  if (field('type') !== 'session-snapshot' || !field('session')) return null;
  return {
    id: field('session'),
    cwd: field('cwd'),
    branch: field('branch'),
    started: field('started'),
    ended: field('last_activity'),
    isHere,
  };
}

async function loadSession($: EngineInterface, id: string, project: string) {
  const s = await api($, `/api/sessions/${enc(id)}/summary?project=${enc(project)}`);
  const m = (s.meta ?? {}) as Json;
  const next: AgentKnowledgeSessionPage = {
    id,
    project,
    name: String(s.name ?? project),
    start: String(m.startTime ?? 'unknown'),
    end: String(m.endTime ?? 'unknown'),
    messages: Number(m.messageCount ?? 0),
    prompts: Number(m.userMessageCount ?? 0),
    branch: String(m.branch ?? ''),
    preview: String(m.preview ?? ''),
    cwd: homeAsTilde(
      String(m.cwd ?? ''),
      (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')),
    ),
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
      await say($, `! ${r.entry} is no longer there`);
    }
    if ((await read($, route)).entry !== null) return;
  }
  if (r.session !== null) {
    try {
      await loadSession($, r.session.id, r.session.project);
    } catch (err) {
      if ((err as { status?: number }).status !== 404) throw err;
      await update($, route, (x) => ({ ...x, session: null }));
      await say($, "! that session's transcript is no longer on this machine");
    }
    if ((await read($, route)).session !== null) return;
  }
  if (r.tab === 'browse') await loadList($);
  if (r.tab === 'sessions') await loadSessions($);
  // Health says where this project's ingest stands; an empty Browse offers it as the next step.
  if (r.tab === 'health' || (await read($, overview))?.entries === 0) await ingestState($);
}

const NOTICE_MS = 10_000;
/** Notices by number: only the one still shown when its time is up is taken away. */
let notices = 0;

/**
 * The status entry: the outcome while the pane is shown (it may be scrolled out of view, or
 * the pane small), else the headline.
 */
async function showStatus($: EngineInterface) {
  const o = await read($, overview);
  if (!o) return;
  const said = await read($, notice);
  const isShown = said !== null && (await $.ui.panes()).some((p) => p.id === PANE && p.isPlaced);
  $.ui.status(
    isShown ? said : o.isUp ? headline(o) : o.old ? `old server ${o.old} on the port` : 'offline',
  );
}

/** Puts an outcome in the status line, or takes it away; it goes by itself after NOTICE_MS. */
async function say($: EngineInterface, said: string | null) {
  const n = ++notices;
  await update($, notice, () => said);
  await showStatus($);
  if (said)
    void $.clock
      .sleep(NOTICE_MS)
      .then(async () => (n === notices ? say($, null) : undefined))
      .catch(() => undefined);
}

/**
 * Runs one action with its busy line (`doing`: "Syncing") and outcome (`what` failed: "sync
 * failed: …"), then reloads and lands the focus.
 */
async function act(
  $: EngineInterface,
  doing: string,
  what: string,
  fn: () => Promise<string>,
  after: 'land' | 'refresh' = 'land',
) {
  const since = claims;
  await update($, busy, () => doing);
  await say($, null);
  try {
    await say($, (await fn()) || null);
  } catch (err) {
    await say($, `✗ ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const o = await refresh($);
  if (!o.isUp && !(await read($, notice)))
    await say(
      $,
      `✗ still nothing answers at ${o.origin} (${new Date().toTimeString().slice(0, 8)})`,
    );
  await loadTab($).catch(() => {});
  await update($, busy, () => null);
  if (after === 'refresh') {
    // Where nothing is pressed by a repeated Enter: Refresh, harmless (an entry, the next row
    // of the list, would open).
    viewChangedAt = await $.clock.now();
    if (since === claims) await focusOn($, refreshKey(true, await read($, rev)));
  } else void land($, since);
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
    // The first past session something was asked in: this one is where the person already is.
    const me = await $.session.id();
    const first = sessionRows((await read($, sessions)) ?? [], await read($, expanded)).find(
      (s) => s.id !== me,
    );
    return first ? `sess:${first.id}` : 'tab:sessions';
  }
  if (r.tab === 'health') {
    return (await read($, analysis)) ? 'analyze:again' : 'analyze:first';
  }
  if (o.entries === 0 && o.snapshots > 0 && (await read($, category)) !== SNAPSHOTS)
    return `cat:${SNAPSHOTS}`;
  if (o.entries === 0 && o.snapshots === 0) {
    const f = await read($, ingest);
    return f && f.state !== 'current' ? 'ingest' : 'tab:browse';
  }
  const c = await read($, category);
  const q = await read($, filter);
  const first = (await drawnRows($, c))[0];
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

/** A new view starts at its top: the tab bar and the outcome line in sight. */
async function toTop($: EngineInterface) {
  await $.ui.scroll({ in: PANE, to: 'start' }).catch(() => undefined);
}

/**
 * Lands the ring on `landing()`, unless the person said otherwise meanwhile: a press, or a
 * move of theirs, after `since` (the claim the action that lands began with) wins, as in
 * /pipeline. The view changed: a risky press right after it is held (`isGuarded`).
 */
async function land($: EngineInterface, since?: number) {
  viewChangedAt = await $.clock.now();
  if (since !== undefined && since !== claims) return;
  const key = await landing($);
  if (key && (since === undefined || since === claims)) await focusOn($, key);
}

/**
 * Every say over where the ring goes, counted: the person's presses and their own moves (Tab,
 * a click). A landing is decided once its view is loaded and drawn, which takes a while; a
 * press that came meanwhile wins over it.
 */
let claims = 0;

/**
 * When the controls last changed: a press on a risky control this soon after went to whatever
 * the new drawing put at the ring's place, or is the second of a double press, and is held.
 */
let viewChangedAt = -Infinity;
const PRESS_GUARD_MS = 400;

/** The command the pane last put in the prompt, and when: Enter this soon after did not read it. */
let filled: { text: string; at: number; held: number } | null = null;

/**
 * The controls a stray press must not reach: they push to git, put a command in the prompt, or
 * delete (Delete on a page only asks: it is free).
 */
const isGuarded = (key: string) => /^(?:sync|ingest|confirm-yes)$/.test(key);

/**
 * The ways off a page, where the ring lands as a page opens: one pressed this soon after the
 * press before it is the same burst of Enter (80 ms apart), not a back the person chose.
 */
const isWayOff = (key: string) => /^(?:back|open-session)$/.test(key);
const BURST_MS = 250;
let pressedAt = -Infinity;

async function reset($: EngineInterface) {
  await update($, confirm, () => null);
  await update($, expanded, () => []);
  await say($, null);
}

async function go($: EngineInterface, tab: AgentKnowledgeTab) {
  const since = claims;
  const was = await read($, route);
  const isAgain = was.tab === tab && was.entry === null && was.session === null;
  await update($, route, () => ({ tab, entry: null, session: null, trail: [] }));
  await reset($);
  const o = await read($, overview);
  // Down, the tab is taken (it shows once the server answers), and that is said.
  if (o && !o.isUp)
    await say($, `– ${tab.charAt(0).toUpperCase()}${tab.slice(1)} shows once the server answers`);
  await update($, shown, () => PAGE);
  await update($, pinned, () => null);
  await bumpRev($);
  await loadTab($).catch(async (err: Error) => say($, `✗ ${err.message}`));
  await toTop($);
  // Search pressed while on Search (2 again, Enter on its tab) asks to type: the ring goes into
  // the field. Getting to the tab alone does not, so the hotkeys still work there.
  if (tab === 'search' && isAgain) {
    // Typing: the field holds the last search's words, to edit or replace.
    await update($, draft, () => null);
    await bumpRev($);
    return void focusOn($, `find:${await read($, rev)}`);
  }
  void land($, since);
}

/**
 * Opens an entry's page, showing it loading meanwhile. One that is not there (deleted
 * elsewhere, a link left behind) is said where the person was: the page, list or search they
 * opened it from comes back, its trail and the ring on what they pressed.
 */
async function open($: EngineInterface, path: string, isTyped = false) {
  const r = await read($, route);
  const held = await read($, focused);
  const trail = r.entry !== null && r.entry !== path ? [...r.trail, r.entry] : r.trail;
  await update($, route, () => ({ ...r, entry: path, session: null, trail }));
  await reset($);
  await toTop($);
  if ((await read($, page))?.path !== path) {
    try {
      await loadPage($, path);
    } catch (err) {
      await update($, route, () => r);
      const isGone = (err as { status?: number }).status === 404;
      // Pressed in the pane, it was there when drawn: gone since. Typed, it may never have been.
      await say(
        $,
        !isGone
          ? `✗ ${(err as Error).message}`
          : isTyped
            ? `✗ there is no entry ${path}`
            : `! ${path} is no longer there`,
      );
      if (!held || !(await focusOn($, held))) await land($);
      return;
    }
  }
  void land($);
}

async function openSession($: EngineInterface, id: string, project: string) {
  await update($, route, (r) => ({
    ...r,
    entry: null,
    session: { id, project },
    trail: r.entry !== null ? [...r.trail, r.entry] : [],
  }));
  await reset($);
  await toTop($);
  if ((await read($, sessionPage))?.id !== id) await update($, sessionPage, () => null);
  await loadTab($).catch(async (err: Error) => say($, `✗ ${err.message}`));
  void land($);
}

async function back($: EngineInterface) {
  const r = await read($, route);
  const prev = r.trail.at(-1);
  // The view changes: an Enter of the same burst reaching where the ring lands is held.
  viewChangedAt = await $.clock.now();
  await reset($);
  await toTop($);
  const from = r.entry;
  if (r.session !== null && r.tab === 'search') {
    await update($, route, () => ({ ...r, entry: null, session: null, trail: [] }));
    const s = await read($, search);
    const i = s?.sessions.findIndex((h) => h.kind === 'session' && h.id === r.session!.id) ?? -1;
    const hit = i >= 0 ? s!.sessions[i] : undefined;
    if (!hit || !(await focusOn($, hitKey(await read($, rev), hit, s!.entries.length + i))))
      await land($);
    return;
  }
  // Back on Sessions, the ring goes to the session's row (a folded one: the landing).
  if (r.session !== null && r.tab === 'sessions' && prev === undefined) {
    await update($, route, () => ({ ...r, entry: null, session: null, trail: [] }));
    if (!(await focusOn($, `sess:${r.session.id}`))) await land($);
    return;
  }
  if (prev !== undefined) {
    await update($, route, () => ({
      ...r,
      entry: prev,
      session: null,
      trail: r.trail.slice(0, -1),
    }));
    await loadTab($).catch(() => {});
    // Back on the page it came from, the ring goes to what it pressed: the link it followed,
    // or Open the session.
    if (r.session !== null && (await focusOn($, 'open-session'))) return;
    const pg = await read($, page);
    const link = pg?.path === prev ? pg.links.find((l) => l.path === from) : undefined;
    if (!link || !(await focusOn($, linkKey(prev, link)))) await land($);
    return;
  }
  await update($, route, () => ({ ...r, entry: null, session: null, trail: [] }));
  // Back on the list, the ring goes to the row it came from, when the shown page has it.
  if (from !== null && r.tab === 'browse') {
    const c = await read($, category);
    const rows = await drawnRows($, c);
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
  searchTyped = null;
  await update($, draft, () => null);
  if (!query) return;
  // Out of the field while it runs: a key typed meanwhile is a hotkey, not text in the field.
  if (fromField) await park($);
  const since = claims;
  await update($, busy, () => `Searching "${query}"`);
  await say($, null);
  try {
    const [e, s] = await Promise.all([
      warmed($, `/api/knowledge/search?q=${enc(query)}&max_results=${ENTRY_HITS}`),
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
          name: String(hit.name ?? hit.project ?? ''),
          when: String(hit.timestamp ?? ''),
          role: String(hit.role ?? 'unknown'),
          excerpt: String(hit.excerpt ?? ''),
        }),
      ),
    }));
  } catch (err) {
    await say($, `✗ search failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  await bumpRev($);
  await update($, busy, () => null);
  const found = await read($, search);
  const n = found ? found.entries.length + found.sessions.length : 0;
  if (found)
    // No hit is said once, where the hits would be.
    await say($, n > 0 ? `✓ ${plural(n, 'hit')} for "${query}"` : null);
  if (n === 0 && fromField && since === claims)
    return void focusOn($, `find:${await read($, rev)}`);
  await land($, since);
}

/** Narrows the Browse list to `text` and lands on its first row. */
async function refilter($: EngineInterface, value: string) {
  await update($, filter, () => value.trim());
  await update($, findValue, () => value.trim());
  await update($, shown, () => PAGE);
  await update($, pinned, () => null);
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
 * Opens the pane afresh, as /pipeline does: `$.ui.open` on an open pane gives it the keyboard
 * back and a take restores the ring to the element it last held, so the view the command just
 * set would start on a control of the old one. Closed first, it starts at its own landing;
 * the cleared `focused` keeps the take from sending the ring back, `pinned` sorts it afresh.
 */
async function openPane($: EngineInterface) {
  await $.ui.close({ id: PANE }).catch(() => undefined);
  await update($, focused, () => null);
  await update($, pinned, () => null);
  return $.ui.open({ id: PANE, title: 'agent-knowledge', focus: true, rows: PANE_ROWS });
}

/**
 * A press whose button was drawn again as it came, carried out by its key when it only moves
 * (`moveOf`): true. A press that changes something is not guessed at: false.
 */
async function pressByKey($: EngineInterface, key: string): Promise<boolean> {
  const m = moveOf(key);
  if (!m) return false;
  const on = actions($);
  if ('tab' in m) await go($, m.tab);
  else if ('entry' in m) await open($, m.entry);
  else if ('session' in m) {
    const hit = (await read($, search))?.sessions.find(
      (x) => x.kind === 'session' && x.id === m.session,
    );
    const project =
      (await read($, sessions))?.find((x) => x.id === m.session)?.project ??
      (hit?.kind === 'session' ? hit.project : '');
    await openSession($, m.session, project);
  } else if ('pageSession' in m) {
    const id = (await read($, page))?.session?.id;
    if (!id) return false;
    await openSession($, id, '');
  } else if ('category' in m) on.pickCategory(m.category);
  else if ('more' in m) on.more();
  else if ('analyzeMore' in m) on.analyzeMore();
  else if ('fold' in m) await toggle($, m.fold);
  else if ('back' in m) await back($);
  else on.refresh();
  return true;
}

function actions($: EngineInterface): Actions {
  return {
    refresh: () => void act($, 'Refreshing', 'refresh', async () => ''),
    go: (tab) => void go($, tab),
    open: (path) => void open($, path),
    openSession: (id, project) => void openSession($, id, project),
    back: () => void back($),
    // Rows are keyed by their category: landing on the new list's first waits for its drawing.
    pickCategory: (c) =>
      void (async () => {
        await update($, category, () => c);
        await update($, shown, () => PAGE);
        await update($, pinned, () => null);
        await say($, null);
        if (!(await read($, list)))
          await loadList($).catch(async (err: Error) => say($, `✗ ${err.message}`));
        // The rows are keyed by category: the ring lands once the new list is drawn.
        await awaitDrawing($);
        await land($);
      })(),
    filter: (v) => void refilter($, v),
    narrow: (v) =>
      void (async () => {
        typedAt = await $.clock.now();
        await update($, filter, () => v.trim());
        await update($, shown, () => PAGE);
        await update($, pinned, () => null);
      })(),
    clearFilter: () => void refilter($, ''),
    more: () =>
      void (async () => {
        const before = await read($, shown);
        await update($, shown, (n) => n + PAGE);
        // The first row the page adds: the button's next key names the new state.
        let key: string | undefined;
        if ((await read($, route)).tab === 'sessions') {
          // Past the sessions loaded, the next ones come from the server.
          const loaded = (await read($, sessions)) ?? [];
          if (
            sessionRows(loaded, await read($, expanded)).length < before + PAGE &&
            loaded.length < (await read($, sessionsTotal))
          )
            await loadSessions($, loaded.length).catch(async (err: Error) =>
              say($, `✗ ${err.message}`),
            );
          const s = sessionRows((await read($, sessions)) ?? [], await read($, expanded))[before];
          if (s) key = `sess:${s.id}`;
        } else {
          const c = await read($, category);
          const row = (await drawnRows($, c))[before];
          if (row) key = rowKey(c, row.path);
        }
        if (!key || !(await focusOn($, key))) await land($);
        else await reveal($, key);
      })(),
    search: (q) => void runSearch($, q, true),
    typing: (text) =>
      void $.clock.now().then((t) => {
        typedAt = t;
        searchTyped = text;
      }),
    toggle: (part) => void toggle($, part),
    askDelete: (path) =>
      void (async () => {
        await update($, confirm, () => `delete:${path}`);
        await land($);
        // Delete is the page's last control: the end shows its confirmation whole.
        await $.ui.scroll({ in: PANE, to: 'end' }).catch(() => undefined);
      })(),
    remove: (path) =>
      void act(
        $,
        `Deleting ${path}`,
        `delete ${path}`,
        async () => {
          // The confirmation goes with the page: until the list is drawn and the ring lands, it
          // waits on Refresh, never on what would be in its place (a category, a row).
          await park($);
          const r = await api($, `/api/knowledge/${enc(path)}`, 'DELETE', undefined, GIT_MS);
          await update($, confirm, () => null);
          const rt = await read($, route);
          await update($, route, () => ({ ...rt, entry: null, trail: [] }));
          await update($, page, () => null);
          await update($, list, (l) => l && l.filter((e) => e.path !== path));
          await update(
            $,
            search,
            (s) =>
              s && {
                ...s,
                entries: s.entries.filter((h) => h.kind !== 'entry' || h.path !== path),
              },
          );
          await toTop($);
          // Without git there is nothing to push to: only a remote that refused is news.
          const git = r.git as Json | undefined;
          return git && git.success === false && (await read($, overview))?.hasGit
            ? `! deleted ${path}, not pushed: ${String(git.message ?? '').split('\n')[0]}`
            : `✓ deleted ${path}`;
        },
        'refresh',
      ),
    dismiss: () =>
      void (async () => {
        await update($, confirm, () => null);
        await focusOn($, 'ask-delete');
      })(),
    sync: () =>
      void act($, 'Syncing', 'sync', async () => {
        const r = await api($, '/api/knowledge/sync', 'POST', undefined, GIT_MS);
        const pull = (r.pull ?? {}) as Json;
        const push = (r.push ?? {}) as Json;
        if (pull.success === false || push.success === false) {
          const why = String((pull.success === false ? pull : push).message ?? '').split('\n')[0];
          const failed = `${pull.success === false ? 'pull' : 'push'}: ${why}`;
          // Kept under Recent activity (the outcome goes in 10 s); this session saw it already.
          const evt = await api($, '/api/events', 'POST', {
            kind: 'sync-failed',
            message: failed.slice(0, 512),
          }).catch(() => null);
          if (evt && typeof evt.id === 'number') seenEvent = Math.max(seenEvent ?? 0, evt.id);
          throw new Error(failed);
        }
        return '✓ synced with the remote';
      }),
    ingest: () =>
      void (async () => {
        const f = await read($, ingest);
        if (!f) return;
        const text = `/knowledge-ingest ${f.dir}`;
        // The prompt takes the keys with the text (a pane cannot take them back over a draft):
        // an Enter of the same burst reaches it, and is held at command.run. Marked before the
        // fill: the box takes the text and the keys before the fill's answer comes back.
        filled = { text, at: await $.clock.now(), held: 0 };
        if (!(await $.prompt.fill({ text })).isFilled) return void (filled = null);
        await say($, '– /knowledge-ingest is in the prompt: Enter runs it');
      })(),
    analyze: () =>
      void act($, 'Analyzing links', 'analyze', async () => {
        const next = await loadAnalysis($, 0);
        await update($, analysis, () => next);
        const o = await read($, overview);
        if (o && o.entries === 0) return '– no entries to analyze';
        return `✓ ${next.hubs.length} most linked, ${next.sparseTotal} with one link or none`;
      }),
    analyzeMore: () =>
      void (async () => {
        const was = await read($, analysis);
        if (!was) return;
        try {
          const page = await loadAnalysis($, was.sparse.length);
          await update($, analysis, () => ({
            ...page,
            sparse: [...was.sparse, ...page.sparse],
          }));
        } catch (err) {
          await say($, `✗ analyze failed: ${(err as Error).message}`);
        }
        // The first row the page adds holds the ring.
        const first = (await read($, analysis))?.sparse[was.sparse.length];
        if (!first || !(await focusOn($, `sparse:${first.path}`))) await land($);
        else await reveal($, `sparse:${first.path}`);
      })(),
  };
}

/** The link analysis, its One link or none from `offset` on, a page of it. */
async function loadAnalysis($: EngineInterface, offset: number): Promise<AgentKnowledgeAnalysis> {
  const a = await api($, `/api/analysis?offset=${offset}&limit=${ANALYSIS_PAGE}`);
  return {
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
    sparseTotal: Number(a.sparse_total ?? arr(a.sparse).length),
  };
}

/** What a search found, in words: `3 entries and 2 past-session messages for "x"`. */
function foundWords(s: { entries: unknown[]; sessions: unknown[] }, q: string) {
  const parts = [
    s.entries.length ? count(s.entries.length, 'entry', 'entries') : '',
    s.sessions.length ? count(s.sessions.length, 'past-session message') : '',
  ].filter(Boolean);
  return parts.length ? `${parts.join(' and ')} for "${q}"` : `nothing found for "${q}"`;
}

/**
 * A path that names an entry, not words to search: no spaces, and `.md` at its end or a
 * folder of the knowledge base first (`notes/x`). `tools/gitbook-sync` is words: no `tools/`.
 */
const isPath = (arg: string, o: AgentKnowledgeOverview) => {
  if (/\s/.test(arg)) return false;
  if (/\.md$/i.test(arg)) return true;
  const folder = /^([\w.-]+)\/./.exec(arg)?.[1];
  return folder !== undefined && isFolder(folder, o);
};

/** A folder of the knowledge base: one with entries, the snapshots', or a known category. */
const isFolder = (folder: string, o: AgentKnowledgeOverview) =>
  folder in o.categories || folder === SNAPSHOTS || CATEGORIES.includes(folder);

export const register: Register = (on) => {
  let isPolling = false;
  let ticks = 0;
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'knowledge',
      description: 'The agent-knowledge base: browse entries, search, sessions, health',
      argumentHint: '[words to search, or an entry path]',
    });
    // Not awaited: the session starts without waiting on the server. A reload or the session
    // ending while it is in flight leaves no one to tell.
    refresh($).catch(() => {});
    $.clock.every(TICK_MS, async () => {
      ticks += 1;
      const pane = (await $.ui.panes()).find((p) => p.id === PANE);
      const isShown = pane?.isPlaced === true;
      if (isPolling || !(isShown || ticks % IDLE_TICKS === 0)) return;
      isPolling = true;
      try {
        // Held, the pane keeps the order it was drawn in (pinned before this poll can change
        // it); given back to the prompt, it sorts afresh.
        if (!pane?.isFocused) await update($, pinned, () => null);
        else if (!(await read($, pinned))) {
          const c = await read($, category);
          const view = pinView(c, await read($, filter));
          const paths = (await drawnRows($, c)).map((e) => e.path);
          await update($, pinned, () => ({ view, paths }));
        }
        await refresh($);
      } finally {
        isPolling = false;
      }
    });

    return next(e);
  });

  // The command Ingest put in the prompt, run by an Enter of the same burst (the prompt took
  // the keys with the text): not read, so not run; it goes back in the prompt. Matched by name:
  // a hook in every command's chain would hold /clear's own (its transcript lines lost).
  const INGEST = { command: /(?:^|:)knowledge-ingest$/, origin: { kind: 'composer' } } as const;
  on('command.run', INGEST, async ($, e, next) => {
    const put = filled;
    const now = await $.clock.now();
    if (!put || now - put.at >= PRESS_GUARD_MS) return next(e);
    // Every Enter of the burst is held, each one keeping the window open; said once.
    filled = { ...put, at: now, held: put.held + 1 };
    void $.prompt.fill({ text: put.text }).catch(() => undefined);
    return put.held
      ? {}
      : { text: 'Not run: that Enter came with the command. Read it, then press Enter.' };
  });

  on('command.run', { command: 'knowledge' }, async ($, e) => {
    const o = await refresh($);
    const arg = e.args.trim();
    // The reply goes to the model too: it says something only when something is wrong (or the
    // pane could not be shown, so the reply is all there is).
    const lines = o.isUp
      ? []
      : [
          o.old
            ? `version ${o.old} holds ${o.origin} and cannot serve the pane: end the sessions still running it`
            : `nothing answers at ${o.origin}: is the agent-knowledge MCP server connected (/mcp)?`,
        ];
    const folder = /^([\w.-]+)\/$/.exec(arg)?.[1];
    if (o.isUp && folder && isFolder(folder, o)) {
      // A folder with its slash: Browse, narrowed to it.
      await update($, route, () => ({
        tab: 'browse' as const,
        entry: null,
        session: null,
        trail: [],
      }));
      await update($, filter, () => '');
      await update($, findValue, () => '');
      await update($, category, () => folder);
      await reset($);
      await bumpRev($);
      await loadTab($).catch(() => {});
    } else if (o.isUp && arg && isPath(arg, o)) {
      const path = arg.endsWith('.md') ? arg : `${arg}.md`;
      // The list behind the page (‹ Browse) is every entry, not a Find left from before.
      await update($, filter, () => '');
      await update($, findValue, () => '');
      await update($, category, () => 'all');
      await update($, route, () => ({
        tab: 'browse' as const,
        entry: null,
        session: null,
        trail: [],
      }));
      await open($, path, true);
      // Not there: the list it was asked from shows, with what was said.
      if ((await read($, route)).entry === null) await loadTab($).catch(() => {});
      const n = await read($, notice);
      if (n && /^[✗!]/.test(n)) lines.push(n.slice(2));
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
      if (s && s.entries.length + s.sessions.length === 0) lines.push(foundWords(s, arg));
    } else if (o.isUp) {
      // Plain /knowledge is Browse, every entry: a Find or category left from before is cleared.
      await update($, route, () => ({
        tab: 'browse' as const,
        entry: null,
        session: null,
        trail: [],
      }));
      await update($, filter, () => '');
      await update($, findValue, () => '');
      await update($, category, () => 'all');
      await reset($);
      await bumpRev($);
      await loadTab($).catch(() => {});
    }
    const opened = await openPane($);
    if (!opened.isPlaced) {
      if (o.isUp) {
        lines.unshift(headline(o));
        const s = await read($, search);
        if (arg && !isPath(arg, o) && s && s.entries.length + s.sessions.length > 0)
          lines.push(foundWords(s, arg));
      }
      lines.push(`pane not shown: ${opened.reason}`);
    } else await land($);

    return lines.length ? { text: lines.join('\n') } : {};
  });

  // Where the person moves the ring (Tab, a click): the header says when keys go into a field.
  // The pane taking the keyboard back (ctrl+x tab) puts the ring where it was, while drawn;
  // its autoFocus element is only where a fresh view starts.
  // A press of the person's is a claim (a landing still on its way yields to it); one on a
  // risky control right after the view changed, or as the second of a double press, is held.
  on('ui.press', { requestId: PANE }, async ($, e, next) => {
    claims += 1;
    const key = e.element ?? '';
    const now = await $.clock.now();
    const sinceChange = Math.round(now - viewChangedAt);
    const sincePress = now - pressedAt;
    pressedAt = now;
    // Every press, in the debug log (--debug-file): what it reached and what came of it.
    const trace = (outcome: string) =>
      $.ui.log(
        `agent-knowledge press ${key}: ${outcome} (${sinceChange} ms since the view changed)`,
        {
          to: 'debug',
        },
      );
    if (
      (isGuarded(key) && sinceChange < PRESS_GUARD_MS) ||
      (isWayOff(key) && sincePress < BURST_MS)
    ) {
      trace('held by the guard');
      await say($, '– that press came as the view changed: nothing was done, press it again');
      return { element: e.element };
    }
    try {
      const r = await next(e);
      trace('handled');
      return r;
    } catch (err) {
      // The key reached the drawing before the one now up: its button's handler went with it.
      // A move is carried out by its key; a press that changes something is said, never lost.
      const moved = await pressByKey($, key);
      trace(
        `its handler was gone (${err instanceof Error ? err.message : String(err)}): ${moved ? 'carried out by key' : 'said'}`,
      );
      if (!moved) await say($, '– that button was drawn again as you pressed it: press it again');
      return { element: e.element };
    }
  });

  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    if (e.origin.kind !== 'plugin') claims += 1;
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
    const seen = version;
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
      read($, draft),
      read($, pinned),
      read($, ingest),
      $.session.id(),
      read($, sessionsTotal),
      read($, findValue),
    ] as const);
    if (!o) return <el.Progress label="agent-knowledge" valueText="connecting…" />;
    const [r, c, f, l, sh, se, ss, pg, sp, an, ex, cf, rv, bz, nt, fo, ld, dr, pn, ig, me, st, fv] =
      rest;

    drawnVersion = Math.max(drawnVersion, seen);
    return (
      <Pane
        el={el}
        overview={o}
        route={r}
        category={c}
        filter={f}
        list={l}
        pinned={pn}
        ingest={ig}
        current={me}
        sessionsTotal={st}
        findValue={fv}
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
        draft={dr}
        on={actions($)}
      />
    );
  });

  // The conversation's first message: what the knowledge base holds, who the person is (or the
  // question to ask them) and the project's ingest. Each part fails open on its own.
  on('prompt.context', async ($, e, next) => {
    const r = await next(e);
    const o = (await read($, overview)) ?? (await poll($, LIFECYCLE_MS));
    if (!o.isUp) return r;
    const [who, f] = await Promise.all([identityText($).catch(() => null), ingestState($)]);
    const text = [contextText(o), who, ingestText(f)].filter((p) => p !== null).join('\n\n');
    const said = ingestToast(f);
    if (said) $.ui.toast(said);

    return { ...r, blocks: [...r.blocks, { name: 'agent-knowledge', text }] };
  });

  // The first real prompt of a conversation carries the entries that match it; a background
  // task's notice or another session's message is no one asking.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || e.origin.kind === 'task-notification' || e.origin.kind === 'peer')
      return next(e);
    const hits = await firstPromptHits($, e.text).catch(() => null);
    if (!hits) return next(e);
    const r = await next({ ...e, context: [...(e.context ?? []), hits.context] });
    // Once the prompt entered: the line reads under it.
    $.ui.log(hits.receipt);

    return r;
  });

  // A compaction of the main conversation: the snapshot is taken while the transcript is
  // whole, and the summary keeps what is still to be saved. AGENT_KNOWLEDGE_PRECOMPACT_NUDGE=0
  // leaves the summary alone, =off does neither.
  on('session.compact', async ($, e, next) => {
    const mode = await $.env.get('AGENT_KNOWLEDGE_PRECOMPACT_NUDGE');
    if (e.agentId || mode?.trim().toLowerCase() === 'off') return next(e);
    const taken = e.trigger === 'precompute' ? null : snapshot($, 'compact').catch(() => null);
    const r = await next(
      isOff(mode)
        ? e
        : { ...e, instructions: [e.instructions, KEEP_KNOWLEDGE].filter(Boolean).join('\n\n') },
    );
    const said = await taken;
    if (said) $.ui.toast(said);

    return r;
  });

  // The session's last snapshot, inside the end's short bound; after a /clear the session
  // goes on, so a toast says where it went.
  // The conversation ending takes its last snapshot; its toast comes from the next
  // conversation's first poll (a /clear), or nowhere (the session closing).
  on('session.end', async ($, e, next) => {
    // The next conversation goes on from what this one saw (its toast of this end included).
    if (e.reason === 'clear') {
      clearedAt = await $.clock.now();
      if (seenEvent !== null)
        await $.store.set(SEEN_KEY, { seen: seenEvent, at: clearedAt }).catch(() => undefined);
    }
    await snapshot($, 'end', e.sessionId).catch(() => null);

    return next(e);
  });
};

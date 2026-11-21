// Trees for the /knowledge pane. Pure: state in, elements out; the actions come from
// register.tsx. Laid out for the docked sidebar first (about 38 to 70 columns): a
// one-line tab bar, one status line, two-line rows, labels beside wrapping values,
// summary lines that break between their parts. Wider panes only get more room.
import type { Elements } from 'claude-code';

import type {
  AgentKnowledgeAnalysis,
  AgentKnowledgeEntry,
  AgentKnowledgeEvent,
  AgentKnowledgeHit,
  AgentKnowledgeIngest,
  AgentKnowledgeLink,
  AgentKnowledgeOverview,
  AgentKnowledgePage,
  AgentKnowledgePin,
  AgentKnowledgeRoute,
  AgentKnowledgeSearch,
  AgentKnowledgeSessionPage,
  AgentKnowledgeSessionRow,
  AgentKnowledgeTab,
} from '../types';

/** The elements the pane draws with; mobile has no `Input`. */
export type El = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Markdown' | 'Progress'> &
  Partial<Pick<Elements['terminal'], 'Input'>> &
  Partial<Pick<Elements['desktop'], 'Svg'>>;

export type Actions = {
  refresh: () => void;
  go: (tab: AgentKnowledgeTab) => void;
  /** Opens an entry's page. */
  open: (path: string) => void;
  openSession: (id: string, project: string) => void;
  back: () => void;
  pickCategory: (category: string) => void;
  filter: (text: string) => void;
  /** Narrows the Browse list as the person types in Find, the ring staying in the field. */
  narrow: (text: string) => void;
  clearFilter: () => void;
  more: () => void;
  search: (query: string) => void;
  /** A key typed into the Search field: only when, so a poll does not redraw above it. */
  typing: (text: string) => void;
  /** Unfolds or folds a part of a page (`foldKey`). */
  toggle: (part: string) => void;
  askDelete: (path: string) => void;
  remove: (path: string) => void;
  dismiss: () => void;
  sync: () => void;
  analyze: () => void;
  /** Loads the next page of One link or none. */
  analyzeMore: () => void;
  /** Puts `/knowledge-ingest <folder>` in the prompt: the person runs it with Enter. */
  ingest: () => void;
};

// Theme keys, so the pane follows the person's theme (light, dark, colorblind).
const OK = 'success';
const BAD = 'error';
const WARN = 'warning';
const ACCENT = 'suggestion';

/** Optional props are left out, never passed as undefined: a remote surface refuses undefined. */
const color = (c: string | false | undefined) => (c ? { color: c } : {});
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** `n` and a word whose plural is not just an s. */
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pad2 = (n: number) => String(n).padStart(2, '0');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Terminal columns of one code point: wide East Asian and emoji take two, marks none. */
function charCols(ch: string): number {
  const c = ch.codePointAt(0)!;
  if ((c >= 0x200b && c <= 0x200f) || (c >= 0xfe00 && c <= 0xfe0f) || /\p{M}/u.test(ch)) return 0;
  if (/\p{Emoji_Presentation}/u.test(ch)) return 2;
  return (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x20000 && c <= 0x3fffd)
    ? 2
    : 1;
}

/** Display width in terminal columns, which is what wraps a line; `length` counts UTF-16 units. */
export const cols = (s: string) => [...s].reduce((n, ch) => n + charCols(ch), 0);

/** `s` cut to `n` columns with an ellipsis. */
export function clip(s: string, n: number): string {
  if (cols(s) <= n) return s;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const w = charCols(ch);
    if (used + w > Math.max(1, n - 1)) break;
    out += ch;
    used += w;
  }
  return `${out.trimEnd()}…`;
}

/** One line of prose: whitespace (newlines too) folded to single spaces. */
export const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Markdown as one line of plain text, for an excerpt: headings, emphasis, code ticks, quote
 * and list marks dropped, a link's text kept.
 */
export const plain = (s: string) =>
  oneLine(
    s
      .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|`)/g, ''),
  );

/**
 * Timestamps come as ISO (sessions, scores), SQLite UTC `YYYY-MM-DD HH:MM:SS`, or a bare
 * `YYYY-MM-DD` (an entry's `updated`), which is a local day.
 */
export function parse(ts: string): Date {
  if (/^\d{4}-\d\d-\d\d$/.test(ts)) {
    const [y, m, d] = ts.split('-').map(Number);
    return new Date(y!, m! - 1, d!);
  }
  return new Date(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(ts) ? ts : `${ts.replace(' ', 'T')}Z`);
}

const isDay = (ts: string) => /^\d{4}-\d\d-\d\d$/.test(ts);

/** Local time: HH:MM today, YYYY-MM-DD HH:MM before (never a month and day alone); a bare day as is. */
export function time(ts: string, now = new Date()): string {
  if (isDay(ts)) return ts;
  const d = parse(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return d.toDateString() === now.toDateString()
    ? clock
    : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clock}`;
}

/**
 * When, on a page, counted as the rows count (`ago`) up to a week: just now, 5m ago, 3h ago,
 * 2d ago (a bare day: today, 1d ago); from a week on the local date (and time).
 */
export function when(ts: string, now = new Date()): string {
  if (!ts) return 'unknown';
  const ms = now.getTime() - parse(ts).getTime();
  if (Number.isNaN(ms)) return ts;
  if (ms >= 7 * 86_400_000) return time(ts, now);
  const short = ago(ts, now.getTime());
  return short === 'now' ? 'just now' : short === 'today' ? 'today' : `${short} ago`;
}

/** How long ago, for a row's facts: now, 5m, 3h, 2d (a bare day: today, 1d, 2d). */
export function ago(ts: string, now = Date.now()): string {
  const ms = now - parse(ts).getTime();
  if (Number.isNaN(ms) || !ts) return '';
  if (isDay(ts)) {
    const days = Math.floor(ms / 86_400_000);
    return days <= 0 ? 'today' : `${days}d`;
  }
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  // From a day on in days, as a bare day reads: 1d, not 26h.
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** The categories in the order the knowledge base names them, other folders, then `other` (files at the top). */
export const CATEGORIES = ['projects', 'people', 'decisions', 'workflows', 'notes'];

export function categoryOrder(counts: Record<string, number>): string[] {
  const extra = Object.keys(counts)
    .filter((c) => !CATEGORIES.includes(c) && c !== 'other' && (counts[c] ?? 0) > 0)
    .sort();
  const top = (counts.other ?? 0) > 0 ? ['other'] : [];
  return [...CATEGORIES.filter((c) => (counts[c] ?? 0) > 0), ...extra, ...top];
}

/** A category as the pane names it: the snapshots folder is `snapshots`, not a second `sessions`. */
export const catLabel = (c: string) => (c === SNAPSHOTS ? 'snapshots' : c);

/** The summary as text: the status line entry reads the same; entries as `all` counts them. */
export function headline(o: Pick<AgentKnowledgeOverview, 'entries' | 'sessions'>): string {
  return `${count(o.entries, 'entry', 'entries')} · ${plural(o.sessions, 'session')}`;
}

const needle = (q: string) => q.trim().toLowerCase();

/** The Browse filter: text found in the title, path or tags. */
/** Find's test: every word of it in the entry's title, path or tags ("gotcha windows"). */
export function matches(e: AgentKnowledgeEntry, query: string): boolean {
  const words = needle(query).split(/\s+/).filter(Boolean);
  const text = [e.title, e.path, ...e.tags].join('\n').toLowerCase();
  return words.every((w) => text.includes(w));
}

/** The folder session snapshots go in: their own category, left out of `all`. */
export const SNAPSHOTS = 'sessions';

/** What Browse lists: `list` narrowed to `category` ('all' for every one) and `filter`. */
export const browseRows = (
  list: AgentKnowledgeEntry[],
  category: string,
  filter: string,
  pinned: AgentKnowledgePin | null = null,
) =>
  pinOrder(
    list.filter(
      (e) =>
        (category === 'all' ? e.category !== SNAPSHOTS : e.category === category) &&
        matches(e, filter),
    ),
    pinned?.view === pinView(category, filter) ? pinned.paths : null,
  );

/** The view an order is kept for: a category and a Find. */
export const pinView = (category: string, filter: string) => `${category}\n${filter}`;

/**
 * `rows` in the order `pinned` drew them, the ones it does not hold after, as they came: a
 * poll then never moves a row under the ring while the pane holds the keyboard (/pipeline's
 * pinOrder, by path).
 */
export function pinOrder<T extends { path: string }>(rows: T[], pinned: string[] | null): T[] {
  if (!pinned) return rows;
  const at = new Map(pinned.map((path, i) => [path, i]));
  const held = rows.filter((r) => at.has(r.path)).sort((a, b) => at.get(a.path)! - at.get(b.path)!);
  return [...held, ...rows.filter((r) => !at.has(r.path))];
}

/**
 * An entry's body as the page draws it: the frontmatter is its facts, and a first heading
 * that only repeats the title is drawn once, above.
 */
export function pageBody(content: string, title: string): string {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const m = /^\s*#\s+(.+?)\s*(\r?\n|$)/.exec(body);
  return m && m[1]!.toLowerCase() === title.trim().toLowerCase() ? body.slice(m[0].length) : body;
}

/** A path's last part without `.md`: how a link to an entry not loaded is named. */
export const baseName = (path: string) => (path.split('/').pop() ?? path).replace(/\.md$/, '');

/** A path under the home directory as `~…`, as Claude Code writes its own working directory. */
export function homeAsTilde(path: string, home: string | undefined): string {
  if (!home) return path;
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const isUnder = norm(path) === norm(home) || norm(path).startsWith(`${norm(home)}/`);
  return isUnder ? `~${path.slice(home.replace(/[\\/]+$/, '').length)}` : path;
}

/** How many hits a search shows at most: entries, and messages of past sessions. */
export const ENTRY_HITS = 15;
export const SESSION_HITS = 10;
/** One link or none comes this many at a time (GET /api/analysis `limit`). */
export const ANALYSIS_PAGE = 30;

/** What a live event's kind says to a person. */
export const eventWords = (kind: string) =>
  ({
    'session-end': 'Session saved',
    compact: 'Session saved at compaction',
    distill: 'Distilled',
    'sync-failed': 'Sync failed',
  })[kind] ?? `${kind.charAt(0).toUpperCase()}${kind.slice(1).replace(/[-_]+/g, ' ')}`;

/** This project's ingest in words, as Health says it. */
export function ingestWords(f: AgentKnowledgeIngest): string {
  if (f.state === 'never') return `${f.project}: never ingested (${f.files}+ source files)`;
  if (f.state === 'stale') return `${f.project}: ${f.files} files changed since (${f.changes})`;
  return `${f.project}: up to date`;
}

/**
 * Text as the pane may draw it: Claude Code refuses a whole drawing when one string holds a
 * control character, so a session's tool output in colour (`\x1b[31m`), a title pasted with a
 * bell, would blank the pane. Escape sequences (CSI, OSC and the other strings, 7-bit or C1, the
 * two-byte ones) go whole; any other
 * C0 or C1 control but newline and tab becomes a visible `�`; a CRLF is a newline.
 */
export function drawable(text: string): string {
  return text.replace(ESCAPES, '').replace(/\r\n/g, '\n').replace(CONTROLS, '\ufffd');
}
/** An escape sequence: CSI, OSC, DCS, SOS, PM, APC (`ESC [` or its one-byte C1 form, …) to their end, any other (`ESC ( B`). */
const ESCAPES =
  // eslint-disable-next-line no-control-regex
  /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|(?:\x1b[P\]X^_]|[\x90\x98\x9d-\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|\x1b[ -/]*[0-~]/g;
/** A C0 or C1 control but newline and tab. */
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** A relationship in words: related_to → related to. */
export const relWords = (rel: string) => rel.replace(/_/g, ' ');

/**
 * A fold's toggle key names its state: landing on it after a toggle waits for the drawing
 * that shows the new state. The engine keeps the ring at its place in the focus order
 * across a redraw, not on a key, so the toggle lands it again itself.
 */
export const foldKey = (part: string, isOpen: boolean) => `${part}:${isOpen ? 'open' : 'shut'}`;

/**
 * Refresh's key names whether the server is up (the tabs before it come and go with it, which
 * would move a ring kept by its place) and, up, the drawing (`rev`): a button that only the next
 * drawing brings, so focusing it waits for that drawing without ever entering a text field.
 */
export const refreshKey = (isUp: boolean, rev = 0) => (isUp ? `refresh:${rev}` : 'retry');

/** A Browse row's key names the list it is in: a row the list before drew too would keep its place. */
export const rowKey = (category: string, path: string) => `open:${category}:${path}`;

/** A search hit's key names the search (by `rev`): the same entry found again is a new row. */
export const hitKey = (rev: number, hit: AgentKnowledgeHit, i: number) =>
  hit.kind === 'entry' ? `hit:${rev}:e:${hit.path}` : `hit:${rev}:s:${hit.id}:${i}`;

/** A link's key names the page it is on: the next page may link the same entry elsewhere. */
export const linkKey = (from: string, l: AgentKnowledgeLink) =>
  `link:${from}:${l.direction}:${l.path}`;

/** What a press on a button only moves to, by its key; null for one that changes something. */
export type Move =
  | { tab: AgentKnowledgeTab }
  | { entry: string }
  | { session: string }
  | { pageSession: true }
  | { category: string }
  | { more: true }
  | { analyzeMore: true }
  | { fold: string }
  | { back: true }
  | { refresh: true };

/**
 * The move a button's key stands for (the keys above): a tab, an entry (a row, a hit, a link,
 * a mention, an Analyze row), a session, a category, more, a fold, back, Refresh. Delete, Sync,
 * Ingest, Analyze, Find and the confirmation change something: null.
 */
export function moveOf(key: string): Move | null {
  const tab = /^tab:(browse|search|sessions|health)$/.exec(key)?.[1];
  if (tab) return { tab: tab as AgentKnowledgeTab };
  const entry = [
    /^open:[^:]+:(.+)$/,
    /^hit:\d+:e:(.+)$/,
    /^link:[^:]+:(?:in|out):(.+)$/,
    /^mention:[^:]+:(.+)$/,
    /^(?:hub|sparse):(.+)$/,
  ]
    .map((re) => re.exec(key)?.[1])
    .find((x) => x !== undefined);
  if (entry) return { entry };
  const session = /^sess:(.+)$/.exec(key)?.[1] ?? /^hit:\d+:s:(.+):\d+$/.exec(key)?.[1];
  if (session) return { session };
  if (key === 'open-session') return { pageSession: true };
  if (key.startsWith('cat:')) return { category: key.slice(4) };
  if (key.startsWith('more:')) return { more: true };
  if (key.startsWith('sparse-more:')) return { analyzeMore: true };
  const fold = /^(.+):(?:open|shut)$/.exec(key)?.[1];
  if (fold) return { fold };
  if (key === 'back') return { back: true };
  if (key === 'retry' || key.startsWith('refresh:')) return { refresh: true };
  return null;
}

/** The text fields' keys: Find on Browse, the Search field. */
export const isField = (key: string | null) => key !== null && /^(filter|find):/.test(key);

/** Rows a Browse page adds. */
export const PAGE = 25;
/** Rows of a long list (topics, files, entries with few links) shown before its fold. */
export const LIST_SHOWN = 8;
/** Lines of an entry's body shown before its fold; it folds only when that hides enough. */
const BODY_LINES = 30;
const BODY_FOLD = 10;

type ViewProps = {
  el: El;
  on: Actions;
  /** The key the ring starts on when the pane takes the keys: drawn `autoFocus`. */
  auto: string | null;
};

/** `autoFocus` for the element `auto` names. */
const af = (auto: string | null, key: string) => (auto === key ? { autoFocus: true as const } : {});

/** A section heading: bold, with an optional dim count or aside. */
function Heading({ el, title, aside }: { el: El; title: string; aside?: string }) {
  const { Text } = el;
  return (
    <Text wrap="truncate">
      <Text bold>{title}</Text>
      {aside ? <Text dimColor> {aside}</Text> : null}
    </Text>
  );
}

const LABEL = 11;

/** A label column beside a value that wraps under itself. */
function Fact({ el, label, children }: { el: El; label: string; children: unknown }) {
  const { Box, Text } = el;
  return (
    <Box columnGap={1}>
      <Box width={LABEL} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} flexDirection="column">
        {children as never}
      </Box>
    </Box>
  );
}

/** A list item whose wrapped lines hang under its first word, not under its dot. */
function Bullet({ el, tone, children }: { el: El; tone?: string; children: unknown }) {
  const { Box, Text } = el;
  return (
    <Box>
      <Box flexShrink={0}>
        <Text {...color(tone)}>· </Text>
      </Box>
      <Box flexShrink={1}>
        <Text wrap="wrap" {...color(tone)}>
          {children as never}
        </Text>
      </Box>
    </Box>
  );
}

/** The parts that fit `width` columns with their ` · `, whole; what does not fit is left out. */
export function fitParts<P extends Part>(parts: P[], width: number): P[] {
  const out: P[] = [];
  let used = 0;
  for (const p of parts) {
    const w = cols(typeof p === 'string' ? p : p.text) + (out.length ? 3 : 0);
    if (used + w > width) break;
    out.push(p);
    used += w;
  }
  return out;
}

/** One part of a summary line: dim text, or text with its own look. */
type Part = string | { text: string; color?: string; bold?: boolean };

const partText = (p: Part) => (typeof p === 'string' ? p : p.text);

/**
 * Parts in lines of at most `width` columns, joined by ` sep `: a narrow pane breaks the
 * line between two parts, never inside one, and no line ends or starts on `sep`.
 */
export function packParts(parts: Part[], width: number, sep = '·'): Part[][] {
  const lines: Part[][] = [];
  let used = 0;
  for (const p of parts) {
    const line = lines.at(-1);
    const len = cols(partText(p));
    if (line && used + sep.length + 2 + len <= width) {
      line.push(p);
      used += sep.length + 2 + len;
    } else {
      lines.push([p]);
      used = len;
    }
  }
  return lines;
}

function Parts({ el, parts, width }: { el: El; parts: (Part | false | null)[]; width: number }) {
  const { Box, Text } = el;
  const lines = packParts(
    parts.filter((p): p is Part => Boolean(p)),
    width,
  );
  return (
    <Box flexDirection="column">
      {lines.map((line, l) => (
        <Text key={`line:${l}`} wrap="truncate">
          {line.map((p, i) => {
            const { text, color: tone, bold } = typeof p === 'string' ? { text: p } : p;
            return (
              <Text key={`part:${i}`}>
                {i > 0 ? <Text dimColor> · </Text> : null}
                <Text {...color(tone)} {...(bold ? { bold } : tone ? {} : { dimColor: true })}>
                  {text}
                </Text>
              </Text>
            );
          })}
        </Text>
      ))}
    </Box>
  );
}

export type PaneProps = Omit<ViewProps, 'auto'> & {
  /** Where the ring lands (`landing()` in register.tsx); it starts there on a take. */
  landing: string | null;
  overview: AgentKnowledgeOverview;
  route: AgentKnowledgeRoute;
  category: string;
  filter: string;
  list: AgentKnowledgeEntry[] | null;
  /** Browse's drawn order kept while the pane holds the keyboard (`pinOrder`). */
  pinned: AgentKnowledgePin | null;
  /** This session's id: its row in Sessions is marked. */
  current: string;
  /** How many sessions there are in all (more than are loaded, often). */
  sessionsTotal: number;
  /** What the Find field is drawn with (never the typing fed back: it would drop keys). */
  findValue: string;
  shown: number;
  search: AgentKnowledgeSearch | null;
  /** The Search field's text while the person types anew (null: the last search's words). */
  draft: string | null;
  sessions: AgentKnowledgeSessionRow[] | null;
  page: AgentKnowledgePage | null;
  sessionPage: AgentKnowledgeSessionPage | null;
  analysis: AgentKnowledgeAnalysis | null;
  ingest: AgentKnowledgeIngest | null;
  expanded: string[];
  confirm: string | null;
  rev: number;
  busy: string | null;
  notice: string | null;
  /** The key of the element holding the ring (`ui.focus`). */
  focused: string | null;
  /** The pane holds the keyboard (Tab walks it), as the Pane site reports. */
  isFocused: boolean;
  /** The pane body's width (`bodyColumns`). */
  columns: number;
  /** Terminal, the desktop app's dock, or its widget (`layoutOf`). */
  layout: Layout;
};

const TABS: [AgentKnowledgeTab, string, string][] = [
  ['browse', 'Browse', '1'],
  ['search', 'Search', '2'],
  ['sessions', 'Sessions', '3'],
  ['health', 'Health', '4'],
];

/** The key hint under the tabs, longest first: the longest that fits the pane is drawn. */
const KEYS = [
  'Tab moves · Enter presses · ↑↓ scroll · Esc to the prompt',
  'Tab moves · Enter presses · Esc to the prompt',
  'Tab · Enter · Esc to the prompt',
];
const UNFOCUSED = ['ctrl+x tab to work this pane from the keyboard', 'ctrl+x tab: keyboard'];
/** In a text field the hotkeys type into it: the hint says how out instead. */
const TYPING = ['Tab leaves the field · Esc to the prompt', 'Tab leaves · Esc to the prompt'];

export const fitting = (hints: string[], width: number) =>
  hints.find((hint) => cols(hint) <= width) ?? hints.at(-1)!;

/**
 * An outcome's tone, by the mark it leads with: ✓ done, ✗ refused or failed, ! changed
 * elsewhere (a warning), – nothing happened (plain).
 */
const noticeTone = (notice: string) =>
  notice.startsWith('✓')
    ? { color: OK }
    : notice.startsWith('✗')
      ? { color: BAD }
      : notice.startsWith('!')
        ? { color: WARN }
        : {};

/** Why there is nothing to show: nothing answers, or an agent-knowledge from before the pane does. */
function Down({ el, o }: { el: El; o: AgentKnowledgeOverview }) {
  const { Box, Text } = el;
  return (
    <Box flexDirection="column">
      <Text color={BAD} bold>
        {o.old
          ? `An older agent-knowledge (${o.old}) holds the port`
          : 'The agent-knowledge server is not reachable'}
      </Text>
      <Text dimColor>
        {o.old
          ? `It answers at ${o.origin} but cannot serve this pane. End the sessions (or the process) still running it: a current one takes the port over. Then Refresh.`
          : `Nothing answers at ${o.origin}. The agent-knowledge MCP server of a running session serves the pane: check in /mcp that agent-knowledge is connected, then Refresh.`}
      </Text>
    </Box>
  );
}

/** Where the pane sits and who draws it: the desktop app's dock gets the wide layout. */
export type Layout = 'terminal' | 'desktop' | 'widget';

export function layoutOf(surface: string, placement: string | undefined): Layout {
  if (placement === 'widget') return 'widget';
  return surface === 'desktop' ? 'desktop' : 'terminal';
}

/** The desktop's side column (the tabs and the categories), in cells. */
const SIDE = 26;
/** Below this many columns the desktop stacks the side column above the view. */
const SPLIT = 90;

export function Pane(p: PaneProps) {
  if (p.layout === 'widget') return <Glance {...p} />;
  const { Box, Text } = p.el;
  const { overview: o } = p;
  const isDesk = p.layout === 'desktop';
  const isSplit = isDesk && p.columns >= SPLIT;
  // The view's own width: beside the side column on a wide desktop, the pane's elsewhere.
  const width = isSplit ? p.columns - SIDE - 2 : p.columns;
  const isTyping = p.isFocused && isField(p.focused);
  const body = <Body {...p} width={width} isDesk={isDesk} isSplit={isSplit} />;
  const status = p.busy ? (
    <p.el.Progress label={p.busy} valueText="working…" />
  ) : p.notice ? (
    <Text {...noticeTone(p.notice)} wrap="wrap">
      {p.notice}
    </Text>
  ) : null;

  if (isDesk)
    return (
      <Box flexDirection="column" gap={1}>
        <DeskHeader {...p} isTyping={isTyping} />
        {status}
        {isSplit ? (
          <Box columnGap={2}>
            <Box width={SIDE} flexShrink={0} flexDirection="column" gap={1}>
              <Nav {...p} isTyping={isTyping} isColumn />
              {o.isUp && <Categories {...p} />}
            </Box>
            <Box flexGrow={1} flexShrink={1} flexDirection="column">
              {body}
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column" gap={1}>
            <Nav {...p} isTyping={isTyping} isColumn={false} />
            {body}
          </Box>
        )}
      </Box>
    );

  return (
    <Box flexDirection="column" gap={1} width={width}>
      <Box flexDirection="column">
        <Nav {...p} isTyping={isTyping} isColumn={false} />
        {/* One status line under the tabs: the action in flight, else its outcome, else the
            keys. Only an outcome long enough to wrap (a refusal's reason) takes more. */}
        {status ?? (
          <Text dimColor wrap="truncate">
            {fitting(isTyping ? TYPING : p.isFocused ? KEYS : UNFOCUSED, width)}
          </Text>
        )}
        <Text dimColor>{'─'.repeat(Math.max(1, width))}</Text>
      </Box>
      {body}
    </Box>
  );
}

/** The tabs and Refresh: a bar on the terminal, the desktop's navigation column when wide. */
function Nav(p: PaneProps & { isTyping: boolean; isColumn: boolean }) {
  const { Box, Text, Button } = p.el;
  const { overview: o, route, on } = p;
  const isDesk = p.layout === 'desktop';
  const counts: Partial<Record<AgentKnowledgeTab, number>> = o.isUp
    ? { browse: o.entries, sessions: o.sessions }
    : {};
  return (
    <Box
      {...(p.isColumn ? { flexDirection: 'column' as const } : { flexWrap: 'wrap' as const })}
      columnGap={2}
    >
      {/* Down too: the digits stay the pane's (never typed into the prompt), and pick the
          tab shown once the server answers. */}
      {TABS.map(([tab, label, hotkey]) => {
        const isOn = route.tab === tab && route.entry === null && route.session === null;
        const n = isDesk ? counts[tab] : undefined;
        return (
          <Button
            key={`tab:${tab}`}
            {...af(p.landing, `tab:${tab}`)}
            label={label}
            {...(p.isTyping ? {} : { hotkey })}
            plain
            {...(route.tab === tab ? {} : { dimColor: true })}
            onPress={() => on.go(tab)}
          >
            {isOn ? (
              <Text bold underline {...color(isDesk && ACCENT)}>
                {label}
              </Text>
            ) : (
              label
            )}
            {n !== undefined ? <Text dimColor> {n}</Text> : null}
          </Button>
        );
      })}
      {!isDesk && (
        <Button
          key={refreshKey(o.isUp, p.rev)}
          label="Refresh"
          {...(p.isTyping ? {} : { hotkey: 'r' })}
          plain
          {...af(p.landing, refreshKey(o.isUp, p.rev))}
          onPress={on.refresh}
        />
      )}
    </Box>
  );
}

/** The desktop's head: name, state, the four counts as tiles, Refresh and Sync. */
function DeskHeader(p: PaneProps & { isTyping: boolean }) {
  const { Box, Text, Button } = p.el;
  const { overview: o, on } = p;
  const tiles: [string, number][] = o.isUp
    ? [
        ['entries', o.entries],
        ['sessions', o.sessions],
        ...(o.snapshots ? [['snapshots', o.snapshots] as [string, number]] : []),
        ['vectors', o.vectors],
      ]
    : [];
  return (
    <Box flexDirection="column" gap={1}>
      <Box columnGap={2} flexWrap="wrap" alignItems="center">
        <Text bold>agent-knowledge</Text>
        {o.isUp && <Text dimColor>v{o.version}</Text>}
        <Text color={o.isUp ? OK : BAD}>{o.isUp ? '● online' : '● offline'}</Text>
        {o.isUp && (
          <Text dimColor>{o.hasGit ? 'git: synced on every write' : 'git: no remote'}</Text>
        )}
        <Box flexGrow={1} />
        <Button
          key={refreshKey(o.isUp, p.rev)}
          label="Refresh"
          {...(p.isTyping ? {} : { hotkey: 'r' })}
          {...af(p.landing, refreshKey(o.isUp, p.rev))}
          onPress={on.refresh}
        />
        {o.isUp && o.hasGit && (
          <Button key="sync" label="Sync now" variant="primary" onPress={on.sync} />
        )}
      </Box>
      {tiles.length > 0 && (
        <Box columnGap={1} flexWrap="wrap">
          {tiles.map(([label, n]) => (
            <Box
              key={`tile:${label}`}
              flexDirection="column"
              borderStyle="round"
              borderDimColor
              paddingX={2}
              minWidth={14}
            >
              <Text bold>{n.toLocaleString('en-US')}</Text>
              <Text dimColor>{label}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

/** The desktop's categories, one button each with its count. */
function Categories(p: PaneProps) {
  const { Box, Button, Text } = p.el;
  const { overview: o, on } = p;
  const all = ['all', ...categoryOrder(o.categories), ...(o.snapshots ? [SNAPSHOTS] : [])];
  const isBrowse = p.route.tab === 'browse' && p.route.entry === null && p.route.session === null;
  return (
    <Box flexDirection="column">
      <Text dimColor bold>
        Categories
      </Text>
      {all.map((c) => {
        const n = c === 'all' ? o.entries : c === SNAPSHOTS ? o.snapshots : (o.categories[c] ?? 0);
        const isOn = isBrowse && c === p.category;
        return (
          <Button
            key={`cat:${c}`}
            {...af(p.landing, `cat:${c}`)}
            plain
            {...(isOn ? {} : { dimColor: true })}
            onPress={() => on.pickCategory(c)}
          >
            {isOn ? (
              <Text bold color={ACCENT}>
                {catLabel(c)}
              </Text>
            ) : (
              catLabel(c)
            )}
            <Text dimColor> {n}</Text>
          </Button>
        );
      })}
    </Box>
  );
}

/** The view under the navigation: the open page, else the tab's own. */
function Body(p: PaneProps & { width: number; isDesk: boolean; isSplit: boolean }) {
  const { overview: o, route, on, width } = p;
  const v = { el: p.el, on, auto: p.landing };
  if (!o.isUp) return <Down el={p.el} o={o} />;
  if (route.entry !== null)
    return p.page?.path === route.entry ? (
      <EntryPage
        {...v}
        page={p.page}
        route={route}
        expanded={p.expanded}
        confirm={p.confirm}
        hasGit={o.hasGit}
        width={width}
        isDesk={p.isDesk}
        known={p.list && new Map(p.list.map((x) => [x.path, x.title]))}
      />
    ) : (
      <p.el.Progress label={route.entry} valueText="loading…" />
    );
  if (route.session !== null)
    return p.sessionPage?.id === route.session.id ? (
      <SessionPage
        {...v}
        s={p.sessionPage}
        route={route}
        expanded={p.expanded}
        width={width}
        backTo={p.page && p.page.path === route.trail.at(-1) ? p.page.title : null}
      />
    ) : (
      <p.el.Progress label="The session" valueText="loading…" />
    );
  if (route.tab === 'browse')
    return (
      <Browse
        {...v}
        o={o}
        category={p.category}
        filter={p.filter}
        list={p.list}
        findValue={p.findValue}
        pinned={p.pinned}
        ingest={p.ingest}
        shown={p.shown}
        rev={p.rev}
        width={width}
        hasCategories={!p.isSplit}
      />
    );
  if (route.tab === 'search')
    return (
      <Search
        {...v}
        search={p.search}
        rev={p.rev}
        width={width}
        draft={p.draft}
        isTyping={p.isFocused && isField(p.focused)}
        isDesk={p.isDesk}
      />
    );
  if (route.tab === 'sessions')
    return (
      <Sessions
        {...v}
        sessions={p.sessions}
        total={p.sessionsTotal}
        current={p.current}
        expanded={p.expanded}
        shown={p.shown}
        width={width}
      />
    );
  return (
    <Health
      {...v}
      o={o}
      list={p.list}
      analysis={p.analysis}
      ingest={p.ingest}
      width={width}
      isDesk={p.isDesk}
    />
  );
}

/**
 * The desktop's widget: a glance (counts, the categories as a bar, the latest activity) and
 * the way into Search. Clicks may not reach a widget, so nothing here is needed to read it.
 */
function Glance(p: PaneProps) {
  const { Box, Text, Button, Svg } = p.el;
  const { overview: o, on } = p;
  if (!o.isUp)
    return (
      <Box flexDirection="column">
        <Text bold>agent-knowledge</Text>
        <Text color={BAD}>● offline</Text>
        <Text dimColor wrap="wrap">
          {o.old ? `version ${o.old} holds the port` : `nothing answers at ${o.origin}`}
        </Text>
      </Box>
    );
  const cats = categoryOrder(o.categories);
  const last = o.events.at(-1);
  return (
    <Box flexDirection="column" gap={1}>
      <Box columnGap={1}>
        <Text bold>agent-knowledge</Text>
        <Text color={OK}>●</Text>
      </Box>
      <Box columnGap={2} flexWrap="wrap">
        <Text>
          <Text bold>{o.entries}</Text>
          <Text dimColor> entries</Text>
        </Text>
        <Text>
          <Text bold>{o.sessions}</Text>
          <Text dimColor> sessions</Text>
        </Text>
      </Box>
      {Svg && cats.length > 0 ? (
        <Svg
          source={stripChart(o.categories, cats)}
          alt={cats.map((c) => `${c} ${o.categories[c]}`).join(', ')}
        />
      ) : (
        cats.length > 0 && (
          <Text dimColor wrap="wrap">
            {cats.map((c) => `${catLabel(c)} ${o.categories[c]}`).join(' · ')}
          </Text>
        )
      )}
      <Text dimColor wrap="wrap">
        {o.hasGit ? 'git: synced on every write' : 'git: no remote'}
        {last ? ` · ${eventWords(last.kind)} ${ago(new Date(last.ts).toISOString())}` : ''}
      </Text>
      <Box>
        <Button
          key="glance:search"
          label="Search"
          variant="primary"
          onPress={() => on.go('search')}
        />
      </Box>
    </Box>
  );
}

// Charts for the desktop's Svg: fixed mid-tone colours that read on light and dark alike
// (an Svg is drawn as an image: it does not follow the theme).
const CAT_COLORS: Record<string, string> = {
  projects: '#4e8fd6',
  people: '#9a6fd6',
  decisions: '#e08a3c',
  workflows: '#3fa66b',
  notes: '#c9a227',
};
const OTHER_COLOR = '#8a8f98';
const INK = '#8a8f98';
export const catColor = (c: string) => CAT_COLORS[c] ?? OTHER_COLOR;
const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const FONT = 'font-family="system-ui, sans-serif" font-size="11"';

/** Entries per category as horizontal bars, each labelled with its count. */
export function categoryChart(counts: Record<string, number>, cats: string[]): string {
  const W = 200;
  const ROW = 20;
  const max = Math.max(1, ...cats.map((c) => counts[c] ?? 0));
  const bars = cats
    .map((c, i) => {
      const n = counts[c] ?? 0;
      const w = Math.max(2, Math.round(((W - 110) * n) / max));
      const y = i * ROW;
      return (
        `<text x="0" y="${y + 13}" fill="${INK}" ${FONT}>${xml(c)}</text>` +
        `<rect x="74" y="${y + 4}" width="${w}" height="12" rx="3" fill="${catColor(c)}"/>` +
        `<text x="${78 + w}" y="${y + 14}" fill="${INK}" ${FONT}>${n}</text>`
      );
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${cats.length * ROW}" viewBox="0 0 ${W} ${cats.length * ROW}">${bars}</svg>`;
}

/** The categories as one stacked bar: the widget's glance. */
export function stripChart(counts: Record<string, number>, cats: string[]): string {
  const W = 200;
  const total = Math.max(
    1,
    cats.reduce((n, c) => n + (counts[c] ?? 0), 0),
  );
  let x = 0;
  const parts = cats
    .map((c) => {
      const w = (W * (counts[c] ?? 0)) / total;
      const r = `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="8" fill="${catColor(c)}"/>`;
      x += w;
      return r;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="8" viewBox="0 0 ${W} 8">${parts}</svg>`;
}

/** Entries updated per week, the last `weeks` weeks, oldest left: the knowledge base's activity. */
export function activityWeeks(list: AgentKnowledgeEntry[], now: Date, weeks = 12): number[] {
  const out = new Array<number>(weeks).fill(0);
  for (const e of list) {
    if (!e.updated) continue;
    const age = Math.floor((now.getTime() - parse(e.updated).getTime()) / (7 * 86_400_000));
    if (age >= 0 && age < weeks) out[weeks - 1 - age]! += 1;
  }
  return out;
}

export function activityChart(weeks: number[]): string {
  const W = 320;
  const H = 70;
  const bw = W / weeks.length;
  const max = Math.max(1, ...weeks);
  const bars = weeks
    .map((n, i) => {
      const h = Math.max(n ? 3 : 1, Math.round(((H - 18) * n) / max));
      return `<rect x="${(i * bw + 2).toFixed(1)}" y="${H - 14 - h}" width="${(bw - 4).toFixed(1)}" height="${h}" rx="2" fill="${n ? '#4e8fd6' : INK}" opacity="${n ? 1 : 0.4}"><title>${n}</title></rect>`;
    })
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${bars}` +
    `<text x="0" y="${H - 2}" fill="${INK}" ${FONT}>${weeks.length} weeks ago</text>` +
    `<text x="${W}" y="${H - 2}" fill="${INK}" ${FONT} text-anchor="end">this week</text></svg>`
  );
}

/** The open entry in the middle, its graph neighbours around it, arrows by direction. */
export function neighbourGraph(page: AgentKnowledgePage): string {
  const W = 360;
  const H = 220;
  const cx = W / 2;
  const cy = H / 2;
  const links = page.links.slice(0, 12);
  const label = (s: string) => xml(clip(s, 22));
  const nodes = links
    .map((l, i) => {
      const a = (2 * Math.PI * i) / links.length - Math.PI / 2;
      const x = cx + Math.cos(a) * 140;
      const y = cy + Math.sin(a) * 80;
      const fill = l.isMissing ? INK : catColor(l.path.split('/')[0] ?? '');
      return (
        `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${INK}" stroke-opacity="0.6" ${l.direction === 'out' ? 'marker-end="url(#a)"' : 'marker-start="url(#b)"'}/>` +
        `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6" fill="${fill}"/>` +
        `<text x="${x.toFixed(1)}" y="${(y + (y < cy ? -10 : 18)).toFixed(1)}" fill="${INK}" ${FONT} text-anchor="middle">${label(l.title)}</text>`
      );
    })
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs><marker id="a" viewBox="0 0 10 10" refX="16" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0L10,5L0,10z" fill="${INK}"/></marker>` +
    `<marker id="b" viewBox="0 0 10 10" refX="-6" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M10,0L0,5L10,10z" fill="${INK}"/></marker></defs>` +
    nodes +
    `<circle cx="${cx}" cy="${cy}" r="10" fill="${catColor(page.category)}"/>` +
    `<text x="${cx}" y="${cy + 26}" fill="${INK}" ${FONT} font-weight="600" text-anchor="middle">${label(page.title)}</text></svg>`
  );
}

/**
 * A row: one Button cut to one line, then its facts beneath, then an optional dim line (an
 * excerpt, a preview).
 */
/** From this many columns a row is one line: title, then its facts at the right. */
const WIDE_ROW = 80;

function Row({
  el,
  auto,
  k,
  title,
  facts,
  extra,
  width,
  onPress,
}: Omit<ViewProps, 'on'> & {
  k: string;
  title: string;
  facts: (Part | false | null | undefined | '')[];
  extra?: string;
  width: number;
  onPress: () => void;
}) {
  const { Box, Text, Button } = el;
  // A wide view reads as a table: the title left, its facts right on the same line.
  const isWide = width >= WIDE_ROW;
  const shown = fitParts(
    facts.filter((f): f is Part => Boolean(f)),
    isWide ? Math.floor(width * 0.45) : Math.max(10, width - 2),
  );
  const factsText = (
    <Text dimColor wrap="truncate">
      {shown.map((f, i) =>
        typeof f === 'string' ? (
          `${i > 0 ? ' · ' : ''}${f}`
        ) : (
          <Text key={`f:${i}`} {...color(f.color)}>
            {i > 0 ? ' · ' : ''}
            {f.text}
          </Text>
        ),
      )}
    </Text>
  );
  const used = shown.reduce((n, f, i) => n + cols(partText(f)) + (i ? 3 : 0), 0);
  return (
    <Box flexDirection="column">
      {isWide ? (
        <Box columnGap={2}>
          <Box flexGrow={1} flexShrink={1}>
            <Button key={k} {...af(auto, k)} plain onPress={onPress}>
              {clip(oneLine(title), Math.max(10, width - used - 2))}
            </Button>
          </Box>
          {shown.length > 0 && <Box flexShrink={0}>{factsText}</Box>}
        </Box>
      ) : (
        <Button key={k} {...af(auto, k)} plain onPress={onPress}>
          {clip(oneLine(title), Math.max(10, width))}
        </Button>
      )}
      {!isWide && shown.length > 0 && <Box paddingLeft={2}>{factsText}</Box>}
      {extra ? (
        <Box paddingLeft={2}>
          <Text dimColor wrap="truncate">
            {clip(plain(extra), Math.max(10, width - 2))}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

/** What an entry row says beneath its title. */
function entryFacts(e: AgentKnowledgeEntry, withCategory: boolean, filter: string): Part[] {
  const q = needle(filter);
  const isHit = (t: string) => q !== '' && t.toLowerCase().includes(q);
  const tags = [...e.tags.filter(isHit), ...e.tags.filter((t) => !isHit(t))].slice(0, 3);
  return [
    ...(withCategory ? [catLabel(e.category)] : []),
    ...(e.isEvergreen ? [{ text: 'evergreen', color: ACCENT }] : []),
    ...(e.maturity !== 'candidate' ? [e.maturity] : []),
    ...(e.updated ? [ago(e.updated)] : []),
    ...tags.map((t) => (isHit(t) ? { text: `#${t}`, color: ACCENT } : `#${t}`)),
  ];
}

function Browse({
  el,
  on,
  auto,
  o,
  category,
  filter,
  list,
  findValue,
  pinned,
  ingest,
  shown,
  rev,
  width,
  hasCategories,
}: ViewProps & {
  /** Draws the category bar: the wide desktop has them in its side column instead. */
  hasCategories: boolean;
  o: AgentKnowledgeOverview;
  category: string;
  filter: string;
  list: AgentKnowledgeEntry[] | null;
  findValue: string;
  pinned: AgentKnowledgePin | null;
  ingest: AgentKnowledgeIngest | null;
  shown: number;
  rev: number;
  width: number;
}) {
  const { Box, Text, Button, Input } = el;
  const snapshots = o.snapshots;
  const empty = (
    <Box flexDirection="column">
      <Text>The knowledge base is empty.</Text>
      <Text dimColor>
        Agents save what they learn here, by category: projects, people, decisions, workflows and
        notes. Past sessions are under Sessions.
      </Text>
      {/* The next step there is: this project's code, ingested. */}
      {ingest && ingest.state !== 'current' && (
        <Box marginTop={1}>
          <Button
            key="ingest"
            {...af(auto, 'ingest')}
            label={`Ingest ${ingest.project} ›`}
            onPress={on.ingest}
          />
        </Box>
      )}
    </Box>
  );
  if (o.entries === 0 && snapshots === 0) return empty;
  // Only session snapshots so far: the empty state, then where the snapshots are.
  if (o.entries === 0 && category !== SNAPSHOTS)
    return (
      <Box flexDirection="column" gap={1}>
        {empty}
        <Button
          key={`cat:${SNAPSHOTS}`}
          {...af(auto, `cat:${SNAPSHOTS}`)}
          label={`${plural(snapshots, 'session snapshot')} ›`}
          plain
          onPress={() => on.pickCategory(SNAPSHOTS)}
        />
      </Box>
    );
  const cats = ['all', ...categoryOrder(o.categories), ...(snapshots ? [SNAPSHOTS] : [])];
  const found = browseRows(list ?? [], category, filter, pinned);
  const rows = found.slice(0, shown);
  const isFiltered = filter !== '';
  return (
    <Box flexDirection="column" gap={1}>
      {hasCategories && (
        <Box flexWrap="wrap" columnGap={2}>
          {cats.map((c) => {
            const n =
              c === 'all' ? o.entries : c === SNAPSHOTS ? snapshots : (o.categories[c] ?? 0);
            return (
              <Button
                key={`cat:${c}`}
                {...af(auto, `cat:${c}`)}
                plain
                {...(c === category ? {} : { dimColor: true })}
                onPress={() => on.pickCategory(c)}
              >
                {c === category ? (
                  <Text bold underline>
                    {catLabel(c)} {n}
                  </Text>
                ) : (
                  `${catLabel(c)} ${n}`
                )}
              </Button>
            );
          })}
        </Box>
      )}
      {Input && (
        <Box flexDirection="column">
          <Input
            key={`filter:${rev}`}
            label="Find"
            placeholder={fitting(['title, path or tag', 'title or tag'], width - 13)}
            value={findValue}
            submitLabel="find"
            onInput={on.narrow}
            onSubmit={on.filter}
          />
          {isFiltered && (
            <Box columnGap={1}>
              <Text {...color(ACCENT)}>{count(found.length, 'match', 'matches')}</Text>
              <Button
                key="clear-filter"
                label="Clear the filter"
                {...af(auto, 'clear-filter')}
                onPress={on.clearFilter}
              />
            </Box>
          )}
        </Box>
      )}
      {list === null ? (
        <el.Progress label="Entries" valueText="loading…" />
      ) : found.length === 0 ? (
        <Text dimColor>{isFiltered ? 'No entry matches.' : 'Nothing in this category.'}</Text>
      ) : (
        <Box flexDirection="column">
          <Heading
            el={el}
            title={
              isFiltered
                ? `Matches${category === 'all' ? '' : ` in ${catLabel(category)}`}`
                : category === 'all'
                  ? 'Every entry'
                  : cap(catLabel(category))
            }
            aside="newest first"
          />
          {rows.map((e) => (
            <Row
              key={`r:${e.path}`}
              el={el}
              auto={auto}
              k={rowKey(category, e.path)}
              title={e.title}
              facts={entryFacts(e, category === 'all', filter)}
              width={width}
              onPress={() => on.open(e.path)}
            />
          ))}
          {found.length > rows.length && (
            <Button
              key={`more:${rows.length}`}
              {...af(auto, `more:${rows.length}`)}
              label={`▸ ${Math.min(PAGE, found.length - rows.length)} more`}
              plain
              dimColor
              onPress={on.more}
            />
          )}
        </Box>
      )}
    </Box>
  );
}

function Search({
  el,
  on,
  auto,
  search,
  rev,
  width,
  draft,
  isTyping,
  isDesk,
}: ViewProps & {
  /** The desktop: a click puts the caret in the field, no hint about keys. */
  isDesk: boolean;
  search: AgentKnowledgeSearch | null;
  rev: number;
  width: number;
  /** The field's text while the person types anew; null: the last search's words. */
  draft: string | null;
  /** The ring is in a text field: keys type. */
  isTyping: boolean;
}) {
  const { Box, Text, Input } = el;
  const hits = (
    title: string,
    list: AgentKnowledgeHit[],
    offset: number,
    cap: number,
    none: string,
  ) =>
    list.length === 0 ? (
      <Box flexDirection="column">
        <Heading el={el} title={title} aside="0" />
        <Text dimColor>{none}</Text>
      </Box>
    ) : (
      <Box flexDirection="column">
        <Heading
          el={el}
          title={title}
          aside={list.length >= cap ? `${cap}, the best` : String(list.length)}
        />
        {list.map((hit, i) =>
          hit.kind === 'entry' ? (
            <Row
              key={`h:${i + offset}`}
              el={el}
              auto={auto}
              k={hitKey(rev, hit, i + offset)}
              title={hit.title}
              facts={[catLabel(hit.category)]}
              extra={hit.excerpt}
              width={width}
              onPress={() => on.open(hit.path)}
            />
          ) : (
            <Row
              key={`h:${i + offset}`}
              el={el}
              auto={auto}
              k={hitKey(rev, hit, i + offset)}
              title={hit.name}
              facts={[hit.when ? time(hit.when) : '', ROLE[hit.role]]}
              extra={hit.excerpt}
              width={width}
              onPress={() => on.openSession(hit.id, hit.project)}
            />
          ),
        )}
      </Box>
    );
  return (
    <Box flexDirection="column" gap={1}>
      {Input ? (
        <Input
          key={`find:${rev}`}
          {...af(auto, `find:${rev}`)}
          label="Search"
          placeholder={fitting(['words, in entries and sessions', 'words to find'], width - 15)}
          value={draft ?? search?.query ?? ''}
          submitLabel="search"
          onInput={on.typing}
          onSubmit={on.search}
        />
      ) : (
        <Text dimColor>Searching needs a surface with text fields.</Text>
      )}
      {!isTyping && !isDesk && (
        <Text {...color(ACCENT)}>Press 2 again, or Enter on Search, to type a search.</Text>
      )}
      {!search ? (
        <Text dimColor>
          Finds words, and close spellings, in every entry and in past sessions. Best matches first.
        </Text>
      ) : search.entries.length + search.sessions.length === 0 ? (
        <Text dimColor>Nothing found for "{search.query}".</Text>
      ) : (
        <Box flexDirection="column" gap={1}>
          {hits('Entries', search.entries, 0, ENTRY_HITS, 'No entry has these words.')}
          {hits(
            'In past sessions',
            search.sessions,
            search.entries.length,
            SESSION_HITS,
            'No past session has these words.',
          )}
        </Box>
      )}
    </Box>
  );
}

/** How long a session ran: 45m, 2h 10m. */
export function duration(start: string, end: string): string {
  const ms = parse(end).getTime() - parse(start).getTime();
  if (Number.isNaN(ms) || ms < 0) return '';
  const min = Math.round(ms / 60_000);
  if (min < 1) return '';
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ''}`;
}

/**
 * The sessions Sessions lists: the ones something was asked in; those with no prompt (a
 * /clear and nothing after, a session only of commands) once the person unfolds them.
 */
export function sessionRows(sessions: AgentKnowledgeSessionRow[], expanded: string[]) {
  return expanded.includes('promptless') ? sessions : sessions.filter((s) => s.prompts > 0);
}

function Sessions({
  el,
  on,
  auto,
  sessions,
  total,
  current,
  expanded,
  shown,
  width,
}: ViewProps & {
  sessions: AgentKnowledgeSessionRow[] | null;
  /** The sessions there are in all: past the ones loaded, `more` loads the next. */
  total: number;
  current: string;
  expanded: string[];
  shown: number;
  width: number;
}) {
  const { Box, Text, Button } = el;
  if (sessions === null) return <el.Progress label="Sessions" valueText="loading…" />;
  if (sessions.length === 0)
    return (
      <Text dimColor>
        No sessions found. Sessions of Claude Code, Cursor and OpenCode on this machine show here.
      </Text>
    );
  const listed = sessionRows(sessions, expanded);
  // Older sessions than the ones loaded: `more` goes on to them.
  const unloaded = Math.max(0, total - sessions.length);
  const promptless = sessions.length - sessions.filter((s) => s.prompts > 0).length;
  const rows = listed.slice(0, shown);
  return (
    <Box flexDirection="column">
      <Heading el={el} title="Recent sessions" aside="newest first" />
      {rows.map((s) => (
        <Row
          key={`s:${s.id}`}
          el={el}
          auto={auto}
          k={`sess:${s.id}`}
          title={s.id === current ? `${s.name} (this session)` : s.name}
          facts={[s.start !== 'unknown' && time(s.start), duration(s.start, s.end), s.branch]}
          extra={s.preview || 'nothing asked'}
          width={width}
          onPress={() => on.openSession(s.id, s.project)}
        />
      ))}
      {listed.length - rows.length + unloaded > 0 && (
        <Button
          key={`more:${rows.length}`}
          {...af(auto, `more:${rows.length}`)}
          label={`▸ ${Math.min(PAGE, listed.length - rows.length + unloaded)} more`}
          plain
          dimColor
          onPress={on.more}
        />
      )}
      {promptless > 0 && (
        <Button
          key={foldKey('promptless', expanded.includes('promptless'))}
          label={
            expanded.includes('promptless')
              ? '▾ Show less'
              : `▸ ${promptless} more where nothing was asked`
          }
          plain
          dimColor
          onPress={() => on.toggle('promptless')}
        />
      )}
    </Box>
  );
}

/** A list that folds past LIST_SHOWN items behind a toggle named by `foldKey(part)`. */
function Folded({
  el,
  on,
  part,
  expanded,
  items,
  render,
}: {
  el: El;
  on: Actions;
  part: string;
  expanded: string[];
  items: string[];
  render: (item: string, i: number) => unknown;
}) {
  const { Box, Button } = el;
  const isOpen = expanded.includes(part);
  const shown = isOpen ? items : items.slice(0, LIST_SHOWN);
  return (
    <Box flexDirection="column">
      {shown.map((it, i) => render(it, i) as never)}
      {items.length > LIST_SHOWN && (
        <Button
          key={foldKey(part, isOpen)}
          label={isOpen ? '▾ Show less' : `▸ ${items.length - LIST_SHOWN} more`}
          plain
          dimColor
          onPress={() => on.toggle(part)}
        />
      )}
    </Box>
  );
}

/** Who said a session hit: the person asked, the agent answered, or a tool was called or answered. */
const ROLE: Record<string, string> = {
  user: 'asked',
  assistant: 'answered',
  tool_use: 'tool call',
  tool_result: 'tool output',
};

const ARROWS = { out: '→', in: '←' } as const;

/**
 * One link on a page, read as a sentence: `→ depends on REST only` (this entry depends on it),
 * `← agent-tasks · depends on this` (it depends on this one). One to an entry that is not there
 * is drawn, not pressed.
 */
function LinkRow({
  el,
  auto,
  k,
  direction,
  rel,
  title,
  origin,
  isGone,
  onPress,
}: {
  el: El;
  auto: string | null;
  k: string;
  direction: 'out' | 'in';
  rel: string;
  title: string;
  origin: string | null;
  isGone: boolean;
  onPress: () => void;
}) {
  const { Box, Text, Button } = el;
  const after = [direction === 'in' ? `${rel} this` : '', origin ?? '', isGone ? 'gone' : '']
    .filter(Boolean)
    .join(' · ');
  return (
    <Box columnGap={1}>
      <Box flexShrink={0}>
        <Text dimColor>{direction === 'out' ? `${ARROWS.out} ${rel}` : ARROWS.in}</Text>
      </Box>
      <Box flexShrink={1}>
        {isGone ? (
          <Text dimColor wrap="wrap">
            {`${title}${after ? ` · ${after}` : ''}`}
          </Text>
        ) : (
          <Button key={k} {...af(auto, k)} plain onPress={onPress}>
            <Text wrap="wrap">
              {title}
              {after ? <Text dimColor> · {after}</Text> : null}
            </Text>
          </Button>
        )}
      </Box>
    </Box>
  );
}

/** A Markdown link to another entry: `[words](projects/x.md)`, by its path from the knowledge root. */
const ENTRY_LINK = /\[([^\]]+)\]\((?![a-z][\w+.-]*:)([^)\s]+\.md)\)/gi;

/** The entries a body links to, by their paths from the knowledge root, once each. */
export function entryLinks(body: string, from: string): string[] {
  const dir = from.split('/').slice(0, -1);
  const out = new Set<string>();
  for (const m of body.matchAll(ENTRY_LINK)) {
    const parts = m[2]!.startsWith('/') ? [] : [...dir];
    for (const seg of m[2]!.replace(/^\//, '').split('/')) {
      if (seg === '..') parts.pop();
      else if (seg !== '.') parts.push(seg);
    }
    // A path naming its category from the root reads from the root.
    const rel = parts.join('/');
    out.add(dir.length && m[2]!.includes('/') && !m[2]!.startsWith('.') ? m[2]! : rel);
  }
  return [...out];
}

/** A body with its entry links as their words: they are listed, and pressed, under Links. */
export const plainEntryLinks = (body: string) => body.replace(ENTRY_LINK, '$1');

/**
 * A body whose Markdown tables fit `width`: a table wider than the pane reads one row a line,
 * its cells joined with ` · ` (the header bold), as box drawing past the edge cannot be read.
 */
export function fitTables(body: string, width: number): string {
  const lines = body.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    if (!/^\s*\|/.test(lines[i]!)) {
      out.push(lines[i++]!);
      continue;
    }
    const table: string[] = [];
    while (i < lines.length && /^\s*\|/.test(lines[i]!)) table.push(lines[i++]!.trim());
    const cells = (row: string) =>
      row
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim());
    const rows = table.filter((r) => !/^\|?[\s:|-]+\|?$/.test(r)).map(cells);
    const widths = rows[0]?.map((_, c) => Math.max(...rows.map((r) => cols(r[c] ?? '')))) ?? [];
    const drawn = widths.reduce((sum, w) => sum + w + 3, 1);
    if (drawn <= width) {
      out.push(...table);
      continue;
    }
    // Too wide: each row as its pairs, every value with the header it stands under.
    const [head = [], ...body] = rows;
    for (const r of body)
      out.push(r.map((v, c) => `**${head[c] || c + 1}:** ${v}`).join(' · '), '');
  }
  return out.join('\n');
}

/** A body cut into its prose (drawn as Markdown) and its fenced code (drawn as code lines). */
export type BodyPart = { code: false; text: string } | { code: true; lines: string[] };

/** The parts of body lines; a fence the fold cut open runs to the end. */
export function bodyParts(lines: string[]): BodyPart[] {
  const parts: BodyPart[] = [];
  let prose: string[] = [];
  let code: string[] | null = null;
  const flush = () => {
    if (prose.join('\n').trim()) parts.push({ code: false, text: prose.join('\n').trim() });
    prose = [];
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (code === null) {
        flush();
        code = [];
      } else {
        parts.push({ code: true, lines: code });
        code = null;
      }
      continue;
    }
    (code ?? prose).push(line);
  }
  if (code !== null) parts.push({ code: true, lines: code });
  flush();
  return parts;
}

/**
 * Code apart from the prose: a dim bar before each line, so a long line wrapped (its rest
 * indented under it, with no bar) never reads as a second command.
 */
function CodeLines({ el, lines }: { el: El; lines: string[] }) {
  const { Box, Text } = el;
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Box key={`line:${i}`} columnGap={1}>
          <Box flexShrink={0}>
            <Text dimColor>│</Text>
          </Box>
          <Box flexShrink={1}>
            <Text color={ACCENT} wrap="wrap">
              {line || ' '}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}

/** What deleting an entry does, said before it is done: what goes, what it leaves, for good. */
export function deleteQuestion(page: AgentKnowledgePage, hasGit: boolean): string {
  const incoming = page.links.filter((l) => l.direction === 'in' && !l.isMissing).length;
  return [
    `Delete ${page.path}?`,
    hasGit
      ? 'The file goes, and the deletion is pushed to the remote (its git history keeps it).'
      : 'The file goes from this machine for good: there is no undo.',
    incoming > 0
      ? `${count(incoming, 'entry', 'entries')} that link${incoming === 1 ? 's' : ''} here lose${incoming === 1 ? 's' : ''} that link.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function EntryPage({
  el,
  on,
  auto,
  page,
  route,
  expanded,
  confirm,
  hasGit,
  width,
  known,
  isDesk,
}: ViewProps & {
  /** The desktop: the body whole as one Markdown, the links drawn as a graph too. */
  isDesk: boolean;
  /** The entries there are, by path to title; null until the list was loaded. */
  known: Map<string, string> | null;
  page: AgentKnowledgePage;
  hasGit: boolean;
  route: AgentKnowledgeRoute;
  expanded: string[];
  confirm: string | null;
  width: number;
}) {
  const { Box, Text, Button, Markdown } = el;
  // Links the text makes to other entries: listed with the links, the text drawn without them.
  const mentions = entryLinks(page.body, page.path).filter(
    (p) => !page.links.some((l) => l.path === p),
  );
  const isGone = (p: string) => known !== null && !known.has(p);
  const gone = page.links.filter((l) => l.isMissing).length + mentions.filter(isGone).length;
  const rowsDrawn = page.links.length + mentions.length;
  const prev = route.trail.at(-1);
  // The entry it came from links to this one: its title comes with the link, from the server.
  const backTitle =
    page.links.find((l) => l.path === prev)?.title ?? (prev ? known?.get(prev) : undefined);
  const backLabel = prev ? clip(backTitle ?? baseName(prev), 40) : cap(route.tab);
  const lines = fitTables(plainEntryLinks(page.body), width).split('\n');
  const isFolding = !isDesk && lines.length >= BODY_LINES + BODY_FOLD;
  const isBodyOpen = expanded.includes('body') || !isFolding;
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Button
          key="back"
          label={`‹ ${backLabel}`}
          plain
          dimColor
          {...af(auto, 'back')}
          onPress={on.back}
        />
        <Text bold wrap="wrap">
          {page.title}
        </Text>
        <Text dimColor wrap="wrap">
          {page.path}
        </Text>
        <Parts
          el={el}
          width={width}
          parts={[
            catLabel(page.category),
            page.isEvergreen && { text: 'evergreen', color: ACCENT },
            page.maturity !== 'candidate' && page.maturity,
            page.reads > 0 && plural(page.reads, 'read'),
            page.updated && `updated ${when(page.updated)}`,
          ]}
        />
      </Box>

      {page.session && (
        <Box flexDirection="column">
          <Fact el={el} label="Session">
            <Text wrap="wrap">{page.session.id}</Text>
          </Fact>
          {page.session.cwd && (
            <Fact el={el} label="Folder">
              <Text wrap="wrap">{page.session.cwd}</Text>
            </Fact>
          )}
          {page.session.branch && (
            <Fact el={el} label="Branch">
              <Text>{page.session.branch}</Text>
            </Fact>
          )}
          {page.session.started && (
            <Fact el={el} label="Started">
              <Text>{time(page.session.started)}</Text>
            </Fact>
          )}
          {page.session.ended && (
            <Fact el={el} label="Last seen">
              <Text>{time(page.session.ended)}</Text>
            </Fact>
          )}
          {page.session.isHere ? (
            <Button
              key="open-session"
              label="Open the session ›"
              plain
              onPress={() => on.openSession(page.session!.id, '')}
            />
          ) : (
            <Text dimColor wrap="wrap">
              The session's transcript is not on this machine: the snapshot is what is kept of it.
            </Text>
          )}
        </Box>
      )}

      {(page.tags.length > 0 || page.author || page.lastRead) && (
        <Box flexDirection="column">
          {page.tags.length > 0 && (
            <Fact el={el} label="Tags">
              <Text wrap="wrap">{page.tags.join(', ')}</Text>
            </Fact>
          )}
          {page.author && (
            <Fact el={el} label="Author">
              <Text wrap="wrap">{page.author}</Text>
            </Fact>
          )}
          {page.lastRead && (
            <Fact el={el} label="Last read">
              <Text wrap="wrap">{when(page.lastRead)}</Text>
            </Fact>
          )}
        </Box>
      )}

      {page.links.length + mentions.length > 0 && (
        <Box flexDirection="column">
          <Heading el={el} title="Links" aside={`${rowsDrawn}${gone ? `, ${gone} gone` : ''}`} />
          {isDesk && el.Svg && page.links.length > 0 && (
            <el.Svg
              source={neighbourGraph(page)}
              alt={`${page.title} and the ${count(page.links.length, 'entry', 'entries')} linked with it`}
            />
          )}
          {page.links.map((l) => (
            <LinkRow
              key={linkKey(page.path, l)}
              el={el}
              auto={auto}
              k={linkKey(page.path, l)}
              direction={l.direction}
              rel={relWords(l.rel)}
              title={l.title}
              origin={l.origin !== 'manual' ? l.origin : null}
              isGone={l.isMissing}
              onPress={() => on.open(l.path)}
            />
          ))}
          {mentions.map((m) => (
            <LinkRow
              key={`mention:${page.path}:${m}`}
              el={el}
              auto={auto}
              k={`mention:${page.path}:${m}`}
              direction="out"
              rel="mentions"
              title={known?.get(m) ?? baseName(m)}
              origin={null}
              isGone={isGone(m)}
              onPress={() => on.open(m)}
            />
          ))}
        </Box>
      )}

      <Box flexDirection="column">
        {page.body.trim() === '' ? (
          <Text dimColor>No text.</Text>
        ) : isDesk ? (
          <Markdown text={plainEntryLinks(page.body)} />
        ) : (
          <Box flexDirection="column" gap={1}>
            {bodyParts(isBodyOpen ? lines : lines.slice(0, BODY_LINES)).map((part, i) =>
              part.code ? (
                <CodeLines key={`code:${i}`} el={el} lines={part.lines} />
              ) : (
                <Markdown key={`text:${i}`} text={part.text} />
              ),
            )}
          </Box>
        )}
        {isFolding && (
          <Button
            key={foldKey('body', expanded.includes('body'))}
            label={expanded.includes('body') ? '▾ Show less' : `▸ Show all ${lines.length} lines`}
            plain
            dimColor
            onPress={() => on.toggle('body')}
          />
        )}
      </Box>

      {confirm === `delete:${page.path}` ? (
        <Box flexDirection="column" borderStyle="round" borderColor={BAD} paddingX={1}>
          <Text color={BAD} wrap="wrap">
            {deleteQuestion(page, hasGit)}
          </Text>
          {/* The safe answer first, with the ring on it. */}
          <Box columnGap={1} flexWrap="wrap">
            <Button
              key="confirm-no"
              label="Keep it"
              {...af(auto, 'confirm-no')}
              onPress={on.dismiss}
            />
            <Button
              key="confirm-yes"
              label={`Delete ${clip(page.path, 40)}`}
              onPress={() => on.remove(page.path)}
            />
          </Box>
        </Box>
      ) : (
        <Box>
          <Button key="ask-delete" label="Delete" onPress={() => on.askDelete(page.path)} />
        </Box>
      )}
    </Box>
  );
}

function SessionPage({
  el,
  on,
  auto,
  s,
  route,
  expanded,
  width,
  backTo,
}: ViewProps & {
  s: AgentKnowledgeSessionPage;
  route: AgentKnowledgeRoute;
  expanded: string[];
  width: number;
  /** The title of the snapshot it was opened from; null: back to the tab. */
  backTo: string | null;
}) {
  const { Box, Text, Button } = el;
  const section = (
    part: string,
    title: string,
    items: string[],
    tone?: string,
    n = items.length,
  ) =>
    items.length === 0 ? null : (
      <Box key={`sec:${part}`} flexDirection="column">
        <Heading el={el} title={title} aside={String(n)} />
        <Folded
          el={el}
          on={on}
          part={part}
          expanded={expanded}
          items={items}
          render={(it, i) => (
            <Bullet key={`${part}:${i}`} el={el} tone={tone}>
              {oneLine(it)}
            </Bullet>
          )}
        />
      </Box>
    );
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Button
          key="back"
          label={`‹ ${backTo ? clip(backTo, 40) : cap(route.tab)}`}
          plain
          dimColor
          {...af(auto, 'back')}
          onPress={on.back}
        />
        <Text bold wrap="wrap">
          {s.name}
        </Text>
        <Parts
          el={el}
          width={width}
          parts={[
            s.start !== 'unknown' && time(s.start),
            duration(s.start, s.end),
            plural(s.prompts, 'prompt'),
          ]}
        />
        {s.cwd && (
          <Text dimColor wrap="wrap">
            {s.cwd}
          </Text>
        )}
      </Box>
      <Box flexDirection="column">
        {s.branch && (
          <Fact el={el} label="Branch">
            <Text wrap="wrap">{s.branch}</Text>
          </Fact>
        )}
        <Fact el={el} label="Session">
          <Text wrap="wrap">{s.id}</Text>
        </Fact>
        <Fact el={el} label="Resume">
          <Text wrap="wrap">claude --resume {s.id}</Text>
        </Fact>
      </Box>
      {section('topics', 'What was asked', s.topics)}
      {section('files', 'Files changed', s.files)}
      {section('commits', 'Commits', s.commits)}
      {section('errors', 'Errors', s.errors, BAD)}
      {section(
        'tools',
        'Tools used',
        s.tools.length ? [s.tools.join(', ')] : [],
        undefined,
        s.tools.length,
      )}
      {s.topics.length + s.files.length + s.commits.length + s.errors.length === 0 && (
        <Text dimColor>Nothing to summarise in this session.</Text>
      )}
    </Box>
  );
}

function Health({
  el,
  on,
  auto,
  o,
  analysis,
  ingest,
  width,
  list,
  isDesk,
}: ViewProps & {
  o: AgentKnowledgeOverview;
  list: AgentKnowledgeEntry[] | null;
  analysis: AgentKnowledgeAnalysis | null;
  ingest: AgentKnowledgeIngest | null;
  width: number;
  isDesk: boolean;
}) {
  const { Box, Text, Button, Svg } = el;
  const cats = categoryOrder(o.categories);
  const weeks = list && activityWeeks(list, new Date());
  return (
    <Box flexDirection="column" gap={1}>
      {isDesk && Svg && cats.length > 0 && (
        <Box columnGap={4} rowGap={1} flexWrap="wrap">
          <Box flexDirection="column">
            <Heading el={el} title="By category" aside="entries" />
            <Svg
              source={categoryChart(o.categories, cats)}
              alt={`Entries per category: ${cats.map((c) => `${c} ${o.categories[c]}`).join(', ')}`}
            />
          </Box>
          {weeks && (
            <Box flexDirection="column">
              <Heading el={el} title="Activity" aside="entries updated per week" />
              <Svg
                source={activityChart(weeks)}
                alt={`Entries updated per week, oldest first: ${weeks.join(', ')}`}
              />
            </Box>
          )}
        </Box>
      )}
      <Box flexDirection="column">
        <Fact el={el} label="Entries">
          <Parts
            el={el}
            width={width - LABEL - 1}
            parts={[
              { text: String(o.entries), bold: true },
              ...cats.map((c) => `${catLabel(c)} ${o.categories[c]}`),
            ]}
          />
        </Fact>
        {o.snapshots > 0 && (
          <Fact el={el} label="Snapshots">
            <Text>{o.snapshots}</Text>
          </Fact>
        )}
        <Fact el={el} label="Sessions">
          <Text>{o.sessions}</Text>
        </Fact>
        <Fact el={el} label="Search">
          <Text wrap="wrap">
            {o.vectors > 0
              ? `words and meaning: ${o.vectors} vectors${o.provider ? ` (${o.provider})` : ''}`
              : 'words only: no embeddings yet'}
          </Text>
        </Fact>
        <Fact el={el} label="Folder">
          {/* Whole, wrapped: a path cut to fit hides where the folder is. */}
          <Text wrap="wrap">{o.memoryDir}</Text>
        </Fact>
        <Fact el={el} label="Git">
          <Text wrap="wrap" {...color(o.hasGit ? undefined : WARN)}>
            {o.hasGit
              ? 'synced with a remote on every write'
              : 'no remote: entries stay on this machine'}
          </Text>
        </Fact>
        <Fact el={el} label="Server">
          <Text>{o.version}</Text>
        </Fact>
        {ingest && (
          <Fact el={el} label="Ingest">
            <Text wrap="wrap" {...color(ingest.state !== 'current' && WARN)}>
              {ingestWords(ingest)}
            </Text>
          </Fact>
        )}
      </Box>
      <Box flexWrap="wrap" columnGap={1}>
        {ingest && ingest.state !== 'current' && (
          <Button key="ingest" label={`Ingest ${ingest.project} ›`} onPress={on.ingest} />
        )}
        {o.hasGit && !isDesk && (
          <Button key="sync" label="Sync now" {...af(auto, 'sync')} onPress={on.sync} />
        )}
        <Button
          key={analysis ? 'analyze:again' : 'analyze:first'}
          label={analysis ? 'Analyze again' : 'Analyze links'}
          {...af(auto, analysis ? 'analyze:again' : 'analyze:first')}
          onPress={on.analyze}
        />
      </Box>
      {o.events.length > 0 && <Events el={el} events={o.events} />}
      {analysis &&
        (o.entries === 0 ? (
          <Text dimColor>No entries to analyze.</Text>
        ) : (
          <Analysis el={el} on={on} auto={auto} a={analysis} width={width} />
        ))}
    </Box>
  );
}

function Analysis({
  el,
  on,
  auto,
  a,
  width,
}: ViewProps & {
  a: AgentKnowledgeAnalysis;
  width: number;
}) {
  const { Box, Text, Button } = el;
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Heading el={el} title="Most linked" aside={String(a.hubs.length)} />
        {a.hubs.length === 0 && <Text dimColor>No links yet.</Text>}
        {a.hubs.map((hub) => (
          <Row
            key={`hub:${hub.path}`}
            el={el}
            auto={auto}
            k={`hub:${hub.path}`}
            title={hub.title}
            facts={[plural(hub.edges, 'link')]}
            width={width}
            onPress={() => on.open(hub.path)}
          />
        ))}
      </Box>
      <Box flexDirection="column">
        <Heading
          el={el}
          title="One link or none"
          aside={
            a.sparseTotal > a.sparse.length
              ? `${a.sparse.length} of ${a.sparseTotal}`
              : String(a.sparse.length)
          }
        />
        {a.sparse.length === 0 && <Text dimColor>Every entry has two links or more.</Text>}
        {/* Fewest links first, then by title, a page at a time. */}
        {a.sparse.map((x) => (
          <Row
            key={`sparse:${x.path}`}
            el={el}
            auto={auto}
            k={`sparse:${x.path}`}
            title={x.title}
            facts={[x.edges ? plural(x.edges, 'link') : 'no links']}
            width={width}
            onPress={() => on.open(x.path)}
          />
        ))}
        {a.sparseTotal > a.sparse.length && (
          <Button
            key={`sparse-more:${a.sparse.length}`}
            label={`▸ ${Math.min(ANALYSIS_PAGE, a.sparseTotal - a.sparse.length)} more`}
            plain
            dimColor
            onPress={on.analyzeMore}
          />
        )}
      </Box>
    </Box>
  );
}

function Events({ el, events }: { el: El; events: AgentKnowledgeEvent[] }) {
  const { Box, Text } = el;
  return (
    <Box flexDirection="column">
      <Heading el={el} title="Recent activity" aside="newest first" />
      {[...events].reverse().map((e) => (
        <Box key={`ev:${e.id}`} columnGap={1}>
          <Box flexShrink={0}>
            <Text dimColor>{time(new Date(e.ts).toISOString())}</Text>
          </Box>
          <Box flexShrink={1}>
            <Text wrap="wrap">
              {eventWords(e.kind)}: {e.message}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}

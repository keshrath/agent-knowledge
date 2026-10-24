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
  AgentKnowledgeLink,
  AgentKnowledgeOverview,
  AgentKnowledgePage,
  AgentKnowledgeRoute,
  AgentKnowledgeSearch,
  AgentKnowledgeSessionPage,
  AgentKnowledgeSessionRow,
  AgentKnowledgeTab,
} from '../types';

/** The elements the pane draws with; mobile has no `Input`. */
export type El = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Markdown'> &
  Partial<Pick<Elements['terminal'], 'Input'>>;

export type Actions = {
  refresh: () => void;
  go: (tab: AgentKnowledgeTab) => void;
  /** Opens an entry's page. */
  open: (path: string) => void;
  openSession: (id: string, project: string) => void;
  back: () => void;
  pickCategory: (category: string) => void;
  filter: (text: string) => void;
  clearFilter: () => void;
  more: () => void;
  search: (query: string) => void;
  /** Unfolds or folds a part of a page (`foldKey`). */
  toggle: (part: string) => void;
  askDelete: (path: string) => void;
  remove: (path: string) => void;
  dismiss: () => void;
  sync: () => void;
  analyze: () => void;
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

/** Local time: HH:MM today, MM-DD HH:MM before; a bare day as YYYY-MM-DD. */
export function time(ts: string, now = new Date()): string {
  if (isDay(ts)) return ts;
  const d = parse(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return d.toDateString() === now.toDateString()
    ? clock
    : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clock}`;
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
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
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

/** The summary as text: the status line entry reads the same. */
export function headline(o: Pick<AgentKnowledgeOverview, 'entries' | 'sessions'>): string {
  return `${count(o.entries, 'entry', 'entries')} · ${plural(o.sessions, 'session')}`;
}

const needle = (q: string) => q.trim().toLowerCase();

/** The Browse filter: text found in the title, path or tags. */
export function matches(e: AgentKnowledgeEntry, query: string): boolean {
  const q = needle(query);
  if (!q) return true;
  return [e.title, e.path, ...e.tags].some((v) => v.toLowerCase().includes(q));
}

/** What Browse lists: `list` narrowed to `category` ('all' for every one) and `filter`. */
export const browseRows = (list: AgentKnowledgeEntry[], category: string, filter: string) =>
  list.filter((e) => (category === 'all' || e.category === category) && matches(e, filter));

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

/** A path cut from the left at a separator to fit `n` columns: `…\agent-knowledge`. */
export function clipPath(path: string, n: number): string {
  if (cols(path) <= n) return path;
  const seps = [...path.matchAll(/[\\/]/g)].map((m) => m.index!);
  const at = seps.find((i) => cols(path.slice(i)) + 1 <= n);
  return at === undefined ? clip(path, n) : `…${path.slice(at)}`;
}

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
  shown: number;
  search: AgentKnowledgeSearch | null;
  sessions: AgentKnowledgeSessionRow[] | null;
  page: AgentKnowledgePage | null;
  sessionPage: AgentKnowledgeSessionPage | null;
  analysis: AgentKnowledgeAnalysis | null;
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

/** An outcome's tone, by the mark `act` in register.tsx leads it with: ✓ done, ✗ failed. */
const noticeTone = (notice: string) =>
  notice.startsWith('✓') ? { color: OK } : notice.startsWith('✗') ? { color: BAD } : {};

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

export function Pane(p: PaneProps) {
  const { Box, Text, Button } = p.el;
  const { overview: o, route, on } = p;
  const width = p.columns;
  const isTyping = p.isFocused && isField(p.focused);
  const v = { el: p.el, on, auto: p.landing };

  let body;
  if (!o.isUp) body = <Down el={p.el} o={o} />;
  else if (route.entry !== null)
    body =
      p.page?.path === route.entry ? (
        <EntryPage
          {...v}
          page={p.page}
          route={route}
          expanded={p.expanded}
          confirm={p.confirm}
          hasGit={o.hasGit}
          width={width}
        />
      ) : (
        <Text dimColor>Loading {route.entry}…</Text>
      );
  else if (route.session !== null)
    body =
      p.sessionPage?.id === route.session.id ? (
        <SessionPage {...v} s={p.sessionPage} route={route} expanded={p.expanded} width={width} />
      ) : (
        <Text dimColor>Loading the session…</Text>
      );
  else if (route.tab === 'browse')
    body = (
      <Browse
        {...v}
        o={o}
        category={p.category}
        filter={p.filter}
        list={p.list}
        shown={p.shown}
        rev={p.rev}
        width={width}
      />
    );
  else if (route.tab === 'search')
    body = <Search {...v} search={p.search} rev={p.rev} width={width} />;
  else if (route.tab === 'sessions')
    body = <Sessions {...v} sessions={p.sessions} shown={p.shown} width={width} />;
  else body = <Health {...v} o={o} analysis={p.analysis} expanded={p.expanded} width={width} />;

  return (
    <Box flexDirection="column" gap={1} width={width}>
      <Box flexDirection="column">
        {/* A narrow dock wraps the bar between two controls, never inside one. */}
        <Box flexWrap="wrap" columnGap={2}>
          {/* Down, there is nothing to switch between: only Refresh is drawn. */}
          {(o.isUp ? TABS : []).map(([tab, label, hotkey]) => (
            <Button
              key={`tab:${tab}`}
              {...af(p.landing, `tab:${tab}`)}
              label={label}
              {...(isTyping ? {} : { hotkey })}
              plain
              {...(route.tab === tab ? {} : { dimColor: true })}
              onPress={() => on.go(tab)}
            >
              {route.tab === tab && route.entry === null && route.session === null ? (
                <Text bold underline>
                  {label}
                </Text>
              ) : (
                label
              )}
            </Button>
          ))}
          <Button
            key={refreshKey(o.isUp, p.rev)}
            label="Refresh"
            {...(isTyping ? {} : { hotkey: 'r' })}
            plain
            {...af(p.landing, refreshKey(o.isUp, p.rev))}
            onPress={on.refresh}
          />
        </Box>
        {/* One status line under the tabs: the action in flight, else its outcome, else the
            keys. Only an outcome long enough to wrap (a refusal's reason) takes more. */}
        {p.busy ? (
          <Text color={WARN} wrap="truncate">
            {p.busy}…
          </Text>
        ) : p.notice ? (
          <Text {...noticeTone(p.notice)}>{p.notice}</Text>
        ) : (
          <Text dimColor wrap="truncate">
            {fitting(isTyping ? TYPING : p.isFocused ? KEYS : UNFOCUSED, width)}
          </Text>
        )}
      </Box>
      {body}
    </Box>
  );
}

/**
 * A row: one Button cut to one line, then its facts beneath, then an optional dim line (an
 * excerpt, a preview).
 */
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
  const shown = facts.filter((f): f is Part => Boolean(f));
  return (
    <Box flexDirection="column">
      <Button key={k} {...af(auto, k)} plain onPress={onPress}>
        {clip(oneLine(title), Math.max(10, width))}
      </Button>
      {shown.length > 0 && (
        <Box paddingLeft={2}>
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
        </Box>
      )}
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
  const tags = q ? e.tags.filter((t) => t.toLowerCase().includes(q)) : e.tags.slice(0, 3);
  return [
    ...(withCategory ? [e.category] : []),
    ...(e.isEvergreen ? [{ text: 'evergreen', color: ACCENT }] : []),
    ...(e.maturity !== 'candidate' ? [e.maturity] : []),
    ...tags.map((t) => (q ? { text: `tag ${t}`, color: ACCENT } : `#${t}`)),
    ...(e.updated ? [ago(e.updated)] : []),
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
  shown,
  rev,
  width,
}: ViewProps & {
  o: AgentKnowledgeOverview;
  category: string;
  filter: string;
  list: AgentKnowledgeEntry[] | null;
  shown: number;
  rev: number;
  width: number;
}) {
  const { Box, Text, Button, Input } = el;
  if (o.entries === 0)
    return (
      <Box flexDirection="column">
        <Text>The knowledge base is empty.</Text>
        <Text dimColor>
          Agents save what they learn here, by category: projects, people, decisions, workflows and
          notes. Past sessions are under Sessions.
        </Text>
      </Box>
    );
  const cats = ['all', ...categoryOrder(o.categories)];
  const found = browseRows(list ?? [], category, filter);
  const rows = found.slice(0, shown);
  const isFiltered = filter !== '';
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexWrap="wrap" columnGap={2}>
        {cats.map((c) => {
          const n = c === 'all' ? o.entries : (o.categories[c] ?? 0);
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
                  {c} {n}
                </Text>
              ) : (
                `${c} ${n}`
              )}
            </Button>
          );
        })}
      </Box>
      {Input && (
        <Box flexDirection="column">
          <Input
            key={`filter:${rev}`}
            label="Find"
            placeholder={fitting(['title, path or tag', 'title or tag'], width - 13)}
            value={filter}
            submitLabel="find"
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
        <Text dimColor>Loading…</Text>
      ) : found.length === 0 ? (
        <Text dimColor>{isFiltered ? 'No entry matches.' : 'Nothing in this category.'}</Text>
      ) : (
        <Box flexDirection="column">
          <Heading
            el={el}
            title={
              isFiltered
                ? `Matches${category === 'all' ? '' : ` in ${category}`}`
                : category === 'all'
                  ? 'Every entry'
                  : cap(category)
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
              label={`▸ ${Math.min(PAGE, found.length - rows.length)} more (${found.length - rows.length} left)`}
              plain
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
}: ViewProps & { search: AgentKnowledgeSearch | null; rev: number; width: number }) {
  const { Box, Text, Input } = el;
  const hits = (title: string, list: AgentKnowledgeHit[], offset: number) =>
    list.length === 0 ? null : (
      <Box flexDirection="column">
        <Heading el={el} title={title} aside={String(list.length)} />
        {list.map((hit, i) =>
          hit.kind === 'entry' ? (
            <Row
              key={`h:${i + offset}`}
              el={el}
              auto={auto}
              k={hitKey(rev, hit, i + offset)}
              title={hit.title}
              facts={[hit.category]}
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
              title={hit.project}
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
          value={search?.query ?? ''}
          submitLabel="search"
          onSubmit={on.search}
        />
      ) : (
        <Text dimColor>Searching needs a surface with text fields.</Text>
      )}
      {!search ? (
        <Text dimColor>
          Finds words, and close spellings, in every entry and in past sessions. Best matches first.
        </Text>
      ) : search.entries.length + search.sessions.length === 0 ? (
        <Text dimColor>Nothing found for "{search.query}".</Text>
      ) : (
        <Box flexDirection="column" gap={1}>
          {hits('Entries', search.entries, 0)}
          {hits('Sessions', search.sessions, search.entries.length)}
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

function Sessions({
  el,
  on,
  auto,
  sessions,
  shown,
  width,
}: ViewProps & { sessions: AgentKnowledgeSessionRow[] | null; shown: number; width: number }) {
  const { Box, Text, Button } = el;
  if (sessions === null) return <Text dimColor>Loading…</Text>;
  if (sessions.length === 0)
    return (
      <Text dimColor>
        No sessions found. Sessions of Claude Code, Cursor and OpenCode on this machine show here.
      </Text>
    );
  const rows = sessions.slice(0, shown);
  return (
    <Box flexDirection="column">
      <Heading el={el} title="Recent sessions" aside="newest first" />
      {rows.map((s) => (
        <Row
          key={`s:${s.id}`}
          el={el}
          auto={auto}
          k={`sess:${s.id}`}
          title={s.project}
          facts={[s.start !== 'unknown' && time(s.start), duration(s.start, s.end), s.branch]}
          extra={s.preview}
          width={width}
          onPress={() => on.openSession(s.id, s.project)}
        />
      ))}
      {sessions.length > rows.length && (
        <Button
          key={`more:${rows.length}`}
          {...af(auto, `more:${rows.length}`)}
          label={`▸ ${Math.min(PAGE, sessions.length - rows.length)} more`}
          plain
          onPress={on.more}
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
          label={isOpen ? '▾ Fewer' : `▸ ${items.length - LIST_SHOWN} more`}
          plain
          onPress={() => on.toggle(part)}
        />
      )}
    </Box>
  );
}

/** Who said a session hit: the person asked, the agent answered. */
const ROLE: Record<string, string> = { user: 'asked', assistant: 'answered' };

const ARROWS = { out: '→', in: '←' } as const;

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
}: ViewProps & {
  page: AgentKnowledgePage;
  hasGit: boolean;
  route: AgentKnowledgeRoute;
  expanded: string[];
  confirm: string | null;
  width: number;
}) {
  const { Box, Text, Button, Markdown } = el;
  const prev = route.trail.at(-1);
  // The entry it came from links to this one: its title comes with the link, from the server.
  const backTitle = page.links.find((l) => l.path === prev)?.title;
  const backLabel = prev ? clip(backTitle ?? baseName(prev), 40) : cap(route.tab);
  const lines = page.body.split('\n');
  const isFolding = lines.length >= BODY_LINES + BODY_FOLD;
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
            page.category,
            page.isEvergreen && { text: 'evergreen', color: ACCENT },
            page.maturity !== 'candidate' && page.maturity,
            page.reads > 0 && plural(page.reads, 'read'),
            page.updated && `updated ${when(page.updated)}`,
          ]}
        />
      </Box>

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

      {page.links.length > 0 && (
        <Box flexDirection="column">
          <Heading el={el} title="Links" aside={String(page.links.length)} />
          {page.links.map((l) => (
            <Button
              key={linkKey(page.path, l)}
              {...af(auto, linkKey(page.path, l))}
              plain
              onPress={() => on.open(l.path)}
            >
              <Text wrap="wrap">
                <Text dimColor>
                  {ARROWS[l.direction]} {relWords(l.rel)}{' '}
                </Text>
                {l.title}
                {l.origin !== 'manual' ? <Text dimColor> · {l.origin}</Text> : null}
              </Text>
            </Button>
          ))}
        </Box>
      )}

      <Box flexDirection="column">
        {page.body.trim() === '' ? (
          <Text dimColor>No text.</Text>
        ) : (
          <Markdown
            text={isBodyOpen ? page.body.trim() : lines.slice(0, BODY_LINES).join('\n').trim()}
          />
        )}
        {isFolding && (
          <Button
            key={foldKey('body', expanded.includes('body'))}
            label={expanded.includes('body') ? '▾ Show less' : `▸ Show all ${lines.length} lines`}
            plain
            onPress={() => on.toggle('body')}
          />
        )}
      </Box>

      {confirm === `delete:${page.path}` ? (
        <Box flexDirection="column" borderStyle="round" borderColor={BAD} paddingX={1}>
          <Text color={BAD}>
            Delete {page.path}?{' '}
            {hasGit
              ? 'The file goes and the deletion is pushed to the remote.'
              : 'The file goes from this machine.'}
          </Text>
          <Box columnGap={1}>
            <Button key="confirm-yes" label="Delete" onPress={() => on.remove(page.path)} />
            <Button
              key="confirm-no"
              label="Never mind"
              {...af(auto, 'confirm-no')}
              onPress={on.dismiss}
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
}: ViewProps & {
  s: AgentKnowledgeSessionPage;
  route: AgentKnowledgeRoute;
  expanded: string[];
  width: number;
}) {
  const { Box, Text, Button } = el;
  const section = (part: string, title: string, items: string[], tone?: string) =>
    items.length === 0 ? null : (
      <Box key={`sec:${part}`} flexDirection="column">
        <Heading el={el} title={title} aside={String(items.length)} />
        <Folded
          el={el}
          on={on}
          part={part}
          expanded={expanded}
          items={items}
          render={(it, i) => (
            <Text key={`${part}:${i}`} wrap="wrap" {...color(tone)}>
              · {oneLine(it)}
            </Text>
          )}
        />
      </Box>
    );
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Button
          key="back"
          label={`‹ ${cap(route.tab)}`}
          plain
          dimColor
          {...af(auto, 'back')}
          onPress={on.back}
        />
        <Text bold wrap="wrap">
          {s.project}
        </Text>
        <Parts
          el={el}
          width={width}
          parts={[
            s.start !== 'unknown' && time(s.start),
            duration(s.start, s.end),
            plural(s.messages, 'message'),
            s.branch,
          ]}
        />
        {s.cwd && (
          <Text dimColor wrap="wrap">
            {s.cwd}
          </Text>
        )}
      </Box>
      {section('topics', 'What was asked', s.topics)}
      {section('files', 'Files changed', s.files)}
      {section('commits', 'Commits', s.commits)}
      {section('errors', 'Errors', s.errors, BAD)}
      {section('tools', 'Tools used', s.tools.length ? [s.tools.join(', ')] : [])}
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
  expanded,
  width,
}: ViewProps & {
  o: AgentKnowledgeOverview;
  analysis: AgentKnowledgeAnalysis | null;
  expanded: string[];
  width: number;
}) {
  const { Box, Text, Button } = el;
  const cats = categoryOrder(o.categories);
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Fact el={el} label="Entries">
          <Parts
            el={el}
            width={width - LABEL - 1}
            parts={[
              { text: String(o.entries), bold: true },
              ...cats.map((c) => `${c} ${o.categories[c]}`),
            ]}
          />
        </Fact>
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
          <Text>{clipPath(o.memoryDir, width - LABEL - 1)}</Text>
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
      </Box>
      <Box flexWrap="wrap" columnGap={1}>
        {o.hasGit && <Button key="sync" label="Sync now" {...af(auto, 'sync')} onPress={on.sync} />}
        <Button
          key={analysis ? 'analyze:again' : 'analyze:first'}
          label={analysis ? 'Analyze again' : 'Analyze links'}
          {...af(auto, analysis ? 'analyze:again' : 'analyze:first')}
          onPress={on.analyze}
        />
      </Box>
      {analysis && (
        <Analysis el={el} on={on} auto={auto} a={analysis} expanded={expanded} width={width} />
      )}
      {o.events.length > 0 && <Events el={el} events={o.events} />}
    </Box>
  );
}

function Analysis({
  el,
  on,
  auto,
  a,
  expanded,
  width,
}: ViewProps & { a: AgentKnowledgeAnalysis; expanded: string[]; width: number }) {
  const { Box, Text } = el;
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
        <Heading el={el} title="One link or none" aside={String(a.sparse.length)} />
        {a.sparse.length === 0 ? (
          <Text dimColor>Every entry has two links or more.</Text>
        ) : (
          <Folded
            el={el}
            on={on}
            part="sparse"
            expanded={expanded}
            items={a.sparse.map((x) => x.path)}
            render={(p) => {
              const x = a.sparse.find((y) => y.path === p);
              return (
                <Row
                  key={`sparse:${p}`}
                  el={el}
                  auto={auto}
                  k={`sparse:${p}`}
                  title={x?.title ?? baseName(p)}
                  facts={[x?.edges ? plural(x.edges, 'link') : 'no links']}
                  width={width}
                  onPress={() => on.open(p)}
                />
              );
            }}
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
        <Text key={`ev:${e.id}`} wrap="wrap">
          <Text dimColor>{time(new Date(e.ts).toISOString())} </Text>
          {e.kind}: {e.message}
        </Text>
      ))}
    </Box>
  );
}

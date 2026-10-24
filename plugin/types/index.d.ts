/** What the REST server looked like at the last poll (GET /api/overview). */
export type AgentKnowledgeOverview = {
  isUp: boolean;
  /** REST origin, e.g. http://127.0.0.1:3423 */
  origin: string;
  /** Down because an agent-knowledge without the overview (1.x) holds the port: its version. */
  old: string | null;
  version: string;
  /**
   * Entries by folder (projects, people, decisions, workflows, notes, any other folder, and
   * `other` for files at the top).
   */
  categories: Record<string, number>;
  entries: number;
  sessions: number;
  /** The embedding index: vectors stored and the provider that made them (null: none yet). */
  vectors: number;
  provider: string | null;
  /** Where the entries live and whether a git remote syncs them. */
  memoryDir: string;
  hasGit: boolean;
  /** Recent live events (a session ended, a distill ran), oldest first. */
  events: AgentKnowledgeEvent[];
};

export type AgentKnowledgeEvent = { id: number; kind: string; message: string; ts: number };

export type AgentKnowledgeTab = 'browse' | 'search' | 'sessions' | 'health';

/**
 * Which view the pane shows. `entry` set is that entry's page, `session` set that session's
 * summary, each opened from `tab`; `trail` holds the entries walked through by their links,
 * for the way back.
 */
export type AgentKnowledgeRoute = {
  tab: AgentKnowledgeTab;
  entry: string | null;
  session: AgentKnowledgeSessionRef | null;
  trail: string[];
};

export type AgentKnowledgeSessionRef = { id: string; project: string };

/** One entry as a list row draws it (GET /api/knowledge). */
export type AgentKnowledgeEntry = {
  path: string;
  title: string;
  category: string;
  tags: string[];
  updated: string;
  maturity: string;
  reads: number;
  isEvergreen: boolean;
};

/** One graph edge seen from the open entry: where it goes and how they relate. */
export type AgentKnowledgeLink = {
  /** The other entry's path. */
  path: string;
  /** Its title as the server reads it; its file name when the entry is gone. */
  title: string;
  rel: string;
  /** out: the open entry points at it; in: it points at the open entry. */
  direction: 'out' | 'in';
  origin: string;
};

/** The open entry's page. */
export type AgentKnowledgePage = AgentKnowledgeEntry & {
  author: string | null;
  lastRead: string | null;
  /** The Markdown body, frontmatter left out. */
  body: string;
  links: AgentKnowledgeLink[];
};

/** A search hit: an entry, or a moment in a session. */
export type AgentKnowledgeHit =
  | { kind: 'entry'; path: string; title: string; category: string; excerpt: string }
  | {
      kind: 'session';
      id: string;
      project: string;
      when: string;
      role: string;
      excerpt: string;
    };

export type AgentKnowledgeSearch = {
  query: string;
  entries: AgentKnowledgeHit[];
  sessions: AgentKnowledgeHit[];
};

/** One session as the Sessions list draws it (GET /api/sessions). */
export type AgentKnowledgeSessionRow = {
  id: string;
  project: string;
  start: string;
  end: string;
  messages: number;
  branch: string;
  preview: string;
};

/** A session's summary page (GET /api/sessions/:id/summary). */
export type AgentKnowledgeSessionPage = AgentKnowledgeSessionRow & {
  cwd: string;
  topics: string[];
  tools: string[];
  files: string[];
  commits: string[];
  errors: string[];
};

/** The Health tab's link analysis, made when asked (it reads every entry). */
export type AgentKnowledgeAnalysis = {
  /** The most linked entries. */
  hubs: { path: string; title: string; edges: number }[];
  /** Entries with one link or none: what nothing much leads to. */
  sparse: { path: string; title: string; edges: number }[];
};

declare module 'claude-code' {
  interface PluginState {
    'agent-knowledge': {
      overview: AgentKnowledgeOverview | null;
      route: AgentKnowledgeRoute;
      /** The Browse tab's category ('all' for every one) and the text its list is narrowed to. */
      category: string;
      filter: string;
      /** Every entry, newest first (Browse narrows it to `category`); null until loaded. */
      list: AgentKnowledgeEntry[] | null;
      /** How many Browse rows are drawn (it grows by a page). */
      shown: number;
      search: AgentKnowledgeSearch | null;
      sessions: AgentKnowledgeSessionRow[] | null;
      page: AgentKnowledgePage | null;
      sessionPage: AgentKnowledgeSessionPage | null;
      analysis: AgentKnowledgeAnalysis | null;
      /** Unfolded parts of a page: `body`, `topics`, `files`, … (`foldKey` in view.tsx). */
      expanded: string[];
      /** An action waiting for a second press ("delete:projects/x.md"). */
      confirm: string | null;
      /**
       * Bumped whenever a text field is submitted or a list is replaced: keys made with it name
       * the new drawing, so landing on them waits for it.
       */
      rev: number;
      /** The action in flight ("sync"), shown instead of its outcome. */
      busy: string | null;
      /** The last action's outcome, one line. */
      notice: string | null;
      /** The key of the pane's element holding the ring; null when none does. */
      focused: string | null;
    };
  }
}

/** What the REST server looked like at the last poll (GET /api/overview). */
export type AgentKnowledgeOverview = {
  isUp: boolean;
  /** REST origin, e.g. http://127.0.0.1:3423 */
  origin: string;
  /** Down because an agent-knowledge without the overview (1.x) holds the port: its version. */
  old: string | null;
  version: string;
  /**
   * The curated entries by folder (projects, people, decisions, workflows, notes, any other
   * folder, and `other` for files at the top); the session snapshots are not among them.
   */
  categories: Record<string, number>;
  /** The curated entries: every one but the session snapshots (the sum of `categories`). */
  entries: number;
  /** The session snapshots (`sessions/` in the knowledge folder). */
  snapshots: number;
  /** The past sessions' transcripts on this machine. */
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
  /** The entry at the other end is not there (deleted, or never written): nothing to open. */
  isMissing: boolean;
};

/** The open entry's page. */
export type AgentKnowledgePage = AgentKnowledgeEntry & {
  author: string | null;
  lastRead: string | null;
  /** The Markdown body, frontmatter left out. */
  body: string;
  links: AgentKnowledgeLink[];
  /** A session snapshot's session: its id, folder, branch and start, from its frontmatter. */
  session: {
    id: string;
    cwd: string;
    branch: string;
    started: string;
    /** The session's last line (`last_activity`): when it ended, or was last seen. */
    ended: string;
    /** Whether the session's transcript is on this machine (it can be opened). */
    isHere: boolean;
  } | null;
};

/** A search hit: an entry, or a moment in a session. */
export type AgentKnowledgeHit =
  | { kind: 'entry'; path: string; title: string; category: string; excerpt: string }
  | {
      kind: 'session';
      id: string;
      /** The session store's folder: what the summary is asked by. */
      project: string;
      /** The project as a person names it, as the Sessions list does. */
      name: string;
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
  /** The session store's folder: what the summary is asked by. */
  project: string;
  /** The project as a person names it: its folder's name. */
  name: string;
  start: string;
  end: string;
  messages: number;
  /** The person's real prompts (no slash commands, no notices): 0 is a session nothing was asked in. */
  prompts: number;
  branch: string;
  /** The first real prompt; '' when there is none. */
  preview: string;
};

/** A session's summary page (GET /api/sessions/:id/summary). */
export type AgentKnowledgeSessionPage = AgentKnowledgeSessionRow & {
  cwd: string;
  /** What the person asked: their prompts, not every line of the transcript. */
  prompts: number;
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
  /** Entries with one link or none: what nothing much leads to (the first of them). */
  sparse: { path: string; title: string; edges: number }[];
  /** How many entries have one link or none in all. */
  sparseTotal: number;
};

/** Browse's order as drawn when the pane took the keyboard, for the view it was drawn in. */
export type AgentKnowledgePin = {
  /** The category and Find it was drawn under (`pinView`): another view sorts afresh. */
  view: string;
  /** Entry paths, top to bottom. */
  paths: string[];
};

/** This session's project against its knowledge-ingest (GET /api/ingest). */
export type AgentKnowledgeIngest = {
  /** never: not ingested; stale: files changed since; current: up to date. */
  state: 'never' | 'stale' | 'current';
  project: string;
  /** The folder, as `/knowledge-ingest <dir>` takes it. */
  dir: string;
  /** never: source files seen (a lower bound); stale: files changed, new and deleted. */
  files: number;
  /** stale: the changes in words ("3 changed, 1 new"). */
  changes: string;
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
      /** How many sessions there are in all: the list loads SESSIONS at a time. */
      sessionsTotal: number;
      page: AgentKnowledgePage | null;
      sessionPage: AgentKnowledgeSessionPage | null;
      analysis: AgentKnowledgeAnalysis | null;
      /** This session's project against its ingest; null until asked, or for a tiny folder. */
      ingest: AgentKnowledgeIngest | null;
      /** Unfolded parts of a page: `body`, `topics`, `files`, … (`foldKey` in view.tsx). */
      expanded: string[];
      /** An action waiting for a second press ("delete:projects/x.md"). */
      confirm: string | null;
      /**
       * Bumped whenever a text field is submitted or a list is replaced: keys made with it name
       * the new drawing, so landing on them waits for it.
       */
      rev: number;
      /** The action in flight ("Syncing"), drawn as a Progress instead of its outcome. */
      busy: string | null;
      /**
       * Browse's rows (entry paths) in the order drawn when the pane took the keyboard: kept
       * while it holds it, so a poll never moves a row under the ring; null: sorted afresh.
       */
      pinned: AgentKnowledgePin | null;
      /** The last action's outcome, one line. */
      notice: string | null;
      /** The key of the pane's element holding the ring; null when none does. */
      focused: string | null;
      /** The Search field's text while the person types anew; null: the last search's words. */
      draft: string | null;
      /**
       * What the Find field is drawn with: set when it is made or reset (a Find run, cleared,
       * a command), never from the typing, which the engine keeps until another value is drawn.
       */
      findValue: string;
      /**
       * The conversation (session id) whose first real prompt already carried the knowledge
       * hits: one injection per conversation, again after a /clear (a new id) or a restart.
       */
      injected: string | null;
    };
  }
}

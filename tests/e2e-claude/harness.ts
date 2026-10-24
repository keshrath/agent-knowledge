// =============================================================================
// Harness for driving the /knowledge pane inside the real Claude Code CLI.
//
// A scratch world: its own knowledge folder (Markdown entries), data dir
// (sessions, the graph and scoring database), HOME and port, seeded before the
// REST server (dist/rest-server.js, started alone) runs on it. Claude Code runs
// in a pseudo-terminal (node-pty) and is rendered by @xterm/headless; the
// screen text is what the tests assert on. Nothing touches the user's REST
// server (127.0.0.1:3423) or knowledge base (~/agent-knowledge).
//
// Isolation from the installed plugin: `--setting-sources project,local` skips
// the user settings file, so its `enabledPlugins`, hooks, status line and `env`
// do not load; auth still comes from the normal credentials store. The plugin
// under test is a scratch copy of plugin/ whose .mcp.json runs this checkout's
// dist/index.js on the scratch world, on a port of its own: the pane talks to
// the world's server alone, so stopping it is seen as down.
// =============================================================================

import { execFileSync, execSync, spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pty from 'node-pty';
import xterm from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';

const ROOT = resolve(import.meta.dirname, '..', '..');
export const DIST = join(ROOT, 'dist');
export const SHOTS_DIR =
  process.env.AGENT_KNOWLEDGE_E2E_SHOTS ??
  join(
    process.env.USERPROFILE ?? process.env.HOME ?? tmpdir(),
    '.claude',
    'tmp',
    'pane-shots-knowledge',
    'e2e',
  );
/** Stable, so the folder-trust answer is remembered instead of piling up per run. */
const WORKSPACE = join(tmpdir(), 'agent-knowledge-e2e-claude-ws');

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
      .once('error', rej)
      .listen(0, '127.0.0.1', () => {
        const { port } = s.address() as { port: number };
        s.close(() => res(port));
      });
  });
}

/** Kills a process with its children; a plain kill on Windows orphans them. */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

/** One entry the seed writes: its path under the knowledge folder, frontmatter and body. */
export type SeedEntry = {
  path: string;
  title: string;
  tags?: string[];
  updated?: string;
  evergreen?: boolean;
  author?: string;
  body: string;
};

export type SeedSession = {
  project: string;
  id: string;
  cwd: string;
  branch?: string;
  /** [role, text or content blocks (tool_use, tool_result), ISO time] */
  lines: ['user' | 'assistant', string | Record<string, unknown>[], string][];
};

export type Seed = {
  entries: SeedEntry[];
  sessions: SeedSession[];
  /** [source, target, rel_type, origin] */
  edges: [string, string, string, string][];
  /** Entry paths read this many times (their maturity follows the reads). */
  reads: Record<string, number>;
};

const LONG_BODY = [
  '# The /knowledge pane',
  '',
  'The web dashboard is gone; the pane is the way in.',
  '',
  ...Array.from({ length: 45 }, (_, i) => `- point ${i + 1}: something worth keeping`),
  '',
  '```ts',
  "const pane = 'agent-knowledge';",
  '```',
].join('\n');

/**
 * A knowledge base a person would recognise: projects with links between them, a decision,
 * a workflow kept evergreen, a person, notes, one long entry, one with a wide-character title,
 * a file at the top of the folder, and two sessions with something to summarise.
 */
export const SEED: Seed = {
  entries: [
    {
      path: 'projects/agent-tasks.md',
      title: 'agent-tasks 2.0',
      tags: ['release', 'pane'],
      updated: '2026-10-22',
      author: 'claude-code',
      body: '# agent-tasks 2.0\n\nThe board moved into the **/pipeline** pane.\n\n- REST stays on 3422\n- the dashboard is gone',
    },
    {
      path: 'projects/agent-knowledge.md',
      title: 'agent-knowledge 2.0',
      tags: ['release', 'pane'],
      updated: '2026-10-23',
      body: LONG_BODY,
    },
    {
      path: 'decisions/rest-only.md',
      title: 'REST only, no WebSocket',
      tags: ['architecture'],
      updated: '2026-10-18',
      body: '# REST only\n\nChose: plain REST polling.\nOver: a WebSocket.\nBecause: the pane polls anyway.',
    },
    {
      path: 'workflows/release.md',
      title: 'Release ritual',
      tags: ['release'],
      updated: '2026-10-15',
      evergreen: true,
      body: '# Release ritual\n\n1. build\n2. prettier\n3. eslint\n4. test\n5. tag and push',
    },
    {
      path: 'people/maintainer.md',
      title: 'The maintainer',
      updated: '2026-09-01',
      body: '# The maintainer\n\nPrefers net-negative diffs.',
    },
    {
      path: 'notes/zebrafish.md',
      title: 'Zebrafish deploy recipe',
      tags: ['deploy'],
      updated: '2026-10-10',
      body: '# Zebrafish\n\nThe zebrafish service deploys with `make ship`.',
    },
    {
      path: 'notes/wide.md',
      title: '設計レビューの記録とメモ 🚀 release notes',
      updated: '2026-10-05',
      body: '# 設計\n\nWide characters take two columns.',
    },
    {
      path: 'README.md',
      title: 'About this folder',
      updated: '2026-08-01',
      body: 'What lives here.',
    },
  ],
  sessions: [
    {
      project: 'agent-tasks',
      id: 'sess-pane-1',
      cwd: 'C:/work/agent-tasks',
      branch: 'main',
      lines: [
        ['user', 'move the board into a Claude Code pane', '2026-10-22T08:00:00.000Z'],
        [
          'assistant',
          'Edited plugin/hooks/view.tsx and ran the tests.',
          '2026-10-22T08:05:00.000Z',
        ],
        ['user', 'now test it in the real CLI with the quokka harness', '2026-10-22T09:00:00.000Z'],
        ['assistant', 'Error: TypeError: x is undefined, fixed it.', '2026-10-22T09:30:00.000Z'],
      ],
    },
    {
      project: 'agent-knowledge',
      id: 'sess-sync-2',
      cwd: 'C:/work/agent-knowledge',
      lines: [
        ['user', 'why did the git sync break', '2026-10-21T08:00:00.000Z'],
        [
          'assistant',
          [
            { type: 'text', text: 'Pushing again to see what the remote says.' },
            { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'git push' } },
          ],
          '2026-10-21T08:05:00.000Z',
        ],
        [
          'user',
          [
            {
              type: 'tool_result',
              tool_use_id: 'tu-1',
              content:
                "push of commit 4e5f6a7 from src/knowledge/git.ts\nError: failed to push some refs to 'origin' (non-fast-forward)",
            },
          ],
          '2026-10-21T08:06:00.000Z',
        ],
        ['assistant', 'The remote rejected the push.', '2026-10-21T08:20:00.000Z'],
      ],
    },
  ],
  edges: [
    ['projects/agent-knowledge.md', 'projects/agent-tasks.md', 'related_to', 'manual'],
    ['projects/agent-tasks.md', 'decisions/rest-only.md', 'depends_on', 'manual'],
    ['workflows/release.md', 'projects/agent-tasks.md', 'related_to', 'auto-link'],
  ],
  reads: { 'projects/agent-tasks.md': 6, 'decisions/rest-only.md': 2 },
};

export interface World {
  dir: string;
  memoryDir: string;
  dataDir: string;
  port: number;
  base: string;
  /** The REST server's environment (the scratch HOME, folders and port). */
  env: Record<string, string>;
  /** Claude Code's environment: the real HOME (auth), the plugin pointed at this world. */
  claudeEnv: Record<string, string>;
  pluginDir: string;
  api: <T = Record<string, unknown>>(method: string, path: string, body?: unknown) => Promise<T>;
  /** Writes an entry file directly, as another session's agent would. */
  write(e: SeedEntry): void;
  /** Records a live event, as a hook does at session end. */
  event(kind: string, message: string): Promise<void>;
  stopServer(): Promise<void>;
  startServer(): Promise<void>;
  /** Starts an MCP process (dist/index.js) of its own on the world's port: it takes over REST when free. */
  startMcp(): ChildProcess;
  stop(): Promise<void>;
}

async function health(base: string): Promise<boolean> {
  try {
    return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1_000) })).ok;
  } catch {
    return false;
  }
}

function entryFile(e: SeedEntry): string {
  const fm = [
    '---',
    `title: ${e.title}`,
    ...(e.tags?.length ? [`tags: [${e.tags.join(', ')}]`] : []),
    ...(e.updated ? [`updated: ${e.updated}`] : []),
    ...(e.evergreen ? ['evergreen: true'] : []),
    ...(e.author ? [`author: ${e.author}`] : []),
    '---',
    '',
  ];
  return `${fm.join('\n')}${e.body}\n`;
}

/** Writes the seed: entry files, session files, and the graph and reads through dist. */
function writeSeed(memoryDir: string, dataDir: string, seed: Seed) {
  for (const e of seed.entries) {
    const file = join(memoryDir, e.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, entryFile(e));
  }
  for (const s of seed.sessions) {
    const dir = join(dataDir, 'projects', s.project);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${s.id}.jsonl`),
      s.lines
        .map(([role, text, ts]) =>
          JSON.stringify({
            type: role,
            sessionId: s.id,
            cwd: s.cwd,
            gitBranch: s.branch ?? '',
            timestamp: ts,
            message: { role, content: text },
          }),
        )
        .join('\n') + '\n',
    );
  }
  if (seed.edges.length === 0 && Object.keys(seed.reads).length === 0) return;
  // The graph and scoring live in one SQLite file in the data dir; a child writes them and
  // exits, so no handle stays open in the test process.
  const db = join(dataDir, 'knowledge-scores.db');
  const graph = pathToFileURL(join(DIST, 'knowledge', 'graph.js')).href;
  const scoring = pathToFileURL(join(DIST, 'knowledge', 'scoring.js')).href;
  const code = `
    const { getKnowledgeGraph } = await import(${JSON.stringify(graph)});
    const { getEntryScoring } = await import(${JSON.stringify(scoring)});
    const g = getKnowledgeGraph(${JSON.stringify(db)});
    for (const [s, t, r, o] of ${JSON.stringify(seed.edges)}) g.link(s, t, r, 0.8, null, null, o);
    const sc = getEntryScoring(${JSON.stringify(db)});
    for (const [p, n] of Object.entries(${JSON.stringify(seed.reads)})) for (let i = 0; i < n; i++) sc.recordAccess(p);
    g.close(); sc.close();
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, AGENT_KNOWLEDGE_DATA_DIR: dataDir },
    stdio: 'pipe',
  });
}

/** Scratch folders + REST server, seeded; the plugin copy pointed at them. */
export async function startWorld(seed: Seed = SEED, port?: number): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-knowledge-e2e-claude-'));
  const home = join(dir, 'home');
  const memoryDir = join(dir, 'knowledge');
  const dataDir = join(dir, 'data');
  for (const d of [home, memoryDir, dataDir, join(home, 'AppData', 'Roaming')])
    mkdirSync(d, { recursive: true });
  writeSeed(memoryDir, dataDir, seed);
  const restPort = port ?? (await freePort());
  const mcpPort = await freePort();
  const base = `http://127.0.0.1:${restPort}`;
  const scratch = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    AGENT_KNOWLEDGE_MEMORY_DIR: memoryDir,
    AGENT_KNOWLEDGE_DATA_DIR: dataDir,
    // No key for it: no embeddings, words-only search, nothing leaves the machine.
    AGENT_KNOWLEDGE_EMBEDDING_PROVIDER: 'openai',
    AGENT_KNOWLEDGE_AUTO_DISTILL: 'false',
  };
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...scratch,
    AGENT_KNOWLEDGE_PORT: String(restPort),
  };
  delete env.AGENT_KNOWLEDGE_GIT_URL;
  delete env.KNOWLEDGE_OPENAI_API_KEY;
  const claudeEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    AGENT_KNOWLEDGE_PORT: String(restPort),
  };
  // A Claude Code session running this suite must not leak its session markers into the child.
  for (const e of [env, claudeEnv])
    for (const k of Object.keys(e)) if (/^(CLAUDECODE|CLAUDE_CODE_)/.test(k)) delete e[k];

  let server: ChildProcess | null = null;
  const startServer = async () => {
    let out = '';
    const url = pathToFileURL(join(DIST, 'rest-server.js')).href;
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const m = await import(${JSON.stringify(url)}); await m.startRestServer(${restPort});`,
      ],
      { env, windowsHide: true },
    );
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (out += d));
    server = child;
    const deadline = Date.now() + 20_000;
    while (!(await health(base))) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`server: ${out}`);
      await sleep(100);
    }
  };
  const stopServer = async () => {
    const child = server;
    server = null;
    if (!child) return;
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    killTree(child.pid);
    await Promise.race([exited, sleep(5_000)]);
    const deadline = Date.now() + 5_000;
    while ((await health(base)) && Date.now() < deadline) await sleep(100);
  };
  await startServer();
  const mcps: ChildProcess[] = [];

  const api: World['api'] = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
    return (text ? JSON.parse(text) : null) as never;
  };

  // The plugin under test, pointed at this checkout and this world.
  const pluginDir = join(dir, 'plugin');
  cpSync(join(ROOT, 'plugin'), pluginDir, {
    recursive: true,
    filter: (src) => !src.startsWith(join(ROOT, 'plugin', 'tests')),
  });
  writeFileSync(
    join(pluginDir, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        'agent-knowledge': {
          command: process.execPath,
          args: [join(DIST, 'index.js')],
          env: { ...scratch, AGENT_KNOWLEDGE_PORT: String(mcpPort) },
        },
      },
    }),
  );

  return {
    dir,
    memoryDir,
    dataDir,
    port: restPort,
    base,
    env,
    claudeEnv,
    pluginDir,
    api,
    write: (e) => {
      const file = join(memoryDir, e.path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, entryFile(e));
    },
    event: async (kind, message) => void (await api('POST', '/api/events', { kind, message })),
    stopServer,
    startServer,
    startMcp: () => {
      const child = spawn(process.execPath, [join(DIST, 'index.js')], {
        env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      mcps.push(child);
      return child;
    },
    async stop() {
      await stopServer();
      for (const m of mcps) killTree(m.pid);
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch {
        // Windows: the session's MCP child can briefly pin the database.
      }
    },
  };
}

const KEYS: Record<string, string> = {
  TAB: '\t',
  SHIFTTAB: '\x1b[Z',
  ENTER: '\r',
  DOWN: '\x1b[B',
  UP: '\x1b[A',
  ESC: '\x1b',
  BS: '\x7f',
  FOCUS: '\x18\t',
};

/** A focused Input draws its submit hint after the field. */
const SUBMIT_HINT = /[⏎↵]/;

/** Claude Code in a pseudo-terminal of `cols` x `rows`. */
export class ClaudeTerm {
  private readonly term: InstanceType<typeof xterm.Terminal>;
  private readonly serializer = new SerializeAddon();
  private proc: pty.IPty | null = null;

  /** `env` adds to the world's, e.g. CLAUDE_CODE_NO_FLICKER=1 for the fullscreen layout. */
  constructor(
    private readonly world: World,
    readonly cols = 120,
    readonly rows = 50,
    private readonly env: Record<string, string> = {},
  ) {
    this.term = new xterm.Terminal({ cols, rows, allowProposedApi: true });
    this.term.loadAddon(this.serializer as never);
    // Unicode 11 widths, as Claude Code lays text out: an emoji takes two columns.
    this.term.loadAddon(new Unicode11Addon() as never);
    this.term.unicode.activeVersion = '11';
  }

  /**
   * Starts it and waits for the plugin's status entry (`ready`): its session.start ran, so
   * /knowledge is registered. The default is the entry and session counts.
   */
  async start(ready = /agent-knowledge: .*\d+ (entry|entries)/): Promise<void> {
    mkdirSync(WORKSPACE, { recursive: true });
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
    this.proc = pty.spawn(
      exe,
      [
        '--plugin-dir',
        this.world.pluginDir,
        '--setting-sources',
        'project,local',
        // The user's own MCP servers (~/.claude.json) stay out; the plugin's still load.
        '--strict-mcp-config',
      ],
      {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: WORKSPACE,
        env: { ...this.world.claudeEnv, ...this.env },
      },
    );
    this.proc.onData((d) => this.term.write(d));
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const s = this.text();
      if (/Yes, I trust this folder/.test(s)) {
        // The default answer is "No, exit"; keys sent before the dialog settles are lost.
        await sleep(1_500);
        this.proc.write(KEYS.DOWN);
        await sleep(300);
        this.proc.write(KEYS.ENTER);
        await sleep(1_000);
      } else if (ready.test(s)) break;
      await sleep(300);
    }
    if (!ready.test(this.text())) throw new Error(`Claude Code never got ready:\n${this.screen()}`);
    await sleep(1_000);
  }

  /** The visible screen; inverted cells (the focus ring) are wrapped in «…». */
  screen(): string {
    const b = this.term.buffer.active;
    const cell = b.getNullCell();
    const out: string[] = [];
    for (let y = 0; y < this.rows; y++) {
      const line = b.getLine(b.viewportY + y);
      if (!line) continue;
      let text = '';
      let inverted = false;
      for (let x = 0; x < this.cols; x++) {
        line.getCell(x, cell);
        // The second cell of a wide character is empty: it adds nothing.
        if (cell.getWidth() === 0) continue;
        const inv = cell.isInverse() !== 0;
        if (inv !== inverted) {
          text += inv ? '«' : '»';
          inverted = inv;
        }
        text += cell.getChars() || ' ';
      }
      if (inverted) text += '»';
      out.push(text.trimEnd());
    }
    return out.join('\n');
  }

  /** The screen without the focus marks, for assertions. */
  text(): string {
    return this.screen().replace(/[«»]/g, '');
  }

  /**
   * How the first cell showing `label` (searched from column `from` on) is drawn: its
   * foreground colour (-1 for the terminal's default), dim and bold.
   */
  style(label: string, from = 0): { fg: number; dim: boolean; bold: boolean } {
    const b = this.term.buffer.active;
    const lines = this.text().split('\n');
    for (let y = 0; y < lines.length; y++) {
      const x = lines[y]!.indexOf(label, from);
      if (x < 0) continue;
      const cell = b.getLine(b.viewportY + y)!.getCell(x)!;
      return {
        fg: cell.isFgDefault() ? -1 : cell.getFgColor(),
        dim: cell.isDim() !== 0,
        bold: cell.isBold() !== 0,
      };
    }
    throw new Error(`nothing on the screen shows ${label}:\n${this.screen()}`);
  }

  async waitFor(re: RegExp, ms = 20_000): Promise<string> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const s = this.text();
      if (re.test(s)) return s;
      await sleep(250);
    }
    throw new Error(`screen never matched ${re}:\n${this.screen()}`);
  }

  async key(name: keyof typeof KEYS | string, times = 1): Promise<void> {
    for (let i = 0; i < times; i++) {
      this.proc!.write(KEYS[name] ?? name);
      await sleep(250);
    }
  }

  /** Writes `text`, then waits `pause` ms. */
  async type(text: string, pause = 400): Promise<void> {
    this.proc!.write(text);
    await sleep(pause);
  }

  /**
   * What holds the focus: a Button is drawn inverted; a focused Input shows its submit hint
   * after the field, so its whole line stands for it.
   */
  focused(): string | null {
    const s = this.screen();
    const ring = /«([^»]*)»/.exec(s)?.[1]?.trim();
    if (ring) return ring;
    const input = s.split('\n').find((l) => SUBMIT_HINT.test(l));
    return input ? input.replace(/^[\s│]+|[\s│]+$/g, '') : null;
  }

  /**
   * Waits until the screen has held still for `quiet` ms (at most `ms`): after a move the pane
   * lands the ring itself a moment later, and a Tab sent before that is undone by it.
   */
  async settle(quiet = 600, ms = 4_000): Promise<void> {
    const deadline = Date.now() + ms;
    let last = this.screen();
    let since = Date.now();
    while (Date.now() < deadline && Date.now() - since < quiet) {
      await sleep(100);
      const now = this.screen();
      if (now !== last) [last, since] = [now, Date.now()];
    }
  }

  /**
   * Tab until the focus ring holds `label`. Each Tab waits for the ring to move, and a hit
   * must hold for a moment: a redraw (the plugin landing the ring itself) can move it.
   */
  async focus(label: string | RegExp, max = 60): Promise<void> {
    const hit = (f: string | null) =>
      f !== null && (typeof label === 'string' ? f.includes(label) : label.test(f));
    await this.settle();
    for (let i = 0; i < max; i++) {
      if (hit(this.focused())) {
        await sleep(300);
        if (hit(this.focused())) return;
        continue;
      }
      const before = this.focused();
      this.proc!.write(KEYS.TAB);
      const deadline = Date.now() + 1_500;
      while (Date.now() < deadline && this.focused() === before) await sleep(50);
    }
    throw new Error(`focus never reached ${label}:\n${this.screen()}`);
  }

  /** Focus `label` and press Enter (pressed again when nothing on the screen moves). */
  async press(label: string | RegExp): Promise<void> {
    await this.focus(label);
    await this.enter();
  }

  /** Enter on what has the focus; now and then the CLI drops one, so it is pressed again. */
  async enter(): Promise<void> {
    const before = this.screen();
    await this.key('ENTER');
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline && this.screen() === before) await sleep(100);
    if (this.screen() === before) await this.key('ENTER');
  }

  /**
   * `/knowledge [args]` typed into the prompt (slash commands make no model call). Returns
   * once the command has answered: keys sent while it still runs are queued for the prompt.
   */
  async knowledge(args = ''): Promise<void> {
    const answered = () => {
      const lines = this.text().split('\n');
      const asked = lines.findLastIndex((l) => /^❯ \/knowledge/.test(l));
      return (
        asked >= 0 &&
        lines.slice(asked + 1).some((l) => /^\s+⎿/.test(l)) &&
        !/esc to interrupt/.test(lines.slice(-4).join('\n'))
      );
    };
    await this.type(`/knowledge${args ? ` ${args}` : ''}`);
    await sleep(300);
    await this.key('ENTER');
    const deadline = Date.now() + 30_000;
    while (!answered()) {
      if (Date.now() > deadline) throw new Error(`/knowledge never answered:\n${this.screen()}`);
      await sleep(100);
    }
    await sleep(300);
  }

  /**
   * A mouse click (left button, SGR encoding) on the first cell showing `label`, searched from
   * `from` columns on (the docked pane sits right of the conversation). Clicked again when
   * nothing on the screen moves for 4 s.
   */
  async click(label: string, from = 0): Promise<void> {
    await this.settle();
    const lines = this.text().split('\n');
    const y = lines.findIndex((l) => l.indexOf(label, from) >= 0);
    if (y < 0) throw new Error(`nothing to click shows ${label}:\n${this.screen()}`);
    const [col, row] = [lines[y]!.indexOf(label, from) + Math.ceil(label.length / 2), y + 1];
    const press = async () => {
      this.proc!.write(`\x1b[<0;${col};${row}M`);
      await sleep(60);
      this.proc!.write(`\x1b[<0;${col};${row}m`);
    };
    const before = this.screen();
    await press();
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline && this.screen() === before) await sleep(100);
    if (this.screen() === before) await press();
    await sleep(300);
  }

  /** The whole screen as escape sequences: what a renderer replays. */
  serialize(): string {
    return this.serializer.serialize();
  }

  /** Writes <label>.ansi (for the PNG renderer) and returns the screen text. */
  shot(label: string): string {
    mkdirSync(SHOTS_DIR, { recursive: true });
    writeFileSync(
      join(SHOTS_DIR, `${label}.ansi`),
      JSON.stringify({ cols: this.cols, rows: this.rows, data: this.serialize() }),
    );
    return this.screen();
  }

  async kill(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      const exited = new Promise<void>((r) => proc.onExit(() => r()));
      killTree(proc.pid);
      await Promise.race([exited, sleep(5_000)]);
    }
    this.term.dispose();
  }
}

/** The ring settles where the plugin lands it after a move. */
export async function landsOn(t: ClaudeTerm, label: string | RegExp, ms = 5_000): Promise<void> {
  const hit = () => {
    const f = t.focused();
    return f !== null && (typeof label === 'string' ? f.includes(label) : label.test(f));
  };
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !hit()) await sleep(100);
  if (!hit()) throw new Error(`the ring is not on ${label}:\n${t.screen()}`);
}

/** The status line entry: the text the plugin hands `$.ui.status`, under the prompt. */
export function statusEntry(t: ClaudeTerm): string | null {
  const lines = t.text().split('\n');
  const prompt = lines.findLastIndex((l) => l.startsWith('❯'));
  const below = lines.slice(prompt + 1).join('\n');
  return /agent-knowledge: ([^\n]+)/.exec(below)?.[1]?.trim() ?? null;
}

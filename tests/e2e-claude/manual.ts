// =============================================================================
// Records the pictures of docs/USER-MANUAL.md §4: scripted sessions in the real
// Claude Code CLI against a scratch world (the e2e suite's seeded knowledge
// base), each still a PNG and each flow a short GIF in docs/images/manual/.
//
//   npm run manual:record            record everything
//   npm run manual:record -- open    write only the pictures whose name contains "open"
//
// Slash commands and the pane make no model calls; a run costs no tokens. The
// seed is the same each run, so the pictures only change when the pane does.
// =============================================================================

import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ClaudeTerm, sleep, startWorld, type World } from './harness.js';
import { Film, Recorder, capture, paneCrop, type Crop, type Take } from './record.js';

const OUT = resolve(import.meta.dirname, '..', '..', 'docs', 'images', 'manual');
/**
 * One port for every recording, so a picture that shows it (the server away) reads the same
 * each run; not 3423, which a running agent-knowledge holds.
 */
const PORT = 3433;
const FULLSCREEN = { CLAUDE_CODE_NO_FLICKER: '1', CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: '1' };
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

type Shot = { name: string; take: Take; kind: 'png' | 'gif' };

/** A session on the world with helpers that keep stills and clips. */
class Session {
  readonly shots: Shot[] = [];
  readonly t: ClaudeTerm;

  constructor(
    readonly w: World,
    cols: number,
    rows: number,
    env: Record<string, string> = FULLSCREEN,
  ) {
    this.t = new ClaudeTerm(w, cols, rows, env);
  }

  private crop(where: 'pane' | 'full'): Crop | null {
    return where === 'pane' ? paneCrop(this.t) : null;
  }

  /** The screen as it is now. */
  async still(name: string, where: 'pane' | 'full' = 'pane'): Promise<void> {
    await this.t.settle(800, 5_000);
    const frames = [{ at: 0, data: capture(this.t) }];
    this.shots.push({
      name,
      kind: 'png',
      take: { cols: this.t.cols, rows: this.t.rows, frames, crop: this.crop(where) },
    });
  }

  /** Plays `act` while recording it. The crop is taken at the end, with the pane there. */
  async clip(name: string, where: 'pane' | 'full', act: () => Promise<void>): Promise<void> {
    await this.t.settle(800, 5_000);
    const rec = new Recorder(this.t);
    rec.start();
    await sleep(700);
    await act();
    await this.t.settle(500, 4_000);
    const frames = await rec.stop(900);
    this.shots.push({
      name,
      kind: 'gif',
      take: { cols: this.t.cols, rows: this.t.rows, frames, crop: this.crop(where) },
    });
  }

  /** Types like a person, so a clip shows it. */
  async typeSlowly(text: string, ms = 70): Promise<void> {
    for (const ch of text) await this.t.type(ch, ms);
    await sleep(250);
  }

  /** Moves the ring one Tab (or shift+Tab) at a time until it holds `label`, then a beat. */
  async tabTo(label: string | RegExp, back = false, max = 30): Promise<void> {
    const hit = () => {
      const f = this.t.focused();
      return f !== null && (typeof label === 'string' ? f.includes(label) : label.test(f));
    };
    await this.t.settle(400, 3_000);
    for (let i = 0; i < max && !hit(); i++) {
      const before = this.t.focused();
      await this.t.key(back ? 'SHIFTTAB' : 'TAB');
      const deadline = Date.now() + 1_500;
      while (Date.now() < deadline && this.t.focused() === before) await sleep(50);
      await sleep(120);
    }
    if (!hit()) throw new Error(`the ring never reached ${label}:\n${this.t.screen()}`);
    await sleep(450);
  }

  /** `/knowledge [args]` from the prompt, typed visibly. */
  async command(args = ''): Promise<void> {
    await this.t.key('ESC');
    await sleep(250);
    await this.typeSlowly(`/knowledge${args ? ` ${args}` : ''}`, 40);
    await this.t.key('ENTER');
    await sleep(500);
    while (/esc to interrupt/.test(this.t.text())) await sleep(100);
    await sleep(300);
  }
}

/** The README's picture: a fresh session opens the pane, an entry and one of its links. */
async function hero(w: World): Promise<Shot[]> {
  const s = new Session(w, 140, 42);
  const { t } = s;
  await t.start();
  try {
    await s.clip('hero', 'full', async () => {
      await s.command();
      await t.waitFor(/Every entry newest first/);
      await sleep(1_200);
      await s.tabTo('agent-tasks 2.0');
      await t.enter();
      await t.waitFor(/Links 3/);
      await sleep(1_200);
      await s.tabTo('depends on');
      await t.enter();
      await t.waitFor(/decisions\/rest-only\.md/);
      await sleep(1_500);
    });
    return s.shots;
  } finally {
    await t.kill();
  }
}

/** The docked pane, wide: every tab and flow but the other layouts and the server away. */
async function docked(w: World): Promise<Shot[]> {
  const s = new Session(w, 140, 42);
  const { t } = s;
  await t.start();
  try {
    await s.clip('open', 'full', async () => {
      await s.command();
      await t.waitFor(/Every entry newest first/);
      await sleep(1_200);
    });
    await s.still('browse-full', 'full');
    await s.still('browse');

    await s.clip('category', 'pane', async () => {
      await s.tabTo('workflows 1', true);
      await t.enter();
      await t.waitFor(/Workflows newest first/);
      await sleep(1_000);
      await s.tabTo('all 8', true);
      await t.enter();
      await t.waitFor(/Every entry newest first/);
    });

    await s.clip('find', 'pane', async () => {
      await s.tabTo('Find', true);
      await s.typeSlowly('deploy');
      await t.key('ENTER');
      await t.waitFor(/1 match\b/);
      await sleep(1_400);
      await s.tabTo('Clear the filter', true);
      await t.enter();
      await t.waitFor(/Every entry newest first/);
    });
    await s.tabTo('Find', true);
    await s.typeSlowly('deploy', 20);
    await t.key('ENTER');
    await t.waitFor(/1 match\b/);
    await s.still('find');
    await s.tabTo('Clear the filter', true);
    await t.enter();
    await t.waitFor(/Every entry newest first/);

    await s.clip('entry', 'pane', async () => {
      await s.tabTo('agent-tasks 2.0');
      await t.enter();
      await t.waitFor(/Links 3/);
      await sleep(1_500);
      await s.tabTo('depends on');
      await t.enter();
      await t.waitFor(/decisions\/rest-only\.md/);
      await sleep(1_200);
      await t.enter(); // ‹ agent-tasks 2.0
      await t.waitFor(/projects\/agent-tasks\.md/);
      await sleep(800);
    });
    await s.still('entry');
    await t.press('‹ Browse'); // back lands on the link followed
    await t.waitFor(/Every entry newest first/);

    await s.clip('fold', 'pane', async () => {
      await s.tabTo('agent-knowledge 2.0', true);
      await t.enter();
      await t.waitFor(/projects\/agent-knowledge\.md/);
      await sleep(800);
      await s.tabTo(/Show all \d+ lines/);
      await t.enter();
      await t.waitFor(/▾ Show less/);
      await sleep(1_200);
    });
    await s.tabTo('‹ Browse', true, 40);
    await t.enter();
    await t.waitFor(/Every entry newest first/);

    await s.clip('search', 'pane', async () => {
      await t.key('2');
      await t.waitFor(/Finds words/);
      await sleep(500);
      await s.typeSlowly('zebrafish');
      await t.key('ENTER');
      await t.waitFor(/Entries 1/);
      await sleep(1_200);
      await t.enter();
      await t.waitFor(/notes\/zebrafish\.md/);
      await sleep(1_000);
    });
    await s.command('pane');
    await t.waitFor(/Sessions 1/);
    await s.still('search');

    await s.clip('sessions', 'pane', async () => {
      await t.key('TAB');
      await t.key('3');
      await t.waitFor(/Recent sessions newest first/);
      await sleep(1_000);
      // The session whose tool calls left files, a commit and an error to summarise.
      await s.tabTo('agent-knowledge');
      await t.enter();
      await t.waitFor(/Tools used/);
      await sleep(1_500);
    });
    await s.still('session');

    await s.clip('health', 'pane', async () => {
      await t.key('4');
      await t.waitFor(/Server\s+2\./);
      await sleep(1_000);
      await s.tabTo('Analyze links');
      await t.enter();
      await t.waitFor(/One link or none/);
      await sleep(1_500);
    });
    await s.still('health');

    await s.clip('delete', 'pane', async () => {
      await t.key('1');
      await t.waitFor(/Every entry newest first/);
      await s.tabTo('About this folder');
      await t.enter();
      await t.waitFor(/README\.md/);
      await sleep(600);
      await s.tabTo('Delete');
      await t.enter();
      await t.waitFor(/Delete README\.md\?/);
      await sleep(1_400);
      await t.enter(); // Never mind
      await sleep(800);
      await t.enter(); // Delete again
      await t.waitFor(/Delete README\.md\?/);
      await sleep(600);
      await s.tabTo(/^\[ Delete \]$/, true);
      await sleep(500);
      await s.still('confirm-delete');
      await t.enter();
      await t.waitFor(/✓ deleted README\.md/);
      await sleep(1_200);
    });

    await w.event('session-end', 'sess-pane-1 distilled into 2 entries');
    await t.waitFor(/session-end: sess-pane-1 distilled/, 15_000);
    await s.still('toast', 'full');
    return s.shots;
  } finally {
    await t.kill();
  }
}

/** The narrow dock and the inline layout. */
async function layouts(w: World): Promise<Shot[]> {
  const narrow = new Session(w, 110, 40);
  await narrow.t.start();
  try {
    await narrow.command();
    await narrow.t.waitFor(/Every entry newest first/);
    await narrow.still('narrow', 'full');
  } finally {
    await narrow.t.kill();
  }
  const inline = new Session(w, 110, 44, {});
  await inline.t.start();
  try {
    await inline.command();
    await inline.t.waitFor(/Every entry newest first/);
    await inline.still('inline', 'full');
  } finally {
    await inline.t.kill();
  }
  return [...narrow.shots, ...inline.shots];
}

/** The REST server goes away and comes back. */
async function down(w: World): Promise<Shot[]> {
  const s = new Session(w, 120, 36);
  const { t } = s;
  await t.start();
  try {
    await s.command();
    await t.waitFor(/Every entry newest first/);
    await s.clip('server-down', 'pane', async () => {
      await w.stopServer();
      await sleep(400);
      await t.key('r');
      await t.waitFor(/not reachable/);
      await sleep(1_500);
      await t.enter();
      await t.waitFor(/still nothing at the port/);
      await sleep(1_200);
      await w.startServer();
      await t.enter();
      await t.waitFor(/Every entry newest first/);
    });
    await w.stopServer();
    await t.key('r');
    await t.waitFor(/not reachable/);
    await s.still('server-down');
    await w.startServer();
    return s.shots;
  } finally {
    await t.kill();
  }
}

const shots: Shot[] = [];
for (const scene of [hero, docked, layouts, down]) {
  // Each scene on a fresh world: the docked one deletes an entry.
  const world = await startWorld(undefined, PORT);
  try {
    shots.push(...(await scene(world)));
  } finally {
    await world.stop();
  }
}

if (!only.length) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const film = await Film.open();
try {
  for (const { name, kind, take } of shots) {
    if (only.length && !only.some((o) => name.includes(o))) continue;
    const file = join(OUT, `${name}.${kind}`);
    const bytes = kind === 'png' ? await film.still(file, take) : await film.gif(file, take);
    const size = `${(bytes / 1024).toFixed(0)} KB`;
    const over = bytes > 1_500_000 ? '  ! over 1.5 MB' : '';
    process.stdout.write(`${name}.${kind}  ${size}${over}\n`);
  }
} finally {
  await film.close();
}
process.exit(0); // a pty or browser handle can outlive the run

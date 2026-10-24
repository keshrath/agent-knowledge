// =============================================================================
// The /knowledge pane in the real Claude Code CLI (AGENT_KNOWLEDGE_E2E_CLAUDE=1,
// `npm run e2e:claude`): every command form, every tab, an entry's page with its
// links and fold, search across entries and sessions, session summaries, Health
// with its analysis and git sync, delete, the keyboard and the mouse, where the
// focus ring lands after each step, toasts and changes from other sessions, wide
// characters, an empty and a large knowledge base, the narrow and inline layouts,
// and the server going away, being taken over and being an older version. One test
// asks the model to quote its context block: the only model call of the suite.
// Each world is a scratch HOME, knowledge folder, data dir and port (harness.ts).
// Shots land in ~/.claude/tmp/pane-shots-knowledge/e2e/*.png.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, unlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ClaudeTerm,
  SEED,
  SHOTS_DIR,
  killTree,
  landsOn,
  sleep,
  startWorld,
  statusEntry,
  type World,
} from './harness.js';
import { renderShots } from './render.js';

const E2E = process.env.AGENT_KNOWLEDGE_E2E_CLAUDE === '1';
const MIN = 60_000;
vi.setConfig({ testTimeout: 3 * MIN });

const FULLSCREEN = { CLAUDE_CODE_NO_FLICKER: '1', CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: '1' };
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'e2e',
  GIT_AUTHOR_EMAIL: 'e2e@example.invalid',
  GIT_COMMITTER_NAME: 'e2e',
  GIT_COMMITTER_EMAIL: 'e2e@example.invalid',
};

const shots: string[] = [];
function shot(t: ClaudeTerm, label: string) {
  shots.push(`pane-${label}`);
  return t.shot(`pane-${label}`);
}

/** The column the docked pane starts at: right of the border most lines have a `│` in. */
function paneColumn(t: ClaudeTerm): number {
  const at = new Map<number, number>();
  for (const line of t.text().split('\n')) {
    const x = line.indexOf('│');
    if (x > 0) at.set(x, (at.get(x) ?? 0) + 1);
  }
  const [border] = [...at.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (border === undefined) throw new Error(`no docked pane on the screen:\n${t.screen()}`);
  return border + 1;
}

/** The pane's lines, as drawn right of its border. */
function paneLines(t: ClaudeTerm): string[] {
  const from = paneColumn(t);
  return t
    .text()
    .split('\n')
    .map((l) => l.slice(from).trimEnd());
}

/** The line under the one showing `label` in the pane: a row's facts. */
function under(t: ClaudeTerm, label: string): string {
  const lines = paneLines(t);
  const i = lines.findIndex((l) => l.includes(label));
  if (i < 0) throw new Error(`the pane shows no ${label}:\n${t.screen()}`);
  return lines[i + 1] ?? '';
}

/** Waits until the screen stops matching `re`. */
async function gone(t: ClaudeTerm, re: RegExp, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && re.test(t.text())) await sleep(200);
  if (re.test(t.text())) throw new Error(`still on the screen: ${re}\n${t.screen()}`);
}

describe.skipIf(!E2E)('/knowledge pane in Claude Code', () => {
  afterAll(async () => {
    if (shots.length) await renderShots(SHOTS_DIR, shots);
  }, 2 * MIN);

  // ---------------------------------------------------------------------------
  // The seeded knowledge base, docked beside the conversation
  // ---------------------------------------------------------------------------

  describe('docked beside the conversation (fullscreen, 160 columns)', () => {
    let w: World;
    let t: ClaudeTerm;
    beforeAll(async () => {
      w = await startWorld();
      t = new ClaudeTerm(w, 160, 50, FULLSCREEN);
      await t.start();
    }, 2 * MIN);
    afterAll(async () => {
      await t?.kill();
      await w?.stop();
    }, 2 * MIN);

    it('the model is given what the knowledge base holds and how to reach it', async () => {
      await t.type(
        'Quote, verbatim and complete, the one context block of yours that starts with "agent-knowledge holds". Reply with that text only, no tools.',
      );
      await sleep(300);
      await t.key('ENTER');
      const s = await t.waitFor(/agent-knowledge holds 8 entries/, 3 * MIN);
      const quoted = s.slice(s.lastIndexOf('agent-knowledge holds')).replace(/\s+/g, ' ');
      expect(quoted).toContain(
        '8 entries · 2 sessions (projects 2, people 1, decisions 1, workflows 1, notes 2, other 1)',
      );
      expect(quoted).toMatch(/knowledge_search/);
      expect(quoted).toMatch(/\/knowledge/);
      await t.waitFor(/❯\s*$/m, MIN);
    });

    it('the status entry counts entries and sessions before the pane opens', async () => {
      expect(statusEntry(t)).toBe('8 entries · 2 sessions');
    });

    it('/knowledge answers with the counts and opens Browse, newest first, the ring on the first row', async () => {
      await t.knowledge();
      const s = await t.waitFor(/Every entry newest first/);
      expect(s).toMatch(/⎿\s+(agent-knowledge: )?8 entries · 2 sessions/);
      expect(s).toMatch(
        /all 8\s+projects 2\s+people 1\s+decisions 1\s+workflows 1\s+notes 2\s+other 1/,
      );
      const order = [
        'agent-knowledge 2.0',
        'agent-tasks 2.0',
        'REST only, no WebSocket',
        'Release ritual',
        'Zebrafish deploy recipe',
        'The maintainer',
        'About this folder',
      ].map((title) => paneLines(t).findIndex((l) => l.startsWith(title)));
      expect(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1]!))).toBe(true);
      await landsOn(t, 'agent-knowledge 2.0');
      // A row's facts: category, maturity, tags, how long ago; evergreen in its own colour.
      expect(under(t, 'agent-tasks 2.0')).toMatch(/projects · established · #release · #pane/);
      expect(under(t, 'Release ritual')).toMatch(/workflows · evergreen · #release/);
      expect(t.style('evergreen', paneColumn(t)).fg).not.toBe(-1);
      expect(under(t, 'About this folder')).toMatch(/^\s*other/);
      shot(t, 'browse');
    });

    it('a title in wide characters keeps its row to two lines', async () => {
      const lines = paneLines(t);
      const i = lines.findIndex((l) => l.startsWith('設計レビュー'));
      expect(i).toBeGreaterThan(0);
      expect(lines[i + 1]).toMatch(/^\s+notes · \d+d$/);
    });

    it('Tab and shift+Tab walk the rows; above the first is Find, where keys type', async () => {
      await landsOn(t, 'agent-knowledge 2.0');
      await t.key('TAB');
      await landsOn(t, 'agent-tasks 2.0');
      await t.key('SHIFTTAB', 2);
      await landsOn(t, 'Find');
      await t.waitFor(/Tab leaves the field · Esc to the prompt/);
      expect(t.text()).not.toMatch(/1: Browse/); // the digits type here: the tab bar drops them
      await t.key('TAB');
      await landsOn(t, 'agent-knowledge 2.0');
      await t.waitFor(/Tab moves · Enter presses/);
    });

    it('Esc gives the keyboard to the prompt; ctrl+x tab takes it back where it was', async () => {
      await t.key('TAB');
      await landsOn(t, 'agent-tasks 2.0');
      await t.key('ESC');
      await t.waitFor(/ctrl\+x tab to work this pane from the keyboard/);
      await t.type('2');
      try {
        await t.waitFor(/^❯\s2\s*$/m, 3_000);
        expect(t.text()).not.toMatch(/Search: /); // the digit went to the prompt
      } finally {
        await t.key('BS');
      }
      await t.key('FOCUS');
      await t.waitFor(/Tab moves · Enter presses/);
      await landsOn(t, 'agent-tasks 2.0');
    });

    it('a category narrows the list and lands on its first row; all brings everything back', async () => {
      await t.press('workflows 1');
      await t.waitFor(/Workflows newest first/);
      expect(paneLines(t).join('\n')).not.toMatch(/agent-tasks 2\.0/);
      await landsOn(t, 'Release ritual');
      await t.press('all 8');
      await t.waitFor(/Every entry newest first/);
      await landsOn(t, 'agent-knowledge 2.0');
    });

    it('Find narrows by tag (and says so), by path; nothing found offers Clear the filter', async () => {
      await t.focus('Find');
      await t.type('deploy');
      await t.enter();
      await t.waitFor(/1 match\b/);
      await t.waitFor(/Matches newest first/);
      expect(under(t, 'Zebrafish deploy recipe')).toMatch(/tag deploy/);
      await landsOn(t, 'Zebrafish deploy recipe');
      await t.focus('Find');
      await t.key('BS', 8);
      await t.type('people/');
      await t.enter();
      await t.waitFor(/1 match\b/);
      await landsOn(t, 'The maintainer');
      await t.focus('Find');
      await t.key('BS', 8);
      await t.type('nothing like this');
      await t.enter();
      await t.waitFor(/No entry matches\./);
      await landsOn(t, 'Clear the filter');
      shot(t, 'browse-no-match');
      await t.enter();
      await t.waitFor(/Every entry newest first/);
      await gone(t, /Clear the filter/);
      await landsOn(t, 'agent-knowledge 2.0');
    });

    it('an entry: path, reads, tags, author, links both ways and the body without its frontmatter', async () => {
      await t.press('agent-tasks 2.0');
      const s = await t.waitFor(/projects\/agent-tasks\.md/);
      await landsOn(t, '‹ Browse');
      expect(s).toMatch(/projects · established · 6 reads · updated (today|\d+[hd] ago)/);
      expect(s).toMatch(/Tags\s+release, pane/);
      expect(s).toMatch(/Author\s+claude-code/);
      expect(s).toMatch(/Links 3/);
      expect(s).toMatch(/→ depends on REST only, no WebSocket/);
      expect(s).toMatch(/← related to agent-knowledge 2\.0/);
      expect(s).toMatch(/← related to Release ritual · auto-link/);
      expect(s).toMatch(/The board moved into the \/pipeline pane\./);
      expect(paneLines(t).join('\n')).not.toMatch(/^---$|title: agent-tasks/m);
      // The heading that only repeats the title is drawn once.
      expect(paneLines(t).filter((l) => l.trim() === 'agent-tasks 2.0')).toHaveLength(1);
      shot(t, 'entry');
    });

    it('a link opens its entry; back walks the way it came, to the row it started from', async () => {
      await t.press('depends on REST only');
      await t.waitFor(/decisions\/rest-only\.md/);
      await landsOn(t, '‹ agent-tasks 2.0');
      expect(t.text()).toMatch(/← depends on agent-tasks 2\.0/);
      expect(t.text()).toMatch(/decisions · 2 reads · updated/);
      await t.enter();
      await t.waitFor(/projects\/agent-tasks\.md/);
      // Back on the page it came from: the ring is on the link it followed.
      await landsOn(t, 'depends on REST only');
      await t.press('‹ Browse');
      await t.waitFor(/Every entry newest first/);
      await landsOn(t, 'agent-tasks 2.0');
    });

    it('a long body folds; its toggle keeps the ring and names what it does', async () => {
      await t.press('agent-knowledge 2.0');
      await t.waitFor(/projects\/agent-knowledge\.md/);
      // The toggle is below the window: Tab takes the ring, and the pane's scroll, to it.
      await t.press(/▸ Show all \d+ lines/);
      await landsOn(t, '▾ Show less');
      expect(t.text()).toMatch(/point 4\d: something worth keeping|const pane/);
      await t.enter();
      await landsOn(t, /▸ Show all \d+ lines/);
      expect(t.text()).not.toMatch(/point 4\d:/);
      await t.press('‹ Browse');
      await t.waitFor(/Every entry newest first/);
    });

    it('2 opens Search with the ring in its field; a search lands on the best hit', async () => {
      await t.key('2');
      await t.waitFor(/Finds words, and close spellings/);
      await t.waitFor(/Tab leaves the field/);
      await t.type('zebrafish');
      await t.enter();
      const s = await t.waitFor(/Entries 1/);
      expect(s).toMatch(/✓ 1 hit for "zebrafish"/);
      await landsOn(t, 'Zebrafish deploy recipe');
      // The excerpt is plain prose: no frontmatter, no Markdown marks.
      const excerpt = paneLines(t)[paneLines(t).findIndex((l) => l.startsWith('Zebrafish')) + 2]!;
      expect(excerpt).toMatch(/zebrafish service deploys with make ship/i);
      expect(excerpt).not.toMatch(/---|title:|#|`/);
      // No heading glued onto the text: the entry's heading does not lead it.
      expect(excerpt.trim()).not.toMatch(/^Zebrafish The/);
      shot(t, 'search');
      await t.enter();
      await t.waitFor(/notes\/zebrafish\.md/);
      await landsOn(t, '‹ Search');
      await t.enter();
      await t.waitFor(/Entries 1/);
    });

    it('/knowledge <words> searches; a session hit opens its summary', async () => {
      await t.knowledge('quokka');
      const s = await t.waitFor(/Sessions 1/);
      expect(s).toMatch(/0 entries and 1 session moment match "quokka"/);
      expect(under(t, 'agent-tasks')).toMatch(/\d\d-\d\d \d\d:\d\d · asked/);
      await landsOn(t, 'agent-tasks');
      await t.enter();
      const p = await t.waitFor(/What was asked 2/);
      expect(p).toMatch(/· move the board into a Claude Code pane/);
      expect(p).toMatch(/1h 30m · 4 messages · main/);
      expect(p).toMatch(/C:\/work\/agent-tasks/);
      await landsOn(t, '‹ Search');
      shot(t, 'session-from-search');
      await t.enter();
      await t.waitFor(/Sessions 1/);
    });

    it('a search with no hit says so and keeps the words', async () => {
      await t.focus(/Search: quokka/);
      await t.key('BS', 6);
      await t.type('xylophonic');
      await t.enter();
      await t.waitFor(/Nothing found for "xylophonic"\./);
      expect(t.text()).toMatch(/– no hits for "xylophonic"/);
      // Typed in the field: the ring stays there to try again.
      await landsOn(t, /Search: xylophonic/);
    });

    it('/knowledge <words> with no hit lands on a button: the next command is a command', async () => {
      await t.key('ESC'); // the keyboard back to the prompt
      await t.knowledge('zzqqxxyy');
      await t.waitFor(/0 entries and 0 session moments match "zzqqxxyy"/);
      await landsOn(t, /^(2: )?Search$/);
      // Not in a text field: the tab bar keeps its digits (a field drops them).
      expect(paneLines(t).join('\n')).toMatch(/1: Browse\s+2: Search/);
      // Typed now, a command goes to the prompt and runs; in a field it would be searched.
      await t.knowledge();
      expect(t.text()).not.toMatch(/Search: \/knowledge/);
    });

    it('3 lists sessions newest first with how long they ran; one opens', async () => {
      await t.key('TAB'); // out of the field: the digits switch tabs again
      await t.waitFor(/Tab moves · Enter presses/);
      await t.key('3');
      const s = await t.waitFor(/Recent sessions newest first/);
      expect(under(t, 'agent-tasks')).toMatch(/\d\d-\d\d \d\d:\d\d · 1h 30m · main/);
      expect(under(t, 'agent-knowledge')).toMatch(/· 20m$/);
      expect(s.indexOf('agent-tasks')).toBeLessThan(s.indexOf('why did the git sync break'));
      await landsOn(t, 'agent-tasks');
      await t.press('agent-knowledge');
      await t.waitFor(/What was asked 1/);
      await landsOn(t, '‹ Sessions');
      // What its tool calls left: the file, the commit, the error (in red), the tools.
      const p = await t.waitFor(/Tools used/);
      expect(p).toMatch(/Files changed 1[\s\S]*src\/knowledge\/git\.ts/);
      expect(p).toMatch(/Commits 1[\s\S]*4e5f6a7/);
      expect(p).toMatch(/Errors 1[\s\S]*failed to push some refs/);
      expect(p).toMatch(/Tools used[\s\S]*Bash/);
      const from = paneColumn(t);
      const err = t.style('Error: failed to push', from);
      expect(err.fg).not.toBe(-1);
      expect(err.fg).not.toBe(t.style('src/knowledge/git.ts', from).fg);
      shot(t, 'session');
      await t.enter();
      await t.waitFor(/Recent sessions/);
    });

    it('4 shows Health: counts, search mode, folder, no git; Analyze lists the most and least linked', async () => {
      await t.key('4');
      const s = await t.waitFor(/Server\s+2\.\d+\.\d+/);
      expect(s).toMatch(/Entries\s+8 · projects 2 · people 1 · decisions 1 · workflows 1/);
      expect(s).toMatch(/Search\s+words only: no embeddings yet/);
      expect(s).toMatch(/no remote: entries stay on this machine/);
      expect(s).not.toMatch(/Sync now/);
      await landsOn(t, 'Analyze links');
      await t.enter();
      const a = await t.waitFor(/One link or none/);
      expect(a).toMatch(/✓ \d+ most linked, \d+ with one link or none/);
      expect(under(t, 'agent-tasks 2.0')).toMatch(/3 links/);
      expect(under(t, 'The maintainer')).toMatch(/no links/);
      // Each entry in one list only: most linked is two links or more.
      const lines = paneLines(t);
      const most = lines.slice(
        lines.findIndex((l) => l.startsWith('Most linked')),
        lines.findIndex((l) => l.startsWith('One link or none')),
      );
      expect(most.join('\n')).not.toMatch(/\b1 link\b/);
      const folder = lines.findIndex((l) => l.startsWith('Folder'));
      expect(lines[folder + 1]).toMatch(/^Git/); // the folder is one line, cut from the left
      await landsOn(t, 'Analyze again');
      shot(t, 'health');
      await t.press('agent-tasks 2.0');
      await t.waitFor(/projects\/agent-tasks\.md/);
      await landsOn(t, '‹ Health');
      await t.enter();
      await t.waitFor(/One link or none/);
    });

    it('a live event toasts once and shows under Recent activity', async () => {
      await w.event('session-end', 'sess-pane-1 distilled into 2 entries');
      await t.waitFor(/session-end: sess-pane-1 distilled into 2 entries/, 15_000);
      await t.waitFor(/Recent activity newest first/, 15_000);
      expect(paneLines(t).join('\n')).toMatch(/\d\d:\d\d session-end: sess-pane-1 distilled/);
    });

    it('an entry another session writes shows without a key, and in the status entry', async () => {
      await t.key('1');
      await t.waitFor(/Every entry newest first/);
      await landsOn(t, 'agent-knowledge 2.0');
      // Newest first: it lands above the row the ring is on.
      w.write({
        path: 'notes/from-elsewhere.md',
        title: 'Written in another session',
        updated: '2099-01-01',
        body: 'Hello from elsewhere.',
      });
      await t.waitFor(/Written in another session/, 15_000); // the next poll, no key
      await t.waitFor(/all 9/, 15_000);
      await landsOn(t, 'agent-knowledge 2.0'); // the ring stayed on its row
      await t.key('r');
      await t.waitFor(/agent-knowledge: 9 entries/, 15_000);
      expect(t.text()).toMatch(/^❯\s*$/m); // r went to the pane, not the prompt
      await t.waitFor(/agent-knowledge: 9 entries · 2 sessions/, 15_000);
    });

    it('the mouse: a tab, a row, the way back', async () => {
      const from = paneColumn(t);
      await t.click('Sessions', from);
      await t.waitFor(/Recent sessions newest first/);
      await t.click('Browse', from);
      await t.waitFor(/Every entry newest first/);
      await t.click('Release ritual', from);
      await t.waitFor(/workflows\/release\.md/);
      // Never read by an agent: no read count, no last-read row.
      expect(paneLines(t).join('\n')).not.toMatch(/\d+ reads?|Last read/);
      await t.click('‹ Browse', from);
      await t.waitFor(/Every entry newest first/);
    });

    it('delete asks first: Never mind keeps it; Delete removes the file and says so', async () => {
      await t.press('Zebrafish deploy recipe');
      await t.waitFor(/notes\/zebrafish\.md/);
      await t.press(/^\[ Delete \]$/);
      await t.waitFor(/Delete notes\/zebrafish\.md\?/);
      // The warning wraps in its box: read it as one line.
      expect(
        paneLines(t)
          .join(' ')
          .replace(/[│╭╮╰╯─]/g, ' ')
          .replace(/\s+/g, ' '),
      ).toMatch(/The file goes from this machine\./);
      expect(paneLines(t).join('\n')).not.toMatch(/pushed/);
      await landsOn(t, 'Never mind');
      expect(paneLines(t).some((l) => l.trimStart().startsWith('╰'))).toBe(true); // box whole
      shot(t, 'confirm-delete');
      await t.enter();
      await gone(t, /Delete notes\/zebrafish\.md\?/);
      await landsOn(t, 'Delete');
      expect(existsSync(join(w.memoryDir, 'notes', 'zebrafish.md'))).toBe(true);
      await t.enter();
      await t.waitFor(/Delete notes\/zebrafish\.md\?/);
      await t.press(/^\[ Delete \]$/);
      await t.waitFor(/✓ deleted notes\/zebrafish\.md$/m);
      expect(t.text()).not.toMatch(/not pushed/); // no git here: nothing to say about pushing
      await t.waitFor(/Every entry newest first/);
      expect(paneLines(t).join('\n')).not.toMatch(/Zebrafish deploy recipe/);
      expect(existsSync(join(w.memoryDir, 'notes', 'zebrafish.md'))).toBe(false);
    });

    it('/knowledge <path> opens that entry; one not there is said and Browse shows', async () => {
      await t.knowledge('workflows/release');
      await t.waitFor(/workflows\/release\.md/);
      await t.waitFor(/opened Release ritual/);
      await landsOn(t, '‹ Browse');
      await t.knowledge('notes/never-written.md');
      await t.waitFor(/there is no entry notes\/never-written\.md/);
      await t.waitFor(/Every entry newest first/);
    });
  });

  // ---------------------------------------------------------------------------
  // A knowledge folder synced with a git remote
  // ---------------------------------------------------------------------------

  describe('with a git remote (fullscreen, 160 columns)', () => {
    let w: World;
    let t: ClaudeTerm;
    let remote: string;
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, env: { ...process.env, ...GIT_ENV }, stdio: 'pipe' })
        .toString()
        .trim();
    beforeAll(async () => {
      // The REST server commits and pushes: it takes its identity from the environment.
      Object.assign(process.env, GIT_ENV);
      w = await startWorld();
      remote = mkdtempSync(join(tmpdir(), 'ak-e2e-remote-'));
      git(remote, 'init', '-q', '--bare', '-b', 'main');
      git(w.memoryDir, 'init', '-q', '-b', 'main');
      git(w.memoryDir, 'add', '-A');
      git(w.memoryDir, 'commit', '-q', '-m', 'seed');
      git(w.memoryDir, 'remote', 'add', 'origin', remote);
      git(w.memoryDir, 'push', '-q', '-u', 'origin', 'main');
      t = new ClaudeTerm(w, 160, 50, { ...FULLSCREEN, ...GIT_ENV });
      await t.start();
    }, 2 * MIN);
    afterAll(async () => {
      await t?.kill();
      await w?.stop();
    }, 2 * MIN);

    it('Health offers Sync now, which pulls and pushes', async () => {
      await t.knowledge();
      await t.key('4');
      await t.waitFor(/synced with a remote on every write/, 15_000);
      await landsOn(t, 'Sync now');
      w.write({ path: 'notes/unsynced.md', title: 'Not pushed yet', body: 'x' });
      await t.enter();
      await t.waitFor(/✓ synced with the remote/, 30_000);
      expect(git(remote, 'log', '--oneline', '-1', '--', 'notes/unsynced.md')).not.toBe('');
      shot(t, 'health-git');
    });

    it('a delete is pushed to the remote', async () => {
      await t.knowledge('people/maintainer');
      await t.waitFor(/people\/maintainer\.md/);
      await t.press(/^\[ Delete \]$/);
      await t.waitFor(/Delete people\/maintainer\.md\?/);
      expect(
        paneLines(t)
          .join(' ')
          .replace(/[│╭╮╰╯─]/g, ' ')
          .replace(/\s+/g, ' '),
      ).toMatch(/the deletion is pushed to the remote\./);
      await t.press(/^\[ Delete \]$/);
      await t.waitFor(/✓ deleted people\/maintainer\.md$/m, 30_000);
      expect(git(remote, 'ls-tree', '-r', '--name-only', 'main')).not.toMatch(/maintainer/);
    });

    it('a remote that refuses the push is said with the deletion', async () => {
      git(w.memoryDir, 'remote', 'set-url', 'origin', join(w.dir, 'no-such-remote.git'));
      await t.knowledge('notes/zebrafish');
      await t.waitFor(/notes\/zebrafish\.md/);
      await t.press(/^\[ Delete \]$/);
      await t.waitFor(/Delete notes\/zebrafish\.md\?/);
      await t.press(/^\[ Delete \]$/);
      await t.waitFor(/✓ deleted notes\/zebrafish\.md \(not pushed: /, 30_000);
      expect(existsSync(join(w.memoryDir, 'notes', 'zebrafish.md'))).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // The narrow dock and the inline layout
  // ---------------------------------------------------------------------------

  describe('docked narrow (fullscreen, 110 columns)', () => {
    let w: World;
    let t: ClaudeTerm;
    beforeAll(async () => {
      w = await startWorld();
      t = new ClaudeTerm(w, 110, 45, FULLSCREEN);
      await t.start();
    }, 2 * MIN);
    afterAll(async () => {
      await t?.kill();
      await w?.stop();
    }, 2 * MIN);

    it('the tab bar wraps between controls, never inside one; rows, wide titles included, keep to two', async () => {
      await t.knowledge();
      await t.waitFor(/Every entry newest first/);
      const lines = paneLines(t);
      for (const control of ['1: Browse', '2: Search', '3: Sessions', '4: Health', 'r: Refresh'])
        expect(lines.slice(0, 4).some((l) => l.includes(control))).toBe(true);
      const i = lines.findIndex((l) => l.startsWith('設計レビュー'));
      expect(lines[i + 1]).toMatch(/^\s+notes · \d+d$/);
      // Every row's facts fit their line: none wraps onto a third.
      expect(lines.filter((l) => /^\s{2}\S/.test(l)).every((l) => !l.endsWith('·'))).toBe(true);
      shot(t, 'narrow-browse');
    });

    it('an entry, a search and Health fit the sidebar', async () => {
      await t.press('agent-tasks 2.0');
      await t.waitFor(/projects\/agent-tasks\.md/);
      shot(t, 'narrow-entry');
      await t.knowledge('pane');
      await t.waitFor(/Sessions 1/);
      // Excerpts are cut to the pane, not wrapped.
      for (const l of paneLines(t).filter((x) => x.startsWith('  ')))
        expect(l.length).toBeLessThan(60);
      shot(t, 'narrow-search');
      await t.key('TAB');
      await t.key('4');
      await t.waitFor(/Server\s+2\./);
      await t.press('Analyze links');
      await t.waitFor(/One link or none/);
      shot(t, 'narrow-health');
    });
  });

  describe('inline above the prompt (120 columns)', () => {
    let w: World;
    let t: ClaudeTerm;
    beforeAll(async () => {
      w = await startWorld();
      t = new ClaudeTerm(w, 120, 50);
      await t.start();
    }, 2 * MIN);
    afterAll(async () => {
      await t?.kill();
      await w?.stop();
    }, 2 * MIN);

    it('opens Browse above the prompt; Enter opens a row and back returns', async () => {
      await t.knowledge();
      await t.waitFor(/Every entry newest first/);
      await landsOn(t, 'agent-knowledge 2.0');
      shot(t, 'inline');
      await t.key('TAB');
      await landsOn(t, 'agent-tasks 2.0');
      await t.enter();
      await t.waitFor(/projects\/agent-tasks\.md/);
      await landsOn(t, '‹ Browse');
      await t.enter();
      await t.waitFor(/Every entry newest first/);
    });
  });

  // ---------------------------------------------------------------------------
  // An empty knowledge base, and a large one
  // ---------------------------------------------------------------------------

  describe('an empty knowledge base', () => {
    let w: World;
    let t: ClaudeTerm;
    beforeAll(async () => {
      w = await startWorld({ entries: [], sessions: [], edges: [], reads: {} });
      t = new ClaudeTerm(w, 160, 50, FULLSCREEN);
      await t.start(/agent-knowledge: 0 entries/);
    }, 2 * MIN);
    afterAll(async () => {
      await t?.kill();
      await w?.stop();
    }, 2 * MIN);

    it('says what lands here; Sessions and Search say they have nothing', async () => {
      await t.knowledge();
      const s = await t.waitFor(/The knowledge base is empty\./);
      expect(s).toMatch(/Agents save what they learn here, by category/);
      shot(t, 'empty');
      await t.key('3');
      await t.waitFor(/No sessions found\./);
      await t.key('2');
      await t.type('anything');
      await t.enter();
      await t.waitFor(/Nothing found for "anything"\./);
    });
  });

  describe('a large knowledge base (300 entries)', () => {
    let w: World;
    let t: ClaudeTerm;
    beforeAll(async () => {
      const many = Array.from({ length: 300 }, (_, i) => ({
        path: `notes/bulk-${String(i).padStart(3, '0')}.md`,
        title: `Bulk note ${String(i).padStart(3, '0')}`,
        updated: `2026-${String(1 + (i % 9)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
        body: `Bulk note number ${i}.`,
      }));
      const sessions = Array.from({ length: 30 }, (_, i) => ({
        project: `bulk-project-${String(i).padStart(2, '0')}`,
        id: `bulk-sess-${i}`,
        cwd: `C:/work/bulk-${i}`,
        lines: [
          ['user', `bulk question ${i}`, `2026-09-${String(1 + i).padStart(2, '0')}T08:00:00.000Z`],
          ['assistant', 'an answer', `2026-09-${String(1 + i).padStart(2, '0')}T08:10:00.000Z`],
        ] as ['user' | 'assistant', string, string][],
      }));
      w = await startWorld({
        ...SEED,
        entries: [...SEED.entries, ...many],
        sessions: [...SEED.sessions, ...sessions],
      });
      t = new ClaudeTerm(w, 160, 50, FULLSCREEN);
      await t.start(/agent-knowledge: 308 entries/);
    }, 2 * MIN);
    afterAll(async () => {
      await t?.kill();
      await w?.stop();
    }, 2 * MIN);

    it('/knowledge <path> first: links and the way back carry titles, with no list loaded', async () => {
      await t.knowledge('projects/agent-tasks');
      await t.waitFor(/opened agent-tasks 2\.0/);
      const p = await t.waitFor(/Links 3/);
      expect(p).toMatch(/→ depends on REST only, no WebSocket/);
      expect(p).toMatch(/← related to agent-knowledge 2\.0/);
      await t.press('→ depends on REST only, no WebSocket');
      await t.waitFor(/decisions\/rest-only\.md/);
      expect(t.text()).toMatch(/‹ agent-tasks 2\.0/);
    });

    it('the row holding the ring pushed off the page, or deleted, lands the ring anew', async () => {
      await t.knowledge();
      await t.waitFor(/all 308/);
      // The last row of the page holds the ring.
      await t.focus(/25 more \(283 left\)/);
      await t.key('SHIFTTAB');
      await landsOn(t, /^Bulk note \d{3}$/);
      // A newer entry pushes it to row 26, off the page: the ring lands on the first row.
      w.write({
        path: 'notes/pushed-in.md',
        title: 'Pushed in from elsewhere',
        updated: '2099-01-01',
        body: 'x',
      });
      await t.waitFor(/all 309/, 20_000);
      await landsOn(t, 'Pushed in from elsewhere', 10_000);
      expect(paneLines(t).join('\n')).toMatch(/1: Browse\s+2: Search/); // a button, never Find
      // The row holding the ring is deleted elsewhere: the ring lands on the new first row.
      unlinkSync(join(w.memoryDir, 'notes', 'pushed-in.md'));
      await t.waitFor(/all 308/, 20_000);
      await landsOn(t, /^(?!Pushed in).+$/, 10_000);
      expect(paneLines(t).join('\n')).not.toMatch(/Pushed in from elsewhere/);
      expect(paneLines(t).join('\n')).toMatch(/1: Browse\s+2: Search/);
    });

    it('back to Browse from an entry beyond the shown page lands on its first row', async () => {
      await t.knowledge('notes/bulk-000');
      await t.waitFor(/notes\/bulk-000\.md/);
      await t.press('‹ Browse');
      await t.waitFor(/Every entry newest first/);
      // bulk-000 is far past row 25: the ring takes the first row, not nothing.
      await landsOn(t, /^\S.*$/);
      expect(t.focused()).not.toBe('Bulk note 000');
      expect(paneLines(t).join('\n')).not.toMatch(/Bulk note 000/); // the transcript says it opened
    });

    it('lists a page at a time; more lands on the first row it adds', async () => {
      await t.knowledge();
      await t.waitFor(/all 308/);
      // The button is below the window: Tab takes the ring, and the pane's scroll, to it.
      await t.press(/25 more \(283 left\)/);
      // The ring is on the first row the page added, not back at the top or on the button.
      await landsOn(t, /^Bulk note \d{3}$/);
      expect(t.text()).not.toMatch(/283 left/);
      await t.focus(/25 more \(258 left\)/);
      shot(t, 'large');
    });

    it('a category of hundreds narrows at once, keys and all', async () => {
      await t.press(/^notes 302$/);
      await t.waitFor(/Notes newest first/);
      await landsOn(t, 'Zebrafish deploy recipe');
      await t.focus(/25 more \(277 left\)/);
    });

    it('Sessions come a page at a time too', async () => {
      await t.key('3');
      await t.waitFor(/Recent sessions newest first/);
      await t.press(/^▸ 7 more$/);
      // The first session the page added holds the ring.
      await landsOn(t, /^bulk-project-\d\d$/);
      expect(t.text()).not.toMatch(/▸ 7 more/);
    });
  });

  // ---------------------------------------------------------------------------
  // The REST server: away, back, taken over, and an older version on the port
  // ---------------------------------------------------------------------------

  describe('when the REST server goes away', () => {
    let w: World;
    let t: ClaudeTerm;
    let old: Server | null = null;
    beforeAll(async () => {
      w = await startWorld();
      t = new ClaudeTerm(w, 160, 50, FULLSCREEN);
      await t.start();
    }, 2 * MIN);
    afterAll(async () => {
      old?.close();
      await t?.kill();
      await w?.stop();
    }, 2 * MIN);

    it('says so instead of showing stale entries; Refresh says it tried; back by itself', async () => {
      await t.knowledge();
      await t.waitFor(/Every entry newest first/);
      await w.stopServer();
      await t.waitFor(/The agent-knowledge server is not reachable/, 20_000);
      expect(statusEntry(t)).toBe('offline');
      expect(t.text()).not.toMatch(/1: Browse/); // only Refresh while down
      await landsOn(t, 'Refresh');
      shot(t, 'down');
      await t.enter();
      await t.waitFor(/✗ still nothing at the port \(\d\d:\d\d:\d\d\)/);
      await w.startServer();
      await t.waitFor(/Every entry newest first/, 20_000); // the next poll, no key pressed
      await t.waitFor(/agent-knowledge: 8 entries · 2 sessions/);
      await landsOn(t, 'agent-knowledge 2.0');
    });

    it('/knowledge while down says nothing answers at the port', async () => {
      await w.stopServer();
      await t.knowledge();
      await t.waitFor(new RegExp(`nothing answers at http://127\\.0\\.0\\.1:${w.port}`));
      await w.startServer();
      await t.waitFor(/Every entry newest first/, 20_000);
    });

    it('a second MCP process takes the port over when the serving one exits', async () => {
      await w.stopServer();
      const a = w.startMcp();
      await t.waitFor(/Every entry newest first/, 30_000); // a serves now
      const b = w.startMcp(); // waits for the port
      killTree(a.pid);
      await t.waitFor(/not reachable|Every entry newest first/, 10_000);
      await t.waitFor(/Every entry newest first/, 30_000); // b took over
      await t.key('r');
      await t.waitFor(/agent-knowledge: 8 entries · 2 sessions/, 15_000);
      killTree(b.pid);
      await t.waitFor(/not reachable/, 30_000);
      await w.startServer();
      await t.waitFor(/Every entry newest first/, 30_000);
    });

    it('an older agent-knowledge on the port is named, not taken for nothing', async () => {
      await w.stopServer();
      old = createServer((req, res) => {
        res.writeHead(req.url === '/health' ? 200 : 404, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(
            req.url === '/health' ? { status: 'ok', version: '1.9.8' } : { error: 'Not found' },
          ),
        );
      }).listen(w.port, '127.0.0.1');
      await t.waitFor(/An older agent-knowledge \(1\.9\.8\) holds the port/, 30_000);
      expect(statusEntry(t)).toBe('old server 1.9.8 on the port');
      await t.knowledge();
      await t.waitFor(/version 1\.9\.8 holds http:\/\/127\.0\.0\.1:\d+ and cannot serve the/);
      shot(t, 'old-server');
      old.close();
      old = null;
      await w.startServer();
      await t.press('Refresh');
      await t.waitFor(/Every entry newest first/, 20_000);
    });
  });
});

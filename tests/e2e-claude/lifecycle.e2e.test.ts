// =============================================================================
// The session lifecycle the plugin's mod gives, in the real Claude Code CLI
// (AGENT_KNOWLEDGE_E2E_CLAUDE=1, `npm run e2e:claude`), every part asserted in a
// real `claude` session:
//
//   - the first message's context block: what the knowledge base holds, who the
//     person is (identity.md) or the onboarding question, the project's ingest
//     (never ingested; changed since);
//   - the first real prompt: the matching entries beside it, the line naming
//     them, how long the person waited for it (2,000 entries), once per
//     conversation and again after /clear;
//   - /compact: the snapshot (file, contents, the line), the summary asked to
//     keep what is unsaved;
//   - the end: /clear and /exit each leave the conversation's last snapshot;
//   - a server that takes the connection and never answers: the session goes on;
//   - the pane while a slow server answers: the entry shown loading.
//
// Model calls: two prompts and a compaction in the first world, one prompt in
// the second, one in the stuck-server world.
//
// The worlds' servers read the live sessions from the real Claude Code session
// store (AGENT_KNOWLEDGE_EXTRA_SESSION_ROOTS), read only; they write to their
// scratch knowledge folders alone.
// =============================================================================

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ClaudeTerm, SHOTS_DIR, freePort, sleep, startWorld, type World } from './harness.js';
import { SEED, type Seed } from './seed.js';
import { renderShots } from './render.js';

const E2E = process.env.AGENT_KNOWLEDGE_E2E_CLAUDE === '1';
const MIN = 60_000;
vi.setConfig({ testTimeout: 4 * MIN });

const FULLSCREEN = { CLAUDE_CODE_NO_FLICKER: '1', CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: '1' };
const SESSION_ROOTS = {
  AGENT_KNOWLEDGE_EXTRA_SESSION_ROOTS: join(homedir(), '.claude', 'projects'),
};

/** A project folder of three source files. Stable paths, so folder trust is remembered. */
function project(name: string): { dir: string; slug: string } {
  const dir = join(tmpdir(), `agent-knowledge-e2e-${name}`);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `${name}-demo` }));
  for (const n of [1, 2, 3])
    writeFileSync(join(dir, 'src', `f${n}.ts`), `export const x${n} = ${n};\n`);
  return { dir, slug: `agent-knowledge-e2e-${name}` };
}

/** The seed and 2,000 more entries: a knowledge base the size of a real one. */
const LARGE: Seed = {
  ...SEED,
  entries: [
    ...SEED.entries,
    ...Array.from({ length: 2_000 }, (_, i) => ({
      path: `notes/filler-${i}.md`,
      title: `Filler ${i}`,
      body: `# Filler ${i}\n\n${'Notes on builds, branches, reviews and deploys. '.repeat(20)}`,
    })),
  ],
};

const shots: string[] = [];
function shot(t: ClaudeTerm, label: string) {
  shots.push(`lifecycle-${label}`);
  return t.shot(`lifecycle-${label}`);
}

/** Types a prompt; returns once the screen matches `done` and the prompt is back. */
async function ask(t: ClaudeTerm, text: string, done: RegExp) {
  await t.type(text);
  await sleep(300);
  await t.key('ENTER');
  await t.waitFor(done, 3 * MIN);
  await t.waitFor(/❯\s*$/m, MIN);
}

/** A slash command typed and entered. */
async function command(t: ClaudeTerm, text: string) {
  await t.type(text);
  await sleep(300);
  await t.key('ENTER');
}

/** The snapshot files of a project. */
function snapshots(w: World, slug: string): string[] {
  const dir = join(w.memoryDir, 'sessions', slug);
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => join(dir, f))
    : [];
}

/**
 * What the model was sent as our context block, read from the session's own transcript in the
 * real session store (the newest session of the project folder that carries it): the model's
 * quote of it may leave parts out.
 */
function sentContext(projectDir: string): string {
  const store = join(homedir(), '.claude', 'projects', projectDir.replace(/[^a-zA-Z0-9]/g, '-'));
  const files = readdirSync(store)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => join(store, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  /** The first string in a row (at any depth) that holds the block. */
  const find = (v: unknown): string | null => {
    if (typeof v === 'string') return /agent-knowledge holds \d/.test(v) ? v : null;
    if (v && typeof v === 'object') {
      for (const x of Object.values(v)) {
        const hit = find(x);
        if (hit) return hit;
      }
    }
    return null;
  };
  for (const f of files) {
    for (const row of readFileSync(f, 'utf-8').split('\n')) {
      if (!row.includes('agent-knowledge holds')) continue;
      const hit = find(JSON.parse(row));
      if (hit) return hit.slice(hit.search(/agent-knowledge holds \d/));
    }
  }
  throw new Error(`no session in ${store} carries the context block`);
}

async function until(check: () => boolean, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await sleep(250);
  return check();
}

describe.skipIf(!E2E)('the session lifecycle in Claude Code', () => {
  afterAll(async () => {
    if (shots.length) await renderShots(SHOTS_DIR, shots);
  }, 2 * MIN);

  describe('a known person, a project never ingested, 2,000 entries', () => {
    const p = project('lifecycle-ws');
    let w: World;
    let t: ClaudeTerm;
    beforeAll(async () => {
      w = await startWorld(LARGE, undefined, SESSION_ROOTS);
      writeFileSync(
        join(w.memoryDir, 'identity.md'),
        '## L0 — IDENTITY\nAlex Example, release engineer on the e2e team.\n',
      );
      t = new ClaudeTerm(w, 160, 50, FULLSCREEN, p.dir);
      await t.start();
    }, 3 * MIN);
    afterAll(async () => {
      await t?.kill();
      await w?.stop();
    }, 2 * MIN);

    it('the first real prompt carries the matching entries, named in one line well within 2 s', async () => {
      await t.type(
        'About our release ritual: quote, verbatim and complete, your context block that starts with "agent-knowledge holds", then the one that starts with "## Knowledge — top hits". Text only, no tools.',
      );
      await sleep(300);
      const t0 = Date.now();
      await t.key('ENTER');
      await t.waitFor(/agent-knowledge: \d+ (entry|entries) for this prompt/, 10_000);
      const waited = Date.now() - t0;
      process.stdout.write(`first-prompt hits drawn ${waited} ms after Enter (2,000 entries)
`);
      // The line is drawn after the hook's search answered: what the person waited, plus a frame.
      expect(waited).toBeLessThan(2_000);
      // The model is told not to narrate its context: the ingest never done reaches the person
      // as a toast.
      await t.waitFor(/Not ingested: lifecycle-ws-demo/, 10_000);
      await t.waitFor(
        /Knowledge — top hits for your first prompt[\s\S]*workflows\/release\.md/,
        3 * MIN,
      );
      await t.waitFor(/❯\s*$/m, MIN);
      const s = shot(t, 'first-prompt');
      // The line names the top two hits by their titles and counts the rest, under the prompt.
      expect(s).toMatch(/agent-knowledge: \d+ (entry|entries) for this prompt: .*\w/);
      expect(s.indexOf('About our release ritual')).toBeLessThan(s.indexOf('for this prompt:'));
    });

    it('the context block: what the knowledge base holds, who the person is, the ingest never done', async () => {
      const s = sentContext(p.dir);
      expect(s).toMatch(/^agent-knowledge holds 2,?009 entries · \d+ sessions/);
      expect(s).toContain(
        '--- Knowledge wakeup (identity only; call `knowledge action=wakeup` for L1 facts) ---\n## L0 — IDENTITY\nAlex Example, release engineer on the e2e team.',
      );
      expect(s).toMatch(
        /knowledge-ingest: project "lifecycle-ws-demo" \(3\+ source files\) has not been ingested yet/,
      );
      expect(s).not.toContain('Identity onboarding');
    });

    it('/compact snapshots the session and says where; the summary is asked to keep what is unsaved', async () => {
      await command(t, '/compact');
      // A toast, not a transcript line in the middle of the turn.
      // The toast names the snapshot by its title (project · day · first prompt), which the toast
      // box may wrap: its start on the screen, the title in the file.
      await t.waitFor(/Session saved at compaction: /, 3 * MIN);
      shot(t, 'compact');
      const [file] = snapshots(w, p.slug);
      expect(file).toBeDefined();
      const text = readFileSync(file!, 'utf-8');
      expect(text).toMatch(/^title: \S+ · \d{4}-\d\d-\d\d · About our release ritual/m);
      expect(text).toContain('event: compact');
      expect(text).toContain('## What was asked');
      expect(text).toContain('About our release ritual');
      await t.waitFor(/❯\s*$/m, MIN);
      // ctrl+o shows the summary: it carries the heading the compaction was asked for.
      await t.key('\x0f');
      await t.waitFor(/Knowledge to save/, 20_000);
      await t.key('\x0f');
    });

    it('/clear ends the conversation: its last snapshot, and the line says where it went', async () => {
      const [file] = snapshots(w, p.slug);
      await command(t, '/clear');
      expect(await until(() => readFileSync(file!, 'utf-8').includes('event: end'))).toBe(true);
      // The summary the compaction left in the person's turn is no prompt of theirs.
      const end = readFileSync(file!, 'utf-8');
      expect(end).toMatch(/^user_turns: 1$/m);
      expect(end).not.toMatch(/continued from a previous conversation/i);
      // The end's own receipt (the compaction's reads "at compaction"), by the snapshot's title:
      // from the next conversation's first poll, a transcript line would go with the one ended.
      const title = /^title: (.+)$/m.exec(readFileSync(file!, 'utf-8'))![1]!;
      // The toast box wraps its text: read it with the box and the line breaks taken out.
      // (Wrapped mid-word too: compared with every space and box line taken out.)
      const flat = (s: string) => s.replace(/[│╭╮╰╯─\s]+/g, '');
      const said = flat(`Session saved: ${title.slice(0, 24)}`);
      const seen = await until(() => flat(t.text()).includes(said), 40_000);
      expect(seen, `no "${said}" toast on:\n${t.screen()}`).toBe(true);
      shot(t, 'clear-toast');
    });

    it('the next conversation gets its own hits again; /exit leaves its snapshot', async () => {
      await ask(
        t,
        'What is the zebrafish deploy recipe? Answer from the hits you were given, one line, no tools.',
        /agent-knowledge: \d+ (entry|entries) for this prompt: .*Zebrafish deploy recipe/,
      );
      await command(t, '/exit');
      expect(await until(() => snapshots(w, p.slug).length === 2)).toBe(true);
      const second = snapshots(w, p.slug)
        .map((f) => readFileSync(f, 'utf-8'))
        .find((x) => x.includes('zebrafish'))!;
      expect(second).toContain('event: end');
    });
  });

  describe('a person not yet known, a project changed since its ingest', () => {
    const p = project('lifecycle-stale');
    let w: World;
    let t: ClaudeTerm;
    beforeAll(async () => {
      // The cache knows f1 as it is, f2 with other contents, and a file since deleted.
      const sha = (x: string) => createHash('sha256').update(x).digest('hex');
      writeFileSync(
        join(p.dir, '.knowledge-ingest-cache.json'),
        JSON.stringify({
          project: 'stale-demo',
          files: {
            'src/f1.ts': { sha256: sha('export const x1 = 1;\n') },
            'src/f2.ts': { sha256: sha('old') },
            'src/gone.ts': { sha256: sha('gone') },
          },
          entries_created: ['projects/stale-demo.md'],
        }),
      );
      w = await startWorld(SEED, undefined, SESSION_ROOTS);
      t = new ClaudeTerm(w, 160, 50, FULLSCREEN, p.dir);
      await t.start();
    }, 3 * MIN);
    afterAll(async () => {
      await t?.kill();
      await w?.stop();
    }, 2 * MIN);

    it('the context block asks who the person is and says what changed since the ingest', async () => {
      await ask(
        t,
        'Quote, verbatim and complete, your context block that starts with "agent-knowledge holds". Text only, no tools, do not ask me anything.',
        /Identity onboarding[\s\S]*knowledge-ingest: project "stale-demo"/,
      );
      shot(t, 'onboarding');
      const s = sentContext(p.dir);
      expect(s).toContain('--- Identity onboarding (no identity.md yet) ---');
      expect(s).toMatch(/identity\.md` as short markdown/);
      expect(s).toMatch(
        /knowledge-ingest: project "stale-demo" has 3 file changes since the last ingest \(1 changed, 1 new, 1 deleted\)/,
      );
    });

    it('a burst of Enter on Ingest puts the command in the prompt and runs nothing', async () => {
      await command(t, '/knowledge');
      await t.waitFor(/Every entry newest first/, 20_000);
      await t.key('4');
      await t.waitFor(/Ingest stale-demo ›/, 20_000);
      const held = () => t.text().split('Not run: that Enter came with the command').length - 1;
      // Enter twice 10, 40, 60 ms apart; three times 30 and 120 ms apart.
      const bursts: [number, number][] = [
        [2, 10],
        [2, 40],
        [2, 60],
        [3, 30],
        [3, 120],
      ];
      for (const [i, [n, gap]] of bursts.entries()) {
        // The prompt has had the keys since the last round's fill: ctrl+x tab gives them back.
        if (i > 0) await t.key('FOCUS');
        await t.focus('Ingest stale-demo ›');
        await t.typeKeys('\r'.repeat(n), gap);
        // Every Enter after the first reached the prompt, which has the keys with the text, and
        // was held; said once a burst, not once an Enter.
        await t.waitFor(/Not run: that Enter came with the command/, 10_000);
        await sleep(1_500);
        expect(held()).toBeLessThanOrEqual(i + 1);
        expect(t.text()).not.toMatch(/esc to interrupt/);
        // The command is back in the prompt, to read; emptied for the next round.
        expect(t.prompt()).toMatch(/^\/knowledge-ingest .*stale/);
        await t.key('ESC');
        await t.key('BS', 120);
      }
    });
  });

  describe('a server that takes the connection and never answers', () => {
    const p = project('lifecycle-stuck');
    let w: World;
    let t: ClaudeTerm;
    let stuck: Server;
    beforeAll(async () => {
      w = await startWorld(SEED, undefined, SESSION_ROOTS);
      const port = await freePort();
      stuck = createServer(() => {
        /* never answers */
      }).listen(port, '127.0.0.1');
      t = new ClaudeTerm(w, 160, 50, { ...FULLSCREEN, AGENT_KNOWLEDGE_PORT: String(port) }, p.dir);
      await t.start(/agent-knowledge: offline/);
    }, 3 * MIN);
    afterAll(async () => {
      await t?.kill();
      stuck?.close();
      await w?.stop();
    }, 2 * MIN);

    it('the status line says offline and a prompt is answered without the hits', async () => {
      await ask(t, 'Reply with the single word PONG, no tools.', /PONG/);
      expect(t.text()).not.toMatch(/for this prompt/);
    });
  });

  describe('a slow server (fullscreen, 160 columns)', () => {
    let w: World;
    let t: ClaudeTerm;
    let slow: Server;
    beforeAll(async () => {
      w = await startWorld();
      // Between the pane and the world's server: an entry and a session answer after 4 s.
      const port = await freePort();
      slow = createServer((req, res) => {
        const delay = /^\/api\/(knowledge\/[^/?]+\.md|sessions\/[^/]+\/summary)/.test(req.url ?? '')
          ? 4_000
          : 0;
        setTimeout(() => {
          const up = request(
            {
              host: '127.0.0.1',
              port: w.port,
              path: req.url,
              method: req.method,
              // The server's guard wants its own port in Host.
              headers: { ...req.headers, host: `127.0.0.1:${w.port}` },
            },
            (r) => {
              res.writeHead(r.statusCode ?? 502, r.headers);
              r.pipe(res);
            },
          );
          up.on('error', () => res.writeHead(502).end());
          req.pipe(up);
        }, delay);
      }).listen(port, '127.0.0.1');
      t = new ClaudeTerm(w, 160, 50, { ...FULLSCREEN, AGENT_KNOWLEDGE_PORT: String(port) });
      await t.start();
    }, 2 * MIN);
    afterAll(async () => {
      await t?.kill();
      slow?.close();
      await w?.stop();
    }, 2 * MIN);

    it('an entry still loading shows its path loading, then the page', async () => {
      await t.knowledge();
      await t.press('Release ritual');
      await t.waitFor(/workflows\/release\.md loading…/, 3_000);
      shot(t, 'progress');
      await t.waitFor(/tag and push/, 15_000);
    });

    it('a session still loading shows "The session loading", then its summary', async () => {
      await t.key('3');
      await t.waitFor(/newest first/, 10_000);
      await t.press('agent-tasks');
      await t.waitFor(/The session loading…/, 3_000);
      shot(t, 'progress-session');
      await t.waitFor(/What was asked/, 15_000);
    });
  });
});

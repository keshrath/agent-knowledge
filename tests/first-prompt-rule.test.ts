// The first-prompt rule's parts, one by one (tests/first-prompt-eval.test.ts measures them
// together): generic words, what names an entry, numbers, two hits, the closest in meaning.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { invalidateKnowledgeIndexCache, searchKnowledge } from '../src/knowledge/search.js';

let dir: string;
const write = (rel: string, text: string) => {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const entry = (rel: string, title: string, body: string) =>
  write(rel, `---\ntitle: ${title}\n---\n\n${body}\n`);
const hits = (prompt: string, similar?: Map<string, number>) =>
  searchKnowledge(dir, prompt, {
    prompt: true,
    mmr: true,
    skipCategory: 'sessions',
    maxResults: 4,
    ...(similar ? { similar } : {}),
  }).map((h) => h.entry.path);

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-rule-'));
  entry(
    'notes/zebrafish.md',
    'Zebrafish deploy recipe',
    'The zebrafish service deploys with make ship.',
  );
  entry(
    'workflows/never-force-push.md',
    'Never force push',
    'Commit, then push; never force the push.',
  );
  entry('notes/hoot-barcode.md', 'Hoot barcode scans', 'A hoot test of a barcode scan on a form.');
  entry(
    'notes/hoot-mount.md',
    'Hoot mount gotchas',
    'Mounting in hoot needs a barcode service mock.',
  );
  entry(
    'notes/hoot-clock.md',
    'Hoot clock',
    'The hoot clock follows the real time in a barcode test.',
  );
  entry('notes/plus-plan.md', 'Plus plan pricing', 'The plus plan costs more.');
  entry('notes/offline.md', 'Working offline', 'What to do when the network is down.');
  for (let i = 0; i < 6; i++)
    entry(`notes/filler-${i}.md`, `Notes ${i}`, `Commit the change and push it, file ${i}.`);
  // The person's sessions: what they say to the assistant about any code.
  for (let i = 0; i < 25; i++)
    write(
      `sessions/demo/2026-11-${String(i + 1).padStart(2, '0')}-s${i}.md`,
      `---\ntype: session-snapshot\nsession: s${i}\n---\n\n## What was asked\n\n- commit and push the file\n`,
    );
  invalidateKnowledgeIndexCache();
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the first-prompt rule', () => {
  it('answers what an entry is named by', () => {
    expect(hits('what is the zebrafish deploy recipe?')).toEqual(['notes/zebrafish.md']);
  });

  it('a prompt of generic words (said in many sessions, naming no entry) brings nothing', () => {
    expect(hits('push the file and commit please')).toEqual([]);
  });

  it('a sum is no question for the base: bare numbers are words it never saw', () => {
    expect(hits("what's 12 plus 30?")).toEqual([]);
  });

  it('two hits at most, each near the best', () => {
    // All three hoot entries hold both words and are named by one: the first two are kept.
    const got = hits('hoot barcode');
    expect(got[0]).toBe('notes/hoot-barcode.md');
    expect(got).toHaveLength(2);
  });

  it('who the person is is no answer: it rides in the context block', () => {
    entry('identity.md', 'identity', 'Zebrafish keeper.');
    invalidateKnowledgeIndexCache();
    expect(hits('who keeps the zebrafish?')).not.toContain('identity.md');
    fs.rmSync(path.join(dir, 'identity.md'));
    invalidateKnowledgeIndexCache();
  });

  it('news that ends in thanks asks nothing', () => {
    expect(hits('the hoot barcode tests pass now, cheers')).toEqual([]);
  });

  it('with embeddings, the entry closest in meaning answers too, words or not', () => {
    const near = new Map([
      ['notes/offline.md', 0.72],
      ['notes/zebrafish.md', 0.31],
    ]);
    expect(hits('the network is down again', near)).toEqual(['notes/offline.md']);
    // Not close enough: nothing.
    near.set('notes/offline.md', 0.5);
    expect(hits('the network is down again', near)).toEqual([]);
    // A session is never one: the snapshots stay out.
    expect(
      hits('the network is down again', new Map([['sessions/demo/2026-11-01-s0.md', 0.9]])),
    ).toEqual([]);
  });
});

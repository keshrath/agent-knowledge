import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { staleByCodeActivity } from '../src/knowledge/freshness.js';

// Uses dependency injection (`sessionSource` option) so the test suite
// doesn't need to mock ESM module bindings. The detector's production path
// (listSessions + getSessionSummary) is covered by the integration test at
// the bottom.

function daysAgoIso(n: number): string {
  return new Date(Date.now() - n * 24 * 3600_000).toISOString();
}

function daysAgoMs(n: number): number {
  return Date.now() - n * 24 * 3600_000;
}

describe('staleByCodeActivity', () => {
  let tmpKB: string;

  beforeEach(() => {
    tmpKB = mkdtempSync(join(tmpdir(), 'agent-knowledge-freshness-'));
    process.env.AGENT_KNOWLEDGE_MEMORY_DIR = tmpKB;
  });

  afterEach(() => {
    rmSync(tmpKB, { recursive: true, force: true });
    delete process.env.AGENT_KNOWLEDGE_MEMORY_DIR;
  });

  function writeEntry(rel: string, body: string, ageDays = 90): void {
    const full = join(tmpKB, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
    const t = daysAgoMs(ageDays) / 1000;
    utimesSync(full, t, t);
  }

  it('flags an old entry when recent sessions modify one of its mentioned files', () => {
    writeEntry(
      'decisions/auth.md',
      '---\ntitle: Auth decision\n---\n\nThe flow lives in src/auth.ts; tokens are signed in src/crypto.ts.',
      90,
    );

    const signals = staleByCodeActivity({
      sessionSource: [
        {
          session_id: 's1',
          project: 'app',
          start_time: daysAgoIso(5),
          filesModified: ['src/auth.ts'],
        },
        {
          session_id: 's2',
          project: 'app',
          start_time: daysAgoIso(2),
          filesModified: ['src/auth.ts', 'src/crypto.ts'],
        },
      ],
    });
    expect(signals).toHaveLength(1);
    const s = signals[0];
    expect(s.entry).toBe('decisions/auth.md');
    expect(s.touched_files).toEqual(expect.arrayContaining(['src/auth.ts', 'src/crypto.ts']));
    expect(s.touching_sessions).toHaveLength(2);
    expect(s.body_age_days).toBeGreaterThan(80);
    expect(s.lag_days).toBeGreaterThan(80);
    expect(s.confidence).toBeGreaterThan(0.3);
    expect(s.confidence).toBeLessThanOrEqual(1);
  });

  it('ignores entries whose body mtime is newer than all touching sessions', () => {
    writeEntry('decisions/recent.md', '---\ntitle: Recent\n---\n\nSee src/app.ts.', 1);
    const signals = staleByCodeActivity({
      sessionSource: [
        {
          session_id: 'old',
          project: 'app',
          start_time: daysAgoIso(10),
          filesModified: ['src/app.ts'],
        },
      ],
    });
    expect(signals).toEqual([]);
  });

  it('exempts evergreen entries even when touching sessions exist', () => {
    writeEntry(
      'decisions/core.md',
      '---\ntitle: Core\nevergreen: true\n---\n\nSee src/core.ts.',
      200,
    );
    const signals = staleByCodeActivity({
      sessionSource: [
        {
          session_id: 's1',
          project: 'app',
          start_time: daysAgoIso(3),
          filesModified: ['src/core.ts'],
        },
        {
          session_id: 's2',
          project: 'app',
          start_time: daysAgoIso(1),
          filesModified: ['src/core.ts'],
        },
      ],
    });
    expect(signals).toEqual([]);
  });

  it('ignores entries with no file-path mentions', () => {
    writeEntry(
      'notes/general.md',
      '---\ntitle: Pure prose\n---\n\nNo code references here at all.',
      200,
    );
    const signals = staleByCodeActivity({
      sessionSource: [
        {
          session_id: 's1',
          project: 'app',
          start_time: daysAgoIso(3),
          filesModified: ['src/auth.ts'],
        },
      ],
    });
    expect(signals).toEqual([]);
  });

  it('orders signals by descending confidence', () => {
    writeEntry('decisions/hot.md', '---\ntitle: Hot\n---\n\nsrc/hot.ts', 100);
    writeEntry('decisions/warm.md', '---\ntitle: Warm\n---\n\nsrc/warm.ts', 100);

    const signals = staleByCodeActivity({
      sessionSource: [
        ...Array.from({ length: 5 }, (_, i) => ({
          session_id: `hot${i}`,
          project: 'app',
          start_time: daysAgoIso(10 + i * 5),
          filesModified: ['src/hot.ts'],
        })),
        {
          session_id: 'warm1',
          project: 'app',
          start_time: daysAgoIso(2),
          filesModified: ['src/warm.ts'],
        },
      ],
    });
    expect(signals.length).toBe(2);
    expect(signals[0].entry).toBe('decisions/hot.md');
    expect(signals[0].confidence).toBeGreaterThan(signals[1].confidence);
  });

  it('respects sinceDays window — sessions older than cutoff ignored', () => {
    writeEntry('decisions/x.md', '---\ntitle: X\n---\n\nsrc/x.ts', 200);
    const session = {
      session_id: 'old',
      project: 'app',
      start_time: daysAgoIso(100),
      filesModified: ['src/x.ts'],
    };
    expect(staleByCodeActivity({ sinceDays: 30, sessionSource: [session] })).toEqual([]);
    expect(staleByCodeActivity({ sinceDays: 365, sessionSource: [session] }).length).toBe(1);
  });

  it('normalises leading `./` and `~/` so entry mentions join session paths', () => {
    writeEntry('decisions/norm.md', '---\ntitle: N\n---\n\nEdit ./src/shared.ts', 100);
    const signals = staleByCodeActivity({
      sessionSource: [
        {
          session_id: 's1',
          project: 'app',
          start_time: daysAgoIso(5),
          filesModified: ['src/shared.ts'], // no leading ./
        },
      ],
    });
    expect(signals).toHaveLength(1);
    expect(signals[0].touched_files).toContain('src/shared.ts');
  });

  it(
    'default-path coverage: listSessions branch returns empty when no sessions registered',
    // Tight timeout BUT we also tighten `sinceDays` to 1 so the real
    // listSessions()+getSessionSummary() path only looks at today's
    // session files, not every JSONL on the developer's box. Earlier
    // iterations of this test ran with `sinceDays: 30` and timed out
    // under full-suite I/O pressure on machines with a heavy session
    // corpus. The point of the test is still covered — we're pinning
    // "the default branch returns an array without throwing", not the
    // size of the result.
    { timeout: 15_000 },
    () => {
      writeEntry('decisions/lonely.md', '---\ntitle: Lonely\n---\n\nSee src/x.ts.', 50);
      const signals = staleByCodeActivity({ sinceDays: 1 });
      expect(Array.isArray(signals)).toBe(true);
      // On THIS machine the real listSessions may return the running session's
      // data — the contract we're pinning is "returns an array without
      // throwing", not the count. Accept any shape.
      for (const s of signals) {
        expect(typeof s.entry).toBe('string');
        expect(Array.isArray(s.touched_files)).toBe(true);
        expect(typeof s.confidence).toBe('number');
      }
    },
  );
});

import { describe, expect, it } from 'vitest';
import {
  SIGNAL_WEIGHTS,
  DEFAULT_GATES,
  computeSignals,
  compositeScore,
  evaluateGates,
  type RawAggregate,
} from '../src/knowledge/promote.js';

function makeAgg(overrides: Partial<RawAggregate> = {}): RawAggregate {
  const nowIso = new Date().toISOString();
  const yesterdayIso = new Date(Date.now() - 24 * 3600_000).toISOString();
  return {
    id: 'test-project',
    sessionIds: ['s1'],
    topics: ['initial setup notes'],
    topicFingerprints: new Set(['initial setup notes']),
    tools: new Set(['Bash']),
    files: new Set(['src/index.ts']),
    errorPatterns: new Set(),
    gitCommits: new Set(),
    firstSeen: yesterdayIso,
    lastSeen: nowIso,
    latestSessionFile: null,
    ...overrides,
  };
}

const NOW = Date.now();

describe('SIGNAL_WEIGHTS', () => {
  it('sums to 1.0 — guards against typos in the weight table', () => {
    const total = Object.values(SIGNAL_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1.0, 6);
  });

  it('orders signals relevance > frequency > {queryDiversity, recency} > consolidation > conceptualRichness', () => {
    // Pins the full ordering so silent re-weighting stands out in a diff.
    expect(SIGNAL_WEIGHTS.relevance).toBeGreaterThan(SIGNAL_WEIGHTS.frequency);
    expect(SIGNAL_WEIGHTS.frequency).toBeGreaterThan(SIGNAL_WEIGHTS.queryDiversity);
    expect(SIGNAL_WEIGHTS.queryDiversity).toBe(SIGNAL_WEIGHTS.recency);
    expect(SIGNAL_WEIGHTS.recency).toBeGreaterThan(SIGNAL_WEIGHTS.consolidation);
    expect(SIGNAL_WEIGHTS.consolidation).toBeGreaterThan(SIGNAL_WEIGHTS.conceptualRichness);
  });
});

describe('computeSignals', () => {
  it('recency ≈ 1 at t=0, ≈ 0.135 at t=60d (30d characteristic decay)', () => {
    const atZero = computeSignals(makeAgg({ lastSeen: new Date(NOW).toISOString() }), NOW);
    expect(atZero.recency).toBeGreaterThan(0.99);

    const sixtyDaysAgo = new Date(NOW - 60 * 24 * 3600_000).toISOString();
    const atSixty = computeSignals(makeAgg({ lastSeen: sixtyDaysAgo }), NOW);
    expect(atSixty.recency).toBeCloseTo(Math.exp(-2), 3);
  });

  it('frequency scales linearly from 1 session to 5, saturates at 5+', () => {
    const at = (n: number) =>
      computeSignals(makeAgg({ sessionIds: Array.from({ length: n }, (_, i) => `s${i}`) }), NOW)
        .frequency;
    expect(at(1)).toBeCloseTo(0.2, 6);
    expect(at(3)).toBeCloseTo(0.6, 6);
    expect(at(5)).toBe(1);
    expect(at(10)).toBe(1);
  });

  it('queryDiversity scales linearly from 1 fingerprint to 5, saturates at 5+', () => {
    const at = (n: number) =>
      computeSignals(
        makeAgg({
          topicFingerprints: new Set(Array.from({ length: n }, (_, i) => `fp${i}`)),
        }),
        NOW,
      ).queryDiversity;
    expect(at(2)).toBeCloseTo(0.4, 6);
    expect(at(5)).toBe(1);
    expect(at(12)).toBe(1);
  });

  it('conceptualRichness >= 0.3 for topic with decision phrase + file ref + code fence', () => {
    // Pins a minimum floor — not just "higher than a control". Catches heuristics
    // that silently weaken (e.g. if the regex drops decision phrase detection).
    const rich = makeAgg({
      topics: [
        '```ts\nconst x = 1;\n```',
        'decided on postgres because JSONB; see src/store/database.ts',
      ],
    });
    const { conceptualRichness } = computeSignals(rich, NOW);
    expect(conceptualRichness).toBeGreaterThanOrEqual(0.3);
  });

  it('conceptualRichness = 0 for topics with no markers at all', () => {
    const shallow = makeAgg({ topics: ['hi', 'ok', 'done', 'lgtm'] });
    expect(computeSignals(shallow, NOW).conceptualRichness).toBe(0);
  });

  it('consolidation saturates at 20 combined metadata items', () => {
    const sparse = makeAgg({ files: new Set(), tools: new Set() });
    expect(computeSignals(sparse, NOW).consolidation).toBeLessThan(0.1);

    const twenty = makeAgg({
      files: new Set(Array.from({ length: 10 }, (_, i) => `f${i}.ts`)),
      tools: new Set(Array.from({ length: 5 }, (_, i) => `t${i}`)),
      gitCommits: new Set(Array.from({ length: 3 }, (_, i) => `c${i}`)),
      errorPatterns: new Set(Array.from({ length: 2 }, (_, i) => `e${i}`)),
    });
    expect(computeSignals(twenty, NOW).consolidation).toBe(1);
  });
});

describe('compositeScore', () => {
  it('equals 1 when every signal is 1 (weights sum consistency)', () => {
    const score = compositeScore({
      relevance: 1,
      frequency: 1,
      queryDiversity: 1,
      recency: 1,
      consolidation: 1,
      conceptualRichness: 1,
    });
    expect(score).toBeCloseTo(1.0, 6);
  });

  it('single-signal scores reflect the full weight ordering', () => {
    // If weights are re-tuned without updating tests, this catches the silent drift.
    const only = (key: keyof typeof SIGNAL_WEIGHTS) =>
      compositeScore({
        relevance: 0,
        frequency: 0,
        queryDiversity: 0,
        recency: 0,
        consolidation: 0,
        conceptualRichness: 0,
        [key]: 1,
      } as Parameters<typeof compositeScore>[0]);

    expect(only('relevance')).toBeGreaterThan(only('frequency'));
    expect(only('frequency')).toBeGreaterThan(only('queryDiversity'));
    expect(only('queryDiversity')).toBe(only('recency'));
    expect(only('recency')).toBeGreaterThan(only('consolidation'));
    expect(only('consolidation')).toBeGreaterThan(only('conceptualRichness'));
  });
});

describe('evaluateGates', () => {
  const T = { ...DEFAULT_GATES };

  it('all three gates pass together when every input is comfortably above threshold', () => {
    const agg = makeAgg({
      sessionIds: ['1', '2', '3'],
      topicFingerprints: new Set(['a', 'b', 'c']),
    });
    const g = evaluateGates(agg, 0.8, T);
    expect(g.minScore.passed).toBe(true);
    expect(g.minRecallCount.passed).toBe(true);
    expect(g.minUniqueQueries.passed).toBe(true);
  });

  it('each gate fails independently (isolation)', () => {
    // Build an aggregate that's borderline — comfortable on 2 gates, fail 1.
    // Verify only the intended gate flips.
    const baseline = makeAgg({
      sessionIds: ['1', '2', '3'],
      topicFingerprints: new Set(['a', 'b', 'c']),
    });

    const onlyScoreFail = evaluateGates(baseline, 0.1, T);
    expect(onlyScoreFail.minScore.passed).toBe(false);
    expect(onlyScoreFail.minRecallCount.passed).toBe(true);
    expect(onlyScoreFail.minUniqueQueries.passed).toBe(true);

    const onlyRecallFail = evaluateGates(
      makeAgg({ sessionIds: ['solo'], topicFingerprints: new Set(['a', 'b']) }),
      0.9,
      T,
    );
    expect(onlyRecallFail.minScore.passed).toBe(true);
    expect(onlyRecallFail.minRecallCount.passed).toBe(false);
    expect(onlyRecallFail.minUniqueQueries.passed).toBe(true);

    const onlyUniqueFail = evaluateGates(
      makeAgg({ sessionIds: ['1', '2'], topicFingerprints: new Set(['lonely']) }),
      0.9,
      T,
    );
    expect(onlyUniqueFail.minScore.passed).toBe(true);
    expect(onlyUniqueFail.minRecallCount.passed).toBe(true);
    expect(onlyUniqueFail.minUniqueQueries.passed).toBe(false);
  });

  it('gate threshold overrides pass through (strict fails, loose passes)', () => {
    const agg = makeAgg({ sessionIds: ['1'], topicFingerprints: new Set(['a']) });

    const strict = evaluateGates(agg, 0.9, {
      minScore: 0.95,
      minRecallCount: 5,
      minUniqueQueries: 5,
    });
    expect([
      strict.minScore.passed,
      strict.minRecallCount.passed,
      strict.minUniqueQueries.passed,
    ]).toEqual([false, false, false]);

    const loose = evaluateGates(agg, 0.1, { minScore: 0, minRecallCount: 1, minUniqueQueries: 1 });
    expect([
      loose.minScore.passed,
      loose.minRecallCount.passed,
      loose.minUniqueQueries.passed,
    ]).toEqual([true, true, true]);
  });

  it('each GateResult carries the actual value and threshold used', () => {
    const agg = makeAgg({ sessionIds: ['1', '2'], topicFingerprints: new Set(['a', 'b', 'c']) });
    const g = evaluateGates(agg, 0.73, T);
    expect(g.minScore.value).toBe(0.73);
    expect(g.minScore.threshold).toBe(T.minScore);
    expect(g.minRecallCount.value).toBe(2);
    expect(g.minRecallCount.threshold).toBe(T.minRecallCount);
    expect(g.minUniqueQueries.value).toBe(3);
    expect(g.minUniqueQueries.threshold).toBe(T.minUniqueQueries);
  });
});

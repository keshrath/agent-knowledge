import { describe, expect, it } from 'vitest';
import { rerankMMR, diversityAtK, cosineSim, jaccardTokenSim } from '../src/search/mmr.js';

describe('rerankMMR', () => {
  it('is identity (input order by relevance) when lambda=1', () => {
    const items = [
      { id: 'a', score: 1.0 },
      { id: 'b', score: 0.8 },
      { id: 'c', score: 0.6 },
    ];
    const out = rerankMMR(items, {
      lambda: 1,
      sim: () => 0.5,
      relevance: (x) => x.score,
      k: 3,
    });
    expect(out.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('prefers novelty over relevance when lambda is low', () => {
    // a and b are near-duplicates (sim=0.9); c is different (sim=0.1).
    // At lambda=0.2 MMR must pick c before b even though b has higher relevance.
    const items = [
      { id: 'a', score: 1.0 },
      { id: 'b', score: 0.9 },
      { id: 'c', score: 0.7 },
    ];
    const simMatrix: Record<string, Record<string, number>> = {
      a: { a: 1, b: 0.9, c: 0.1 },
      b: { a: 0.9, b: 1, c: 0.1 },
      c: { a: 0.1, b: 0.1, c: 1 },
    };
    const out = rerankMMR(items, {
      lambda: 0.2,
      sim: (x, y) => simMatrix[x.id][y.id],
      relevance: (x) => x.score,
      k: 3,
    });
    expect(out.map((x) => x.id)).toEqual(['a', 'c', 'b']);
  });

  it('truncates to k AND keeps the top-relevance item first', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, score: 1 - i * 0.05 }));
    const out = rerankMMR(items, {
      k: 3,
      lambda: 0.7,
      sim: () => 0.3,
      relevance: (x) => x.score,
    });
    expect(out).toHaveLength(3);
    expect(out[0].id).toBe('x0'); // highest score must always be first pick
  });

  it('lambda>1 clamps to 1.0 (behaves as pure relevance)', () => {
    const items = [
      { id: 'a', score: 1.0 },
      { id: 'b', score: 0.5 },
    ];
    const simMatrix = { a: { a: 1, b: 0.5 }, b: { a: 0.5, b: 1 } };
    const outAt5 = rerankMMR(items, {
      lambda: 5,
      sim: (x, y) => simMatrix[x.id as 'a' | 'b'][y.id as 'a' | 'b'],
      relevance: (x) => x.score,
      k: 2,
    });
    const outAt1 = rerankMMR(items, {
      lambda: 1,
      sim: (x, y) => simMatrix[x.id as 'a' | 'b'][y.id as 'a' | 'b'],
      relevance: (x) => x.score,
      k: 2,
    });
    expect(outAt5.map((x) => x.id)).toEqual(outAt1.map((x) => x.id));
  });

  it('lambda<0 clamps to 0.0 (behaves as pure diversity)', () => {
    const items = [
      { id: 'a', score: 1.0 },
      { id: 'b', score: 0.99 },
      { id: 'c', score: 0.1 },
    ];
    const simMatrix: Record<string, Record<string, number>> = {
      a: { a: 1, b: 0.95, c: 0.05 },
      b: { a: 0.95, b: 1, c: 0.05 },
      c: { a: 0.05, b: 0.05, c: 1 },
    };
    // lambda=-5 should clamp to 0 → after picking a, diversity wins: c before b.
    const out = rerankMMR(items, {
      lambda: -5,
      sim: (x, y) => simMatrix[x.id][y.id],
      relevance: (x) => x.score,
      k: 3,
    });
    expect(out.map((x) => x.id)).toEqual(['a', 'c', 'b']);
  });

  it('does not mutate the input array', () => {
    const items = [
      { id: 'a', score: 1 },
      { id: 'b', score: 0.5 },
    ];
    const before = items.map((x) => x.id);
    rerankMMR(items, { sim: () => 0, relevance: (x) => x.score, k: 2 });
    expect(items.map((x) => x.id)).toEqual(before);
  });
});

describe('diversityAtK', () => {
  it('counts 1 cluster when all items are similar (>= threshold)', () => {
    expect(diversityAtK(['a', 'b', 'c'], () => 0.9, 0.5)).toBe(1);
  });

  it('counts N clusters when all items are dissimilar (< threshold)', () => {
    expect(diversityAtK(['a', 'b', 'c'], () => 0.1, 0.5)).toBe(3);
  });

  it('connected-components over pairwise similarity graph', () => {
    // a~b (0.9), b~c (0.9), c~d (0.1). Threshold 0.5:
    //   a-b-c share a cluster via transitivity; d is its own. Expect 2.
    const simFn = (x: string, y: string) => {
      const pair = [x, y].sort().join('');
      if (pair === 'ab') return 0.9;
      if (pair === 'bc') return 0.9;
      return 0.1;
    };
    expect(diversityAtK(['a', 'b', 'c', 'd'], simFn, 0.5)).toBe(2);
  });
});

describe('cosineSim', () => {
  it('handles zero-magnitude vectors without NaN', () => {
    expect(cosineSim([0, 0], [1, 1])).toBe(0);
    expect(cosineSim([1, 1], [0, 0])).toBe(0);
    expect(cosineSim([0, 0], [0, 0])).toBe(0);
  });

  it('uses shorter-prefix semantics for mismatched-length inputs', () => {
    // Documents the design choice: truncate, don't error, don't pad.
    expect(cosineSim([1, 0, 0], [1, 0])).toBeCloseTo(1, 6);
    expect(cosineSim([1, 2], [1, 2, 9999])).toBeCloseTo(1, 6);
  });

  it('computes signed cosine for well-formed vectors', () => {
    expect(cosineSim([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
    expect(cosineSim([1, 0], [0, 1])).toBe(0);
    expect(cosineSim([1, 2], [-1, -2])).toBeCloseTo(-1, 6);
  });
});

describe('jaccardTokenSim', () => {
  it('is case-insensitive (design choice, not incidental)', () => {
    expect(jaccardTokenSim('the QUICK brown fox', 'the quick Brown FOX')).toBe(1);
  });

  it('drops tokens <= 2 chars (design choice)', () => {
    // Without the length filter, "a/b/c" would dominate the overlap. With
    // the filter, {cat} and {dog} are the only surviving tokens — disjoint,
    // so the similarity collapses to 0.
    expect(jaccardTokenSim('a b c cat', 'a b c dog')).toBe(0);
    // Meanwhile, a control where the long tokens DO overlap returns 1,
    // regardless of short-token noise around them.
    expect(jaccardTokenSim('a b c cat', 'x y z cat')).toBe(1);
  });

  it('returns standard Jaccard for multi-token overlap', () => {
    // 2 shared ("database", "migration"); 1 unique each side.
    const s = jaccardTokenSim('database migration workflow', 'database migration playbook');
    expect(s).toBeCloseTo(2 / 4, 2);
  });

  it('returns 0 rather than NaN for empty input', () => {
    expect(jaccardTokenSim('', 'anything')).toBe(0);
    expect(jaccardTokenSim('anything', '')).toBe(0);
  });
});

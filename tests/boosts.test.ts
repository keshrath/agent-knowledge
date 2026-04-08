import { describe, it, expect } from 'vitest';
import {
  extractProperNouns,
  properNounBoost,
  parseTemporalReference,
  temporalProximityBoost,
  buildBoostContext,
  applyBoosts,
  hasAnyBoostSignal,
  MAX_PROPER_NOUN_BOOST,
  MAX_TEMPORAL_BOOST,
  MAX_TOTAL_BOOST,
} from '../src/search/boosts.js';

describe('extractProperNouns', () => {
  it('extracts capitalized non-stopword tokens', () => {
    expect(extractProperNouns('What did Rachel say about Postgres?')).toEqual([
      'Rachel',
      'Postgres',
    ]);
  });

  it('drops sentence-initial stopwords', () => {
    // 'What' is a stopword, 'The' is a stopword
    expect(extractProperNouns('The auth migration')).toEqual([]);
  });

  it('deduplicates case-insensitively', () => {
    expect(extractProperNouns('Maya and MAYA')).toEqual(['Maya']);
  });

  it('returns empty for an all-lowercase query', () => {
    expect(extractProperNouns('how does the auth flow work')).toEqual([]);
  });
});

describe('properNounBoost', () => {
  it('returns 0 when no nouns provided', () => {
    expect(properNounBoost([], 'anything')).toBe(0);
  });

  it('returns 0 when no nouns match the document', () => {
    expect(properNounBoost(['Rachel'], 'discussion about typescript')).toBe(0);
  });

  it('returns half max for one match', () => {
    expect(properNounBoost(['Rachel'], 'rachel mentioned the plan')).toBeCloseTo(
      MAX_PROPER_NOUN_BOOST / 2,
    );
  });

  it('returns full max for two or more matches', () => {
    expect(
      properNounBoost(['Rachel', 'Postgres'], 'rachel chose postgres over sqlite'),
    ).toBeCloseTo(MAX_PROPER_NOUN_BOOST);
  });
});

describe('parseTemporalReference', () => {
  const now = new Date('2026-04-08T12:00:00Z');

  it('parses today / yesterday / tomorrow', () => {
    expect(parseTemporalReference('what did I do today', now)).toBe(now.getTime());
    expect(parseTemporalReference('yesterday I broke the build', now)).toBe(
      now.getTime() - 24 * 3600_000,
    );
  });

  it('parses last week / month / year', () => {
    expect(parseTemporalReference('last week we shipped', now)).toBe(
      now.getTime() - 7 * 24 * 3600_000,
    );
    expect(parseTemporalReference('last month deploys', now)).toBe(
      now.getTime() - 30 * 24 * 3600_000,
    );
  });

  it('parses month names', () => {
    const result = parseTemporalReference('what happened in March 2025', now);
    expect(result).not.toBeNull();
    expect(new Date(result!).getMonth()).toBe(2); // March
    expect(new Date(result!).getFullYear()).toBe(2025);
  });

  it('parses bare year', () => {
    const result = parseTemporalReference('the 2024 incident', now);
    expect(result).not.toBeNull();
    expect(new Date(result!).getFullYear()).toBe(2024);
  });

  it('returns null for queries without a temporal reference', () => {
    expect(parseTemporalReference('how does auth work', now)).toBeNull();
  });
});

describe('temporalProximityBoost', () => {
  const anchor = new Date('2025-06-15').getTime();

  it('returns 0 when doc has no timestamp', () => {
    expect(temporalProximityBoost(anchor, null)).toBe(0);
  });

  it('returns max boost at the anchor', () => {
    expect(temporalProximityBoost(anchor, anchor)).toBeCloseTo(MAX_TEMPORAL_BOOST);
  });

  it('decays smoothly with distance (Gaussian)', () => {
    const oneSigmaAway = anchor + 30 * 24 * 3600_000;
    const twoSigmaAway = anchor + 60 * 24 * 3600_000;
    const oneSigma = temporalProximityBoost(anchor, oneSigmaAway);
    const twoSigma = temporalProximityBoost(anchor, twoSigmaAway);
    expect(oneSigma).toBeLessThan(MAX_TEMPORAL_BOOST);
    expect(twoSigma).toBeLessThan(oneSigma);
  });
});

describe('applyBoosts', () => {
  it('returns the original score when no boost signals present', () => {
    const ctx = buildBoostContext('how does the auth flow work');
    expect(hasAnyBoostSignal(ctx)).toBe(false);
    expect(applyBoosts(0.5, ctx, { docText: 'whatever' })).toBe(0.5);
  });

  it('boosts a doc that contains a proper noun from the query', () => {
    const ctx = buildBoostContext('what did Rachel say about Postgres?');
    const original = 0.5;
    const boosted = applyBoosts(original, ctx, {
      docText: 'rachel chose postgres over sqlite',
    });
    expect(boosted).toBeGreaterThan(original);
    expect(boosted).toBeLessThanOrEqual(original * (1 + MAX_TOTAL_BOOST));
  });

  it('caps the combined boost at MAX_TOTAL_BOOST', () => {
    const ctx = buildBoostContext('Rachel Postgres in march 2025');
    // Force a doc that matches everything strongly
    const docTimestamp = new Date(2025, 2, 15).toISOString();
    const original = 1.0;
    const boosted = applyBoosts(original, ctx, {
      docText: 'rachel and postgres notes from march',
      docTimestamp,
    });
    expect(boosted).toBeLessThanOrEqual(original * (1 + MAX_TOTAL_BOOST) + 1e-9);
  });
});

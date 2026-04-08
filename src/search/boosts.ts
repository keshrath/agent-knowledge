/**
 * Search-time scoring boosts.
 *
 * Two boosts applied on top of the TF-IDF + semantic blend:
 *
 * 1. **Proper-noun boost** — capitalized non-stopword tokens in the query
 *    are matched against document text. Embeddings under-weight proper
 *    nouns; this rescues them.
 * 2. **Temporal proximity boost** — when the query mentions a date or
 *    relative time, documents whose timestamp is near that date get a
 *    Gaussian boost.
 *
 * Boosts are additive and capped so the maximum combined boost cannot
 * exceed `MAX_TOTAL_BOOST` (≈ 40% distance reduction in distance space).
 * Queries without proper nouns or date tokens short-circuit via
 * `hasAnyBoostSignal` so default behavior is preserved.
 */

const STOPWORDS = new Set([
  'A',
  'An',
  'And',
  'As',
  'At',
  'Be',
  'But',
  'By',
  'For',
  'From',
  'How',
  'I',
  'If',
  'In',
  'Is',
  'It',
  'Of',
  'On',
  'Or',
  'So',
  'The',
  'This',
  'To',
  'Was',
  'We',
  'What',
  'When',
  'Where',
  'Who',
  'Why',
  'With',
  'You',
  'Your',
]);

/** Maximum boost any single signal can contribute (in score-multiplier space). */
export const MAX_PROPER_NOUN_BOOST = 0.4;
export const MAX_TEMPORAL_BOOST = 0.4;
/** Cap on the combined boost so a doc cannot more than ~1.67x its score. */
export const MAX_TOTAL_BOOST = 0.667;

/** Extract capitalized non-stopword tokens from a query (proper nouns). */
export function extractProperNouns(query: string): string[] {
  const tokens = query.match(/\b[A-Z][A-Za-z0-9_-]*\b/g) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (STOPWORDS.has(t)) continue;
    const lower = t.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(t);
  }
  return out;
}

/**
 * Compute a proper-noun boost for a document.
 * Returns 0 when no nouns match, scales linearly up to MAX_PROPER_NOUN_BOOST
 * when 2+ nouns match.
 */
export function properNounBoost(nouns: string[], docText: string): number {
  if (nouns.length === 0 || !docText) return 0;
  const lowerDoc = docText.toLowerCase();
  let matches = 0;
  for (const n of nouns) {
    if (lowerDoc.includes(n.toLowerCase())) matches++;
  }
  if (matches === 0) return 0;
  // Linear ramp: 1 match → half, 2+ matches → full.
  const fraction = Math.min(matches / 2, 1);
  return MAX_PROPER_NOUN_BOOST * fraction;
}

const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

const MONTH_ABBR = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];

/**
 * Try to parse a temporal reference out of a query.
 * Returns the anchor date in epoch milliseconds, or null if no reference found.
 *
 * Recognizes:
 *   - explicit years: "2024", "2025"
 *   - month names: "march", "april 2025"
 *   - relative: "today", "yesterday", "tomorrow", "last week/month/year"
 */
export function parseTemporalReference(query: string, now: Date = new Date()): number | null {
  const q = query.toLowerCase();

  // Relative
  if (/\btoday\b/.test(q)) return now.getTime();
  if (/\byesterday\b/.test(q)) return now.getTime() - 24 * 3600_000;
  if (/\btomorrow\b/.test(q)) return now.getTime() + 24 * 3600_000;
  const lastMatch = q.match(/\blast\s+(week|month|year)\b/);
  if (lastMatch) {
    const unit = lastMatch[1];
    const ms =
      unit === 'week'
        ? 7 * 24 * 3600_000
        : unit === 'month'
          ? 30 * 24 * 3600_000
          : 365 * 24 * 3600_000;
    return now.getTime() - ms;
  }

  // Month name (optionally with year)
  for (let i = 0; i < MONTH_NAMES.length; i++) {
    const re = new RegExp(`\\b${MONTH_NAMES[i]}\\b(?:\\s+(\\d{4}))?`, 'i');
    const m = q.match(re);
    if (m) {
      const year = m[1] ? parseInt(m[1], 10) : now.getFullYear();
      return new Date(year, i, 15).getTime();
    }
  }
  for (let i = 0; i < MONTH_ABBR.length; i++) {
    const re = new RegExp(`\\b${MONTH_ABBR[i]}\\b(?:\\s+(\\d{4}))?`, 'i');
    const m = q.match(re);
    if (m) {
      const year = m[1] ? parseInt(m[1], 10) : now.getFullYear();
      return new Date(year, i, 15).getTime();
    }
  }

  // Bare year
  const yearMatch = q.match(/\b(20\d{2})\b/);
  if (yearMatch) {
    return new Date(parseInt(yearMatch[1], 10), 5, 15).getTime();
  }

  return null;
}

/**
 * Gaussian proximity factor.
 * Returns 1 at the anchor, ~0.6 at one sigma away, ~0.13 at two sigma.
 * `sigmaDays` defaults to 30 days — half a sprint.
 */
export function temporalProximityBoost(
  anchorMs: number,
  docMs: number | null | undefined,
  sigmaDays: number = 30,
): number {
  if (!docMs) return 0;
  const ageDays = Math.abs(anchorMs - docMs) / (24 * 3600_000);
  const factor = Math.exp(-0.5 * (ageDays / sigmaDays) ** 2);
  return MAX_TEMPORAL_BOOST * factor;
}

export interface BoostContext {
  properNouns: string[];
  temporalAnchorMs: number | null;
}

export function buildBoostContext(query: string, now: Date = new Date()): BoostContext {
  return {
    properNouns: extractProperNouns(query),
    temporalAnchorMs: parseTemporalReference(query, now),
  };
}

export function hasAnyBoostSignal(ctx: BoostContext): boolean {
  return ctx.properNouns.length > 0 || ctx.temporalAnchorMs !== null;
}

export interface ApplyBoostInput {
  docText?: string;
  docTimestamp?: string | null;
}

/**
 * Apply boosts to a base score.
 * `score` is multiplied by `(1 + min(pnBoost + tpBoost, MAX_TOTAL_BOOST))`.
 * Returns the boosted score (≥ original score).
 */
export function applyBoosts(score: number, ctx: BoostContext, input: ApplyBoostInput): number {
  if (!hasAnyBoostSignal(ctx)) return score;
  const pn = ctx.properNouns.length > 0 ? properNounBoost(ctx.properNouns, input.docText ?? '') : 0;
  let tp = 0;
  if (ctx.temporalAnchorMs !== null && input.docTimestamp) {
    const docMs = Date.parse(input.docTimestamp);
    if (!Number.isNaN(docMs)) {
      tp = temporalProximityBoost(ctx.temporalAnchorMs, docMs);
    }
  }
  const total = Math.min(pn + tp, MAX_TOTAL_BOOST);
  return score * (1 + total);
}

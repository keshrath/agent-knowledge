import fs from 'fs';
import path from 'path';
import { BM25Index, tokenize } from '../search/bm25.js';
import { Lexicon } from '../search/lexicon.js';
import { withoutControls } from '../text.js';
import { runAll, runSliced } from '../slice.js';
import { getEntryScoring, computeFinalScore, decayFactor, maturityMultiplier } from './scoring.js';
import { buildExcerpt } from '../search/excerpt.js';
import { getAllFiles, parseFrontmatter, readEntry, KnowledgeEntry } from './store.js';
import { rerankMMR, jaccardTokenSim } from '../search/mmr.js';

export interface SearchOptions {
  category?: string;
  maxResults?: number;
  caseSensitive?: boolean;
  /**
   * How to use `category`:
   *  - 'filter': only entries in `category` are indexed — silently drops
   *     everything else.
   *  - 'boost' (DEFAULT): all entries are indexed; matching-category entries
   *     get a score multiplier. Prevents the "zero results because the
   *     category guess was wrong" failure mode.
   *
   * NOTE: The default flipped from 'filter' to 'boost' in v1.8.0 as part of
   * the agent-UX pass. Pass 'filter' explicitly for the legacy hard-filter
   * behavior.
   */
  categoryMode?: 'filter' | 'boost';
  /** Apply MMR diversification to the result list. Default: false. */
  mmr?: boolean;
  /** A category left out of the hits, e.g. `sessions` (session snapshots) for curated entries. */
  skipCategory?: string;
  /**
   * The query is a person's prompt (the first-prompt hits): what it asks about is searched
   * (`askedAbout`), and only what answers it is a hit (`PROMPT_RULE`). Default: false, any hit.
   */
  prompt?: boolean;
  /** The first-prompt rule's dials (`PROMPT_RULE`): the eval measures others. */
  promptRule?: PromptRule;
  /**
   * How close each entry is to the prompt in meaning (the cosine of its closest chunk), when
   * embeddings are there (`promptSimilarity`): the first-prompt rule's second judge.
   */
  similar?: ReadonlyMap<string, number>;
  /** MMR relevance-vs-diversity tradeoff 0-1. Default: 0.7. */
  mmrLambda?: number;
  /** When true, each result carries a `score_components` breakdown. */
  explain?: boolean;
}

/** Score multiplier applied to entries whose category matches in 'boost' mode. */
export const CATEGORY_BOOST_MULTIPLIER = 1.25;

/** Default MMR tradeoff when the caller passes `mmr: true` without `mmrLambda`. */
export const DEFAULT_MMR_LAMBDA = 0.7;

export interface ScoreComponents {
  bm25: number;
  decay: number;
  maturity: number;
  confidence: number;
  category_boost: number;
  mmr_penalty: number;
}

/**
 * Freshness + trust metadata attached to every knowledge hit (v1.8.1).
 *
 * These are automatic signals — no agent action required. The agent can read
 * them to form a trust judgment ("body last edited 120 days ago, still being
 * accessed 8x/week → probably out of date") without us imposing policy via
 * demotion or flags.
 */
export interface FreshnessMeta {
  /** Days since the underlying markdown file was last modified on disk. */
  body_age_days: number | null;
  /** ISO timestamp of the most recent read via knowledge(action:"read"). */
  last_accessed: string | null;
  /** Number of recorded reads. */
  access_count: number;
  /** ISO timestamp of the last promoter auto-verify (or future explicit verify). */
  verified_at: string | null;
  /** Days since last verified, null if never verified. */
  verification_age_days: number | null;
  /** Evergreen entries are exempt from decay-based demotion; surfaced here for UI. */
  evergreen: boolean;
}

export interface SearchResult {
  entry: KnowledgeEntry;
  score: number;
  excerpt: string;
  /** Populated only when the caller passes `explain: true`. */
  score_components?: ScoreComponents;
  /** Automatic freshness + trust signal — present on every hit. */
  freshness?: FreshnessMeta;
}

// ── TF-IDF index cache for knowledge entries ──────────────────────────────

/**
 * One TF-IDF index over the entries (of a category, in 'filter' mode), kept in step with the
 * files: each search compares the files' sizes and times with what was indexed and re-reads
 * only what changed, so entries other sessions write are found at once and a write never
 * costs a rebuild of the whole knowledge base.
 */
interface KnowledgeIndex {
  index: BM25Index;
  /** The curated entries' words: which are generic, which name an entry (`Lexicon`). */
  lexicon: Lexicon;
  docs: Map<string, { entry: KnowledgeEntry; content: string }>;
  /** What each indexed file looked like: `<mtime>:<size>`. */
  stamps: Map<string, string>;
  /** When the files were last compared; a burst of searches compares once. */
  checkedAt: number;
}

const knowledgeIndexes = new Map<string, KnowledgeIndex>();
/** Searches within this long of the last comparison trust it; a write here resets it. */
const RECHECK_MS = 2_000;

/**
 * Words a prompt uses around what it asks, not about it: greetings, the asking itself, time
 * and filler. "hi! I want to start working on a small script today" is about a script.
 */
const PROMPT_WORDS = new Set(
  (
    'hi hello hey thanks thank please want wanted start starting work working small little ' +
    'quick today tomorrow tonight now help know tell show need like would could can also just ' +
    'something anything thing things stuff question ok okay sure let lets going try ' +
    'remind recall decide decided against'
  ).split(' '),
);

/**
 * The first-prompt rule, measured in tests/first-prompt-eval.test.ts (holdout prompts it was
 * never tuned on). Precision over recall: no hit costs little (the model can still search), a
 * wrong one misleads it. A prompt is answered when what it says is what the base is about:
 *
 * - its known terms are not mostly generic (`Lexicon.isGeneric`: build, page, rename), by
 *   weight: at least `specific` of it;
 * - each hit is named by its specific terms (title, path, tags: what the entry is about, not
 *   words in passing) for `named` of what the prompt's terms tell (IDF), holds `coverage` of
 *   it, and scores `nearTop` of the best at least;
 * - `hits` at most.
 *
 * With embeddings (`similar`), the entry closest in meaning answers too, words or not, when it
 * is `close` or closer (a cosine: the local model's, the one measured).
 */
export interface PromptRule {
  specific: number;
  named: number;
  coverage: number;
  nearTop: number;
  hits: number;
  close: number;
}
export const PROMPT_RULE: PromptRule = {
  specific: 0.5,
  named: 0.4,
  coverage: 0.6,
  nearTop: 0.7,
  hits: 2,
  close: 0.6,
};

/**
 * A reply, not a question: an ack or a greeting, a few words long, with nothing asked; or
 * news that ends in thanks ("the tests pass now, cheers").
 */
const THANKS = /\b(?:thanks?|thank you|ty|cheers)[.!]*$/;
const ACK =
  /^(?:ok(?:ay)?|yes|yep|yeah|no|nope|sure|thanks?|thank you|ty|great|nice|cool|perfect|awesome|good|looks good|lgtm|sounds good|go ahead|do it|ship it|continue|proceed|next|done|hi|hello|hey|good (?:morning|afternoon|evening|night))\b/;
/** Asking for something made, not known: a poem, a joke, a story. */
const CHAT = /\b(?:poem|haiku|limerick|joke|song|story|riddle)s?\b/;
/**
 * A task on what the person has at hand, not a question: "let's refactor this function",
 * "draft an email to my landlord", "explain this error".
 */
const TASK =
  /^(?:(?:ok|so|now|hey)[, ]+)?(?:let'?s |please |can you |could you |would you )?(?:refactor|rewrite|clean ?up|tidy|fix|explain|review|simplify|optimi[sz]e|rename|reformat|format|draft|write|summari[sz]e|translate|shorten|improve|undo|revert)\b.*\b(?:this|that|these|those|it|my|the last|the previous)\b/;
/** Acting on the work at hand: "commit and push please", "merge it". */
const ACT = /^(?:(?:ok|so|now)[, ]+)?(?:please )?(?:commit|push|merge|deploy|undo|revert)\b/;

export function isAck(prompt: string): boolean {
  const p = prompt.trim().toLowerCase();
  const words = p.match(/[a-z0-9']+/g) ?? [];
  const isShort = words.length <= 8 && !p.includes('?');
  return (
    CHAT.test(p) ||
    TASK.test(p) ||
    (ACT.test(p) && isShort) ||
    (isShort && (THANKS.test(p) || (ACK.test(p) && words.length <= 6)))
  );
}

/** The forms a word may take in the entries, itself first: releases, released → release. */
function forms(t: string): string[] {
  const out = [t];
  const cut = (suffix: string, add = '') => {
    if (t.length > suffix.length + 2 && t.endsWith(suffix))
      out.push(t.slice(0, -suffix.length) + add);
  };
  cut('ies', 'y');
  cut('es');
  cut('s');
  cut('ing');
  cut('ing', 'e');
  cut('ed');
  cut('ed', 'e');
  out.push(`${t}s`);
  return out;
}

/**
 * The terms a prompt is about: its words (how the answer is to look left out, `askedAbout`)
 * but the asking around them, those in so many entries they tell nothing, and those in none
 * (no entry can be about them: a long prompt's other words do not raise the share needed);
 * each in the form the entries use (`stemmed`).
 */
export function promptTerms(lexicon: Lexicon, prompt: string, namesEntry = false): string[] {
  if (isAck(prompt)) return [];
  const terms = new Set<string>();
  const unknown = new Set<string>();
  for (const t of tokenize(askedAbout(prompt))) {
    if (PROMPT_WORDS.has(t)) continue;
    // A bare number (17 times 23) is no word an entry is about: it counts as one the base
    // never saw, so a sum is no question for it. A version (odoo 19) beside words still is.
    if (/^\d+$/.test(t)) {
      unknown.add(t);
      continue;
    }
    // The first form the base knows is the word (odoo is not odoos), telling or not.
    const known = forms(t).find((f) => lexicon.knows(f));
    if (known === undefined) unknown.add(t);
    else if (lexicon.isTelling(known)) terms.add(known);
  }
  // More words the base never saw than words it knows: the prompt is about something else.
  // (A prompt that names an entry by its whole title is about the base, whatever else it says.)
  if (!namesEntry && unknown.size > terms.size) return [];
  return [...terms];
}

/**
 * The curated entries a prompt names by their whole title, two words or more ("about our
 * release ritual: quote…" names "Release ritual"): the title's words, in its order.
 */
function namedEntries(documents: Array<{ entry: KnowledgeEntry }>, prompt: string): Set<string> {
  const said = ` ${tokenize(prompt).join(' ')} `;
  const named = new Set<string>();
  for (const { entry } of documents) {
    if (entry.snapshot) continue;
    const title = tokenize(entry.title);
    if (title.length >= 2 && said.includes(` ${title.join(' ')} `)) named.add(entry.path);
  }
  return named;
}

/**
 * How many of a prompt's content terms a hit must hold: the one there is, both of two, a third
 * of more (two at least). One shared word of many is no match; a one-word question is.
 */
export const termsNeeded = (n: number) => (n <= 2 ? n : Math.max(2, Math.ceil(n / 3)));

/**
 * What a person's prompt asks about, without how the answer is to look: "one line", "no tools",
 * "do not call tools", "text only", "verbatim", "be brief" name nothing an entry is about, and
 * a hit on them is no match.
 */
export function askedAbout(prompt: string): string {
  return prompt
    .replace(
      /\b(?:in |on )?(?:one|a single|1) (?:line|sentence|word|paragraph)s?\b|\b(?:use )?no tools?\b|\b(?:do not|don't|dont) (?:call|use|run) (?:any )?tools?\b|\bwithout (?:using |calling )?(?:any )?tools?\b|\b(?:text|answer|reply|code) only\b|\bverbatim\b|\bbe (?:brief|concise|short)\b|\bbriefly\b/gi,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * An entry body as excerpt text: headings, fences, long code lines and table separator rows
 * dropped (a short code line kept), a paragraph's lines joined, each paragraph, list item and
 * code line one segment, the segments joined with ` · `.
 */
export function excerptText(raw: string): string {
  const body = withoutControls(raw);
  const parts: string[] = [];
  let cur = '';
  let isInFence = false;
  for (const raw of body.split(/\r?\n/)) {
    const isFence = /^\s{0,3}(```|~~~)/.test(raw);
    if (isFence) isInFence = !isInFence;
    // A short code line (a command, a setting) says what the entry is for: kept as a segment.
    // A long one, or the fence itself, is not text to read in a line.
    if (isInFence && !isFence) {
      if (cur) parts.push(cur);
      cur = '';
      if (raw.trim() && raw.trim().length <= 80) parts.push(raw.trim());
      continue;
    }
    const isSkip =
      isFence ||
      !raw.trim() ||
      /^\s{0,3}#{1,6}\s/.test(raw) ||
      /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(raw);
    const isRow = /^\s*\|/.test(raw);
    if (isSkip || isRow || /^\s*([-*+]|\d+\.)\s+/.test(raw)) {
      if (cur) parts.push(cur);
      cur = '';
    }
    if (isSkip) continue;
    // A table row reads as its cells: `| a | b |` is `a, b`.
    const line = isRow
      ? raw
          .split('|')
          .map((c) => c.trim())
          .filter(Boolean)
          .join(', ')
      : raw.replace(/^\s*(>|[-*+]|\d+\.)\s+/, '').trim();
    cur = cur ? `${cur} ${line}` : line;
  }
  if (cur) parts.push(cur);
  return parts.join(' · ');
}

/** After a write or delete: the next search compares the files again. */
export function invalidateKnowledgeIndexCache(): void {
  for (const idx of knowledgeIndexes.values()) idx.checkedAt = 0;
}

/** The `.md` files under `dir` (or its `category` folder), relative, with their stamps. */
function stampFiles(dir: string, category?: string): Map<string, string> {
  const stamps = new Map<string, string>();
  for (const rel of getAllFiles(category ? path.join(dir, category) : dir, category ?? '')) {
    try {
      const st = fs.statSync(path.join(dir, rel));
      stamps.set(rel, `${st.mtimeMs}:${st.size}`);
    } catch {
      /* gone between the listing and the stat */
    }
  }
  return stamps;
}

function indexFor(dir: string, category?: string): KnowledgeIndex {
  const key = `${dir}:${category ?? ''}`;
  let idx = knowledgeIndexes.get(key);
  if (!idx) {
    idx = {
      index: new BM25Index(),
      lexicon: new Lexicon(),
      docs: new Map(),
      stamps: new Map(),
      checkedAt: 0,
    };
    knowledgeIndexes.set(key, idx);
  }
  return idx;
}

/** Brings the index up to date with the files, one step per file read. */
function* refreshKnowledgeIndex(idx: KnowledgeIndex, dir: string, category?: string) {
  const startedAt = Date.now();
  const current = stampFiles(dir, category);
  for (const rel of [...idx.stamps.keys()]) {
    if (current.has(rel)) continue;
    idx.index.removeDocument(rel);
    idx.lexicon.remove(rel);
    idx.docs.delete(rel);
    idx.stamps.delete(rel);
  }
  for (const [rel, stamp] of current) {
    if (idx.stamps.get(rel) === stamp) continue;
    try {
      const { entry, content } = readEntry(dir, rel);
      idx.docs.set(rel, { entry: { ...entry, content }, content });
      idx.index.addDocument(rel, content);
      // A snapshot is what was said in a session; a curated entry, what the base knows.
      if (entry.snapshot) idx.lexicon.addSession(rel, content);
      else idx.lexicon.add(rel, `${entry.title} ${rel} ${entry.tags.join(' ')}`, content);
      idx.stamps.set(rel, stamp);
    } catch {
      idx.index.removeDocument(rel);
      idx.lexicon.remove(rel);
      idx.docs.delete(rel);
      idx.stamps.delete(rel);
    }
    yield;
  }
  idx.checkedAt = startedAt;
}

/** The update of an index running now, which a search that comes during it joins. */
const updating = new Map<KnowledgeIndex, Promise<void>>();

/**
 * Brings the index (of `category`, for a 'filter' search) up to date without holding the
 * process: the REST holder warms it as it starts, and a search awaits it before it runs, so a
 * search that comes during the warm-up waits for it instead of reading the rest at once.
 */
export function warmKnowledgeIndex(dir: string, category?: string): Promise<void> {
  const idx = indexFor(dir, category);
  const running = updating.get(idx);
  if (running) return running;
  if (Date.now() - idx.checkedAt < RECHECK_MS) return Promise.resolve();
  const update = runSliced(refreshKnowledgeIndex(idx, dir, category)).finally(() =>
    updating.delete(idx),
  );
  updating.set(idx, update);
  return update;
}

/** Every entry of the knowledge base, as the index holds them (no file read when unchanged). */
export function indexedEntries(dir: string): KnowledgeEntry[] {
  return getOrBuildKnowledgeIndex(dir).documents.map((d) => d.entry);
}

function getOrBuildKnowledgeIndex(
  dir: string,
  category?: string,
): {
  index: BM25Index;
  lexicon: Lexicon;
  documents: Array<{ entry: KnowledgeEntry; content: string }>;
} {
  const idx = indexFor(dir, category);
  if (Date.now() - idx.checkedAt >= RECHECK_MS) runAll(refreshKnowledgeIndex(idx, dir, category));
  return { index: idx.index, lexicon: idx.lexicon, documents: [...idx.docs.values()] };
}

/**
 * Search knowledge entries using TF-IDF ranking with regex fallback.
 *
 * Uses a TF-IDF index kept in step with the files (only what changed is
 * re-read) to avoid rebuilding the index on every search. Falls back to regex search
 * if TF-IDF returns no results (useful for exact phrase matches).
 *
 * Scoring:
 *   score = bm25 * decay(last_accessed) * maturity(level) * confidence * category_boost
 *
 * When `mmr` is true, the TF-IDF top-K is re-ranked with Maximal Marginal
 * Relevance on token-Jaccard similarity — see search/mmr.ts.
 */
export function searchKnowledge(
  dir: string,
  asked: string,
  options: SearchOptions = {},
): Array<SearchResult> {
  // A prompt is searched for what it asks about, not for how the answer is to look.
  const query = options.prompt ? askedAbout(asked) : asked;
  const {
    category,
    maxResults = 10,
    caseSensitive = false,
    categoryMode = 'boost',
    mmr = false,
    skipCategory,
    prompt = false,
    promptRule = PROMPT_RULE,
    similar,
    mmrLambda = DEFAULT_MMR_LAMBDA,
    explain = false,
  } = options;

  // In 'boost' mode, build the index over the full corpus (no category restriction).
  // In 'filter' mode, keep legacy behavior of restricting the index to one category.
  const indexCategory = categoryMode === 'boost' ? undefined : category;
  const { index, lexicon, documents } = getOrBuildKnowledgeIndex(dir, indexCategory);

  if (documents.length === 0) return [];

  // Fetch a wider candidate pool when MMR is enabled so diversification has
  // room to operate. Cap at 3× maxResults to avoid pathological long tails.
  const candidatePool = mmr ? Math.min(maxResults * 3, documents.length) : maxResults;

  // Search using TF-IDF
  // What is left out (a category, a hit sharing too few of the words) goes before the pool is
  // cut, so the pool stays full.
  // An entry the prompt names by its title is a hit whatever else the prompt says.
  const named = prompt ? namedEntries(documents, query) : new Set<string>();
  const terms = prompt ? promptTerms(lexicon, query, named.size > 0) : [];
  // A prompt of greetings and asking alone ("hi, can you help me today?") asks about nothing.
  if (prompt && terms.length === 0) return [];
  const needed = termsNeeded(terms.length);
  const weightOf = (ts: string[]) => ts.reduce((sum, t) => sum + lexicon.weight(t), 0);
  const total = weightOf(terms);
  // What the prompt says that entries are about; the generic rest (rename, page) names none.
  const specific = terms.filter((t) => !lexicon.isGeneric(t));
  // Mostly generic ("add a dark mode toggle to the settings page"): about the person's code.
  if (prompt && named.size === 0 && weightOf(specific) < total * promptRule.specific) return [];
  // An entry's category as the store tells it: a 2.x session dump under projects/ is `sessions`.
  const categoryOf = new Map(documents.map((d) => [d.entry.path, d.entry.category]));
  // Who the person is rides in the session's context block: no answer to a prompt.
  const isSkipped = (id: string) =>
    (skipCategory !== undefined && categoryOf.get(id) === skipCategory) ||
    (prompt && /^identity\.md$/i.test(id));
  const isKept = (id: string) => {
    if (isSkipped(id)) return false;
    if (!prompt || named.has(id)) return true;
    const held = terms.filter((t) => index.has(id, t));
    if (held.length < needed) return false;
    const names = weightOf(specific.filter((t) => lexicon.names(id, t))) / total;
    const holds = weightOf(held) / total;
    return names >= promptRule.named && holds >= promptRule.coverage;
  };
  const ranked = prompt || skipCategory ? index.search(prompt ? terms.join(' ') : query) : [];
  const tfidfResults =
    skipCategory || prompt
      ? // A prompt is ranked by its terms, in the form the entries use them.
        ranked.filter((r) => isKept(r.id)).slice(0, candidatePool)
      : index.search(query, candidatePool);
  // The entry closest to the prompt in meaning answers it, whatever words it shares.
  const closest =
    prompt && similar
      ? closestOf(similar, (id) => !isSkipped(id) && categoryOf.has(id))
      : undefined;
  if (closest && closest[1] >= promptRule.close && !tfidfResults.some((r) => r.id === closest[0]))
    tfidfResults.push({
      id: closest[0],
      score: ranked.find((r) => r.id === closest[0])?.score ?? 0,
    });
  const meant = closest && closest[1] >= promptRule.close ? closest[0] : undefined;

  if (tfidfResults.length > 0) {
    const results: SearchResult[] = [];
    const scoring = getEntryScoring();
    const entryPaths = tfidfResults
      .map((r) => documents.find((d) => d.entry.path === r.id)?.entry.path)
      .filter((p): p is string => p !== undefined);
    const scores = scoring.getScores(entryPaths);

    for (const result of tfidfResults) {
      const doc = documents.find((d) => d.entry.path === result.id);
      if (!doc) continue;

      const scoreInfo = scores.get(doc.entry.path);
      const maturity = (scoreInfo?.maturity ?? 'candidate') as
        | 'candidate'
        | 'established'
        | 'proven';
      const lastAccessed = scoreInfo?.last_accessed ?? null;
      const confidence = doc.entry.confidence;
      const evergreen = doc.entry.evergreen === true;
      let finalScore = computeFinalScore(
        result.score,
        lastAccessed,
        maturity,
        confidence,
        evergreen,
      );

      // Category boost: in 'boost' mode, give matching-category entries an
      // edge instead of dropping non-matching entries.
      let categoryBoost = 1;
      if (categoryMode === 'boost' && category && doc.entry.category === category) {
        categoryBoost = CATEGORY_BOOST_MULTIPLIER;
        finalScore *= categoryBoost;
      }

      const components: ScoreComponents | undefined = explain
        ? {
            bm25: result.score,
            decay: evergreen ? 1 : lastAccessed ? decayFactor(lastAccessed) : 1,
            maturity: maturityMultiplier(maturity),
            confidence: confidence === 'inferred' ? 0.85 : 1,
            category_boost: categoryBoost,
            mmr_penalty: 1, // updated below if MMR runs
          }
        : undefined;

      // v1.8.1: automatic freshness metadata per hit — surface the trust
      // signals the agent needs to judge whether this entry is still current,
      // without requiring any agent-proactive call. Cheap: scoring row is
      // already loaded above; body mtime is a single fs.statSync. We tolerate
      // stat errors gracefully and emit `null` age.
      let bodyAgeDays: number | null = null;
      try {
        const full = path.join(dir, doc.entry.path);
        const stat = fs.statSync(full);
        bodyAgeDays = Math.round(((Date.now() - stat.mtimeMs) / (24 * 3600_000)) * 10) / 10;
      } catch {
        /* ignore — file may have been moved */
      }
      const verifiedAt = scoreInfo?.verified_at ?? null;
      const freshness = {
        body_age_days: bodyAgeDays,
        last_accessed: lastAccessed,
        access_count: scoreInfo?.access_count ?? 0,
        verified_at: verifiedAt,
        verification_age_days: verifiedAt
          ? Math.round(((Date.now() - new Date(verifiedAt).getTime()) / (24 * 3600_000)) * 10) / 10
          : null,
        evergreen,
      };

      const res: SearchResult = {
        entry: doc.entry,
        score: finalScore,
        excerpt: buildExcerpt(excerptText(parseFrontmatter(doc.content).body), query, {
          caseSensitive,
          contextAfter: 200,
        }),
        freshness,
      };
      if (components) res.score_components = components;
      results.push(res);
    }

    // Filter out negative scores and sort by final score (the one closest in meaning may share
    // no word: it stays).
    const filtered = results.filter((r) => r.score > 0 || r.entry.path === meant);
    filtered.sort((a, b) => b.score - a.score);

    // Optional MMR re-ranking — diversifies the top-K at a small relevance cost.
    if (mmr && filtered.length > 1) {
      const reranked = rerankMMR(filtered, {
        k: maxResults,
        lambda: mmrLambda,
        relevance: (r) => r.score,
        sim: (a, b) =>
          jaccardTokenSim(a.entry.content ?? a.excerpt ?? '', b.entry.content ?? b.excerpt ?? ''),
      });
      if (explain) {
        // Track where each item came from for the mmr_penalty component.
        // Items picked first get penalty=1 (no penalty); later picks get
        // a smaller value reflecting diversity cost.
        const originalRank = new Map(filtered.map((r, idx) => [r.entry.path, idx + 1]));
        reranked.forEach((r, newIdx) => {
          const orig = originalRank.get(r.entry.path) ?? newIdx + 1;
          if (r.score_components) {
            r.score_components.mmr_penalty = newIdx === 0 ? 1 : Math.min(1, orig / (newIdx + 1));
          }
        });
      }
      return prompt ? answering(reranked, promptRule, maxResults, meant) : reranked;
    }

    return prompt
      ? answering(filtered, promptRule, maxResults, meant)
      : filtered.slice(0, maxResults);
  }

  // A prompt is answered by its terms or not at all: no phrase search over it.
  if (prompt) return [];

  // Fallback: regex search for exact phrase matches
  const flags = caseSensitive ? 'g' : 'gi';
  let regex: RegExp;
  try {
    regex = new RegExp(query, flags);
  } catch {
    regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  }

  const regexResults: SearchResult[] = [];
  for (const doc of documents) {
    if (!isKept(doc.entry.path)) continue;
    regex.lastIndex = 0; // Reset before test() — global regex is stateful
    if (regex.test(doc.content)) {
      regexResults.push({
        entry: doc.entry,
        score: 1,
        excerpt: buildExcerpt(excerptText(parseFrontmatter(doc.content).body), query, {
          caseSensitive,
          contextAfter: 200,
        }),
      });
      if (regexResults.length >= maxResults) break;
    }
  }

  return regexResults;
}

/**
 * The hits that answer a prompt: what the words found near the best, in the ranking's order,
 * and the entry closest in meaning (`meant`); `hits` at most.
 */
function answering(
  hits: SearchResult[],
  rule: PromptRule,
  max: number,
  meant?: string,
): SearchResult[] {
  const found = hits.filter((h) => h.entry.path !== meant);
  const top = found[0]?.score ?? 0;
  const near = found.filter((h) => h.score >= top * rule.nearTop);
  const close = hits.find((h) => h.entry.path === meant);
  const all = close ? [close, ...near] : near;
  return all.slice(0, Math.min(rule.hits, max));
}

/** The entry of `similar` closest to the prompt among those `isOne`, with its cosine. */
function closestOf(
  similar: ReadonlyMap<string, number>,
  isOne: (id: string) => boolean,
): [string, number] | undefined {
  let best: [string, number] | undefined;
  for (const [id, cos] of similar) if (isOne(id) && (!best || cos > best[1])) best = [id, cos];
  return best;
}

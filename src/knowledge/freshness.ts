/**
 * Automatic staleness detector driven by code activity in session summaries.
 *
 * The Telegram-level pain point that inspired this feature: "new entries go
 * in fine, but old entries don't update themselves — on fast-moving projects
 * my knowledge system ends up working AGAINST me."
 *
 * v1.8.1 answer (fully automatic, no agent action required):
 *   1. For each knowledge entry, extract the file paths it mentions in its
 *      body (reuses the same FILE_PATH_RE pattern used for session summary
 *      extraction so we stay consistent).
 *   2. For each recent session (default: last 30d), the existing
 *      `getSessionSummary` gives us `filesModified` — paths touched during
 *      that session's tool_result output.
 *   3. If entry X mentions `src/auth.ts` AND recent sessions modified
 *      `src/auth.ts` AFTER the entry's body was last edited, X is a
 *      staleness candidate. Surface via `knowledge_analyze(action:
 *      "stale_by_code_activity")`.
 *
 * The signal is inherently noisy — a file being edited doesn't prove the
 * entry's CLAIM about it is now wrong. But it's the strongest automatic
 * signal we can derive without regex-scanning full transcripts (a tarpit
 * ruled out during design review) or requiring an LLM judge.
 *
 * Entries with `evergreen: true` are exempt — the whole point of evergreen
 * is "this doesn't decay even when the surrounding code churns".
 */

import fs from 'fs';
import path from 'path';
import { listEntries, readEntry } from './store.js';
import { listSessions, getSessionSummary } from '../sessions/summary.js';
import { getConfig } from '../types.js';

// ── Extract file paths from entry body ──────────────────────────────────────

// Same pattern used for session summaries (sessions/summary.ts). Keep them
// aligned — matching behaviour means an entry's mentions and a session's
// touches are comparable.
const FILE_PATH_RE =
  /(?:^|[\s"'`(])([./~]?(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|vue|svelte|css|scss|html|json|yaml|yml|toml|md|txt|sh|sql|prisma|graphql|proto))\b/g;

function extractFilePathsFromBody(text: string): string[] {
  const paths = new Set<string>();
  FILE_PATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FILE_PATH_RE.exec(text)) !== null) {
    // Normalise leading './' and '~/' so an entry written as `./src/x.ts`
    // matches a session's `src/x.ts`.
    let p = match[1];
    if (p.startsWith('./')) p = p.slice(2);
    if (p.startsWith('~/')) p = p.slice(2);
    paths.add(p);
  }
  return Array.from(paths);
}

// ── Symbol extraction for precision layer ──────────────────────────────────
//
// File-activity alone is a noisy signal: every formatting / rename / import
// touch flags entries that still describe the file correctly. We tighten
// precision by extracting SYMBOLS the entry names (identifiers inside inline
// backticks and inside fenced code blocks) and checking whether those names
// still appear literally in the touched file. If all named symbols are still
// present, the entry's concrete claims probably still hold and we downweight
// the signal even if the file was edited; if named symbols are missing, that
// is real drift and we keep full confidence.
//
// Kept intentionally cheap (no tree-sitter): regex + substring on the file
// content. Good enough to cut a large share of false positives at zero new
// native dependencies. Tree-sitter-backed version is a candidate for v1.9.

const INLINE_CODE_RE = /`([^`\n]{2,80})`/g;
const FENCED_BLOCK_RE = /```[\s\S]*?```/g;
const IDENT_IN_FENCE_RE = /\b([A-Za-z_][A-Za-z0-9_]{2,})\b/g;
const IDENT_STRICT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Extract identifier-shaped tokens the entry uses. Only backticked items
 * (inline or inside fenced blocks) qualify — prose camelCase is too noisy.
 * Strips URLs, file paths, and punctuation-bearing strings.
 */
function extractSymbols(text: string): string[] {
  const symbols = new Set<string>();

  // Inline backticks: `someFunction`, `Foo.bar`, `SOME_CONST`.
  INLINE_CODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_CODE_RE.exec(text)) !== null) {
    const raw = m[1].trim();
    // Reject: paths, URLs, spaces, multi-word prose in backticks.
    if (/[\s/\\]/.test(raw)) continue;
    // Dotted identifier like `Foo.bar` — take the last segment (what grep will match).
    const last = raw.split('.').pop() || raw;
    if (IDENT_STRICT_RE.test(last) && last.length >= 3) symbols.add(last);
  }

  // Fenced blocks: pull identifiers from the contents, skipping the
  // language hint and obvious prose.
  FENCED_BLOCK_RE.lastIndex = 0;
  while ((m = FENCED_BLOCK_RE.exec(text)) !== null) {
    const block = m[0];
    IDENT_IN_FENCE_RE.lastIndex = 0;
    let im: RegExpExecArray | null;
    while ((im = IDENT_IN_FENCE_RE.exec(block)) !== null) {
      const tok = im[1];
      // Skip language labels + SQL-ish keywords + common filler; let
      // anything ≥4 chars and not all-lowercase-short-word through.
      if (tok.length < 4) continue;
      if (/^(the|and|for|this|that|with|from|into|when|else|true|false|null|undefined)$/i.test(tok))
        continue;
      symbols.add(tok);
    }
  }

  return Array.from(symbols);
}

// ── Public types ────────────────────────────────────────────────────────────

export interface StalenessSignal {
  /** Knowledge entry path (relative to memoryDir). */
  entry: string;
  /** Entry title (best-effort from frontmatter). */
  title: string;
  /** File paths the entry mentions that have been modified in recent sessions. */
  touched_files: string[];
  /** Distinct session IDs whose tool output touched one of `touched_files`. */
  touching_sessions: Array<{
    session_id: string;
    project: string;
    start_time: string;
    files: string[];
  }>;
  /** Days since the entry's body file was last modified on disk. */
  body_age_days: number;
  /**
   * Days between the entry's body last-modified time and the EARLIEST
   * touching session. A large positive number means the entry body hasn't
   * been updated to reflect later code activity.
   */
  lag_days: number;
  /**
   * Heuristic confidence 0–1. Scales with number of touching sessions and
   * the lag, saturates at 5+ sessions and 60+ days. Multiplied by the
   * symbol-evidence factor (see `symbol_evidence`) to downweight cases
   * where the entry's named identifiers still appear in the touched file.
   */
  confidence: number;
  /**
   * Precision-layer evidence explaining the final confidence.
   *  - `not_applicable`: entry quoted no identifiers we could verify.
   *  - `all_present`: every named symbol still appears in the touched files
   *    (confidence × 0.3 — entry's specific claims likely still hold).
   *  - `partial`: some named symbols missing (confidence scaled by missing ratio).
   *  - `all_missing`: no named symbols found in touched files (full confidence).
   */
  symbol_evidence: 'not_applicable' | 'all_present' | 'partial' | 'all_missing';
  /** Named identifiers the entry quotes (in backticks or fenced blocks). */
  symbols_checked: string[];
  /** Subset of `symbols_checked` NOT found in any touched file (candidate drift). */
  symbols_missing: string[];
}

export interface FreshnessOptions {
  /** Only consider sessions that started within this many days. Default 30. */
  sinceDays?: number;
  /** Minimum number of touching sessions before an entry qualifies. Default 1. */
  minTouchingSessions?: number;
  /** Maximum entries to scan (cost bound). Default 500. */
  maxEntries?: number;
  /** Category filter (e.g. only "decisions"). Default: all. */
  category?: string;
  /**
   * Dependency-injection hook for tests. When provided, skips `listSessions`
   * + `getSessionSummary` and reads from the caller-supplied array. Each
   * entry is `{session_id, project, start_time, filesModified[]}`.
   */
  sessionSource?: Array<{
    session_id: string;
    project: string;
    start_time: string;
    filesModified: string[];
  }>;
}

// ── Main detector ──────────────────────────────────────────────────────────

/**
 * Scan knowledge entries for code-activity-driven staleness signals.
 *
 * Cost bound: `maxEntries` × `recentSessionCount`. On a 100-entry KB with 50
 * recent sessions the work is ~5000 set intersections, tolerable.
 */
export function staleByCodeActivity(options: FreshnessOptions = {}): StalenessSignal[] {
  const sinceDays = options.sinceDays ?? 30;
  const minTouchingSessions = options.minTouchingSessions ?? 1;
  const maxEntries = options.maxEntries ?? 500;
  const category = options.category;

  const config = getConfig();
  const cutoffMs = Date.now() - sinceDays * 24 * 3600_000;

  // 1. Gather entries + their mtimes + their mentioned file paths.
  const entries = listEntries(config.memoryDir, category).slice(0, maxEntries);
  interface EntryBundle {
    path: string;
    title: string;
    evergreen: boolean;
    mtimeMs: number;
    filesMentioned: Set<string>;
    symbols: string[];
  }
  const bundles: EntryBundle[] = [];
  for (const entry of entries) {
    if (entry.evergreen) continue; // explicit exemption
    try {
      const full = path.join(config.memoryDir, entry.path);
      const stat = fs.statSync(full);
      const { content } = readEntry(config.memoryDir, entry.path);
      const filesMentioned = new Set(extractFilePathsFromBody(content));
      if (filesMentioned.size === 0) continue; // entries without code refs can't be stale via this signal
      bundles.push({
        path: entry.path,
        title: entry.title || entry.path,
        evergreen: Boolean(entry.evergreen),
        mtimeMs: stat.mtimeMs,
        filesMentioned,
        symbols: extractSymbols(content),
      });
    } catch {
      // Skip unreadable entries; they're a separate class of problem.
      continue;
    }
  }
  if (bundles.length === 0) return [];

  // 2. Collect recent session summaries (start ≥ cutoff) together with their
  //    `filesModified` lists. Honour the `sessionSource` injection when
  //    present so tests don't need to mock ESM module bindings.
  interface RecentSession {
    session_id: string;
    project: string;
    start_time: string;
    startMs: number;
    filesModified: Set<string>;
  }
  const recent: RecentSession[] = [];
  const normalisePath = (raw: string): string => {
    let p = raw;
    if (p.startsWith('./')) p = p.slice(2);
    if (p.startsWith('~/')) p = p.slice(2);
    return p;
  };

  if (options.sessionSource) {
    for (const s of options.sessionSource) {
      const startMs = new Date(s.start_time).getTime();
      if (!Number.isFinite(startMs) || startMs < cutoffMs) continue;
      if (s.filesModified.length === 0) continue;
      const normalised = new Set<string>();
      for (const raw of s.filesModified) normalised.add(normalisePath(raw));
      recent.push({
        session_id: s.session_id,
        project: s.project,
        start_time: s.start_time,
        startMs,
        filesModified: normalised,
      });
    }
  } else {
    const sessions = listSessions();
    for (const sess of sessions) {
      if (sess.startTime === 'unknown') continue;
      const startMs = new Date(sess.startTime).getTime();
      if (!Number.isFinite(startMs) || startMs < cutoffMs) continue;
      const summary = getSessionSummary(sess.sessionId, sess.project);
      if (!summary || summary.filesModified.length === 0) continue;
      const normalised = new Set<string>();
      for (const raw of summary.filesModified) normalised.add(normalisePath(raw));
      recent.push({
        session_id: sess.sessionId,
        project: sess.project,
        start_time: sess.startTime,
        startMs,
        filesModified: normalised,
      });
    }
  }
  if (recent.length === 0) return [];

  // 3. Join — for each entry, find sessions whose modified files intersect
  //    the entry's mentions AND whose start is AFTER the entry body's mtime.
  const signals: StalenessSignal[] = [];
  const nowMs = Date.now();
  for (const bundle of bundles) {
    const touchingFiles = new Set<string>();
    const touchingSessions: StalenessSignal['touching_sessions'] = [];
    let earliestTouchMs = Number.POSITIVE_INFINITY;
    for (const sess of recent) {
      if (sess.startMs <= bundle.mtimeMs) continue;
      const overlap: string[] = [];
      for (const f of sess.filesModified) {
        if (bundle.filesMentioned.has(f)) overlap.push(f);
      }
      if (overlap.length === 0) continue;
      for (const f of overlap) touchingFiles.add(f);
      touchingSessions.push({
        session_id: sess.session_id,
        project: sess.project,
        start_time: sess.start_time,
        files: overlap,
      });
      if (sess.startMs < earliestTouchMs) earliestTouchMs = sess.startMs;
    }
    if (touchingSessions.length < minTouchingSessions) continue;

    const bodyAgeDays = Math.max(0, (nowMs - bundle.mtimeMs) / (24 * 3600_000));
    const lagDays = Number.isFinite(earliestTouchMs)
      ? Math.max(0, (earliestTouchMs - bundle.mtimeMs) / (24 * 3600_000))
      : 0;
    // Baseline confidence from volume + lag: saturate at 5 sessions / 60d.
    const sessionFactor = Math.min(1, touchingSessions.length / 5);
    const lagFactor = Math.min(1, lagDays / 60);
    let confidence = sessionFactor * lagFactor;

    // Precision layer: check whether symbols the entry NAMES still appear
    // in the touched files. Entries that name e.g. `recordAccess` get
    // downweighted when that identifier still lives in the current source
    // — the file was edited but the claim survived.
    let symbolEvidence: StalenessSignal['symbol_evidence'] = 'not_applicable';
    let symbolsMissing: string[] = [];
    if (bundle.symbols.length > 0) {
      let combined = '';
      for (const file of touchingFiles) {
        try {
          combined += '\n' + fs.readFileSync(path.resolve(file), 'utf-8');
        } catch {
          // File may live outside the knowledge cwd or be gone — that's a
          // strong staleness signal on its own, but the existing file-
          // activity path already surfaced it. Don't also credit symbols.
        }
      }
      if (combined.length > 0) {
        const missing = bundle.symbols.filter((s) => !combined.includes(s));
        const missingRatio = missing.length / bundle.symbols.length;
        if (missingRatio === 0) {
          // Every named identifier still present → entry's concrete claims
          // likely intact; strongly downweight.
          confidence *= 0.3;
          symbolEvidence = 'all_present';
        } else if (missingRatio === 1) {
          symbolEvidence = 'all_missing';
        } else {
          // Scale linearly: half missing → keep half-weight.
          confidence *= 0.3 + 0.7 * missingRatio;
          symbolEvidence = 'partial';
        }
        symbolsMissing = missing;
      }
    }

    signals.push({
      entry: bundle.path,
      title: bundle.title,
      touched_files: Array.from(touchingFiles).sort(),
      touching_sessions: touchingSessions.sort((a, b) => a.start_time.localeCompare(b.start_time)),
      body_age_days: Math.round(bodyAgeDays * 10) / 10,
      lag_days: Math.round(lagDays * 10) / 10,
      confidence: Math.round(confidence * 100) / 100,
      symbol_evidence: symbolEvidence,
      symbols_checked: bundle.symbols,
      symbols_missing: symbolsMissing,
    });
  }

  // Sort highest-confidence first — that's the "probably stale, look here"
  // queue ordering the agent or dashboard should honour.
  signals.sort((a, b) => b.confidence - a.confidence);
  return signals;
}

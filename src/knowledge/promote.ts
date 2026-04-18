/**
 * Scored-and-gated promotion pass.
 *
 * Replaces the regex-only auto-distillation with a scored candidate pipeline.
 * Each project-level insight (extracted by existing distill.ts machinery) is
 * scored on six weighted signals and held against three independent gates.
 * Only candidates that clear ALL gates are promoted to durable knowledge
 * entries.
 *
 * Signal weights (v1.8 starting point — tune against the self-labeled write
 * bench, not by intuition):
 *   Relevance            0.30
 *   Frequency            0.24
 *   Query diversity      0.15
 *   Recency              0.15
 *   Consolidation        0.10
 *   Conceptual richness  0.06
 *
 * Gates (default thresholds; overridable per call):
 *   minScore            ≥ 0.5
 *   minRecallCount      ≥ 2  (number of source sessions)
 *   minUniqueQueries    ≥ 2  (number of distinct topic fingerprints)
 *
 * Grounded rehydration: before promoting, every source session file is
 * checked to still exist on disk. Missing sources ⇒ skip + diary entry.
 * Prevents promoting content the user has since deleted.
 *
 * Evergreen exemption: entries with `evergreen: true` frontmatter are never
 * OVERWRITTEN by promotion — the merger appends a fresh Recent-Activity
 * block below the existing content instead of replacing it.
 *
 * Diary: every run writes `~/agent-knowledge/.dreams/YYYY-MM-DD.md` with per-
 * candidate score breakdown and gate outcomes. The `.`-prefixed directory is
 * git-tracked (audit trail) but excluded from listEntries/search (not part
 * of the retrievable corpus).
 */

import fs from 'fs';
import path from 'path';
import {
  getProjectDirs,
  getSessionFiles,
  parseSessionFile,
  getSessionMeta,
} from '../sessions/parser.js';
import { getSessionSummary } from '../sessions/summary.js';
import { listEntries, readEntry, writeEntry, parseFrontmatter } from './store.js';
import { gitPull, gitPush } from './git.js';
import { getConfig } from '../types.js';
import { scrubContent, normalizeProjectName } from './distill.js';
import { getEntryScoring } from './scoring.js';

// ── Signal weights ──────────────────────────────────────────────────────────

export const SIGNAL_WEIGHTS = {
  relevance: 0.3,
  frequency: 0.24,
  queryDiversity: 0.15,
  recency: 0.15,
  consolidation: 0.1,
  conceptualRichness: 0.06,
} as const;

export const DEFAULT_GATES = {
  minScore: 0.5,
  minRecallCount: 2,
  minUniqueQueries: 2,
} as const;

// ── Types ────────────────────────────────────────────────────────────────────

export interface SignalBreakdown {
  relevance: number;
  frequency: number;
  queryDiversity: number;
  recency: number;
  consolidation: number;
  conceptualRichness: number;
}

export interface GateResult {
  value: number;
  threshold: number;
  passed: boolean;
}

export interface GateOutcomes {
  minScore: GateResult;
  minRecallCount: GateResult;
  minUniqueQueries: GateResult;
}

export interface PromoteCandidate {
  /** Normalized project name — the candidate's durable identity. */
  id: string;
  /** A short human-readable signature for display. */
  label: string;
  /** Source session IDs that contributed to this candidate. */
  sessionIds: string[];
  /** ISO timestamp of the earliest source session. */
  firstSeen: string;
  /** ISO timestamp of the latest source session. */
  lastSeen: string;
  signals: SignalBreakdown;
  /** Weighted composite score in [0, 1]. */
  score: number;
  gates: GateOutcomes;
  passed: boolean;
  /** Populated when `mode === 'apply'` and promotion succeeded. */
  promotedPath?: string;
  /** Populated when the candidate was skipped — reason string. */
  skipReason?: string;
}

export interface PromoteOptions {
  /** "explain" scores candidates but never writes; "apply" writes those that pass. Default: "explain". */
  mode?: 'apply' | 'explain';
  /** Gate threshold overrides. */
  minScore?: number;
  minRecallCount?: number;
  minUniqueQueries?: number;
  /** Write the diary markdown to ~/agent-knowledge/.dreams/. Default: true. */
  writeDiary?: boolean;
  /**
   * Consider sessions starting on/after this cutoff only. Useful for
   * replay benches; omit for "since last run".
   */
  sinceIso?: string | null;
  /**
   * When true, read cursor state but do NOT advance it on success. Keeps
   * replays idempotent. Default: mode === 'apply' advances, 'explain' does not.
   */
  advanceCursor?: boolean;
}

export interface PromoteResult {
  runStartedAt: string;
  runFinishedAt: string;
  mode: 'apply' | 'explain';
  candidates: PromoteCandidate[];
  promotedPaths: string[];
  skippedIds: string[];
  diaryPath: string | null;
  totals: {
    candidates: number;
    passed: number;
    promoted: number;
    skipped: number;
  };
}

// ── Cursor (tracks "since when" — reused across runs) ───────────────────────

function cursorPath(): string {
  return path.join(getConfig().dataDir, '.knowledge-promote-cursor');
}

function readCursor(): string | null {
  const p = cursorPath();
  if (!fs.existsSync(p)) return null;
  try {
    return fs.readFileSync(p, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

function writeCursor(iso: string): void {
  try {
    fs.mkdirSync(path.dirname(cursorPath()), { recursive: true });
    fs.writeFileSync(cursorPath(), iso, 'utf-8');
  } catch (err) {
    console.error('[promote] failed to write cursor:', err instanceof Error ? err.message : err);
  }
}

// ── Candidate extraction ────────────────────────────────────────────────────

export interface RawAggregate {
  id: string;
  sessionIds: string[];
  topics: string[];
  topicFingerprints: Set<string>;
  tools: Set<string>;
  files: Set<string>;
  errorPatterns: Set<string>;
  gitCommits: Set<string>;
  firstSeen: string;
  lastSeen: string;
  latestSessionFile: string | null;
}

/**
 * Lowercase + first-3-content-words fingerprint. Used to count unique
 * "queries" (topic openers) that surface the same content.
 */
function fingerprint(topic: string): string {
  const words = topic
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 3);
  return words.join(' ');
}

function aggregateSessions(sinceIso: string | null): Map<string, RawAggregate> {
  const projects = getProjectDirs();
  const agg = new Map<string, RawAggregate>();

  for (const proj of projects) {
    const sessions = getSessionFiles(proj.path);
    for (const sess of sessions) {
      try {
        const entries = parseSessionFile(sess.file);
        if (entries.length === 0) continue;
        const meta = getSessionMeta(entries);
        if (meta.startTime === 'unknown') continue;
        if (sinceIso && meta.startTime <= sinceIso) continue;

        const summary = getSessionSummary(sess.id, proj.name);
        if (!summary) continue;

        const humanTopics = summary.topics
          .map((t) => scrubContent(t.content))
          .filter((t) => t.length > 15 && t.length < 500);
        if (humanTopics.length === 0 && summary.toolsUsed.length === 0) continue;

        const id = normalizeProjectName(proj.name);
        let a = agg.get(id);
        if (!a) {
          a = {
            id,
            sessionIds: [],
            topics: [],
            topicFingerprints: new Set<string>(),
            tools: new Set<string>(),
            files: new Set<string>(),
            errorPatterns: new Set<string>(),
            gitCommits: new Set<string>(),
            firstSeen: meta.startTime,
            lastSeen: meta.startTime,
            latestSessionFile: sess.file,
          };
          agg.set(id, a);
        }

        a.sessionIds.push(sess.id);
        a.topics.push(...humanTopics.slice(0, 5));
        for (const t of humanTopics) a.topicFingerprints.add(fingerprint(t));
        for (const t of summary.toolsUsed) a.tools.add(t);
        for (const f of summary.filesModified) a.files.add(f);
        for (const e of summary.errorPatterns ?? []) a.errorPatterns.add(e);
        for (const c of summary.gitCommits ?? []) a.gitCommits.add(c);
        if (meta.startTime < a.firstSeen) a.firstSeen = meta.startTime;
        if (meta.startTime > a.lastSeen) {
          a.lastSeen = meta.startTime;
          a.latestSessionFile = sess.file;
        }
      } catch (err) {
        console.error(
          '[promote] session aggregate failed:',
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  return agg;
}

// ── Signal scoring ──────────────────────────────────────────────────────────

const CODE_FENCE_RE = /```/;
const DECISION_RE =
  /\b(decided|chose|chosen|because|rationale|trade.?off|alternative|going\s+with)\b/i;
const FILE_REF_RE =
  /(?:\/|\\)[\w.-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|vue|svelte|md|json|yaml|yml)\b/;

export function computeSignals(a: RawAggregate, now: number): SignalBreakdown {
  const sessions = a.sessionIds.length;

  // Relevance: proxy via topic-to-tool ratio — candidates with real content
  // relative to tool noise score higher. Normalized by sigmoid-ish cap.
  const toolWeight = Math.max(1, a.tools.size);
  const relevanceRaw = a.topics.length / (a.topics.length + toolWeight);
  const relevance = Math.max(0, Math.min(1, relevanceRaw * 1.5));

  // Frequency: saturates at 5+ contributing sessions.
  const frequency = Math.min(1, sessions / 5);

  // Query diversity: distinct topic-opener fingerprints, saturates at 5+.
  const queryDiversity = Math.min(1, a.topicFingerprints.size / 5);

  // Recency: exponential decay with ~30-day characteristic length.
  const lastMs = new Date(a.lastSeen).getTime();
  const daysAgo = isNaN(lastMs) ? 999 : Math.max(0, (now - lastMs) / (24 * 3600_000));
  const recency = Math.exp(-daysAgo / 30);

  // Consolidation: richness of extracted metadata — files + tools + commits
  // + errors. 20+ distinct items ⇒ max. Noisy single-shot sessions score low.
  const metadataCount = a.files.size + a.tools.size + a.gitCommits.size + a.errorPatterns.size;
  const consolidation = Math.min(1, metadataCount / 20);

  // Conceptual richness: does the topic content look like durable knowledge?
  // Heuristics: code blocks, decision phrases, file references.
  let richScore = 0;
  let richChecks = 0;
  for (const topic of a.topics.slice(0, 10)) {
    richChecks++;
    let hits = 0;
    if (CODE_FENCE_RE.test(topic)) hits++;
    if (DECISION_RE.test(topic)) hits++;
    if (FILE_REF_RE.test(topic)) hits++;
    richScore += Math.min(1, hits / 2); // 2+ hits in a single topic = max
  }
  const conceptualRichness = richChecks === 0 ? 0 : richScore / richChecks;

  return { relevance, frequency, queryDiversity, recency, consolidation, conceptualRichness };
}

export function compositeScore(s: SignalBreakdown): number {
  return (
    SIGNAL_WEIGHTS.relevance * s.relevance +
    SIGNAL_WEIGHTS.frequency * s.frequency +
    SIGNAL_WEIGHTS.queryDiversity * s.queryDiversity +
    SIGNAL_WEIGHTS.recency * s.recency +
    SIGNAL_WEIGHTS.consolidation * s.consolidation +
    SIGNAL_WEIGHTS.conceptualRichness * s.conceptualRichness
  );
}

export function evaluateGates(
  agg: RawAggregate,
  score: number,
  thresholds: { minScore: number; minRecallCount: number; minUniqueQueries: number },
): GateOutcomes {
  const minScore = {
    value: score,
    threshold: thresholds.minScore,
    passed: score >= thresholds.minScore,
  };
  const minRecallCount = {
    value: agg.sessionIds.length,
    threshold: thresholds.minRecallCount,
    passed: agg.sessionIds.length >= thresholds.minRecallCount,
  };
  const minUniqueQueries = {
    value: agg.topicFingerprints.size,
    threshold: thresholds.minUniqueQueries,
    passed: agg.topicFingerprints.size >= thresholds.minUniqueQueries,
  };
  return { minScore, minRecallCount, minUniqueQueries };
}

// ── Promotion ──────────────────────────────────────────────────────────────

function buildPromotionBody(agg: RawAggregate): string {
  const latest = agg.lastSeen.split('T')[0];
  const lines: string[] = [];
  lines.push('## Recent Activity');
  lines.push('');
  lines.push(
    `_Promoted from ${agg.sessionIds.length} session(s) — latest ${latest}. Gates: score, recall, unique-queries — all passed._`,
  );
  lines.push('');

  if (agg.topics.length > 0) {
    lines.push('### Topics Discussed');
    const unique = [...new Set(agg.topics)].slice(0, 15);
    for (const topic of unique) {
      const short = topic.length > 150 ? topic.slice(0, 150) + '...' : topic;
      const safe = scrubContent(short);
      if (safe.length > 10) lines.push(`- ${safe}`);
    }
    lines.push('');
  }

  if (agg.tools.size > 0) {
    lines.push('### Tools Used');
    lines.push([...agg.tools].sort().join(', '));
    lines.push('');
  }

  if (agg.files.size > 0) {
    lines.push('### Files Touched');
    const fileList = [...agg.files].sort().slice(0, 30);
    for (const f of fileList) lines.push(`- \`${f}\``);
    if (agg.files.size > 30) lines.push(`- _...and ${agg.files.size - 30} more_`);
    lines.push('');
  }

  if (agg.gitCommits.size > 0) {
    lines.push('### Commits');
    const commits = [...agg.gitCommits].slice(0, 10);
    lines.push(commits.map((c) => `\`${c}\``).join(', '));
    lines.push('');
  }

  if (agg.errorPatterns.size > 0) {
    lines.push('### Errors Encountered');
    const errors = [...agg.errorPatterns].slice(0, 5);
    for (const e of errors) {
      const safe = scrubContent(e);
      if (safe.length > 10) lines.push(`- ${safe}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function mergeIntoExisting(existingContent: string, activity: string): string {
  const marker = '## Recent Activity';
  const idx = existingContent.indexOf(marker);
  if (idx >= 0) {
    const nextH2 = existingContent.indexOf('\n## ', idx + marker.length);
    if (nextH2 >= 0) {
      return existingContent.slice(0, idx) + activity + existingContent.slice(nextH2);
    }
    return existingContent.slice(0, idx) + activity;
  }
  return existingContent.trimEnd() + '\n\n' + activity;
}

/**
 * Grounded rehydration check: source session file must still exist.
 */
function sourceStillExists(agg: RawAggregate): boolean {
  if (!agg.latestSessionFile) return false;
  // Virtual adapter paths (opencode://…) skip the FS check.
  if (!/^[a-zA-Z]+:\/\//.test(agg.latestSessionFile)) {
    if (!fs.existsSync(agg.latestSessionFile)) return false;
  }
  return true;
}

/**
 * Parse the evergreen frontmatter flag. Evergreen entries are never
 * overwritten by promotion — the activity section is appended instead.
 */
function isEvergreen(memoryDir: string, entryPath: string): boolean {
  try {
    const full = path.join(memoryDir, entryPath);
    if (!fs.existsSync(full)) return false;
    const raw = fs.readFileSync(full, 'utf-8');
    const { meta } = parseFrontmatter(raw);
    const val = meta.evergreen;
    if (typeof val === 'string') return val.toLowerCase() === 'true' || val === '1';
    return false;
  } catch {
    return false;
  }
}

async function applyPromotion(memoryDir: string, agg: RawAggregate): Promise<string> {
  const activity = buildPromotionBody(agg);
  const existing = listEntries(memoryDir, 'projects');
  const entryMap = new Map(
    existing.map((e) => [
      e.path
        .replace(/^projects\//, '')
        .replace(/\.md$/, '')
        .toLowerCase(),
      e.path,
    ]),
  );
  const existingPath = entryMap.get(agg.id.toLowerCase());

  let writtenPath: string;
  if (existingPath) {
    const { content } = readEntry(memoryDir, existingPath);
    const merged = isEvergreen(memoryDir, existingPath)
      ? content.trimEnd() + '\n\n' + activity
      : mergeIntoExisting(content, activity);
    const filename = existingPath.replace(/^projects\//, '');
    writeEntry(memoryDir, 'projects', filename, merged);
    writtenPath = existingPath;
  } else {
    const filename = `${agg.id}.md`;
    const body = [
      '---',
      `title: ${agg.id}`,
      `tags: [auto-distilled, promoted]`,
      `updated: ${new Date().toISOString().split('T')[0]}`,
      `confidence: inferred`,
      `confidence_score: 0.75`,
      '---',
      '',
      `# ${agg.id}`,
      '',
      activity,
    ].join('\n');
    writeEntry(memoryDir, 'projects', filename, body);
    writtenPath = `projects/${filename}`;
  }

  // v1.8.1: auto-verify promoter output. The promoter writes from CURRENT
  // session activity — by construction the content reflects fresh signal,
  // so the timestamp is the point of promotion itself. This gives retrieval
  // + dashboard a trust anchor without requiring any agent-facing action.
  try {
    getEntryScoring().markVerified(writtenPath);
  } catch (err) {
    console.error(
      '[promote] markVerified failed (non-fatal):',
      err instanceof Error ? err.message : err,
    );
  }
  return writtenPath;
}

// ── Diary ──────────────────────────────────────────────────────────────────

function writeDiary(
  memoryDir: string,
  result: PromoteResult,
  thresholds: { minScore: number; minRecallCount: number; minUniqueQueries: number },
): string {
  const dir = path.join(memoryDir, '.dreams');
  fs.mkdirSync(dir, { recursive: true });
  const date = result.runStartedAt.split('T')[0];
  const file = path.join(dir, `${date}.md`);

  const header = [
    `# Promotion run — ${date}`,
    '',
    `- Started: ${result.runStartedAt}`,
    `- Finished: ${result.runFinishedAt}`,
    `- Mode: **${result.mode}**`,
    `- Thresholds: minScore=${thresholds.minScore}, minRecallCount=${thresholds.minRecallCount}, minUniqueQueries=${thresholds.minUniqueQueries}`,
    `- Totals: ${result.totals.candidates} candidates, ${result.totals.passed} passed, ${result.totals.promoted} promoted, ${result.totals.skipped} skipped`,
    '',
    '## Signal weights',
    '',
    `Relevance ${SIGNAL_WEIGHTS.relevance} · Frequency ${SIGNAL_WEIGHTS.frequency} · QueryDiversity ${SIGNAL_WEIGHTS.queryDiversity} · Recency ${SIGNAL_WEIGHTS.recency} · Consolidation ${SIGNAL_WEIGHTS.consolidation} · ConceptualRichness ${SIGNAL_WEIGHTS.conceptualRichness}`,
    '',
    '## Candidates',
    '',
  ].join('\n');

  const lines: string[] = [];
  for (const c of result.candidates) {
    const status = c.promotedPath
      ? `PROMOTED → \`${c.promotedPath}\``
      : c.passed
        ? 'PASSED (mode=explain, not written)'
        : `SKIPPED${c.skipReason ? ' — ' + c.skipReason : ''}`;
    lines.push(`### \`${c.id}\` — score **${c.score.toFixed(3)}** — ${status}`);
    lines.push('');
    lines.push(
      `- Sessions: ${c.sessionIds.length} (first ${c.firstSeen.split('T')[0]}, last ${c.lastSeen.split('T')[0]})`,
    );
    lines.push(
      `- Signals: relevance ${c.signals.relevance.toFixed(2)}, frequency ${c.signals.frequency.toFixed(2)}, queryDiversity ${c.signals.queryDiversity.toFixed(2)}, recency ${c.signals.recency.toFixed(2)}, consolidation ${c.signals.consolidation.toFixed(2)}, conceptualRichness ${c.signals.conceptualRichness.toFixed(2)}`,
    );
    const gates = c.gates;
    lines.push(
      `- Gates: minScore ${gates.minScore.passed ? '✓' : '✗'} (${gates.minScore.value.toFixed(2)}/${gates.minScore.threshold}), minRecallCount ${gates.minRecallCount.passed ? '✓' : '✗'} (${gates.minRecallCount.value}/${gates.minRecallCount.threshold}), minUniqueQueries ${gates.minUniqueQueries.passed ? '✓' : '✗'} (${gates.minUniqueQueries.value}/${gates.minUniqueQueries.threshold})`,
    );
    lines.push('');
  }

  const content = header + lines.join('\n');
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

// ── Main entry point ────────────────────────────────────────────────────────

export async function promote(options: PromoteOptions = {}): Promise<PromoteResult> {
  const mode = options.mode ?? 'explain';
  const thresholds = {
    minScore: options.minScore ?? DEFAULT_GATES.minScore,
    minRecallCount: options.minRecallCount ?? DEFAULT_GATES.minRecallCount,
    minUniqueQueries: options.minUniqueQueries ?? DEFAULT_GATES.minUniqueQueries,
  };
  const writeDiaryEnabled = options.writeDiary ?? true;
  const advanceCursor = options.advanceCursor ?? mode === 'apply';

  const config = getConfig();
  const runStart = new Date();
  const runStartedAt = runStart.toISOString();

  const since = options.sinceIso !== undefined ? options.sinceIso : readCursor();
  const aggregates = aggregateSessions(since);

  if (mode === 'apply') {
    await gitPull(config.memoryDir);
  }

  const now = runStart.getTime();
  const candidates: PromoteCandidate[] = [];
  const promotedPaths: string[] = [];
  const skippedIds: string[] = [];
  let maxLastSeen = since ?? '';

  for (const agg of aggregates.values()) {
    if (agg.lastSeen > maxLastSeen) maxLastSeen = agg.lastSeen;

    const signals = computeSignals(agg, now);
    const score = compositeScore(signals);
    const gates = evaluateGates(agg, score, thresholds);
    const passed =
      gates.minScore.passed && gates.minRecallCount.passed && gates.minUniqueQueries.passed;

    const candidate: PromoteCandidate = {
      id: agg.id,
      label: agg.topics[0]?.slice(0, 80) ?? agg.id,
      sessionIds: [...agg.sessionIds],
      firstSeen: agg.firstSeen,
      lastSeen: agg.lastSeen,
      signals,
      score,
      gates,
      passed,
    };

    if (!passed) {
      const reasons: string[] = [];
      if (!gates.minScore.passed)
        reasons.push(`score ${score.toFixed(2)} < ${thresholds.minScore}`);
      if (!gates.minRecallCount.passed)
        reasons.push(`sessions ${agg.sessionIds.length} < ${thresholds.minRecallCount}`);
      if (!gates.minUniqueQueries.passed)
        reasons.push(
          `unique-queries ${agg.topicFingerprints.size} < ${thresholds.minUniqueQueries}`,
        );
      candidate.skipReason = reasons.join('; ');
      candidates.push(candidate);
      skippedIds.push(agg.id);
      continue;
    }

    if (!sourceStillExists(agg)) {
      candidate.skipReason = 'grounded-rehydration: source session file no longer present';
      candidates.push(candidate);
      skippedIds.push(agg.id);
      continue;
    }

    if (mode === 'apply') {
      try {
        const writtenPath = await applyPromotion(config.memoryDir, agg);
        candidate.promotedPath = writtenPath;
        promotedPaths.push(writtenPath);
      } catch (err) {
        candidate.skipReason = `write failed: ${err instanceof Error ? err.message : String(err)}`;
        skippedIds.push(agg.id);
      }
    }

    candidates.push(candidate);
  }

  candidates.sort((a, b) => b.score - a.score);

  const runFinishedAt = new Date().toISOString();
  const passedCount = candidates.filter((c) => c.passed).length;

  const result: PromoteResult = {
    runStartedAt,
    runFinishedAt,
    mode,
    candidates,
    promotedPaths,
    skippedIds,
    diaryPath: null,
    totals: {
      candidates: candidates.length,
      passed: passedCount,
      promoted: promotedPaths.length,
      skipped: skippedIds.length,
    },
  };

  if (writeDiaryEnabled) {
    try {
      const diary = writeDiary(config.memoryDir, result, thresholds);
      result.diaryPath = diary;
    } catch (err) {
      console.error('[promote] diary write failed:', err instanceof Error ? err.message : err);
    }
  }

  if (mode === 'apply' && promotedPaths.length > 0) {
    try {
      await gitPush(config.memoryDir, `promote: ${promotedPaths.length} candidate(s)`);
    } catch (err) {
      console.error('[promote] git push failed:', err instanceof Error ? err.message : err);
    }
  }

  if (advanceCursor && maxLastSeen) {
    writeCursor(maxLastSeen);
  }

  return result;
}

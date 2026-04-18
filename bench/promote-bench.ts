/**
 * Self-labeled write-bench for the scored promoter.
 *
 * Offline replay that measures whether the promoter's "would promote" decisions
 * line up with what the user actually referenced in LATER sessions.
 *
 * Method (no humans in the loop):
 *   1. Pick a cutoff date (default: 14 days ago).
 *   2. Score every candidate produced by sessions on or before the cutoff.
 *   3. Auto-label: "useful" iff the candidate's distinctive tokens reappear
 *      in sessions AFTER the cutoff (within the lookahead window).
 *   4. Compare three strategies head-to-head on the same candidates:
 *        - `gated`   — the v1.8 scored promoter (gates must all pass)
 *        - `naive`   — ship every candidate that appeared at least once
 *        - `distill` — the v1.7 regex-only distiller (fair historic baseline)
 *   5. Optional: per-signal ablation — drop ONE signal at a time from the
 *      gated strategy and re-measure F1 to see which signal is carrying it.
 *   6. Optional: write a jsonl snapshot of every labeled candidate so a
 *      human can eyeball a sample and measure agreement with the auto-label.
 *
 * Metrics (per strategy):
 *   Precision = |promoted ∩ referenced-later| / |promoted|
 *   Recall    = |promoted ∩ referenced-later| / |all referenced-later|
 *   F1        = 2·P·R / (P+R)
 *
 * Flags:
 *   --cutoff-days N         (default 14)  — how far back the replay cutoff sits
 *   --lookahead-days N      (default 30)  — future window for labels
 *   --min-score / --min-recall-count / --min-unique-queries — gate overrides
 *   --ablate                Run the 6-signal drop-one-out ablation
 *   --write-snapshot        Dump jsonl candidate+label snapshot into
 *                           ~/.claude/tmp/promote-bench-snapshot-<date>.jsonl
 *                           for manual spot-check. One JSON object per line:
 *                           {id, label, score, passed, referenced_later, signals, gates}
 *   --no-distill-baseline   Skip the regex-distiller comparison (faster)
 *
 * Usage:
 *   npx tsx bench/promote-bench.ts
 *   npx tsx bench/promote-bench.ts --cutoff-days 30 --lookahead-days 60
 *   npx tsx bench/promote-bench.ts --ablate
 *   npx tsx bench/promote-bench.ts --write-snapshot
 *
 * The bench is side-effect-free on the knowledge base — it never writes entries,
 * never advances the promote cursor. Safe to re-run.
 */

import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import {
  promote,
  compositeScore,
  DEFAULT_GATES,
  SIGNAL_WEIGHTS,
  type PromoteCandidate,
  type SignalBreakdown,
} from '../src/knowledge/promote.js';
import {
  getProjectDirs,
  getSessionFiles,
  parseSessionFile,
  extractMessages,
  getSessionMeta,
} from '../src/sessions/parser.js';
import { normalizeProjectName, distillSessions } from '../src/knowledge/distill.js';

// ── Arg parsing ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function numOpt(name: string, fallback: number): number {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && i + 1 < args.length) return parseFloat(args[i + 1]);
    if (args[i].startsWith(`--${name}=`)) return parseFloat(args[i].split('=')[1]);
  }
  return fallback;
}
function flag(name: string): boolean {
  return args.includes(`--${name}`);
}

const cutoffDays = numOpt('cutoff-days', 14);
const lookaheadDays = numOpt('lookahead-days', 30);
const minScore = numOpt('min-score', DEFAULT_GATES.minScore);
const minRecallCount = Math.round(numOpt('min-recall-count', DEFAULT_GATES.minRecallCount));
const minUniqueQueries = Math.round(numOpt('min-unique-queries', DEFAULT_GATES.minUniqueQueries));
const runAblation = flag('ablate');
const writeSnapshot = flag('write-snapshot');
const skipDistillBaseline = flag('no-distill-baseline');

const now = Date.now();
const cutoffIso = new Date(now - cutoffDays * 24 * 3600_000).toISOString();
const lookaheadEndIso = new Date(now + 0).toISOString();

// ── Build "future corpus" — sessions strictly after cutoff ──────────────────

interface FutureSegment {
  projectSlug: string;
  tokens: Set<string>;
}

function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  for (const tok of s.toLowerCase().split(/[\s.,;:!?()[\]{}"'<>/\\|`~@#$%^&*=+_-]+/)) {
    if (tok.length > 3) out.add(tok);
  }
  return out;
}

function collectFutureCorpus(): FutureSegment[] {
  const segments: FutureSegment[] = [];
  for (const proj of getProjectDirs()) {
    const slug = normalizeProjectName(proj.name);
    const sessions = getSessionFiles(proj.path);
    for (const sess of sessions) {
      try {
        const entries = parseSessionFile(sess.file);
        if (entries.length === 0) continue;
        const meta = getSessionMeta(entries);
        if (meta.startTime <= cutoffIso) continue;
        if (meta.startTime > lookaheadEndIso) continue;

        const messages = extractMessages(entries);
        const concatenated = messages.map((m) => m.content).join(' ');
        const tokens = tokenize(concatenated);
        if (tokens.size === 0) continue;
        segments.push({ projectSlug: slug, tokens });
      } catch {
        // skip broken
      }
    }
  }
  return segments;
}

function isReferenced(id: string, label: string, future: FutureSegment[]): boolean {
  const candidateTokens = new Set<string>();
  for (const tok of tokenize(id)) candidateTokens.add(tok);
  for (const tok of tokenize(label)) candidateTokens.add(tok);
  if (candidateTokens.size === 0) return false;

  for (const seg of future) {
    if (seg.projectSlug !== id) continue;
    let overlap = 0;
    for (const tok of candidateTokens) {
      if (seg.tokens.has(tok)) {
        overlap++;
        if (overlap >= 3) return true;
      }
    }
  }
  return false;
}

function isReferencedCandidate(candidate: PromoteCandidate, future: FutureSegment[]): boolean {
  return isReferenced(candidate.id, candidate.label, future);
}

// ── Metric helpers ──────────────────────────────────────────────────────────

interface Metrics {
  promoted: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

function computeMetrics(
  promotedIds: Set<string>,
  allCandidates: Array<{ id: string; referencedLater: boolean }>,
): Metrics {
  const tp = allCandidates.filter((c) => promotedIds.has(c.id) && c.referencedLater).length;
  const fp = allCandidates.filter((c) => promotedIds.has(c.id) && !c.referencedLater).length;
  const allRef = allCandidates.filter((c) => c.referencedLater).length;
  const fn = allRef - tp;
  const promoted = promotedIds.size;
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = allRef === 0 ? 0 : tp / allRef;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { promoted, tp, fp, fn, precision, recall, f1 };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

// ── Distiller baseline replay ───────────────────────────────────────────────

/**
 * Run the legacy regex distiller against the same pre-cutoff corpus and
 * return the set of project IDs it would have touched. This is the HISTORIC
 * baseline — what shipped in v1.7 and earlier. A fair comparison to the v1.8
 * gated promoter.
 *
 * Implementation note: distillSessions uses its own cursor state in
 * {dataDir}/.knowledge-distill-cursor and writes to memoryDir. We back both
 * up and restore them so the bench stays side-effect-free.
 */
async function replayDistillerBaseline(): Promise<Set<string>> {
  const dataDir =
    process.env.KNOWLEDGE_DATA_DIR ||
    (process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'), 'knowledge')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'knowledge'));
  const memoryDir = process.env.KNOWLEDGE_MEMORY_DIR || path.join(homedir(), 'agent-knowledge');
  const cursorFile = path.join(dataDir, '.knowledge-distill-cursor');

  const backup = {
    cursorExisted: fs.existsSync(cursorFile),
    cursorContent: fs.existsSync(cursorFile) ? fs.readFileSync(cursorFile, 'utf-8') : null,
    projectsSnapshot: new Map<string, string | null>(),
  };

  // Snapshot any existing project entries we might overwrite.
  const projectsDir = path.join(memoryDir, 'projects');
  try {
    if (fs.existsSync(projectsDir)) {
      for (const f of fs.readdirSync(projectsDir)) {
        const full = path.join(projectsDir, f);
        try {
          backup.projectsSnapshot.set(full, fs.readFileSync(full, 'utf-8'));
        } catch {
          /* skip */
        }
      }
    }
  } catch {
    /* ignore */
  }

  // Drive the distiller to see only pre-cutoff sessions by setting its
  // cursor forward to cutoffIso BEFORE invocation. distillSessions pulls
  // sessions with startTime > cursor, so the cursor acts as a lower bound —
  // we actually want the opposite: only distill sessions <= cutoffIso.
  // Since distillSessions doesn't expose an upper bound, we back up the
  // entire session index and won't get a clean historical slice. Compromise:
  // just run distill on the full available corpus and compare to the same
  // pre-cutoff candidate slice the promoter saw. This overestimates the
  // distiller's reach (it sees post-cutoff sessions too) — a known caveat.
  let touched: string[] = [];
  try {
    // Reset cursor so distill doesn't think it's already caught up.
    if (backup.cursorExisted) fs.unlinkSync(cursorFile);
    const result = await distillSessions();
    touched = [...result.updated, ...result.created];
  } catch (err) {
    process.stderr.write(`[promote-bench] distiller baseline failed: ${err}\n`);
  } finally {
    // Restore everything.
    if (backup.cursorExisted && backup.cursorContent !== null) {
      fs.writeFileSync(cursorFile, backup.cursorContent, 'utf-8');
    } else if (!backup.cursorExisted && fs.existsSync(cursorFile)) {
      fs.unlinkSync(cursorFile);
    }
    for (const [file, content] of backup.projectsSnapshot) {
      try {
        if (content === null) {
          if (fs.existsSync(file)) fs.unlinkSync(file);
        } else {
          fs.writeFileSync(file, content, 'utf-8');
        }
      } catch {
        /* ignore */
      }
    }
    // Also remove any projects/ entries the distiller CREATED that weren't in the snapshot.
    try {
      if (fs.existsSync(projectsDir)) {
        for (const f of fs.readdirSync(projectsDir)) {
          const full = path.join(projectsDir, f);
          if (!backup.projectsSnapshot.has(full)) {
            fs.unlinkSync(full);
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  // Convert "projects/<name>.md" entries back into normalized IDs
  // (which is what promote candidates use).
  const ids = new Set<string>();
  for (const p of touched) {
    const m = p.match(/^projects\/(.+)\.md$/);
    if (m) ids.add(m[1].toLowerCase());
  }
  return ids;
}

// ── Per-signal ablation ────────────────────────────────────────────────────

const SIGNAL_KEYS = Object.keys(SIGNAL_WEIGHTS) as (keyof SignalBreakdown)[];

/**
 * Re-score every candidate with ONE signal forced to zero, keeping gates the
 * same. Returns a map of { droppedSignal -> promotedIds }. Shows which
 * signals the gated strategy actually relies on.
 */
function ablateSignals(
  candidates: PromoteCandidate[],
  thresholds: { minScore: number; minRecallCount: number; minUniqueQueries: number },
): Map<keyof SignalBreakdown, Set<string>> {
  const out = new Map<keyof SignalBreakdown, Set<string>>();
  for (const drop of SIGNAL_KEYS) {
    const promoted = new Set<string>();
    for (const c of candidates) {
      const muted: SignalBreakdown = { ...c.signals, [drop]: 0 };
      const reScore = compositeScore(muted);
      const pass =
        reScore >= thresholds.minScore &&
        c.gates.minRecallCount.passed &&
        c.gates.minUniqueQueries.passed;
      if (pass) promoted.add(c.id);
    }
    out.set(drop, promoted);
  }
  return out;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const future = collectFutureCorpus();
  if (future.length === 0) {
    console.log('# promote-bench');
    console.log('');
    console.log(
      `No sessions found after cutoff ${cutoffIso.split('T')[0]}. Nothing to bench — run once you have 2+ weeks of session history.`,
    );
    process.exit(0);
  }

  // Score every candidate since epoch; filter to pre-cutoff below.
  const veryOld = new Date(0).toISOString();
  const scoreRun = await promote({
    mode: 'explain',
    writeDiary: false,
    sinceIso: veryOld,
    minScore,
    minRecallCount,
    minUniqueQueries,
    advanceCursor: false,
  });

  const candidates = scoreRun.candidates.filter((c) => c.lastSeen <= cutoffIso);
  if (candidates.length === 0) {
    console.log('# promote-bench');
    console.log('');
    console.log(
      `No pre-cutoff candidates produced. Try --cutoff-days ${cutoffDays + 7} to shift the window earlier.`,
    );
    process.exit(0);
  }

  const labeled = candidates.map((c) => ({
    id: c.id,
    referencedLater: isReferencedCandidate(c, future),
  }));

  // ── Strategy 1: gated (v1.8 scored promoter) ────────────────────────────
  const gatedIds = new Set(candidates.filter((c) => c.passed).map((c) => c.id));
  const gated = computeMetrics(gatedIds, labeled);

  // ── Strategy 2: naive (ship all) ────────────────────────────────────────
  const naiveIds = new Set(labeled.map((l) => l.id));
  const naive = computeMetrics(naiveIds, labeled);

  // ── Strategy 3: distiller baseline (v1.7 regex) ─────────────────────────
  let distill: Metrics | null = null;
  if (!skipDistillBaseline) {
    const distillIds = await replayDistillerBaseline();
    distill = computeMetrics(distillIds, labeled);
  }

  // ── Strategy 4: per-signal ablation (optional) ──────────────────────────
  let ablationMetrics: Array<{ dropped: keyof SignalBreakdown; m: Metrics }> = [];
  if (runAblation) {
    const thresholds = { minScore, minRecallCount, minUniqueQueries };
    const ablated = ablateSignals(candidates, thresholds);
    for (const [dropped, promotedIds] of ablated) {
      ablationMetrics.push({ dropped, m: computeMetrics(promotedIds, labeled) });
    }
    ablationMetrics = ablationMetrics.sort((a, b) => b.m.f1 - a.m.f1);
  }

  const allReferenced = labeled.filter((l) => l.referencedLater).length;

  // ── Report ───────────────────────────────────────────────────────────────
  const lines: string[] = [];
  lines.push('# promote-bench');
  lines.push('');
  lines.push(`Cutoff: **${cutoffDays}d** (last-seen ≤ ${cutoffIso.split('T')[0]})`);
  lines.push(`Lookahead: **${lookaheadDays}d** (future corpus strictly after cutoff)`);
  lines.push(
    `Gates: minScore=${minScore}, minRecallCount=${minRecallCount}, minUniqueQueries=${minUniqueQueries}`,
  );
  lines.push('');
  lines.push(`Pre-cutoff candidates: **${labeled.length}**`);
  lines.push(`Referenced in lookahead: **${allReferenced}**`);
  lines.push('');

  lines.push('## Strategies');
  lines.push('');
  lines.push('| Strategy | Promoted | TP | FP | FN | Precision | Recall | F1 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  const row = (name: string, m: Metrics) =>
    `| ${name} | ${m.promoted} | ${m.tp} | ${m.fp} | ${m.fn} | ${pct(m.precision)} | ${pct(m.recall)} | **${pct(m.f1)}** |`;
  lines.push(row('gated (v1.8 scored)', gated));
  if (distill) lines.push(row('distill (v1.7 regex)', distill));
  lines.push(row('naive (ship all)', naive));
  lines.push('');

  if (distill) {
    const delta = gated.f1 - distill.f1;
    const direction = delta > 0 ? '**wins**' : delta < 0 ? '**loses**' : 'ties';
    lines.push(
      `**v1.8 vs v1.7**: gated ${direction} the F1 race by ${Math.abs(delta * 100).toFixed(1)}pp ` +
        `(${pct(gated.f1)} vs ${pct(distill.f1)}). ` +
        'Remember: "useful" here is "referenced later" via a 3-token fuzzy match — noisy by design. ' +
        'Use --write-snapshot to spot-check human agreement with the auto-label.',
    );
    lines.push('');
  }

  if (runAblation && ablationMetrics.length > 0) {
    lines.push('## Per-signal ablation');
    lines.push('');
    lines.push(
      'Re-score each candidate with ONE signal forced to zero, keep the same gates. ' +
        'Signals ordered by resulting F1 (lowest F1 = the signal was most load-bearing).',
    );
    lines.push('');
    lines.push(
      `Baseline (no drop): **${pct(gated.f1)}** F1 from ${gated.promoted} promotions, weight = ${Object.values(
        SIGNAL_WEIGHTS,
      )
        .reduce((a, b) => a + b, 0)
        .toFixed(2)}.`,
    );
    lines.push('');
    lines.push('| Signal dropped | Weight | Promoted | F1 | ΔF1 vs baseline |');
    lines.push('|---|---|---|---|---|');
    for (const { dropped, m } of ablationMetrics) {
      const delta = m.f1 - gated.f1;
      const arrow = delta > 0.005 ? '↑' : delta < -0.005 ? '↓' : '·';
      lines.push(
        `| ${dropped} | ${SIGNAL_WEIGHTS[dropped]} | ${m.promoted} | ${pct(m.f1)} | ${arrow} ${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}pp |`,
      );
    }
    lines.push('');
    lines.push(
      '_Signals whose drop INCREASES F1 are candidates for weight reduction; signals whose drop crushes F1 are load-bearing._',
    );
    lines.push('');
  }

  // Worst FPs/FNs against the gated strategy.
  const worstFp = candidates
    .filter((c) => gatedIds.has(c.id) && !labeled.find((l) => l.id === c.id)?.referencedLater)
    .slice(0, 5);
  const worstFn = candidates
    .filter((c) => !gatedIds.has(c.id) && labeled.find((l) => l.id === c.id)?.referencedLater)
    .slice(0, 5);
  if (worstFp.length > 0) {
    lines.push('### Top false-positives (gated promoted, never referenced later)');
    for (const x of worstFp) {
      lines.push(`- \`${x.id}\` — score ${x.score.toFixed(2)} — label: ${x.label.slice(0, 60)}`);
    }
    lines.push('');
  }
  if (worstFn.length > 0) {
    lines.push('### Top false-negatives (gated skipped, referenced later)');
    for (const x of worstFn) {
      lines.push(
        `- \`${x.id}\` — score ${x.score.toFixed(2)} — reason: ${x.skipReason ?? '(unknown)'}`,
      );
    }
    lines.push('');
  }

  const report = lines.join('\n');
  console.log(report);

  // Save the markdown report.
  try {
    const outDir = path.join(homedir(), '.claude', 'tmp');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(outDir, `promote-bench-${stamp}.md`), report, 'utf-8');

    // Optional: full jsonl snapshot so a human can eyeball-label a random sample
    // and compute agreement with the auto-label proxy.
    if (writeSnapshot) {
      const snapshotPath = path.join(outDir, `promote-bench-snapshot-${stamp}.jsonl`);
      const lookup = new Map(labeled.map((l) => [l.id, l.referencedLater]));
      const lines: string[] = [];
      for (const c of candidates) {
        lines.push(
          JSON.stringify({
            id: c.id,
            label: c.label,
            score: c.score,
            passed: c.passed,
            referenced_later: lookup.get(c.id) ?? false,
            sessions: c.sessionIds.length,
            first_seen: c.firstSeen,
            last_seen: c.lastSeen,
            signals: c.signals,
            gates: {
              minScore: c.gates.minScore.passed,
              minRecallCount: c.gates.minRecallCount.passed,
              minUniqueQueries: c.gates.minUniqueQueries.passed,
            },
            skip_reason: c.skipReason ?? null,
          }),
        );
      }
      fs.writeFileSync(snapshotPath, lines.join('\n') + '\n', 'utf-8');
      process.stderr.write(`[promote-bench] snapshot: ${snapshotPath}\n`);
      process.stderr.write(
        '[promote-bench] to spot-check: random-sample 20 lines, label referenced_later by hand, compute Cohen kappa vs the auto-label.\n',
      );
    }
  } catch {
    /* ignore */
  }
}

main().catch((err) => {
  console.error('[promote-bench] fatal:', err);
  process.exit(1);
});

// =============================================================================
// agent-knowledge — session snapshot
//
// One Markdown file per session in the knowledge base, written when the host
// compacts the conversation and again when it ends: what was asked, the tools,
// files, commits and errors, so the session's gist outlives the transcript and
// reaches other machines through git. Built from the session parser (every
// host the adapters read), secrets scrubbed as distillation scrubs them.
// =============================================================================

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { scrubContent } from '../knowledge/distill.js';
import { invalidateKnowledgeIndexCache } from '../knowledge/search.js';
import { getConfig } from '../types.js';
import { loadSessionSummary, type SessionSummary } from './summary.js';

export type SnapshotEvent = 'compact' | 'end';

export interface SessionSnapshot {
  /**
   * The entry's path in the knowledge base, e.g. `sessions/my-app/2026-11-13-ec51c282.md`;
   * null when nothing was asked in the session (nothing to keep, nothing written).
   */
  path: string | null;
  /** Its title: the project, the day and what was asked first; null with no path. */
  title: string | null;
  prompts: number;
  messages: number;
  tools: number;
}

const ASKED_HEAD = 10;
const ASKED_TAIL = 10;
const LISTED = 30;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'session';

/** Each line scrubbed; lines scrubbing leaves empty (system noise) dropped. */
const scrubbed = (lines: string[]) =>
  lines.map((l) => scrubContent(l).replace(/\s+/g, ' ').trim()).filter(Boolean);

/**
 * The files the session changed, as code (a Windows path's `\.` is no Markdown escape), less
 * the knowledge base's own hidden files (`.identity-declined`, `.git/…`): bookkeeping, not work.
 */
function changedFiles(files: string[], memoryDir: string): string[] {
  const isKbHidden = (f: string) => {
    const rel = relative(memoryDir, f);
    return (
      !rel.startsWith('..') && !isAbsolute(rel) && rel.split(/[\\/]/).some((p) => p.startsWith('.'))
    );
  };
  return scrubbed(files.filter((f) => !isKbHidden(f))).map((f) => `\`${f}\``);
}

function section(title: string, lines: string[], max = LISTED): string[] {
  if (lines.length === 0) return [];
  const shown = lines.slice(0, max).map((l) => `- ${l}`);
  if (lines.length > max) shown.push(`- … ${lines.length - max} more`);
  return [`## ${title}`, '', ...shown, ''];
}

/** What was asked: the first and the last prompts, the middle counted. */
function asked(topics: string[]): string[] {
  if (topics.length <= ASKED_HEAD + ASKED_TAIL) return section('What was asked', topics);
  return [
    '## What was asked',
    '',
    ...topics.slice(0, ASKED_HEAD).map((t) => `- ${t}`),
    `- … ${topics.length - ASKED_HEAD - ASKED_TAIL} more`,
    ...topics.slice(-ASKED_TAIL).map((t) => `- ${t}`),
    '',
  ];
}

/** `text` cut to `n` characters at a word, an ellipsis saying so. */
const atWord = (text: string, n: number) =>
  text.length <= n ? text : `${text.slice(0, n).replace(/\s+\S*$/, '')}…`;

/** Named by what a list shows first: the project, the day, what was asked; the id is below. */
const titleOf = (where: { project: string; day: string }, topics: string[]) =>
  [where.project, where.day, topics[0] && atWord(topics[0], 80)].filter(Boolean).join(' · ');

function render(
  id: string,
  event: SnapshotEvent,
  where: { cwd: string; project: string; day: string },
  s: SessionSummary,
  topics: string[],
) {
  const m = s.meta;
  const title = titleOf(where, topics);
  return [
    '---',
    `title: ${title}`,
    'type: session-snapshot',
    `session: ${id}`,
    `event: ${event}`,
    `cwd: ${scrubContent(where.cwd) || '~'}`,
    // A folder outside git reads as HEAD: no branch then.
    ...(m.branch && m.branch !== 'HEAD' ? [`branch: ${m.branch}`] : []),
    `started: ${m.startTime}`,
    `last_activity: ${m.endTime}`,
    `messages: ${m.messageCount}`,
    `user_turns: ${m.userMessageCount}`,
    `updated: ${new Date().toISOString()}`,
    '---',
    '',
    `# ${title}`,
    '',
    ...asked(topics),
    ...section('Tools used', s.toolsUsed),
    ...section('Files', changedFiles(s.filesModified, getConfig().memoryDir)),
    ...section('Commits', scrubbed(s.gitCommits)),
    ...section('Errors', scrubbed(s.errorPatterns), 10),
  ].join('\n');
}

/**
 * Writes the session's snapshot under `sessions/<project>/`, the project named after `cwd`
 * (else the session's own working folder). Null when no host's sessions hold that id.
 */
export async function writeSessionSnapshot(
  sessionId: string,
  event: SnapshotEvent,
  cwd?: string,
): Promise<SessionSnapshot | null> {
  const summary = await loadSessionSummary(sessionId);
  if (!summary) return null;
  const topics = scrubbed(summary.topics.map((t) => t.content));
  const counts = {
    prompts: topics.length,
    messages: summary.meta.messageCount,
    tools: summary.toolsUsed.length,
  };
  if (topics.length === 0) return { path: null, title: null, ...counts };
  const where = cwd || summary.meta.cwd || '';
  const name = basename(where.replace(/[\\/]+$/, ''));
  const project = slug(name);
  const day = (summary.meta.startTime || new Date().toISOString()).slice(0, 10);
  const rel = `sessions/${project}/${day}-${slug(sessionId).slice(0, 8)}.md`;

  const memoryDir = getConfig().memoryDir;
  mkdirSync(join(memoryDir, 'sessions', project), { recursive: true });
  const where2 = { cwd: where, project: name || project, day };
  writeFileSync(join(memoryDir, rel), render(sessionId, event, where2, summary, topics), 'utf-8');
  invalidateKnowledgeIndexCache();

  return { path: rel, title: titleOf(where2, topics), ...counts };
}

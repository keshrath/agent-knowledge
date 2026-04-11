import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  getProjectDirs,
  getSessionFiles,
  parseSessionFile,
  getSessionMeta,
} from '../sessions/parser.js';
import { getSessionSummary } from '../sessions/summary.js';
import { listEntries, readEntry, writeEntry } from './store.js';
import { gitPull, gitPush } from './git.js';
import { getConfig } from '../types.js';

// ── Cursor tracking ─────────────────────────────────────────────────────────

function getCursorPath(): string {
  const config = getConfig();
  return join(config.dataDir, '.knowledge-distill-cursor');
}

function getLastDistillTime(): string | null {
  const cursorPath = getCursorPath();
  if (!existsSync(cursorPath)) return null;
  try {
    return readFileSync(cursorPath, 'utf-8').trim() || null;
  } catch (err) {
    console.error('[knowledge] read distill cursor:', err instanceof Error ? err.message : err);
    return null;
  }
}

function setLastDistillTime(iso: string): void {
  writeFileSync(getCursorPath(), iso, 'utf-8');
}

// ── Secrets / sensitive data scrubbing ──────────────────────────────────────

const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // API keys and tokens (common prefixes)
  { pattern: /\b(sk-[a-zA-Z0-9]{20,})\b/g, replacement: '[REDACTED_API_KEY]' },
  { pattern: /\b(ghp_[a-zA-Z0-9]{36,})\b/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
  { pattern: /\b(gho_[a-zA-Z0-9]{36,})\b/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
  { pattern: /\b(glpat-[a-zA-Z0-9_-]{20,})\b/g, replacement: '[REDACTED_GITLAB_TOKEN]' },
  { pattern: /\b(xox[bsapr]-[a-zA-Z0-9-]{10,})\b/g, replacement: '[REDACTED_SLACK_TOKEN]' },
  { pattern: /\b(AIza[a-zA-Z0-9_-]{35})\b/g, replacement: '[REDACTED_GOOGLE_KEY]' },
  { pattern: /\b(AKIA[A-Z0-9]{16})\b/g, replacement: '[REDACTED_AWS_KEY]' },
  {
    pattern: /\b(eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,})\b/g,
    replacement: '[REDACTED_JWT]',
  },

  // Generic key=value patterns
  {
    pattern:
      /(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token|bearer|password|passwd|pwd)\s*[:=]\s*["']?([^\s"']{8,})["']?/gi,
    replacement: '[REDACTED_CREDENTIAL]',
  },

  // Bearer tokens in headers
  { pattern: /Bearer\s+[a-zA-Z0-9._\-+/=]{20,}/gi, replacement: 'Bearer [REDACTED]' },

  // Connection strings with passwords
  { pattern: /(:\/\/[^:]+:)[^@\s]{4,}(@)/g, replacement: '$1[REDACTED]$2' },

  // Private key blocks
  {
    pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },

  // .env style secrets
  {
    pattern: /^[A-Z_]*(SECRET|TOKEN|PASSWORD|KEY|CREDENTIAL)[A-Z_]*\s*=\s*\S+/gm,
    replacement: '[REDACTED_ENV_VAR]',
  },

  // Base64-encoded blobs after secret-related keywords, or with = padding
  {
    pattern:
      /(?:key|secret|token|password|credential|authorization|private.key)\s*[:=]\s*["']?[A-Za-z0-9+/]{40,}={1,2}["']?/gi,
    replacement: '[REDACTED_BASE64]',
  },
  {
    pattern: /\b[A-Za-z0-9+/]{64,}={1,2}\b/g,
    replacement: '[REDACTED_BASE64]',
  },

  // Email addresses (privacy)
  {
    pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
    replacement: '[REDACTED_EMAIL]',
  },
];

// Content that should be stripped entirely (system noise, not secrets)
const NOISE_PATTERNS: RegExp[] = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<task-notification>[\s\S]*?<\/task-notification>/g,
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
  /<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/g,
  /\btool_use_id\b[^}\n]*/g,
  /\boutput-file[^<\n]*/g,
];

/**
 * Scrub secrets and system noise from text before it reaches git.
 */
export function scrubContent(text: string): string {
  let result = text;

  for (const pattern of NOISE_PATTERNS) {
    result = result.replace(pattern, '');
  }

  // Redact secrets
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }

  result = result.replace(/[A-Z]:[/\\]Users[/\\][^/\\\s]+[/\\]/gi, '~/');
  result = result.replace(/\/home\/[^/\s]+\//g, '~/');

  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}

/**
 * Check if text contains potentially sensitive content that wasn't caught
 * by pattern matching. Returns true if the text looks safe.
 */
function isSafeContent(text: string): boolean {
  // Reject topics that are mostly XML/JSON/system garbage
  if (text.startsWith('<') && text.includes('>')) return false;
  if (text.startsWith('{') || text.startsWith('[{')) return false;
  // Reject base64 image data
  if (text.includes('base64') && text.includes('media_type')) return false;
  // Reject tool result JSON
  if (text.includes('tool_use_id') || text.includes('tool_result')) return false;
  // Reject very short or very long content
  if (text.length < 15) return false;
  if (text.length > 500) return false;
  // Must contain at least some alphabetic content
  const alphaRatio = (text.match(/[a-zA-Z]/g) || []).length / text.length;
  if (alphaRatio < 0.3) return false;

  return true;
}

// ── Project name normalization ──────────────────────────────────────────────

/**
 * Normalize a project directory name to a clean, readable
 * project name suitable for the knowledge base.
 *
 * Session directories are typically encoded paths from a host (Claude Code,
 * Cursor, etc.) — e.g. `C--Users-Alice--repos-myapp--worktrees-feature-x`.
 * This collapses host prefixes, worktree suffixes, and duplicated trailing
 * segments into a clean project name.
 */
export function normalizeProjectName(raw: string): string {
  let name = raw;

  // Strip Windows-style user prefix: C--Users-<Username>-- or C--Users-<Username>-
  name = name.replace(/^C--Users-[^-]+-{1,2}/i, '');

  // Strip leading dot (hidden dirs)
  name = name.replace(/^\./, '');

  // Handle worktrees: <project>--worktrees-<name> → <project>
  name = name.replace(/--(?:[a-z0-9-]+-)?worktrees-[a-z0-9-]+$/i, '');

  // Handle swarm/fan-out sessions: <project>-swarm-<role>-<n> → <project>
  name = name.replace(/-swarm-[a-z]+-(?:agent|review|scale-test|test|ui)-?\d*$/i, '');
  name = name.replace(/-swarm-[a-z0-9-]+$/i, '');

  // Generic path-to-name mappings
  const pathMappings: Array<[RegExp, string]> = [
    // Bare host config dir (e.g. `claude` → `claude-code-config`)
    [/^claude$/, 'claude-code-config'],
    // MCP servers under a host config dir
    [/^[a-z0-9]+-mcp-servers-(.+)$/, '$1'],
    // Strip a host-name prefix repeated as a leading segment
    [/^claude-(.+)$/, '$1'],
    // Collapse `<stem><version>-...-<stem>` → `<stem><version>` (e.g.
    // `proj19-sub-proj` → `proj19`). The stem appears versioned at the
    // start and bare at the end with arbitrary middle segments in between.
    [/^([a-z]+)(\d+)-(?:.*-)?\1$/i, '$1$2'],
    // Strip a duplicated trailing word: `<a>-<b>-<b>` → `<a>-<b>`
    [/^(.+?)-([a-z0-9]+)-\2$/i, '$1-$2'],
  ];

  for (const [pattern, replacement] of pathMappings) {
    if (pattern.test(name)) {
      name = name.replace(pattern, replacement);
      break;
    }
  }

  // Final cleanup
  name = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return name || 'unknown';
}

/**
 * Determine if a project should be skipped entirely.
 * Short-lived swarm sessions, worktrees with only 1 session, etc.
 */
function shouldSkipProject(name: string, sessionCount: number): boolean {
  // Skip if the session count is too low for a worktree/swarm
  // (they'll be merged into the parent anyway)
  // This is handled by normalization — duplicates merge.
  // But skip truly empty results
  if (sessionCount === 0) return true;
  return false;
}

// ── Session insight extraction ──────────────────────────────────────────────

interface ProjectInsights {
  sessions: number;
  topics: string[];
  tools: Set<string>;
  files: Set<string>;
  latestDate: string;
  gitCommits: Set<string>;
  errorPatterns: Set<string>;
  urlsAccessed: Set<string>;
  packagesChanged: Set<string>;
}

function extractInsights(cutoff: string | null): Map<string, ProjectInsights> {
  const projects = getProjectDirs();
  const raw = new Map<string, ProjectInsights>();

  for (const proj of projects) {
    const sessions = getSessionFiles(proj.path);

    for (const sess of sessions) {
      try {
        const entries = parseSessionFile(sess.file);
        if (entries.length === 0) continue;

        const meta = getSessionMeta(entries);
        if (meta.startTime === 'unknown') continue;
        if (cutoff && meta.startTime <= cutoff) continue;

        const summary = getSessionSummary(sess.id, proj.name);
        if (!summary) continue;

        // Clean and filter topics
        const humanTopics = summary.topics
          .map((t) => scrubContent(t.content))
          .filter((t) => isSafeContent(t));

        if (humanTopics.length === 0 && summary.toolsUsed.length === 0) continue;

        // Normalize project name (merges worktrees/swarms into parent)
        const normalized = normalizeProjectName(proj.name);

        let pi = raw.get(normalized);
        if (!pi) {
          pi = {
            sessions: 0,
            topics: [],
            tools: new Set(),
            files: new Set(),
            latestDate: '',
            gitCommits: new Set(),
            errorPatterns: new Set(),
            urlsAccessed: new Set(),
            packagesChanged: new Set(),
          };
          raw.set(normalized, pi);
        }

        pi.sessions++;
        pi.topics.push(...humanTopics.slice(0, 5));
        for (const t of summary.toolsUsed) pi.tools.add(t);
        // Scrub file paths — remove absolute user-specific prefixes
        for (const f of summary.filesModified) {
          const cleaned = f.replace(/^[A-Z]:[/\\]Users[/\\][^/\\]+[/\\]/i, '~/');
          pi.files.add(cleaned);
        }
        for (const c of summary.gitCommits ?? []) pi.gitCommits.add(c);
        for (const e of summary.errorPatterns ?? []) pi.errorPatterns.add(e);
        for (const u of summary.urlsAccessed ?? []) pi.urlsAccessed.add(u);
        for (const p of summary.packagesChanged ?? []) pi.packagesChanged.add(p);
        if (meta.startTime > pi.latestDate) pi.latestDate = meta.startTime;
      } catch (err) {
        console.error('[knowledge] extract insights:', err instanceof Error ? err.message : err);
        continue;
      }
    }
  }

  // Filter out empty projects
  const insights = new Map<string, ProjectInsights>();
  for (const [name, pi] of raw) {
    if (!shouldSkipProject(name, pi.sessions)) {
      insights.set(name, pi);
    }
  }

  return insights;
}

// ── Knowledge base update ───────────────────────────────────────────────────

function buildActivitySection(pi: ProjectInsights): string {
  const lines: string[] = [];
  lines.push(`## Recent Activity`);
  lines.push('');
  lines.push(
    `_Auto-distilled from ${pi.sessions} session(s), last updated ${pi.latestDate.split('T')[0]}_`,
  );
  lines.push('');

  if (pi.topics.length > 0) {
    lines.push('### Topics Discussed');
    const unique = [...new Set(pi.topics)].slice(0, 15);
    for (const topic of unique) {
      const short = topic.length > 150 ? topic.slice(0, 150) + '...' : topic;
      // Final scrub — defense in depth
      const safe = scrubContent(short);
      if (safe.length > 10) {
        lines.push(`- ${safe}`);
      }
    }
    lines.push('');
  }

  if (pi.tools.size > 0) {
    lines.push('### Tools Used');
    lines.push([...pi.tools].sort().join(', '));
    lines.push('');
  }

  if (pi.files.size > 0) {
    lines.push('### Files Touched');
    const fileList = [...pi.files].sort().slice(0, 30);
    for (const f of fileList) {
      lines.push(`- \`${f}\``);
    }
    if (pi.files.size > 30) {
      lines.push(`- _...and ${pi.files.size - 30} more_`);
    }
    lines.push('');
  }

  if (pi.gitCommits.size > 0) {
    lines.push('### Commits');
    const commits = [...pi.gitCommits].slice(0, 10);
    lines.push(commits.map((c) => `\`${c}\``).join(', '));
    lines.push('');
  }

  if (pi.errorPatterns.size > 0) {
    lines.push('### Errors Encountered');
    const errors = [...pi.errorPatterns].slice(0, 5);
    for (const e of errors) {
      const safe = scrubContent(e);
      if (safe.length > 10) {
        lines.push(`- ${safe}`);
      }
    }
    lines.push('');
  }

  if (pi.urlsAccessed.size > 0) {
    lines.push('### URLs Accessed');
    const urls = [...pi.urlsAccessed].slice(0, 10);
    for (const u of urls) {
      lines.push(`- ${u}`);
    }
    lines.push('');
  }

  if (pi.packagesChanged.size > 0) {
    lines.push('### Packages Changed');
    lines.push([...pi.packagesChanged].join(', '));
    lines.push('');
  }

  return lines.join('\n');
}

function mergeIntoEntry(existingContent: string, activitySection: string): string {
  const activityMarker = '## Recent Activity';
  const idx = existingContent.indexOf(activityMarker);

  if (idx >= 0) {
    const nextH2 = existingContent.indexOf('\n## ', idx + activityMarker.length);
    if (nextH2 >= 0) {
      return existingContent.slice(0, idx) + activitySection + existingContent.slice(nextH2);
    }
    return existingContent.slice(0, idx) + activitySection;
  }

  return existingContent.trimEnd() + '\n\n' + activitySection;
}

// ── Pre-push safety check ───────────────────────────────────────────────────

/**
 * Final safety scan of all content about to be written. Returns list of
 * issues found. If non-empty, the write should be aborted.
 */
function auditContent(content: string): string[] {
  const issues: string[] = [];

  if (/\bsk-[a-zA-Z0-9]{20,}\b/.test(content)) issues.push('Possible API key (sk-...)');
  if (/\bghp_[a-zA-Z0-9]{36,}\b/.test(content)) issues.push('Possible GitHub token');
  if (/\bglpat-[a-zA-Z0-9_-]{20,}\b/.test(content)) issues.push('Possible GitLab token');
  if (/-----BEGIN[A-Z ]*PRIVATE KEY-----/.test(content)) issues.push('Private key block detected');
  if (/\bpassword\s*[:=]\s*\S{4,}/i.test(content)) issues.push('Possible password in plaintext');
  if (/Bearer\s+[a-zA-Z0-9._\-+/=]{20,}/i.test(content)) issues.push('Possible bearer token');

  return issues;
}

// ── Main distill entry point ────────────────────────────────────────────────

export async function distillSessions(): Promise<{
  updated: string[];
  created: string[];
  skipped: string[];
}> {
  const config = getConfig();
  const cutoff = getLastDistillTime();
  const insights = extractInsights(cutoff);

  if (insights.size === 0) {
    return { updated: [], created: [], skipped: [] };
  }

  await gitPull(config.memoryDir);

  const updated: string[] = [];
  const created: string[] = [];
  const skipped: string[] = [];
  let latestDate = cutoff ?? '';

  const existingEntries = listEntries(config.memoryDir, 'projects');
  const entryMap = new Map<string, string>();
  const entryMapNoDash = new Map<string, string>();
  for (const e of existingEntries) {
    const name = e.path
      .replace(/^projects\//, '')
      .replace(/\.md$/, '')
      .toLowerCase();
    entryMap.set(name, e.path);
    entryMapNoDash.set(name.replace(/-/g, ''), e.path);
  }

  for (const [normalizedName, pi] of insights) {
    const activitySection = buildActivitySection(pi);

    const issues = auditContent(activitySection);
    if (issues.length > 0) {
      console.error(`[knowledge] BLOCKED distill for "${normalizedName}": ${issues.join(', ')}`);
      skipped.push(normalizedName);
      if (pi.latestDate > latestDate) latestDate = pi.latestDate;
      continue;
    }

    const existingPath =
      entryMap.get(normalizedName) ?? entryMapNoDash.get(normalizedName.replace(/-/g, ''));

    try {
      if (existingPath) {
        const { content } = readEntry(config.memoryDir, existingPath);
        const merged = mergeIntoEntry(content, activitySection);

        // Audit the merged result too
        const mergedIssues = auditContent(merged);
        if (mergedIssues.length > 0) {
          console.error(
            `[knowledge] BLOCKED merge for "${normalizedName}": ${mergedIssues.join(', ')}`,
          );
          skipped.push(normalizedName);
          continue;
        }

        const filename = existingPath.replace(/^projects\//, '');
        writeEntry(config.memoryDir, 'projects', filename, merged);
        updated.push(existingPath);
      } else {
        const filename = `${normalizedName}.md`;
        const content = [
          '---',
          `title: ${normalizedName}`,
          `tags: [auto-distilled]`,
          `updated: ${new Date().toISOString().split('T')[0]}`,
          `confidence: inferred`,
          `confidence_score: 0.7`,
          '---',
          '',
          `# ${normalizedName}`,
          '',
          activitySection,
        ].join('\n');

        writeEntry(config.memoryDir, 'projects', filename, content);
        created.push(`projects/${filename}`);
      }
    } catch (err) {
      console.error(`[knowledge] Failed to distill project ${normalizedName}: ${err}`);
    }

    if (pi.latestDate > latestDate) {
      latestDate = pi.latestDate;
    }
  }

  if (updated.length > 0 || created.length > 0) {
    const count = updated.length + created.length;
    await gitPush(config.memoryDir, `distill: update ${count} project(s) from session insights`);
  }

  if (latestDate) {
    setLastDistillTime(latestDate);
  }

  return { updated, created, skipped };
}

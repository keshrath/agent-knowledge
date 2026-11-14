import fs from 'fs';
import path from 'path';

export const CATEGORIES = ['projects', 'people', 'decisions', 'workflows', 'notes'] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * Sanitize a path component — reject null bytes and path traversal.
 */
export function sanitizePath(input: string): string {
  if (input.includes('\0')) {
    throw new Error('Path contains null bytes');
  }
  const normalized = input.replace(/\\/g, '/');
  if (normalized.includes('..') || normalized.startsWith('/')) {
    throw new Error('Path traversal not allowed');
  }
  return input;
}

export interface KnowledgeEntry {
  path: string;
  title: string;
  tags: string[];
  updated: string;
  category: string;
  content?: string;
  confidence?: string; // 'extracted' | 'inferred'
  confidence_score?: number; // 0.0 - 1.0
  /**
   * When true, the entry is exempt from decay in ranking (see scoring.ts)
   * AND the promoter appends fresh activity instead of overwriting the body.
   * Use for durable decisions / architecture / identity.
   */
  evergreen?: boolean;
  /**
   * Optional free-form author string from frontmatter.
   * Examples: "human", "agent:opencode", "claude-code".
   * Shown on the entry's page in the /knowledge pane.
   */
  author?: string;
  /**
   * A session's record, not curated knowledge (`isSnapshot`): its category is `sessions`,
   * and Browse's all, the first-prompt hits and Analyze leave it out.
   */
  snapshot?: boolean;
}

/**
 * Whether an entry records a session rather than knowledge: a snapshot (`sessions/`), or what
 * the 2.x hooks wrote beside the curated entries: a `type` naming a session (session-end,
 * precompact, …), or their file names (`projects/session-<cwd>-<id>.md`,
 * `projects/precompact-<cwd>-<id>.md`, ending in the session id).
 */
export function isSnapshot(rel: string, meta: Record<string, string | string[]> = {}): boolean {
  if (rel.startsWith('sessions/')) return true;
  const type = typeof meta.type === 'string' ? meta.type.toLowerCase() : '';
  if (/^(?:session|pre-?compact)/.test(type)) return true;
  return /^projects\/(?:session|precompact)-.*[0-9a-f]{8}\.md$/i.test(rel);
}

/** The day an entry was written: its `updated`, else a date in its file name, else the file's. */
function dayOf(rel: string, updated: string, mtimeMs: number): string {
  if (updated) return updated;
  const name = rel.split('/').at(-1) ?? '';
  const m = /(\d{4})-?(\d{2})-?(\d{2})/.exec(name);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return `${m[1]}-${m[2]}-${m[3]}`;
  return Number.isFinite(mtimeMs) && mtimeMs > 0
    ? new Date(mtimeMs).toISOString().slice(0, 10)
    : '';
}

/**
 * A session record's name when its file gives none (the 2.x dumps): `project · day · what`, as
 * the snapshots are named. The project is its frontmatter's, its folder's (`cwd`), or the one
 * the 2.x file name carries (`projects/session-C--work-repo-<id>.md` → repo).
 */
function recordTitle(
  rel: string,
  meta: Record<string, string | string[]>,
  day: string,
  heading: string | undefined,
): string {
  const str = (k: string) => (typeof meta[k] === 'string' ? (meta[k] as string) : '');
  const slug = /(?:^|\/)(?:session|precompact|PreCompact)-(.+?)-[0-9a-f]{8,}\.md$/i.exec(rel)?.[1];
  const project =
    str('project') ||
    str('cwd').split(/[\\/]/).filter(Boolean).at(-1) ||
    (slug && !/^\d/.test(slug) ? slug.split('-').filter(Boolean).at(-1) : '') ||
    rel.split('/').at(-2) ||
    '';
  const what =
    heading ||
    (/pre-?compact/i.test(`${str('type')} ${rel}`) ? 'before a compaction' : 'session end');
  return [project, day, what].filter(Boolean).join(' · ');
}

/**
 * An entry as its file says it: the title its frontmatter gives, else its first heading, else
 * its path; the day (`dayOf`); a session's record told apart (`isSnapshot`).
 */
function entryOf(rel: string, content: string, mtimeMs: number): KnowledgeEntry {
  const { meta, body } = parseFrontmatter(content);
  const str = (k: string) => (typeof meta[k] === 'string' ? (meta[k] as string) : '');
  const confidenceScore = str('confidence_score') ? parseFloat(str('confidence_score')) : NaN;
  const evergreen = ['true', '1'].includes(str('evergreen').toLowerCase());
  const author = str('author').trim();
  const snapshot = isSnapshot(rel, meta);
  const heading = /^#\s+(.+?)\s*$/m.exec(body)?.[1];
  const updated = dayOf(rel, str('updated'), mtimeMs);
  return {
    path: rel,
    title:
      str('title') ||
      (snapshot ? recordTitle(rel, meta, updated, heading) : heading) ||
      rel.replace(/\.md$/, ''),
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    updated,
    category: snapshot ? 'sessions' : (rel.split('/')[0] ?? ''),
    ...(str('confidence') ? { confidence: str('confidence') } : {}),
    ...(!isNaN(confidenceScore) ? { confidence_score: confidenceScore } : {}),
    ...(evergreen ? { evergreen } : {}),
    ...(author ? { author } : {}),
    ...(snapshot ? { snapshot } : {}),
  };
}

/**
 * Parse YAML-like frontmatter delimited by `---`.
 * Extracts title, tags (as array), updated, and any other simple key-value pairs.
 */
/**
 * A YAML scalar as written in frontmatter, its value without the quotes: `"Task #1: x"` is
 * Task #1: x (`\"`, `\\`, `\n`, `\t` unescaped), `'it''s'` is it's; a plain one as it is.
 */
export function yamlScalar(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"'))
    return v.slice(1, -1).replace(/\\(["\\nt])/g, (_, c: string) => ({ n: '\n', t: '\t' })[c] ?? c);
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'"))
    return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

export function parseFrontmatter(content: string): {
  meta: Record<string, string | string[]>;
  body: string;
} {
  // Normalize \r\n to \n for cross-platform compatibility
  const normalized = content.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta: Record<string, string | string[]> = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (m) {
      const raw = m[2].trim();
      // Inline arrays like [tag1, "tag 2", 'tag3']
      meta[m[1]] =
        raw.startsWith('[') && raw.endsWith(']')
          ? raw
              .slice(1, -1)
              .split(',')
              .map((s: string) => yamlScalar(s.trim()))
              .filter((s: string) => s.length > 0)
          : yamlScalar(raw);
    }
  }

  return { meta, body: match[2] };
}

/** Every entry's path under `dir` (`base` prefixed): .md files, hidden folders skipped. */
export function getAllFiles(dir: string, base: string = ''): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      results.push(...getAllFiles(path.join(dir, entry.name), rel));
    } else if (entry.name.endsWith('.md')) {
      results.push(rel);
    }
  }

  return results;
}

/**
 * List all knowledge entries, optionally filtered by category and/or tag.
 */
export function listEntries(dir: string, category?: string, tag?: string): KnowledgeEntry[] {
  const searchDir = category ? path.join(dir, category) : dir;
  const files = getAllFiles(searchDir, category || '');
  const entries: KnowledgeEntry[] = [];

  for (const file of files) {
    const fullPath = path.join(dir, file);
    try {
      const entry = entryOf(
        file,
        fs.readFileSync(fullPath, 'utf-8'),
        fs.statSync(fullPath).mtimeMs,
      );
      if (tag && !entry.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) continue;
      entries.push(entry);
    } catch (err) {
      console.error('[knowledge] list entry:', err instanceof Error ? err.message : err);
      continue;
    }
  }

  return entries;
}

/**
 * The file of the entry at `entryPath` under `dir`. Throws for anything that is no entry, as
 * getAllFiles lists them: a path out of `dir`, a file that is not `.md`, a hidden file or one
 * in a hidden folder (`.git/config`, `.identity-declined`).
 */
function entryFile(dir: string, entryPath: string): string {
  sanitizePath(entryPath);
  const filePath = path.resolve(dir, entryPath);
  const root = path.resolve(dir);
  if (!filePath.startsWith(root + path.sep)) throw new Error('Path traversal not allowed');
  const parts = path.relative(root, filePath).split(path.sep);
  if (!filePath.endsWith('.md') || parts.some((p) => p.startsWith('.'))) {
    throw new Error(`Not a knowledge entry: ${entryPath}`);
  }
  return filePath;
}

/**
 * Read a specific entry by its relative path.
 * Includes path traversal protection.
 */
export function readEntry(
  dir: string,
  entryPath: string,
): { entry: KnowledgeEntry; content: string } {
  const filePath = entryFile(dir, entryPath);
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${entryPath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const entry: KnowledgeEntry = {
    ...entryOf(entryPath, content, fs.statSync(filePath).mtimeMs),
    content: parseFrontmatter(content).body,
  };

  return { entry, content };
}

/**
 * Write a knowledge entry to disk.
 * Validates the category, ensures the directory exists, and auto-adds .md extension.
 * Returns the relative path of the written file.
 */
export function writeEntry(
  dir: string,
  category: string,
  filename: string,
  content: string,
): string {
  if (!CATEGORIES.includes(category as Category)) {
    throw new Error(`Invalid category: ${category}. Must be one of: ${CATEGORIES.join(', ')}`);
  }

  // Reject filenames with path separators or traversal attempts
  if (/[/\\]/.test(filename) || filename.includes('..')) {
    throw new Error('Filename must not contain path separators or ".."');
  }

  const safeName = filename.endsWith('.md') ? filename : `${filename}.md`;
  const categoryDir = path.join(dir, category);

  if (!fs.existsSync(categoryDir)) {
    fs.mkdirSync(categoryDir, { recursive: true });
  }

  const filePath = path.resolve(categoryDir, safeName);

  // Path traversal protection
  if (!filePath.startsWith(path.resolve(dir))) {
    throw new Error('Path traversal not allowed');
  }

  fs.writeFileSync(filePath, content, 'utf-8');
  return `${category}/${safeName}`;
}

/**
 * Delete a knowledge entry.
 * Includes path traversal protection.
 * Returns true if the file was deleted, false if it didn't exist.
 */
export function deleteEntry(dir: string, entryPath: string): boolean {
  const filePath = entryFile(dir, entryPath);
  if (!fs.existsSync(filePath)) {
    return false;
  }

  fs.unlinkSync(filePath);
  return true;
}

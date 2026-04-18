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
}

/**
 * Parse YAML-like frontmatter delimited by `---`.
 * Extracts title, tags (as array), updated, and any other simple key-value pairs.
 */
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
      let val: string | string[] = m[2].trim();
      // Parse inline arrays like [tag1, tag2, tag3]
      if (val.startsWith('[') && val.endsWith(']')) {
        val = val
          .slice(1, -1)
          .split(',')
          .map((s: string) => s.trim())
          .filter((s: string) => s.length > 0);
      }
      meta[m[1]] = val;
    }
  }

  return { meta, body: match[2] };
}

/**
 * Recursively collect all .md files under a directory.
 * Skips directories starting with `.`
 */
function getAllFiles(dir: string, base: string = ''): string[] {
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
  const basePrefix = category || '';
  const files = getAllFiles(searchDir, basePrefix);
  const entries: KnowledgeEntry[] = [];

  for (const file of files) {
    const fullPath = path.join(dir, file);
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const { meta } = parseFrontmatter(content);

      // Filter by tag if specified
      if (tag) {
        const tags: string[] = Array.isArray(meta.tags) ? meta.tags : [];
        if (!tags.some((t) => t.toLowerCase() === tag.toLowerCase())) {
          continue;
        }
      }

      // Derive category from the first path segment
      const [entryCategory = ''] = file.split('/');

      const confidence = typeof meta.confidence === 'string' ? meta.confidence : undefined;
      const confidenceScore =
        typeof meta.confidence_score === 'string' ? parseFloat(meta.confidence_score) : undefined;
      const evergreenRaw = typeof meta.evergreen === 'string' ? meta.evergreen : undefined;
      const evergreen = evergreenRaw
        ? evergreenRaw.toLowerCase() === 'true' || evergreenRaw === '1'
        : undefined;

      entries.push({
        path: file,
        title: (typeof meta.title === 'string' ? meta.title : '') || file.replace(/\.md$/, ''),
        tags: Array.isArray(meta.tags) ? meta.tags : [],
        updated: (typeof meta.updated === 'string' ? meta.updated : '') || '',
        category: entryCategory,
        ...(confidence ? { confidence } : {}),
        ...(confidenceScore !== undefined && !isNaN(confidenceScore)
          ? { confidence_score: confidenceScore }
          : {}),
        ...(evergreen ? { evergreen } : {}),
      });
    } catch (err) {
      console.error('[knowledge] list entry:', err instanceof Error ? err.message : err);
      continue;
    }
  }

  return entries;
}

/**
 * Read a specific entry by its relative path.
 * Includes path traversal protection.
 */
export function readEntry(
  dir: string,
  entryPath: string,
): { entry: KnowledgeEntry; content: string } {
  sanitizePath(entryPath);
  const filePath = path.resolve(dir, entryPath);

  // Path traversal protection
  if (!filePath.startsWith(path.resolve(dir))) {
    throw new Error('Path traversal not allowed');
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${entryPath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const { meta, body } = parseFrontmatter(content);

  const [entryCategory = ''] = entryPath.split('/');

  const confidence = typeof meta.confidence === 'string' ? meta.confidence : undefined;
  const confidenceScore =
    typeof meta.confidence_score === 'string' ? parseFloat(meta.confidence_score) : undefined;
  const evergreenRaw = typeof meta.evergreen === 'string' ? meta.evergreen : undefined;
  const evergreen = evergreenRaw
    ? evergreenRaw.toLowerCase() === 'true' || evergreenRaw === '1'
    : undefined;

  const entry: KnowledgeEntry = {
    path: entryPath,
    title: (typeof meta.title === 'string' ? meta.title : '') || entryPath.replace(/\.md$/, ''),
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    updated: (typeof meta.updated === 'string' ? meta.updated : '') || '',
    category: entryCategory,
    content: body,
    ...(confidence ? { confidence } : {}),
    ...(confidenceScore !== undefined && !isNaN(confidenceScore)
      ? { confidence_score: confidenceScore }
      : {}),
    ...(evergreen ? { evergreen } : {}),
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
  sanitizePath(entryPath);
  const filePath = path.resolve(dir, entryPath);

  // Path traversal protection
  if (!filePath.startsWith(path.resolve(dir))) {
    throw new Error('Path traversal not allowed');
  }

  if (!fs.existsSync(filePath)) {
    return false;
  }

  fs.unlinkSync(filePath);
  return true;
}

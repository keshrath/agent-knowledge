// =============================================================================
// agent-knowledge — ingest freshness of a project folder
//
// Whether a folder was ingested with the knowledge-ingest skill, and how many
// of its source files changed since: the skill's `.knowledge-ingest-cache.json`
// holds a SHA-256 per file. Reads and hashes files only, no tokens.
// =============================================================================

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
// The walk tree-sitter-extract.mjs ingests by: the same folders, extensions and cap.
import { walkSources } from '../../scripts/source-walk.mjs';

export const INGEST_CACHE = '.knowledge-ingest-cache.json';

/** Folder entries the walk reads at most: a folder that is no project is not read through. */
const MAX_ENTRIES = 20_000;

/** Below this many source files a folder is not offered an ingest. */
const MIN_FILES = 3;

export type IngestFreshness =
  /** Too few source files to be worth an ingest, or no folder. */
  | { state: 'none' }
  | { state: 'never'; project: string; dir: string; files: number }
  | {
      state: 'current' | 'stale';
      project: string;
      dir: string;
      files: number;
      entries: number;
      changed: number;
      added: number;
      removed: number;
    };

/** The source files an ingest of `dir` would read, relative and `/`-separated. */
const sources = (dir: string) =>
  walkSources(dir, { maxEntries: MAX_ENTRIES }).map((f) =>
    relative(dir, f.fullPath).replace(/\\/g, '/'),
  );

/** A file's SHA-256, or null when it cannot be read (gone). */
function sha256(file: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(file, 'utf-8')).digest('hex');
  } catch {
    return null;
  }
}

/** The project's own name from its manifest, else the folder's name. */
function projectName(dir: string): string {
  const manifests: Array<[string, (text: string) => string | undefined]> = [
    ['package.json', (t) => (JSON.parse(t) as { name?: string }).name],
    ['Cargo.toml', (t) => /name\s*=\s*"([^"]+)"/.exec(t)?.[1]],
    ['go.mod', (t) => /module\s+(\S+)/.exec(t)?.[1]?.split('/').pop()],
    ['pyproject.toml', (t) => /name\s*=\s*"([^"]+)"/.exec(t)?.[1]],
  ];
  for (const [file, read] of manifests) {
    const p = join(dir, file);
    if (!existsSync(p)) continue;
    try {
      const name = read(readFileSync(p, 'utf-8'));
      if (name) return name;
    } catch {
      /* the next manifest, or the folder name */
    }
  }
  return basename(dir);
}

type IngestCache = {
  project?: string;
  files?: Record<string, { sha256?: string }>;
  entries_created?: unknown[];
};

export function ingestFreshness(cwd: string): IngestFreshness {
  const dir = resolve(cwd);
  if (!existsSync(dir)) return { state: 'none' };
  const cachePath = join(dir, INGEST_CACHE);

  if (!existsSync(cachePath)) {
    const files = sources(dir).length;
    return files < MIN_FILES
      ? { state: 'none' }
      : { state: 'never', project: projectName(dir), dir, files };
  }

  let cache: IngestCache;
  try {
    cache = JSON.parse(readFileSync(cachePath, 'utf-8')) as IngestCache;
  } catch {
    return { state: 'none' };
  }
  const cached = cache.files ?? {};
  // What was ingested, file by file; then what an ingest now would read that it did not.
  let changed = 0;
  let removed = 0;
  for (const [path, { sha256: was } = {}] of Object.entries(cached)) {
    const now = sha256(join(dir, path));
    if (now === null) removed++;
    else if (now !== was) changed++;
  }
  const added = sources(dir).filter((path) => !cached[path]).length;

  return {
    state: changed + added + removed === 0 ? 'current' : 'stale',
    project: cache.project ?? projectName(dir),
    dir,
    files: Object.keys(cached).length,
    entries: Array.isArray(cache.entries_created) ? cache.entries_created.length : 0,
    changed,
    added,
    removed,
  };
}

// =============================================================================
// source-walk.mjs — the source files a knowledge ingest reads
//
// One walk for tree-sitter-extract.mjs (what is ingested) and the server's
// ingest freshness (src/knowledge/ingest-freshness.ts: what changed since), so
// both see the same files: the same folders skipped, the same extensions, the
// same cap.
// =============================================================================

import { readdirSync, statSync } from 'fs';
import { extname, join } from 'path';
import { buildExtensionMap } from './tree-sitter-lang.mjs';

export const DEFAULT_EXCLUDE = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.next',
  '.nuxt',
  'coverage',
  '.pytest_cache',
  '.cargo',
  'bin',
  'obj',
  '.gradle',
  '.idea',
  '.vscode',
];

export const DEFAULT_MAX_FILES = 2000;

/** Extension (`.ts`) to the language that parses it. */
export const EXTENSIONS = buildExtensionMap();

/**
 * The source files under `dir` in walk order, up to `maxFiles`, sorted newest first. The walk
 * stops after `maxEntries` folder entries (files and folders seen), so a folder that is no
 * project (a home folder) is not read through.
 */
export function walkSources(
  dir,
  {
    exclude = DEFAULT_EXCLUDE,
    includeExts = [],
    maxFiles = DEFAULT_MAX_FILES,
    maxEntries = Infinity,
  } = {},
) {
  const files = [];
  let seen = 0;

  function walk(currentDir) {
    if (files.length >= maxFiles || seen >= maxEntries) return;
    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles || ++seen > maxEntries) return;
      const name = entry.name;
      if (exclude.some((ex) => name === ex || name.startsWith(ex + '/'))) continue;
      const fullPath = join(currentDir, name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = extname(name).toLowerCase();
        if (!EXTENSIONS.has(ext)) continue;
        if (includeExts.length > 0 && !includeExts.some((ie) => name.endsWith(ie) || ext === ie))
          continue;
        let mtime;
        try {
          mtime = statSync(fullPath).mtimeMs;
        } catch {
          continue;
        }
        files.push({ fullPath, ext, mtime });
      }
    }
  }

  walk(dir);
  files.sort((a, b) => b.mtime - a.mtime);
  return files;
}

#!/usr/bin/env node

// =============================================================================
// agent-knowledge SessionStart ingest hook
//
// On session start, detects the current project and checks whether a
// knowledge-ingest cache exists. If no cache: suggests bootstrapping.
// If cache exists: runs a quick SHA256 diff against the current files
// to report how many files changed since last ingest.
//
// Zero LLM tokens — only reads files and computes hashes.
// Fail-open: errors logged to stderr, always outputs valid JSON.
// =============================================================================

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, extname, resolve, dirname } from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

process.on('uncaughtException', (err) => {
  process.stderr.write(`[session-start-ingest] fatal: ${err.message}\n`);
  console.log(JSON.stringify({}));
  process.exit(0);
});

const SUPPORTED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.h',
  '.cpp',
  '.cc',
  '.cxx',
  '.hpp',
  '.hh',
  '.hxx',
]);

const DEFAULT_EXCLUDE = new Set([
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
]);

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function countFiles(dir, maxFiles = 500) {
  const hashes = new Map();
  let count = 0;

  function walk(currentDir) {
    if (count >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= maxFiles) return;
      if (DEFAULT_EXCLUDE.has(entry.name)) continue;
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
        count++;
        try {
          const content = readFileSync(fullPath, 'utf-8');
          const relPath = fullPath.slice(dir.length + 1).replace(/\\/g, '/');
          hashes.set(relPath, sha256(content));
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  walk(dir);
  return { hashes, totalFiles: count };
}

function detectProjectName(dir) {
  const checks = [
    { file: 'package.json', extract: (c) => JSON.parse(c).name },
    { file: 'Cargo.toml', extract: (c) => c.match(/name\s*=\s*"([^"]+)"/)?.[1] },
    {
      file: 'go.mod',
      extract: (c) =>
        c
          .match(/module\s+(\S+)/)?.[1]
          ?.split('/')
          .pop(),
    },
    { file: 'pyproject.toml', extract: (c) => c.match(/name\s*=\s*"([^"]+)"/)?.[1] },
  ];
  for (const { file, extract } of checks) {
    const p = join(dir, file);
    if (existsSync(p)) {
      try {
        return extract(readFileSync(p, 'utf-8'));
      } catch {
        // continue
      }
    }
  }
  return dir.split(/[\\/]/).pop();
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData = {};
  try {
    hookData = JSON.parse(input);
  } catch {
    // no stdin data
  }

  const cwd = hookData?.cwd || hookData?.workspace?.current_dir || process.cwd();
  const projectDir = resolve(cwd);

  const cachePath = join(projectDir, '.knowledge-ingest-cache.json');

  if (!existsSync(cachePath)) {
    const { totalFiles } = countFiles(projectDir, 100);
    if (totalFiles < 3) {
      console.log(JSON.stringify({}));
      return;
    }

    const projectName = detectProjectName(projectDir);
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: `knowledge-ingest: Project "${projectName}" (${totalFiles}+ source files) has not been ingested yet. Run \`/knowledge-ingest ${projectDir}\` to bootstrap the knowledge base.`,
        },
      }),
    );
    return;
  }

  let cache;
  try {
    cache = JSON.parse(readFileSync(cachePath, 'utf-8'));
  } catch {
    console.log(JSON.stringify({}));
    return;
  }

  const cachedFiles = cache.files || {};
  const { hashes: currentHashes } = countFiles(projectDir);

  let changed = 0;
  let added = 0;
  let removed = 0;

  for (const [path, hash] of currentHashes) {
    if (!cachedFiles[path]) {
      added++;
    } else if (cachedFiles[path].sha256 !== hash) {
      changed++;
    }
  }

  for (const path of Object.keys(cachedFiles)) {
    if (!currentHashes.has(path)) {
      removed++;
    }
  }

  const total = changed + added + removed;

  if (total === 0) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: `knowledge-ingest: Project "${cache.project}" knowledge is up to date (${Object.keys(cachedFiles).length} files, ${(cache.entries_created || []).length} entries).`,
        },
      }),
    );
    return;
  }

  const parts = [];
  if (changed > 0) parts.push(`${changed} changed`);
  if (added > 0) parts.push(`${added} new`);
  if (removed > 0) parts.push(`${removed} deleted`);

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `knowledge-ingest: Project "${cache.project}" has ${total} file changes since last ingest (${parts.join(', ')}). Run \`/knowledge-ingest ${projectDir}\` to update.`,
      },
    }),
  );
}

main().catch((err) => {
  process.stderr.write(`[session-start-ingest] ${err.message}\n`);
  console.log(JSON.stringify({}));
});

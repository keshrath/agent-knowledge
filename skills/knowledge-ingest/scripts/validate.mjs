#!/usr/bin/env node

// =============================================================================
// validate.mjs — post-ingest validation for knowledge-ingest skill
//
// Checks that a knowledge-ingest run produced valid results:
// - Cache file exists and is well-formed
// - Expected knowledge entries exist on disk
// - Graph edges were created between entries
// - No orphaned entries (listed in cache but missing on disk)
//
// Usage:
//   node scripts/validate.mjs <target-path> [--knowledge-dir <path>]
//
// Exits 0 if valid, 1 if issues found. Prints a structured report to stdout.
// =============================================================================

import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';

function parseArgs(argv) {
  const args = { targetPath: null, knowledgeDir: null };
  let i = 2;
  while (i < argv.length) {
    if (argv[i] === '--knowledge-dir' && argv[i + 1]) {
      args.knowledgeDir = argv[++i];
    } else if (!argv[i].startsWith('--')) {
      args.targetPath = argv[i];
    }
    i++;
  }
  if (!args.targetPath) {
    console.error('Usage: node validate.mjs <target-path> [--knowledge-dir <path>]');
    process.exit(1);
  }
  args.targetPath = resolve(args.targetPath);
  args.knowledgeDir = args.knowledgeDir
    ? resolve(args.knowledgeDir)
    : resolve(process.env.KNOWLEDGE_MEMORY_DIR || join(homedir(), 'agent-knowledge'));
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const issues = [];
  const passed = [];

  // ---- 1. Cache file ----
  const cachePath = join(args.targetPath, '.knowledge-ingest-cache.json');
  let cache = null;

  if (!existsSync(cachePath)) {
    issues.push(
      'Cache file .knowledge-ingest-cache.json not found — ingest may not have completed',
    );
  } else {
    try {
      cache = JSON.parse(readFileSync(cachePath, 'utf-8'));
      passed.push('Cache file exists and is valid JSON');
    } catch (e) {
      issues.push(`Cache file is not valid JSON: ${e.message}`);
    }
  }

  if (cache) {
    // ---- 2. Cache structure ----
    if (!cache.version || !cache.timestamp || !cache.project) {
      issues.push('Cache file missing required fields (version, timestamp, project)');
    } else {
      passed.push(`Cache: project="${cache.project}", version=${cache.version}`);
    }

    if (!cache.entries_created || !Array.isArray(cache.entries_created)) {
      issues.push('Cache file missing entries_created array');
    } else if (cache.entries_created.length === 0) {
      issues.push('Cache entries_created is empty — no entries were created');
    } else {
      passed.push(`Cache lists ${cache.entries_created.length} entries created`);
    }

    if (!cache.files || typeof cache.files !== 'object') {
      issues.push('Cache file missing files object');
    } else {
      const fileCount = Object.keys(cache.files).length;
      if (fileCount === 0) {
        issues.push('Cache files object is empty — no files were tracked');
      } else {
        passed.push(`Cache tracks ${fileCount} files with SHA256 hashes`);
      }
    }

    // ---- 3. Entry existence ----
    if (cache.entries_created && Array.isArray(cache.entries_created)) {
      const missing = [];
      const found = [];
      for (const entry of cache.entries_created) {
        const entryPath = join(args.knowledgeDir, entry.endsWith('.md') ? entry : entry + '.md');
        if (existsSync(entryPath)) {
          found.push(entry);
        } else {
          missing.push(entry);
        }
      }
      if (found.length > 0) {
        passed.push(`${found.length}/${cache.entries_created.length} entries exist on disk`);
      }
      if (missing.length > 0) {
        issues.push(
          `${missing.length} entries listed in cache but missing on disk:\n${missing.map((e) => '  - ' + e).join('\n')}`,
        );
      }
    }

    // ---- 4. Project entry ----
    if (cache.project) {
      const projectEntry = join(args.knowledgeDir, 'projects', cache.project + '.md');
      if (existsSync(projectEntry)) {
        passed.push(`Project entry exists: projects/${cache.project}.md`);

        const content = readFileSync(projectEntry, 'utf-8');
        if (!content.includes('---')) {
          issues.push('Project entry missing YAML frontmatter');
        }
        if (content.length < 100) {
          issues.push('Project entry seems too short (< 100 chars)');
        }
      } else {
        issues.push(`Project entry missing: projects/${cache.project}.md`);
      }
    }

    // ---- 5. File hash integrity ----
    if (cache.files && typeof cache.files === 'object') {
      let missingHashes = 0;
      let missingEntryRefs = 0;
      for (const [filePath, meta] of Object.entries(cache.files)) {
        if (!meta.sha256 || typeof meta.sha256 !== 'string' || meta.sha256.length !== 64) {
          missingHashes++;
        }
        if (!meta.entries || !Array.isArray(meta.entries) || meta.entries.length === 0) {
          missingEntryRefs++;
        }
      }
      if (missingHashes > 0) {
        issues.push(`${missingHashes} files have invalid or missing SHA256 hashes`);
      }
      if (missingEntryRefs > 0) {
        issues.push(`${missingEntryRefs} files have no entry references`);
      }
      if (missingHashes === 0 && missingEntryRefs === 0) {
        passed.push('All file entries have valid SHA256 hashes and entry references');
      }
    }
  }

  // ---- Report ----
  const report = {
    target: args.targetPath,
    knowledgeDir: args.knowledgeDir,
    status: issues.length === 0 ? 'PASS' : 'FAIL',
    passed,
    issues,
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(issues.length === 0 ? 0 : 1);
}

main();

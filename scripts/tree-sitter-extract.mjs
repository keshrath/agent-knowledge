#!/usr/bin/env node

// =============================================================================
// tree-sitter-extract.mjs — deterministic structural extraction from codebases
//
// Parses source files via web-tree-sitter (WASM) and outputs a JSON structure
// containing symbols, imports, exports, call edges, rationale comments, and
// a file-level dependency graph. Zero LLM tokens consumed.
//
// Usage:
//   node scripts/tree-sitter-extract.mjs <path> [options]
//
// Options:
//   --include "*.py,*.ts"       Glob patterns to include (default: all supported)
//   --exclude "node_modules,dist"  Directories/patterns to exclude
//   --max-files 2000            Cap on number of files to process
//   --json                      Pretty-print JSON output (default: compact)
// =============================================================================

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname, relative, resolve, dirname } from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { LANGUAGE_CONFIG, RATIONALE_PATTERNS, buildExtensionMap } from './tree-sitter-lang.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

// ---- Defaults ----

const DEFAULT_EXCLUDE = [
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

const DEFAULT_MAX_FILES = 2000;

// ---- CLI argument parsing ----

function parseArgs(argv) {
  const args = {
    path: null,
    include: [],
    exclude: [...DEFAULT_EXCLUDE],
    maxFiles: DEFAULT_MAX_FILES,
    pretty: false,
  };
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--include' && argv[i + 1]) {
      args.include = argv[++i].split(',').map((s) => s.trim());
    } else if (arg === '--exclude' && argv[i + 1]) {
      args.exclude = [...DEFAULT_EXCLUDE, ...argv[++i].split(',').map((s) => s.trim())];
    } else if (arg === '--max-files' && argv[i + 1]) {
      args.maxFiles = parseInt(argv[++i], 10);
    } else if (arg === '--json') {
      args.pretty = true;
    } else if (!arg.startsWith('--')) {
      args.path = arg;
    }
    i++;
  }
  if (!args.path) {
    console.error(
      'Usage: node tree-sitter-extract.mjs <path> [--include "*.py,*.ts"] [--exclude "dir1,dir2"] [--max-files N] [--json]',
    );
    process.exit(1);
  }
  args.path = resolve(args.path);
  return args;
}

// ---- File discovery ----

function walkDir(dir, exclude, extMap, includeExts, maxFiles) {
  const files = [];

  function walk(currentDir) {
    if (files.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const name = entry.name;
      if (exclude.some((ex) => name === ex || name.startsWith(ex + '/'))) continue;
      const fullPath = join(currentDir, name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = extname(name).toLowerCase();
        if (!extMap.has(ext)) continue;
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
  return files.slice(0, maxFiles);
}

// ---- Tree-sitter initialization ----

let TreeSitter;
let parserInstance;
const loadedLanguages = new Map();

async function initTreeSitter() {
  const mod = await import('web-tree-sitter');
  TreeSitter = mod.default || mod;
  await TreeSitter.init();
  parserInstance = new TreeSitter();
}

async function getLanguage(langName) {
  if (loadedLanguages.has(langName)) return loadedLanguages.get(langName);
  const config = LANGUAGE_CONFIG[langName];
  if (!config) return null;

  let wasmPath;
  try {
    wasmPath = require.resolve(config.grammarPackage);
  } catch {
    try {
      wasmPath = fileURLToPath(import.meta.resolve(config.grammarPackage));
    } catch {
      return null;
    }
  }

  const lang = await TreeSitter.Language.load(wasmPath);
  loadedLanguages.set(langName, lang);
  return lang;
}

// ---- Extraction ----

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function extractRationale(source) {
  const results = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const pattern of RATIONALE_PATTERNS) {
      const re = new RegExp(pattern.source, pattern.flags.replace('g', ''));
      const match = re.exec(lines[i]);
      if (match) {
        results.push({
          line: i + 1,
          tag: match[1].toUpperCase(),
          text: match[2].trim(),
        });
        break;
      }
    }
  }
  return results;
}

function runQuery(tree, language, queryStr) {
  if (!queryStr || !queryStr.trim()) return [];
  try {
    const query = language.query(queryStr);
    return query.matches(tree.rootNode);
  } catch {
    return [];
  }
}

function extractDocstring(node, source) {
  const nextSibling = node.nextNamedSibling;
  if (nextSibling && nextSibling.type === 'expression_statement') {
    const child = nextSibling.firstNamedChild;
    if (child && child.type === 'string') {
      const text = child.text.replace(/^["']{1,3}|["']{1,3}$/g, '').trim();
      if (text.length > 0 && text.length < 500) return text;
    }
  }

  const prev = node.previousNamedSibling;
  if (prev && prev.type === 'comment') {
    const text = prev.text
      .replace(/^\/\*\*?|\*\/$/g, '')
      .replace(/^\s*\*\s?/gm, '')
      .trim();
    if (text.length > 0 && text.length < 500) return text;
  }

  let sibling = node.previousSibling;
  while (sibling && sibling.type === 'comment') {
    sibling = sibling.previousSibling;
  }
  if (sibling !== node.previousSibling && node.previousSibling?.type === 'comment') {
    const commentNodes = [];
    let s = node.previousSibling;
    while (s && s.type === 'comment') {
      commentNodes.unshift(s);
      s = s.previousSibling;
    }
    const text = commentNodes
      .map((c) => c.text.replace(/^\/\/\s?/, ''))
      .join('\n')
      .trim();
    if (text.length > 0 && text.length < 500) return text;
  }

  return null;
}

function getCapture(match, name) {
  const cap = match.captures.find((c) => c.name === name);
  return cap ? cap.node : null;
}

function getCaptureText(match, name) {
  const node = getCapture(match, name);
  return node ? node.text : null;
}

async function extractFile(filePath, langName, source) {
  const config = LANGUAGE_CONFIG[langName];
  const language = await getLanguage(langName);
  if (!language) return null;

  parserInstance.setLanguage(language);
  const tree = parserInstance.parse(source);

  const symbols = [];
  const imports = [];
  const exports = [];
  const calls = [];

  const classMatches = runQuery(tree, language, config.queries.classes);
  for (const match of classMatches) {
    const nameNode = getCapture(match, 'name');
    const mainCapture = match.captures.find((c) =>
      ['class', 'interface', 'struct', 'enum', 'trait', 'impl', 'typedef'].includes(c.name),
    );
    if (nameNode) {
      symbols.push({
        kind: mainCapture?.name || 'class',
        name: nameNode.text,
        line: nameNode.startPosition.row + 1,
        endLine: (mainCapture?.node || nameNode).endPosition.row + 1,
        params: null,
        docstring: extractDocstring(mainCapture?.node || nameNode, source),
      });
    }
  }

  const funcMatches = runQuery(tree, language, config.queries.functions);
  for (const match of funcMatches) {
    const nameNode = getCapture(match, 'name');
    const paramsNode = getCapture(match, 'params');
    const mainCapture = match.captures.find((c) =>
      ['func', 'method', 'arrow_decl', 'constructor'].includes(c.name),
    );
    if (nameNode) {
      symbols.push({
        kind: mainCapture?.name === 'method' ? 'method' : 'function',
        name: nameNode.text,
        line: nameNode.startPosition.row + 1,
        endLine: (mainCapture?.node || nameNode).endPosition.row + 1,
        params: paramsNode ? paramsNode.text : null,
        docstring: extractDocstring(mainCapture?.node || nameNode, source),
      });
    }
  }

  const importMatches = runQuery(tree, language, config.queries.imports);
  const importMap = new Map();
  for (const match of importMatches) {
    const sourceNode = getCapture(match, 'source');
    const nameNode = getCapture(match, 'imported_name');
    if (sourceNode) {
      const src = sourceNode.text.replace(/^["']|["']$/g, '');
      if (!importMap.has(src)) importMap.set(src, []);
      if (nameNode) importMap.get(src).push(nameNode.text);
    }
  }
  for (const [source, names] of importMap) {
    imports.push({ source, names: [...new Set(names)] });
  }

  if (config.queries.exports) {
    const exportMatches = runQuery(tree, language, config.queries.exports);
    for (const match of exportMatches) {
      const mainNode = match.captures[0]?.node;
      if (mainNode) {
        const text = mainNode.text;
        const nameMatch = text.match(
          /export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/,
        );
        if (nameMatch) exports.push(nameMatch[1]);
      }
    }
  }

  const callMatches = runQuery(tree, language, config.queries.calls);
  const seenCalls = new Set();
  for (const match of callMatches) {
    const calleeNode = getCapture(match, 'callee');
    if (calleeNode) {
      const callee = calleeNode.text;
      const line = calleeNode.startPosition.row + 1;
      const enclosingFunc = symbols.find(
        (s) =>
          (s.kind === 'function' || s.kind === 'method') && line >= s.line && line <= s.endLine,
      );
      const caller = enclosingFunc ? enclosingFunc.name : '<module>';
      const key = `${caller}→${callee}`;
      if (!seenCalls.has(key)) {
        seenCalls.add(key);
        calls.push({ caller, callee });
      }
    }
  }

  tree.delete();
  return { symbols, imports, exports, calls };
}

// ---- Dependency graph ----

function buildDependencyGraph(files, rootPath) {
  const graph = {};
  const pathMap = new Map();

  for (const f of files) {
    const rel = f.relativePath;
    pathMap.set(rel, true);
    const base = rel.replace(/\.[^.]+$/, '');
    pathMap.set(base, rel);
    const indexBase = base.replace(/\/index$/, '');
    if (indexBase !== base) pathMap.set(indexBase, rel);
  }

  for (const f of files) {
    if (!f.extracted) continue;
    const deps = [];
    for (const imp of f.extracted.imports) {
      const src = imp.source;
      if (src.startsWith('.')) {
        const dir = dirname(f.relativePath);
        const resolved = join(dir, src).replace(/\\/g, '/');
        const found = pathMap.get(resolved);
        if (found && found !== true) deps.push(found);
        else if (pathMap.has(resolved)) deps.push(resolved);
      } else {
        deps.push(src.split('/')[0]);
      }
    }
    if (deps.length > 0) graph[f.relativePath] = [...new Set(deps)];
  }

  return graph;
}

// ---- Main ----

async function main() {
  const args = parseArgs(process.argv);
  const extMap = buildExtensionMap();

  const discovered = walkDir(args.path, args.exclude, extMap, args.include, args.maxFiles);

  await initTreeSitter();

  const fileResults = [];
  for (const file of discovered) {
    const langName = extMap.get(file.ext);
    let source;
    try {
      source = readFileSync(file.fullPath, 'utf-8');
    } catch {
      continue;
    }

    const relativePath = relative(args.path, file.fullPath).replace(/\\/g, '/');
    const hash = sha256(source);
    const rationale = extractRationale(source);
    const extracted = await extractFile(file.fullPath, langName, source);

    fileResults.push({
      path: relativePath,
      language: langName,
      sha256: hash,
      size: source.length,
      symbols: extracted?.symbols || [],
      imports: extracted?.imports || [],
      exports: extracted?.exports || [],
      rationale,
      calls: extracted?.calls || [],
      relativePath,
      extracted,
    });
  }

  const dependencyGraph = buildDependencyGraph(fileResults, args.path);

  const output = {
    version: 1,
    timestamp: new Date().toISOString(),
    root: args.path.replace(/\\/g, '/'),
    fileCount: fileResults.length,
    files: fileResults.map((f) => ({
      path: f.path,
      language: f.language,
      sha256: f.sha256,
      size: f.size,
      symbols: f.symbols,
      imports: f.imports,
      exports: f.exports,
      rationale: f.rationale,
      calls: f.calls,
    })),
    dependencyGraph,
  };

  const json = args.pretty ? JSON.stringify(output, null, 2) : JSON.stringify(output);
  process.stdout.write(json + '\n');
}

main().catch((err) => {
  console.error('tree-sitter-extract failed:', err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});

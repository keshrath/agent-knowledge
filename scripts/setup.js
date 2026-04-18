#!/usr/bin/env node

// =============================================================================
// agent-knowledge setup script
//
// Configures an MCP-compatible AI agent to use agent-knowledge.
// Currently supports: Claude Code (auto-detected via ~/.claude.json)
//
// What it does:
// - Builds the project if dist/ is missing
// - Registers the MCP server in the agent's config
// - Adds lifecycle hooks for Claude Code (SessionStart banner, PreCompact
//   flush + distill, SessionEnd distill)
// - Adds permission for mcp__agent-knowledge__* tools
//
// Usage: node scripts/setup.js [--agent claude|generic]
// =============================================================================

import { readFileSync, writeFileSync, existsSync, statSync, cpSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(join(__dirname, '..'));
const HOME = homedir();
const CLAUDE_JSON = join(HOME, '.claude.json');
const SETTINGS_JSON = join(HOME, '.claude', 'settings.json');

const AGENT_FLAG = process.argv.find((_a, i, arr) => arr[i - 1] === '--agent') ?? 'auto';
const IS_CLAUDE = AGENT_FLAG === 'claude' || (AGENT_FLAG === 'auto' && existsSync(CLAUDE_JSON));

console.log('agent-knowledge setup\n');
console.log(`Agent type: ${IS_CLAUDE ? 'Claude Code' : 'Generic (manual MCP config)'}`);

// ---------------------------------------------------------------------------
// Build if needed
// ---------------------------------------------------------------------------

if (!existsSync(join(PROJECT_DIR, 'dist', 'index.js'))) {
  console.log('Building agent-knowledge...');
  execSync('npm run build', { cwd: PROJECT_DIR, stdio: 'inherit' });
  console.log('');
}

// ---------------------------------------------------------------------------
// Register MCP server
// ---------------------------------------------------------------------------

const distPath = join(PROJECT_DIR, 'dist', 'index.js');

console.log('Registering MCP server...');
if (IS_CLAUDE && existsSync(CLAUDE_JSON)) {
  const config = JSON.parse(readFileSync(CLAUDE_JSON, 'utf-8'));
  if (!config.mcpServers) config.mcpServers = {};

  config.mcpServers['agent-knowledge'] = {
    type: 'stdio',
    command: 'node',
    args: [distPath],
    env: {},
  };

  writeFileSync(CLAUDE_JSON, JSON.stringify(config, null, 2));
  console.log(`  Added agent-knowledge MCP server → ${distPath}`);
} else {
  console.log('  Add this to your MCP client config:');
  console.log('  {');
  console.log('    "mcpServers": {');
  console.log('      "agent-knowledge": {');
  console.log('        "command": "node",');
  console.log(`        "args": ["${distPath.replace(/\\/g, '/')}"]`);
  console.log('      }');
  console.log('    }');
  console.log('  }');
}

// ---------------------------------------------------------------------------

if (!IS_CLAUDE) {
  console.log(`
Setup complete!

Start the dashboard:  node dist/server.js
MCP server (stdio):   node dist/index.js
Dashboard URL:        http://localhost:3423
`);
  process.exit(0);
}

console.log('Configuring Claude Code hooks...');
if (!existsSync(SETTINGS_JSON)) {
  console.log('  Warning: settings.json not found. Configure hooks manually.');
  process.exit(0);
}

const settings = JSON.parse(readFileSync(SETTINGS_JSON, 'utf-8'));

if (!settings.permissions) settings.permissions = {};
if (!settings.permissions.allow) settings.permissions.allow = [];
if (!settings.permissions.allow.includes('mcp__agent-knowledge__*')) {
  settings.permissions.allow.push('mcp__agent-knowledge__*');
  console.log('  Added mcp__agent-knowledge__* permission');
}

if (!settings.hooks) settings.hooks = {};

const hookDir = join(PROJECT_DIR, 'scripts', 'hooks');

function addUnmatchedHook(eventName, marker, command, timeout = 10) {
  if (!settings.hooks[eventName]) settings.hooks[eventName] = [];
  const groups = settings.hooks[eventName];
  const existing = groups.find(
    (g) => g.hooks && g.hooks.some((h) => h.command && h.command.includes(marker)),
  );
  if (existing) {
    console.log(`  ${eventName} (${marker}): already configured`);
    return;
  }
  if (groups.length > 0 && groups[0].hooks && !groups[0].matcher) {
    groups[0].hooks.push({ type: 'command', command, timeout });
  } else {
    groups.push({ hooks: [{ type: 'command', command, timeout }] });
  }
  console.log(`  ${eventName}: added ${marker} hook`);
}

// SessionStart: dashboard banner
addUnmatchedHook(
  'SessionStart',
  'session-start.js',
  `node "${join(hookDir, 'session-start.js')}"`,
  5,
);

// SessionStart: knowledge-ingest freshness check
addUnmatchedHook(
  'SessionStart',
  'session-start-ingest.mjs',
  `node "${join(hookDir, 'session-start-ingest.mjs')}"`,
  10,
);

// UserPromptSubmit: targeted knowledge injection on the session's first real prompt
addUnmatchedHook(
  'UserPromptSubmit',
  'first-prompt-inject.mjs',
  `node "${join(hookDir, 'first-prompt-inject.mjs')}"`,
  10,
);

// PreCompact: rich summary (library) + simple text distill (heuristic)
addUnmatchedHook(
  'PreCompact',
  'precompact-flush.mjs',
  `node "${join(hookDir, 'precompact-flush.mjs')}"`,
  10,
);
addUnmatchedHook(
  'PreCompact',
  'precompact-distill.mjs',
  `node "${join(hookDir, 'precompact-distill.mjs')}"`,
  10,
);

// SessionEnd: simple text distill for cross-machine memory
addUnmatchedHook(
  'SessionEnd',
  'sessionend-distill.mjs',
  `node "${join(hookDir, 'sessionend-distill.mjs')}"`,
  10,
);

writeFileSync(SETTINGS_JSON, JSON.stringify(settings, null, 2));
console.log('  Saved settings.json');

// ---------------------------------------------------------------------------
// Install knowledge-ingest skill
// ---------------------------------------------------------------------------

console.log('Installing knowledge-ingest skill...');

const skillSrc = join(PROJECT_DIR, 'skills', 'knowledge-ingest', 'SKILL.md');

const skillDests = [
  join(HOME, '.claude', 'skills', 'knowledge-ingest', 'SKILL.md'),
  join(HOME, '.agents', 'skills', 'knowledge-ingest', 'SKILL.md'),
];

if (existsSync(skillSrc)) {
  const srcMtime = statSync(skillSrc).mtimeMs;
  for (const dest of skillDests) {
    mkdirSync(dirname(dest), { recursive: true });
    let shouldCopy = true;
    if (existsSync(dest)) {
      if (statSync(dest).mtimeMs >= srcMtime) {
        shouldCopy = false;
      }
    }
    if (shouldCopy) {
      cpSync(skillSrc, dest);
      console.log(`  Installed → ${dest}`);
    } else {
      console.log(`  Up to date → ${dest}`);
    }
  }
} else {
  console.log('  Warning: skills/knowledge-ingest/SKILL.md not found in repo');
}

console.log(`
Setup complete!

Restart Claude Code to load the new MCP server. Every session will now:
  - Show the knowledge dashboard URL + L0/L1 wakeup payload on start (session-start.js)
  - Report ingest freshness on start (session-start-ingest.mjs)
  - Inject query-targeted knowledge hits on the first real user prompt (first-prompt-inject.mjs)
  - Flush a rich session summary before compaction (precompact-flush.mjs)
  - Snapshot recent user prompts before compaction (precompact-distill.mjs)
  - Dump a final session summary on exit (sessionend-distill.mjs)

Dashboard: http://localhost:3423 (auto-starts on first MCP connection)
Knowledge base: ~/agent-knowledge/ (configurable via AGENT_KNOWLEDGE_MEMORY_DIR)

See docs/HOOKS.md for details and docs/SETUP.md for manual configuration.
`);

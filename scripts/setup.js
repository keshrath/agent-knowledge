#!/usr/bin/env node

// =============================================================================
// agent-knowledge setup script
//
// Configures an MCP-compatible AI agent to use agent-knowledge.
// Supports: Claude Code (auto-detected via ~/.claude.json) and OpenCode
// (auto-detected via ~/.config/opencode/opencode.json on Linux/macOS or
// %APPDATA%\opencode\opencode.json on Windows).
//
// What it does:
// - Builds the project if dist/ is missing
// - Registers the MCP server in the agent's config
// - Adds lifecycle hooks for Claude Code (SessionStart banner, PreCompact
//   flush + distill, SessionEnd distill)
// - Registers the opencode plugin ("agent-knowledge/opencode") in opencode.json
// - Adds permission for mcp__agent-knowledge__* tools
//
// Usage: node scripts/setup.js [--host=claude|opencode|all|auto]
//        node scripts/setup.js [--agent claude|generic]   # deprecated alias
//        node scripts/setup.js --host=opencode --workspace=/path/to/project
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

// OpenCode global config path — per opencode docs / XDG on Linux/macOS,
// %APPDATA%\opencode on Windows (APPDATA is always defined on supported Windows).
const OPENCODE_GLOBAL_JSON =
  process.platform === 'win32'
    ? join(process.env.APPDATA || join(HOME, 'AppData', 'Roaming'), 'opencode', 'opencode.json')
    : join(HOME, '.config', 'opencode', 'opencode.json');

function argValue(name) {
  const eqMatch = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eqMatch) return eqMatch.slice(name.length + 3);
  const idx = process.argv.findIndex((a) => a === `--${name}`);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return undefined;
}

const HOST_FLAG = argValue('host') || argValue('agent') || 'auto';
const WORKSPACE_FLAG = argValue('workspace');

function hostSelected(name) {
  if (HOST_FLAG === 'all') return true;
  if (HOST_FLAG === 'auto') {
    if (name === 'claude') return existsSync(CLAUDE_JSON);
    if (name === 'opencode') return existsSync(OPENCODE_GLOBAL_JSON) || !!WORKSPACE_FLAG;
    return false;
  }
  // Back-compat: `generic` from the old --agent flag means no host
  if (HOST_FLAG === 'generic') return false;
  return HOST_FLAG === name;
}

const IS_CLAUDE = hostSelected('claude');
const IS_OPENCODE = hostSelected('opencode');

console.log('agent-knowledge setup\n');
const active = [IS_CLAUDE && 'Claude Code', IS_OPENCODE && 'OpenCode'].filter(Boolean);
console.log(`Hosts: ${active.length ? active.join(', ') : 'Generic (manual MCP config)'}`);

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
} else if (!IS_OPENCODE) {
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
// Configure OpenCode
// ---------------------------------------------------------------------------

if (IS_OPENCODE) {
  const targets = [];
  if (WORKSPACE_FLAG) {
    const workspacePath = resolve(WORKSPACE_FLAG);
    const cfgPath = join(workspacePath, 'opencode.json');
    targets.push({ label: `workspace: ${workspacePath}`, path: cfgPath });
  } else if (existsSync(OPENCODE_GLOBAL_JSON)) {
    targets.push({ label: 'global', path: OPENCODE_GLOBAL_JSON });
  } else {
    console.log(
      `\nOpenCode: no opencode.json found at ${OPENCODE_GLOBAL_JSON}. Create it or pass --workspace=<path> to configure a project.`,
    );
  }

  for (const target of targets) {
    console.log(`\nConfiguring OpenCode (${target.label})...`);
    let cfg = {};
    if (existsSync(target.path)) {
      try {
        cfg = JSON.parse(readFileSync(target.path, 'utf-8')) || {};
      } catch (err) {
        console.log(`  Warning: could not parse ${target.path}: ${err.message}`);
        continue;
      }
    } else {
      mkdirSync(dirname(target.path), { recursive: true });
      cfg = { $schema: 'https://opencode.ai/config.json' };
    }

    if (!cfg.mcp) cfg.mcp = {};
    if (!cfg.mcp['agent-knowledge']) {
      cfg.mcp['agent-knowledge'] = {
        type: 'local',
        command: ['node', distPath],
        enabled: true,
        timeout: 60000,
      };
      console.log('  Added mcp.agent-knowledge');
    } else {
      console.log('  mcp.agent-knowledge: already configured');
    }

    if (!Array.isArray(cfg.plugin)) cfg.plugin = [];
    const pluginId = 'agent-knowledge/opencode';
    const already = cfg.plugin.some((p) =>
      typeof p === 'string' ? p === pluginId : Array.isArray(p) && p[0] === pluginId,
    );
    if (!already) {
      cfg.plugin.push(pluginId);
      console.log(`  Added plugin "${pluginId}"`);
    } else {
      console.log(`  plugin "${pluginId}": already configured`);
    }

    writeFileSync(target.path, JSON.stringify(cfg, null, 2) + '\n');
    console.log(`  Saved ${target.path}`);
  }
}

if (!IS_CLAUDE) {
  console.log(`
Setup complete!

Start the dashboard:  node dist/server.js
MCP server (stdio):   node dist/index.js
Dashboard URL:        http://localhost:3423
${
  IS_OPENCODE
    ? 'OpenCode: the plugin loads automatically on next session start. See docs/SETUP.md#opencode-plugins for env-var tuning.\n'
    : ''
}`);
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

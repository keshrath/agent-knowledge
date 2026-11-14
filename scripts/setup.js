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
// - Claude Code: says how to install the plugin (it runs the MCP server, the
//   knowledge-ingest skill and the mod with the /knowledge pane and the session
//   lifecycle), adds permission for mcp__agent-knowledge__* tools, and removes the
//   command hooks agent-knowledge 2.x installed (the mod replaces them)
// - OpenCode: registers the MCP server and the opencode plugin
//   ("agent-knowledge/opencode") in opencode.json
// - Any other client: prints the MCP config to add
// - Installs the knowledge-ingest skill to ~/.agents/skills (OpenCode, Cursor, Codex CLI,
//   Gemini CLI)
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

if (!IS_CLAUDE && !IS_OPENCODE) {
  console.log('Add this to your MCP client config:');
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

// ---------------------------------------------------------------------------
// knowledge-ingest skill for every host reading ~/.agents/skills (OpenCode, Cursor,
// Codex CLI, Gemini CLI). Claude Code gets it from the plugin.
// ---------------------------------------------------------------------------

const skillSrc = join(PROJECT_DIR, 'plugin', 'skills', 'knowledge-ingest', 'SKILL.md');
const skillDest = join(HOME, '.agents', 'skills', 'knowledge-ingest', 'SKILL.md');
if (existsSync(skillSrc)) {
  if (!existsSync(skillDest) || statSync(skillDest).mtimeMs < statSync(skillSrc).mtimeMs) {
    mkdirSync(dirname(skillDest), { recursive: true });
    cpSync(skillSrc, skillDest);
    console.log(`
Installed the knowledge-ingest skill → ${skillDest}`);
  }
}

if (!IS_CLAUDE) {
  console.log(`
Setup complete!

MCP server (stdio):   node dist/index.js
REST API:             http://localhost:3423 (served by the first MCP process)
${
  IS_OPENCODE
    ? 'OpenCode: the plugin loads automatically on next session start. See docs/SETUP.md#opencode-plugins for env-var tuning.\n'
    : ''
}`);
  process.exit(0);
}

console.log('Configuring Claude Code...');
if (existsSync(SETTINGS_JSON)) {
  const settings = JSON.parse(readFileSync(SETTINGS_JSON, 'utf-8'));

  if (!settings.permissions) settings.permissions = {};
  if (!settings.permissions.allow) settings.permissions.allow = [];
  if (!settings.permissions.allow.includes('mcp__agent-knowledge__*')) {
    settings.permissions.allow.push('mcp__agent-knowledge__*');
    console.log('  Added mcp__agent-knowledge__* permission');
  }

  // The command hooks 2.x installed: the plugin's mod does their work now, and their
  // scripts are gone, so each would fail at every session.
  const OLD_HOOKS = [
    'session-start.js',
    'session-start-ingest.mjs',
    'first-prompt-inject.mjs',
    'precompact-flush.mjs',
    'precompact-distill.mjs',
    'sessionend-distill.mjs',
  ];
  const isOld = (h) =>
    typeof h.command === 'string' &&
    h.command.includes('agent-knowledge') &&
    OLD_HOOKS.some((name) => h.command.includes(name));
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    for (const group of groups) {
      const before = group.hooks?.length ?? 0;
      group.hooks = (group.hooks ?? []).filter((h) => !isOld(h));
      if (group.hooks.length < before)
        console.log(
          `  ${event}: removed ${before - group.hooks.length} agent-knowledge 2.x hook(s)`,
        );
    }
    settings.hooks[event] = groups.filter((g) => g.hooks.length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }

  writeFileSync(SETTINGS_JSON, JSON.stringify(settings, null, 2));
  console.log('  Saved settings.json');
}

const config = existsSync(CLAUDE_JSON) ? JSON.parse(readFileSync(CLAUDE_JSON, 'utf-8')) : {};
const handWritten = config.mcpServers?.['agent-knowledge'];

console.log(`
Setup complete!

Install the plugin in Claude Code:
  claude plugin marketplace add keshrath/agent-knowledge
  claude plugin install agent-knowledge@agent-knowledge

It runs the MCP server, adds the knowledge-ingest skill and a mod that
  - names the knowledge base, who you are and the project's ingest state in each conversation
  - adds the matching entries to the first real prompt
  - snapshots the session into the knowledge base when it is compacted and when it ends
  - opens the knowledge base beside the conversation: /knowledge
${
  handWritten
    ? `\nRemove the hand-written "agent-knowledge" entry from ${CLAUDE_JSON} once the plugin is in,\nso the tools do not appear twice.\n`
    : ''
}
Knowledge base: ~/agent-knowledge/ (configurable via AGENT_KNOWLEDGE_MEMORY_DIR)
See docs/HOOKS.md for the lifecycle and docs/SETUP.md for other clients.
`);

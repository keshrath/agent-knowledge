// =============================================================================
// Unit tests never see the person's home: getConfig() auto-detects session
// roots under homedir() (~/.claude/projects, ~/.cursor/projects, ...) and reads
// the persisted config from APPDATA / XDG_CONFIG_HOME. Every test file starts
// with an empty scratch home instead.
//
// The real-CLI suites (AGENT_KNOWLEDGE_E2E_CLAUDE=1) keep the real home: the
// `claude` they spawn reads its login from it, and they isolate the server
// they test through its own env.
// =============================================================================

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.AGENT_KNOWLEDGE_E2E_CLAUDE !== '1') {
  const home = mkdtempSync(join(tmpdir(), 'ak-test-home-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = join(home, 'AppData', 'Roaming');
  process.env.XDG_CONFIG_HOME = join(home, '.config');
}

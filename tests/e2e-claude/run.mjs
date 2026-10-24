/* global process */
// `npm run e2e:claude`: the real Claude Code CLI suites, one file at a time (each starts
// its own claude processes; in parallel they fight over the terminal and the CPU).
import { spawnSync } from 'node:child_process';

const r = spawnSync(
  'npx',
  ['vitest', 'run', 'tests/e2e-claude/', '--no-file-parallelism', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, AGENT_KNOWLEDGE_E2E_CLAUDE: '1' },
  },
);
process.exit(r.status ?? 1);

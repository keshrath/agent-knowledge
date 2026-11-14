// =============================================================================
// The e2e knowledge base: what the worlds the real CLI runs in are seeded with, and how an
// entry is written as a file. Data only (no terminal), so the first-prompt eval reads it too.
// =============================================================================

/** One entry the seed writes: its path under the knowledge folder, frontmatter and body. */
export type SeedEntry = {
  path: string;
  title: string;
  tags?: string[];
  updated?: string;
  evergreen?: boolean;
  author?: string;
  /** More frontmatter, as a session snapshot carries (`session`, `cwd`, `branch`, `started`). */
  meta?: Record<string, string>;
  body: string;
};

export type SeedSession = {
  project: string;
  id: string;
  cwd: string;
  branch?: string;
  /** [role, text or content blocks (tool_use, tool_result), ISO time] */
  lines: ['user' | 'assistant', string | Record<string, unknown>[], string][];
};

export type Seed = {
  entries: SeedEntry[];
  sessions: SeedSession[];
  /** [source, target, rel_type, origin] */
  edges: [string, string, string, string][];
  /** Entry paths read this many times (their maturity follows the reads). */
  reads: Record<string, number>;
};

const LONG_BODY = [
  '# The /knowledge pane',
  '',
  'The web dashboard is gone; the pane is the way in.',
  '',
  ...Array.from({ length: 45 }, (_, i) => `- point ${i + 1}: something worth keeping`),
  '',
  '```ts',
  "const pane = 'agent-knowledge';",
  '```',
].join('\n');

/**
 * A knowledge base a person would recognise: projects with links between them, a decision,
 * a workflow kept evergreen, a person, notes, one long entry, one with a wide-character title,
 * a file at the top of the folder, and two sessions with something to summarise.
 */
export const SEED: Seed = {
  entries: [
    {
      path: 'projects/agent-tasks.md',
      title: 'agent-tasks 2.0',
      tags: ['release', 'pane'],
      updated: '2026-10-22',
      author: 'claude-code',
      body: '# agent-tasks 2.0\n\nThe board moved into the **/pipeline** pane.\n\n- REST stays on 3422\n- the dashboard is gone',
    },
    {
      path: 'projects/agent-knowledge.md',
      title: 'agent-knowledge 2.0',
      tags: ['release', 'pane'],
      updated: '2026-10-23',
      body: LONG_BODY,
    },
    {
      path: 'decisions/rest-only.md',
      title: 'REST only, no WebSocket',
      tags: ['architecture'],
      updated: '2026-10-18',
      body: '# REST only\n\nChose: plain REST polling.\nOver: a WebSocket.\nBecause: the pane polls anyway.',
    },
    {
      path: 'workflows/release.md',
      title: 'Release ritual',
      tags: ['release'],
      updated: '2026-10-15',
      evergreen: true,
      body: '# Release ritual\n\n1. build\n2. prettier\n3. eslint\n4. test\n5. tag and push',
    },
    {
      path: 'people/maintainer.md',
      title: 'The maintainer',
      updated: '2026-09-01',
      body: '# The maintainer\n\nPrefers net-negative diffs.',
    },
    {
      path: 'notes/zebrafish.md',
      title: 'Zebrafish deploy recipe',
      tags: ['deploy'],
      updated: '2026-10-10',
      body: '# Zebrafish\n\nThe zebrafish service deploys with `make ship`.',
    },
    {
      path: 'notes/wide.md',
      title: '設計レビューの記録とメモ 🚀 release notes',
      updated: '2026-10-05',
      body: '# 設計\n\nWide characters take two columns.',
    },
    {
      path: 'README.md',
      title: 'About this folder',
      updated: '2026-08-01',
      body: 'What lives here.',
    },
  ],
  sessions: [
    {
      project: 'agent-tasks',
      id: 'sess-pane-1',
      cwd: 'C:/work/agent-tasks',
      branch: 'main',
      lines: [
        ['user', 'move the board into a Claude Code pane', '2026-10-22T08:00:00.000Z'],
        [
          'assistant',
          'Edited plugin/hooks/view.tsx and ran the tests.',
          '2026-10-22T08:05:00.000Z',
        ],
        ['user', 'now test it in the real CLI with the quokka harness', '2026-10-22T09:00:00.000Z'],
        ['assistant', 'Error: TypeError: x is undefined, fixed it.', '2026-10-22T09:30:00.000Z'],
      ],
    },
    {
      project: 'agent-knowledge',
      id: 'sess-sync-2',
      cwd: 'C:/work/agent-knowledge',
      lines: [
        ['user', 'why did the git sync break', '2026-10-21T08:00:00.000Z'],
        [
          'assistant',
          [
            { type: 'text', text: 'Pushing again to see what the remote says.' },
            {
              type: 'tool_use',
              id: 'tu-0',
              name: 'Edit',
              input: { file_path: 'src/knowledge/git.ts' },
            },
            { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'git push' } },
          ],
          '2026-10-21T08:05:00.000Z',
        ],
        [
          'user',
          [
            {
              type: 'tool_result',
              tool_use_id: 'tu-1',
              content:
                "[main 4e5f6a7] Retry the push on a rejected sync\nError: failed to push some refs to 'origin' (non-fast-forward)",
            },
          ],
          '2026-10-21T08:06:00.000Z',
        ],
        ['assistant', 'The remote rejected the push.', '2026-10-21T08:20:00.000Z'],
      ],
    },
  ],
  edges: [
    ['projects/agent-knowledge.md', 'projects/agent-tasks.md', 'related_to', 'manual'],
    ['projects/agent-tasks.md', 'decisions/rest-only.md', 'depends_on', 'manual'],
    ['workflows/release.md', 'projects/agent-tasks.md', 'related_to', 'auto-link'],
  ],
  reads: { 'projects/agent-tasks.md': 6, 'decisions/rest-only.md': 2 },
};

/** An entry as its file: the frontmatter, then the body. */
export function entryFile(e: SeedEntry): string {
  const fm = [
    '---',
    `title: ${e.title}`,
    ...(e.tags?.length ? [`tags: [${e.tags.join(', ')}]`] : []),
    ...(e.updated ? [`updated: ${e.updated}`] : []),
    ...(e.evergreen ? ['evergreen: true'] : []),
    ...(e.author ? [`author: ${e.author}`] : []),
    ...Object.entries(e.meta ?? {}).map(([k, v]) => `${k}: ${v}`),
    '---',
    '',
  ];
  return `${fm.join('\n')}${e.body}\n`;
}

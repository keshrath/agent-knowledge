// =============================================================================
// The first-prompt hits, measured. Labelled first prompts in two sets: TUNE, which the rule
// (PROMPT_RULE) was shaped on, and HOLDOUT, the reviewers' prompts (rounds 6 and 7), which it
// never was. The holdout numbers are what the rule is judged by: no off-topic injection on any
// base, 80% of the injected hits on topic, and as many on-topic prompts answered as that
// allows. Bases: the rich seed, one shaped like a real store (2.x session dumps, filler in
// everyday words), the reviewers' seeds (round 6's and the e2e seed round 7 used), a
// business-software store; and, when AGENT_KNOWLEDGE_EVAL_STORE names a copy of a real one,
// that store with the reviewer's questions about it. The table is printed.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  invalidateKnowledgeIndexCache,
  searchKnowledge,
  PROMPT_RULE,
  askedAbout,
  type PromptRule,
} from '../src/knowledge/search.js';
import { SEED, entryFile } from './e2e-claude/seed.js';

type Entry = [path: string, title: string, body: string, tags?: string[]];

const CURATED: Entry[] = [
  [
    'projects/agent-tasks.md',
    'agent-tasks 2.0',
    'The board moved into the /pipeline pane. Its REST API stays on port 3422.',
    ['release', 'pane'],
  ],
  [
    'projects/agent-knowledge.md',
    'agent-knowledge 2.0',
    'The /knowledge pane. Its REST API listens on port 3423, loopback only.',
    ['pane'],
  ],
  [
    'decisions/rest-only.md',
    'REST only, no WebSocket',
    'Chose plain REST polling over a WebSocket: the pane polls anyway.',
    ['architecture'],
  ],
  [
    'workflows/release.md',
    'Release ritual',
    '1. build 2. prettier 3. eslint 4. test 5. tag and push to both remotes.',
    ['release'],
  ],
  [
    'workflows/agent-publish.md',
    'Releasing an agent-* repo',
    'Run /agent-publish: bump package.json and server.json, tag vX.Y.Z, push to origin and github; GitHub Actions publishes to npm.',
    ['release', 'npm'],
  ],
  [
    'people/maintainer.md',
    'The maintainer',
    'Prefers net-negative diffs and asks before every commit.',
  ],
  [
    'notes/zebrafish.md',
    'Zebrafish deploy recipe',
    'The zebrafish service deploys with make ship.',
    ['deploy'],
  ],
  [
    'notes/win-lock.md',
    'Windows file lock',
    'A dead process can hold a file lock on Windows: find it with handle.exe, then kill it.',
    ['windows'],
  ],
  [
    'notes/win-paths.md',
    'Windows path gotchas',
    'Backslashes in paths on Windows; normalise before comparing.',
    ['windows'],
  ],
  [
    'notes/css-tokens.md',
    'Pane CSS tokens',
    'The theme keys the pane draws with: success, error, warning, suggestion.',
  ],
  [
    'notes/git-sync.md',
    'Git sync of the knowledge base',
    'Pull, then push; a rejected push is pulled and retried once.',
    ['git'],
  ],
  [
    'notes/gotcha-npm.md',
    'npm ci fails on lockfile drift',
    'Regenerate the lockfile with the CI npm version, then commit it.',
    ['npm'],
  ],
  [
    'notes/gotcha-pty.md',
    'pty swallows the first keypress',
    'node-pty on Windows drops the first key: write it twice after spawn.',
    ['pty'],
  ],
  [
    'notes/gotcha-sqlite.md',
    'SQLite busy on Windows',
    'Another process holds the database: set busy_timeout to 5000.',
    ['sqlite'],
  ],
  [
    'notes/poems.md',
    'Poem formatting rules',
    'Poems in the docs are code blocks, one stanza each.',
  ],
];

/** A real store: filler in everyday words, and the 2.x hooks' session dumps beside them. */
const REAL: Entry[] = [
  ...CURATED,
  ...Array.from(
    { length: 60 },
    (_, i): Entry => [
      `notes/filler-${i}.md`,
      `Working notes ${i}`,
      `Good progress today on item ${i}; it looks fine and the work is done. Thanks for the review, morning standup next.`,
    ],
  ),
];
const DUMPS = Array.from({ length: 40 }, (_, i) => [
  `projects/session-C--Users-me-repo-${(0x3f2a9b10 + i).toString(16)}.md`,
  `---\ntype: session-end\n---\n\n## Prompts\n\n- looks good, ship it\n- thanks, that worked\n- good morning claude, how do I release agent-tasks?\n`,
]);

/** TUNE: [prompt, the entries that answer it (none: nothing may be injected)] */
const PROMPTS: [string, string[]][] = [
  // Chit-chat and acks: nothing to find.
  ['looks good, ship it', []],
  ['thanks, that worked', []],
  ['good morning claude', []],
  ['write me a poem about autumn leaves', []],
  ['perfect, thanks!', []],
  ['lgtm', []],
  ['hi there!', []],
  ['can you help me?', []],
  ['tell me a joke', []],
  ['nice work', []],
  ['continue', []],
  ['sounds good, go ahead', []],
  ['hello! how are you today?', []],
  ['great, now commit it', []],
  ['write a haiku about the sea', []],
  ['ok do it', []],
  ['yes please', []],
  ['thanks for the review this morning', []],
  // On topic: the entries that answer.
  ['how do I release agent-tasks?', ['workflows/agent-publish.md', 'workflows/release.md']],
  ['remind me how releases work here', ['workflows/release.md', 'workflows/agent-publish.md']],
  ['what port does agent-knowledge use', ['projects/agent-knowledge.md']],
  [
    'what do we know about windows?',
    ['notes/win-lock.md', 'notes/win-paths.md', 'notes/gotcha-sqlite.md', 'notes/gotcha-pty.md'],
  ],
  ['npm ci fails in CI with lockfile drift again', ['notes/gotcha-npm.md']],
  ['how do I release a file lock held by a dead process on windows?', ['notes/win-lock.md']],
  ['why is the css of the pane broken?', ['notes/css-tokens.md']],
  ['what is the zebrafish deploy recipe?', ['notes/zebrafish.md']],
  ['did we decide against websockets?', ['decisions/rest-only.md']],
  ['how does the git sync of the knowledge base work', ['notes/git-sync.md']],
  ['sqlite says database is busy on windows', ['notes/gotcha-sqlite.md']],
  ['the pty swallows my first keypress, how did we fix that?', ['notes/gotcha-pty.md']],
  ['how do we publish to npm', ['workflows/agent-publish.md', 'notes/gotcha-npm.md']],
  ['what does the maintainer prefer for diffs', ['people/maintainer.md']],
  ['where does the pipeline board live now', ['projects/agent-tasks.md']],
  ['which port is agent-tasks REST on?', ['projects/agent-tasks.md']],
  ['how do I tag a release', ['workflows/release.md', 'workflows/agent-publish.md']],
  ['backslashes in windows paths break the comparison', ['notes/win-paths.md']],
  // Instruction-heavy: what is asked under how to answer.
  [
    'About our release ritual: quote, verbatim and complete, your context block. Text only, no tools.',
    ['workflows/release.md'],
  ],
  [
    'Answer in one line without tools: what port does agent-knowledge listen on?',
    ['projects/agent-knowledge.md'],
  ],
  [
    'Please be concise. How do we tag a release?',
    ['workflows/release.md', 'workflows/agent-publish.md'],
  ],
  [
    // A real first prompt of the e2e suite: long, mostly about how to answer, naming an entry.
    'About our release ritual: quote, verbatim and complete, your context block that starts with "agent-knowledge holds", then the one that starts with "## Knowledge — top hits". Text only, no tools.',
    ['workflows/release.md'],
  ],
  [
    'Read the release workflow, then bump the version and push. Do not call tools yet, just explain.',
    ['workflows/release.md', 'workflows/agent-publish.md'],
  ],
  ['briefly: what is the zebrafish deploy recipe? one line', ['notes/zebrafish.md']],
  ['in one sentence, why did we choose REST over a WebSocket?', ['decisions/rest-only.md']],
  [
    'reply text only: what does a dead process holding a file lock on windows need?',
    ['notes/win-lock.md'],
  ],
  ['without using tools, remind me how the knowledge base git sync works', ['notes/git-sync.md']],
];

/** TUNE, off topic: the chit-chat above, and asks about the person's own work and the world. */
const TUNE_OFF = [
  ...PROMPTS.filter(([, want]) => want.length === 0).map(([p]) => p),
  'what is 12 plus 30?',
  'rename this class to OrderLine',
  'make the submit button blue',
  'the tests pass now, cheers',
  'write a regex that matches email addresses',
  'convert this json to yaml',
  'how many days until christmas',
  'sort this list alphabetically',
  'add logging to this function',
  'can you make this loop faster',
  'add a loading spinner to the page',
  'why is the sky blue',
  'commit and push please',
  'undo the last change',
  'what time is it in tokyo',
  'explain what a closure is in javascript',
  'write unit tests for this module',
  'delete the unused imports in this file',
];

/** HOLDOUT, off topic: the reviewers' (round 6, then round 7). Never tuned on. */
const HOLDOUT_OFF = [
  "ok that's fine, merge it",
  'can you write a limerick about a cat',
  "what's the weather like in Berlin today?",
  'good night, talk tomorrow',
  'awesome, thank you so much!',
  'explain quicksort in python',
  "translate 'hello world' into french",
  'hmm, try again please',
  'draft an email to my landlord about the heating',
  "let's refactor this function to be cleaner",
  'fix the failing test in this file',
  'can you rename the variable foo to bar everywhere',
  "what's 17 times 23?",
  'please summarize this PR description for me',
  'write a bash script that backs up my photos folder',
  'cool, push it',
  'add a dark mode toggle to the settings page',
  'how tall is the eiffel tower',
  'review my last commit for typos',
  'the build is green now, thanks',
];

/** The reviewer's rich seed (round 6): the e2e seed's entries and its own beside them. */
const REVIEW: Entry[] = [
  [
    'projects/agent-tasks.md',
    'agent-tasks 2.0',
    'The board moved into the /pipeline pane. REST stays on 3422; the dashboard is gone.',
    ['release', 'pane'],
  ],
  [
    'projects/agent-knowledge.md',
    'agent-knowledge 2.0',
    'The web dashboard is gone; the pane is the way in.',
    ['release', 'pane'],
  ],
  [
    'decisions/rest-only.md',
    'REST only, no WebSocket',
    'Chose: plain REST polling. Over: a WebSocket. Because: the pane polls anyway.',
    ['architecture'],
  ],
  [
    'workflows/release.md',
    'Release ritual',
    '1. build 2. prettier 3. eslint 4. test 5. tag and push',
    ['release'],
  ],
  ['people/maintainer.md', 'The maintainer', 'Prefers net-negative diffs.'],
  [
    'notes/zebrafish.md',
    'Zebrafish deploy recipe',
    'The zebrafish service deploys with make ship.',
    ['deploy'],
  ],
  ['notes/wide.md', '設計レビューの記録とメモ release notes', 'Wide characters take two columns.'],
  ['README.md', 'About this folder', 'What lives here.'],
  [
    'decisions/very-long-title.md',
    'Why we moved the knowledge base sync from a cron job to a post-write hook with retries, backoff and a conflict-resolution strategy that prefers the remote',
    'The cron sync lost writes. A post-write hook pushes at once, with retries and backoff. Chose the hook.',
    ['architecture', 'git', 'sync'],
  ],
  [
    'notes/narrow-table.md',
    'Ports',
    '| Service | Port |\n|---|---|\n| tasks | 3422 |\n| knowledge | 3423 |\n| discover | 3424 |',
    ['ports'],
  ],
  ...Array.from(
    { length: 30 },
    (_, i): Entry => [
      `notes/gotcha-${String(i + 1).padStart(2, '0')}.md`,
      `Gotcha ${i + 1}: ${['Windows paths need forward slashes in git bash', 'node-pty needs a rebuild after a Node upgrade', 'vitest excludes plugin/ on purpose', 'tsc -p plugin emits js into the folder'][i % 4]}`,
      `Gotcha number ${i + 1}. Remember it.`,
      i % 3 === 0 ? ['gotcha', 'windows'] : ['gotcha'],
    ],
  ),
];
/** HOLDOUT, on topic: the round-6 reviewer's questions about its seed. */
const REVIEW_ON: [string, (path: string, title: string) => boolean][] = [
  ['which port does agent-discover listen on?', (p) => p === 'notes/narrow-table.md'],
  [
    'node-pty broke after I upgraded node, what was the fix?',
    (p, t) => p.includes('gotcha') && t.includes('node-pty'),
  ],
  ['why did we move the knowledge sync off cron?', (p) => p === 'decisions/very-long-title.md'],
  ['how does zebrafish get deployed', (p) => p === 'notes/zebrafish.md'],
  [
    'git bash path problems on windows',
    (p, t) => p.includes('gotcha') && t.includes('Windows paths'),
  ],
  [
    'why does vitest not run the plugin tests?',
    (p, t) => p.includes('gotcha') && t.includes('vitest'),
  ],
  [
    'does tsc -p plugin put js files in the plugin folder?',
    (p, t) => p.includes('gotcha') && t.includes('tsc'),
  ],
  ['what does the maintainer think about big diffs', (p) => p === 'people/maintainer.md'],
  ['is there a websocket in agent-knowledge', (p) => p === 'decisions/rest-only.md'],
  ['where did the agent-tasks board go', (p) => p === 'projects/agent-tasks.md'],
];

/**
 * A store shaped like a person's real one, from a business-software shop (synthetic: the
 * shape, not the data): many project and module notes, code-style notes in everyday words
 * (refactor, function, email, draft, python, test), the notes the reviewer's questions are
 * about, and the 2.x hooks' dumps beside them.
 */
const MUK: Entry[] = [
  [
    'notes/windows-netstat-german-port-kill.md',
    'Windows: kill the process holding a port (German netstat)',
    'netstat -ano prints ABHÖREN, not LISTENING: grep for the port, then taskkill /PID.',
    ['windows'],
  ],
  [
    'notes/gemini-3-thought-signatures-and-provider-carry-state.md',
    'Gemini 3 thought signatures and the provider carry state',
    'Gemini 3 returns thought signatures that must be sent back with the next turn.',
    ['ai', 'gemini'],
  ],
  [
    'notes/odoo-test-loader-ignores-mixin-tests.md',
    'The Odoo test loader ignores tests on mixins',
    'A test class inheriting a mixin is skipped by the loader unless tagged; tag it post_install.',
    ['odoo', 'testing'],
  ],
  [
    'notes/dhl-paket-live-api-behaviour.md',
    'DHL Paket live API behaviour',
    'Live answers differ from the sandbox: label sizes and error codes.',
    ['dhl', 'shipping'],
  ],
  [
    'notes/dhl-paket-review-findings.md',
    'DHL Paket review findings',
    'Review of the DHL Paket connector: retries, label storage.',
    ['dhl', 'shipping'],
  ],
  [
    'decisions/packoneers-invoice-cc-follower-leak.md',
    'Packoneers: invoice CC followers leak',
    'Invoice emails added the CC address as a follower; removed in the mail hook.',
    ['packoneers', 'invoice'],
  ],
  [
    'workflows/gitlab-com-mr-creation-push-options.md',
    'GitLab: create an MR with push options',
    'git push -o merge_request.create -o merge_request.target=main',
    ['gitlab'],
  ],
  [
    'workflows/long-running-jobs-resume-not-restart.md',
    'Long-running jobs: resume, do not restart',
    'A job that runs for hours keeps its state and resumes after a crash.',
    ['jobs'],
  ],
  [
    'decisions/muk_ai_mistral_streaming_500.md',
    'muk_ai: Mistral streaming returns 500',
    'Streaming responses from Mistral fail with HTTP 500 on long tool calls.',
    ['muk_ai', 'mistral'],
  ],
  [
    'notes/gls-shopreturn-numberoflabels-bug.md',
    'GLS ShopReturn numberOfLabels bug',
    'GLS ShopReturn ignores numberOfLabels above one.',
    ['gls', 'shipping'],
  ],
  [
    'decisions/odoo19-module-icon-style.md',
    'Odoo 19 module icon style',
    'Module icons: flat, one colour, the Odoo 19 shape.',
    ['odoo', 'design'],
  ],
  ...[
    'muk_web_theme',
    'muk_web_chatter',
    'muk_mail',
    'muk_rest',
    'muk_dms',
    'muk_ai',
    'muk_report_designer',
    'muk_ai_workflows',
  ].flatMap((m, i): Entry[] => [
    [
      `projects/${m}.md`,
      `${m}`,
      `The ${m} module for Odoo 17 to 20: models, views, tests and the release notes.`,
      ['odoo', 'muk'],
    ],
    [
      `notes/${m}-migration.md`,
      `${m}: migrating to Odoo 19`,
      `Field renames, the new views and the python changes when ${m} moves to 19.0.`,
      ['odoo', 'migration'],
    ],
    [
      `notes/${m}-email-templates.md`,
      `${m}: email templates`,
      `The email templates ${m} ships, drafts and the mail layout.`,
      ['mail'],
    ],
    [
      `notes/${m}-tests-${i}.md`,
      `${m}: test setup`,
      `How the ${m} tests run: test tags, the test database, python unittest.`,
      ['testing'],
    ],
  ]),
  [
    'notes/codestyle-functions.md',
    'Code style: small functions',
    'Refactor a long function into small ones; each function does one thing and reads cleanly.',
    ['codestyle'],
  ],
  [
    'notes/codestyle-python-imports.md',
    'Code style: python imports',
    'Imports sorted, one per line, standard library first.',
    ['codestyle', 'python'],
  ],
  [
    'notes/codestyle-naming.md',
    'Code style: naming',
    'Names say what a thing is; a function name says what it does.',
    ['codestyle'],
  ],
  [
    'notes/codestyle-refactor.md',
    'Code style: refactor before adding',
    'Refactor the code a change touches before adding to it; keep the diff clean.',
    ['codestyle'],
  ],
  [
    'notes/invoice-draft-numbering.md',
    'Draft invoices keep no number',
    'A draft invoice has no sequence number until posted.',
    ['invoice', 'accounting'],
  ],
  [
    'notes/python-env.md',
    'Python environment for Odoo',
    'A venv per Odoo version; pip install -r requirements.txt.',
    ['python', 'odoo'],
  ],
  [
    'notes/translations.md',
    'Translations: po files',
    'Module translations live in i18n/*.po, German first.',
    ['i18n'],
  ],
  [
    'notes/weather-widget.md',
    'Weather widget in the dashboard',
    'The dashboard tile shows the weather for the company city.',
    ['dashboard'],
  ],
];
/** TUNE, on topic: questions about the business-software store. */
const MUK_ON: [string, string[]][] = [
  [
    'how do I kill a process holding a port on windows with german netstat?',
    ['notes/windows-netstat-german-port-kill.md', 'notes/windows-netstat-german-locale.md'],
  ],
  [
    "what's the deal with gemini 3 thought signatures?",
    ['notes/gemini-3-thought-signatures-and-provider-carry-state.md'],
  ],
  [
    'why does the odoo test loader skip my mixin tests?',
    ['notes/odoo-test-loader-ignores-mixin-tests.md'],
  ],
  [
    'dhl paket api behaves weird in live, what did we find?',
    ['notes/dhl-paket-live-api-behaviour.md', 'notes/dhl-paket-review-findings.md'],
  ],
  [
    'the packoneers invoice cc followers leak, remind me',
    ['decisions/packoneers-invoice-cc-follower-leak.md'],
  ],
  [
    'how do I create a gitlab MR with push options?',
    ['workflows/gitlab-com-mr-creation-push-options.md'],
  ],
  [
    'what were the rules for long running jobs, resume or restart?',
    ['workflows/long-running-jobs-resume-not-restart.md'],
  ],
  ['mistral streaming returns 500 in muk_ai', ['decisions/muk_ai_mistral_streaming_500.md']],
  ['gls shop return number of labels bug', ['notes/gls-shopreturn-numberoflabels-bug.md']],
  ['how should the odoo 19 module icon look?', ['decisions/odoo19-module-icon-style.md']],
];

/** The e2e seed (round 7's reviewer drove the real CLI on it), with its extras beside it. */
const E2E: Entry[] = [
  ...SEED.entries.map((e): Entry => [e.path, e.title, e.body, e.tags]),
  ...REVIEW.filter(([p]) => !SEED.entries.some((e) => e.path === p)),
];
const isGotcha = (what: string) => (p: string, t: string) =>
  p.includes('gotcha') && t.includes(what);
const is = (want: string) => (p: string) => p === want;
/** HOLDOUT, on topic: the round-7 reviewer's questions about the e2e seed. */
const E2E_ON: OnTopic = [
  ["what's the port table for our services?", is('notes/narrow-table.md')],
  ['after upgrading node the terminal library stopped working', isGotcha('node-pty')],
  [
    'what conflict strategy does the knowledge sync use when pushing fails?',
    is('decisions/very-long-title.md'),
  ],
  ['zebrafish make ship', is('notes/zebrafish.md')],
  ['steps to cut a release', is('workflows/release.md')],
  ['do we use websockets or polling for the pane?', is('decisions/rest-only.md')],
  ['who maintains this and what do they like?', is('people/maintainer.md')],
  ['plugin tests are not picked up by vitest, why', isGotcha('vitest')],
  ['where did the dashboard go for agent-tasks?', is('projects/agent-tasks.md')],
  ['path separators break in git bash on windows', isGotcha('Windows paths')],
];

/** A real store's copy (AGENT_KNOWLEDGE_EVAL_STORE): questions about entries a real one holds. */
const STORE = process.env.AGENT_KNOWLEDGE_EVAL_STORE;
/** TUNE, on topic, about a real store (each counted where the store holds its entry). */
const STORE_TUNE: [string, string[]][] = [
  [
    'how do I free a port on windows when netstat is in german?',
    ['notes/windows-netstat-german-port-kill.md'],
  ],
  [
    'my gif has static regions that flicker between frames',
    ['notes/gif-per-frame-palette-breaks-static-regions.md'],
  ],
  ['var() easing inside @keyframes does nothing', ['notes/css-keyframes-var-easing-ignored.md']],
  [
    'odoo xpath on a translated string gives a 500 on the german site',
    ['notes/odoo-xpath-translated-text-500.md'],
  ],
  [
    'submodule clone from gitlab.etrondev.at fails over ssh',
    ['notes/gitlab-etrondev-ssh-port-2224-submodules.md'],
  ],
  [
    'a stored compute field went stale, why?',
    ['notes/odoo-stale-stored-fields-behind-nonstored-computes.md'],
  ],
  [
    'my hand written po file imports nothing in odoo 19',
    ['notes/odoo-po-needs-occurrence-lines.md'],
  ],
  [
    'which eu hosted alternatives to melious do we have?',
    ['notes/melious-eu-inference-alternatives.md'],
  ],
  [
    'how do I batch print pdfs on the brother printer',
    ['workflows/brother-mfc-l2710dw-batch-pdf-printing.md'],
  ],
  [
    'can I edit a muk addon inside the customer submodule?',
    ['workflows/muk-addon-source-vs-mirror.md'],
  ],
  ['how to refresh the muk_ai model catalogue', ['workflows/muk-ai-model-catalogue-refresh.md']],
  [
    'what does mathias think about code comments',
    ['workflows/comments-in-code-mathias-preference.md', 'workflows/muk-code-comments-minimal.md'],
  ],
  ['is muk_ai the same as the odoo ee ai?', ['workflows/muk-ai-vs-odoo-ee-ai.md']],
  ['what size should odoo 19 module icons be', ['decisions/odoo19-module-icon-style.md']],
  [
    'where does the free vs paid boundary of muk_ai sit',
    ['decisions/muk-ai-free-paid-code-boundary.md'],
  ],
  [
    'mounting the muk_ai chatwindow in hoot needs which mocks',
    ['workflows/muk-ai-chatwindow-hoot-mount-gotchas.md'],
  ],
];
/** HOLDOUT, on topic: the round-7 reviewer's questions about a copy of the real store. */
const STORE_HOLDOUT: [string, string[]][] = [
  [
    'the meta shops checkout url, how does meta encode the products param?',
    ['notes/muk-product-feed-meta-checkout-url.md'],
  ],
  [
    "aimee says forbidden on every odoo tool call, what's wrong?",
    ['notes/agentidoo-stale-per-user-key-forbidden.md'],
  ],
  ['is the newsletter double opt-in confirm route safe?', ['notes/etron-newsletter-doi-gaps.md']],
  [
    'how can I see which version of my module is live on apps.odoo.com?',
    ['notes/odoo-apps-store-version-check.md'],
  ],
  [
    'my hoot test simulating a barcode scan on a new record form gets no events',
    ['workflows/odoo-hoot-newrecord-form-barcode-autofocus.md'],
  ],
  [
    "which payment term wins on an ESV quotation, the customer's or the template's?",
    ['decisions/etron-esv-payment-term-precedence.md'],
  ],
  [
    'is the down payment open amount bug real in muk_sale?',
    ['decisions/muk-sale-downpayment-open-amount.md'],
  ],
  [
    'the owl 3 codemod says nothing to migrate on my windows box',
    ['workflows/odoo-20-owl3-codemod-windows-noop.md'],
  ],
  ['pdf text extraction tests fail locally, pdfminer missing', ['notes/odoo19-dev-env-gotchas.md']],
  [
    'agent-tasks keeps deleting tasks I just created',
    ['notes/agent-tasks-system-creator-reaper.md'],
  ],
];

function makeKb(entries: Entry[], dumps: string[][] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-eval-'));
  for (const [rel, title, body, tags] of entries) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entryFile({ path: rel, title, body, ...(tags ? { tags } : {}) }));
  }
  for (const [rel, text] of dumps) {
    const file = path.join(dir, rel!);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text!);
  }
  return dir;
}

/** On-topic prompts, each answered when a hit passes its test. */
type OnTopic = [string, (path: string, title: string) => boolean][];

/** A base and its on-topic prompts. */
type Kb = {
  name: string;
  dir: string;
  /** Made for the eval (removed after), not a store's copy. */
  isScratch: boolean;
  tune: OnTopic;
  holdout: OnTopic;
  /** How close each entry is to a prompt in meaning (AGENT_KNOWLEDGE_EVAL_EMBED=1). */
  meaning?: Meaning;
};

type Score = {
  injected: number;
  quiet: number;
  found: number;
  asked: number;
  hits: number;
  right: number;
};

/**
 * How close in meaning a base's entries are to each prompt, for the hybrid rule: the local
 * model's embeddings, as the server keeps them (the cosine of an entry's closest chunk).
 * Only with AGENT_KNOWLEDGE_EVAL_EMBED=1 (the model is read from disk, a big base takes
 * minutes); an entry's vectors are kept in the system's temp folder by its text, for the
 * next run.
 */
const EMBED = process.env.AGENT_KNOWLEDGE_EVAL_EMBED === '1';
type Meaning = (prompt: string) => ReadonlyMap<string, number>;

async function meaningOf(dir: string, prompts: string[]): Promise<Meaning> {
  const { LocalEmbeddingProvider } = await import('../src/embeddings/local.js');
  const { chunkKnowledge } = await import('../src/vectorstore/chunker.js');
  const { listEntries, readEntry } = await import('../src/knowledge/store.js');
  const provider = new LocalEmbeddingProvider();
  const cacheDir = path.join(os.tmpdir(), 'ak-eval-vectors');
  fs.mkdirSync(cacheDir, { recursive: true });
  const cached = async (text: string): Promise<number[]> => {
    const file = path.join(cacheDir, `${createHash('sha256').update(text).digest('hex')}.json`);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    const v = await provider.embedOne(text);
    fs.writeFileSync(file, JSON.stringify(v));
    return v;
  };
  const entries = new Map<string, number[][]>();
  for (const e of listEntries(dir)) {
    if (e.snapshot) continue;
    const { content } = readEntry(dir, e.path);
    const chunks = chunkKnowledge(content).map((c) => c.text);
    const vs: number[][] = [];
    for (const c of chunks.length ? chunks : [e.title]) vs.push(await cached(c));
    entries.set(e.path, vs);
  }
  const asked = new Map<string, number[]>();
  for (const p of prompts) asked.set(p, await cached(askedAbout(p)));
  const dot = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + x * (b[i] ?? 0), 0);
  return (prompt) => {
    const v = asked.get(prompt)!;
    return new Map([...entries].map(([id, vs]) => [id, Math.max(...vs.map((c) => dot(c, v)))]));
  };
}

/**
 * What the person's first prompt carries: the server's answer to the mod's ask (`prompt=true`,
 * MMR, no snapshots).
 */
function injected(kb: Kb, prompt: string, rule: PromptRule, hybrid: boolean) {
  return searchKnowledge(kb.dir, prompt, {
    prompt: true,
    promptRule: rule,
    mmr: true,
    skipCategory: 'sessions',
    maxResults: 4,
    ...(hybrid && kb.meaning ? { similar: kb.meaning(prompt) } : {}),
  }).map((h) => h.entry);
}

function score(
  kb: Kb,
  off: string[],
  on: OnTopic,
  hybrid: boolean,
  rule: PromptRule = PROMPT_RULE,
): Score & { wrong: string[] } {
  const s = { injected: 0, quiet: 0, found: 0, asked: 0, hits: 0, right: 0, wrong: [] as string[] };
  for (const prompt of off) {
    s.quiet += 1;
    const got = injected(kb, prompt, rule, hybrid);
    if (got.length > 0) {
      s.injected += 1;
      s.wrong.push(`injected on "${prompt}": ${got.map((e) => e.path).join(', ')}`);
    }
  }
  for (const [prompt, ok] of on) {
    const got = injected(kb, prompt, rule, hybrid);
    s.asked += 1;
    s.hits += got.length;
    const right = got.filter((e) => ok(e.path, e.title)).length;
    s.right += right;
    if (right > 0) s.found += 1;
    if (right < got.length || right === 0)
      s.wrong.push(
        `${right ? 'extra' : 'missed'} on "${prompt}": ${got.map((e) => `${ok(e.path, e.title) ? '+' : '-'}${e.path}`).join(', ') || 'nothing'}`,
      );
  }
  return s;
}

const kbs: Kb[] = [];
const onOf = (list: [string, string[]][], dir?: string): OnTopic =>
  list
    .filter(
      ([, want]) => want.length > 0 && (!dir || want.some((w) => fs.existsSync(path.join(dir, w)))),
    )
    .map(([p, want]) => [p, (at: string) => want.includes(at)]);
beforeAll(async () => {
  const tune = onOf(PROMPTS);
  kbs.push(
    { name: 'rich seed', dir: makeKb(CURATED), isScratch: true, tune, holdout: [] },
    { name: 'real-store shape', dir: makeKb(REAL, DUMPS), isScratch: true, tune, holdout: [] },
    { name: "round 6's seed", dir: makeKb(REVIEW), isScratch: true, tune: [], holdout: REVIEW_ON },
    { name: 'e2e seed', dir: makeKb(E2E), isScratch: true, tune: [], holdout: E2E_ON },
    {
      name: 'business store',
      dir: makeKb(MUK, DUMPS),
      isScratch: true,
      tune: onOf(MUK_ON),
      holdout: [],
    },
  );
  if (STORE)
    kbs.push({
      name: 'real store copy',
      dir: STORE,
      isScratch: false,
      tune: onOf(STORE_TUNE, STORE),
      holdout: onOf(STORE_HOLDOUT, STORE),
    });
  invalidateKnowledgeIndexCache();
  if (EMBED)
    for (const kb of kbs)
      kb.meaning = await meaningOf(kb.dir, [
        ...TUNE_OFF,
        ...HOLDOUT_OFF,
        ...[...kb.tune, ...kb.holdout].map(([p]) => p),
      ]);
}, 60 * 60_000);
afterAll(() => {
  for (const kb of kbs) if (kb.isScratch) fs.rmSync(kb.dir, { recursive: true, force: true });
});

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '–');

describe('the first-prompt rule, measured', () => {
  it('has the labelled prompts it needs, the holdout apart from what was tuned', () => {
    expect(TUNE_OFF.length).toBeGreaterThanOrEqual(30);
    expect(HOLDOUT_OFF.length).toBe(20);
    for (const p of HOLDOUT_OFF) expect(TUNE_OFF).not.toContain(p);
  });

  it('prints its table; on the holdout it injects nothing off topic and 80% of its hits are on topic', () => {
    const rows = [
      '| knowledge base | rule | set | off-topic injected | on-topic answered | hits on topic |',
      '| --- | --- | --- | --- | --- | --- |',
    ];
    const held: [string, ReturnType<typeof score>][] = [];
    for (const hybrid of EMBED ? [false, true] : [false])
      for (const kb of kbs) {
        for (const [set, off, on] of [
          ['tune', TUNE_OFF, kb.tune],
          ['holdout', HOLDOUT_OFF, kb.holdout],
        ] as const) {
          const s = score(kb, off, on, hybrid);
          const mode = hybrid ? 'hybrid' : 'words';
          rows.push(
            `| ${kb.name} | ${mode} | ${set} | ${s.injected} of ${s.quiet} | ${s.asked ? `${s.found} of ${s.asked}` : '–'} | ${s.right} of ${s.hits} (${pct(s.right, s.hits)}) |`,
          );
          if (set === 'tune' || process.env.AGENT_KNOWLEDGE_EVAL_HOLDOUT_DETAIL === '1')
            for (const w of s.wrong) process.stdout.write(`${kb.name} (${mode}, ${set}): ${w}\n`);
          if (set === 'holdout') held.push([`${kb.name} (${mode})`, s]);
        }
      }
    process.stdout.write(`\n${rows.join('\n')}\n\n`);
    for (const mode of EMBED ? ['words', 'hybrid'] : ['words']) {
      const mine = held.filter(([name]) => name.endsWith(`(${mode})`));
      const all = mine.reduce(
        (t, [, s]) => ({
          found: t.found + s.found,
          asked: t.asked + s.asked,
          hits: t.hits + s.hits,
          right: t.right + s.right,
        }),
        { found: 0, asked: 0, hits: 0, right: 0 },
      );
      process.stdout.write(
        `holdout, ${mode}: answered ${all.found} of ${all.asked}, hits on topic ${all.right} of ${all.hits}\n`,
      );
      for (const [name, s] of mine) expect(s.injected, `${name}: off-topic injected`).toBe(0);
      expect(all.right / all.hits, `holdout (${mode}): hits on topic`).toBeGreaterThanOrEqual(0.8);
      expect(all.found / all.asked, `holdout (${mode}): answered`).toBeGreaterThanOrEqual(
        HOLDOUT_RECALL[mode]!,
      );
    }
  });
});

// AGENT_KNOWLEDGE_EVAL_SWEEP=1: the rule's dials over a grid, on the TUNE prompts only.
if (process.env.AGENT_KNOWLEDGE_EVAL_SWEEP === '1')
  it(
    'sweeps the dials on the tune prompts',
    () => {
      const out: string[] = [];
      const grid: Partial<PromptRule>[] = JSON.parse(
        process.env.AGENT_KNOWLEDGE_EVAL_GRID ?? '[{}]',
      );
      for (const dials of grid) {
        const rule = { ...PROMPT_RULE, ...dials };
        const t = { injected: 0, found: 0, asked: 0, hits: 0, right: 0 };
        for (const kb of kbs) {
          const s = score(kb, TUNE_OFF, kb.tune, EMBED, rule);
          t.injected += s.injected;
          t.found += s.found;
          t.asked += s.asked;
          t.hits += s.hits;
          t.right += s.right;
        }
        out.push(
          `${JSON.stringify(dials)}: off ${t.injected}, answered ${t.found}/${t.asked}, on topic ${t.right}/${t.hits}`,
        );
      }
      process.stdout.write(`${out.join('\n')}\n`);
    },
    60 * 60_000,
  );

/**
 * The holdout recall each rule reached when it was settled (measured, never tuned for), with
 * or without a real store's copy: it may not fall. Words: 10 of 20 on the seeds, 12 of 30 with
 * the real store; hybrid: 12 of 20, 17 of 30.
 */
const HOLDOUT_RECALL: Record<string, number> = { words: 0.4, hybrid: 0.55 };

# Contributing to agent-knowledge

## Getting Started

1. Clone the repository:
   ```bash
   git clone https://github.com/keshrath/agent-knowledge.git
   cd agent-knowledge
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build:
   ```bash
   npm run build
   ```

## Development Setup

### Prerequisites

- **Node.js >= 20** (LTS recommended)
- **Git** (for knowledge base sync)
- A knowledge base repo (or create one):
  ```bash
  mkdir -p ~/agent-knowledge && cd ~/agent-knowledge && git init
  mkdir projects people decisions workflows notes
  ```

### Development Mode

```bash
# Watch mode — recompiles on changes
npm run dev

# Run tests (each test file gets a scratch HOME: no test reads your real sessions or config)
npm test
npm run test:watch

# The Claude Code plugin (/knowledge pane): validate and run its tests
npm run plugin:check

# Every MCP tool and action through the real Claude Code CLI (needs npm run build
# and a logged-in claude; scratch HOME, knowledge dir, git remote and port)
AGENT_KNOWLEDGE_E2E_CLAUDE=1 npx vitest run tests/e2e-claude/mcp.e2e.test.ts
```

### Environment

```bash
export AGENT_KNOWLEDGE_MEMORY_DIR=~/agent-knowledge
export AGENT_KNOWLEDGE_DATA_DIR=~/.claude   # primary session dir (other tools auto-detected)
export AGENT_KNOWLEDGE_PORT=3423            # local REST API (the pane, hooks, agent-tasks)
```

## Project Structure

```
agent-knowledge/
  src/
    index.ts              Entry point (MCP stdio; the REST port holder runs the background indexer)
    server.ts             MCP server, 6 tool definitions, request routing
    rest-server.ts        REST server on 127.0.0.1, leader election with takeover
    transport/            rest.ts (routes), http.ts (json, readBody, Router), guard.ts
    events.ts             Live event ring (POST /api/events)
    types.ts              KnowledgeConfig, getConfig()
    knowledge/            store, search, git, graph, scoring, consolidate, reflect, analyze, promote
    sessions/             parser, indexer, search, scopes, summary, adapters/
    search/               tfidf, fuzzy, excerpt
    embeddings/           local, openai, claude, gemini providers
    vectorstore/          SQLite vector store, chunker
  plugin/                 Claude Code plugin: .mcp.json, skills/knowledge-ingest, the /knowledge pane mod
  scripts/
    hooks/                Claude Code lifecycle hooks (see docs/HOOKS.md)
    plugins/opencode/     opencode plugin
    setup.js              Setup wizard
  tests/
    *.test.ts             vitest unit + integration tests (setup-home.ts isolates HOME)
    hooks/                every hook script, spawned against scratch dirs
    plugins/              the opencode plugin
    e2e/                  end-to-end feature suites
    e2e-claude/           the real Claude Code CLI (skipped unless AGENT_KNOWLEDGE_E2E_CLAUDE=1)
  docs/
    SETUP.md, USER-MANUAL.md, ARCHITECTURE.md, HOOKS.md, INGEST.md
```

## Code Style

- **TypeScript** with strict mode, ES modules
- **Imports**: use `.js` extensions (TypeScript NodeNext convention)
- **Naming**: `camelCase` for functions/variables, `PascalCase` for types/classes, `UPPER_SNAKE` for constants
- **Async**: use `async`/`await` over raw promises
- **Error handling**: throw descriptive errors, catch and return MCP-formatted errors in tool handlers
- **No external formatters** -- match existing code style

## Testing

```bash
npm test                          # Run all tests
npm run test:watch                # Watch mode
npx vitest run tests/tfidf.test.ts  # Single file
npm run lint                      # Type-check (tsc --noEmit)
```

Tests use **vitest** with `fs.mkdtempSync` for temp directories in filesystem tests.

### What to Test

- Knowledge store: CRUD, frontmatter parsing, category validation, path traversal
- TF-IDF: tokenization, stopwords, ranking correctness, edge cases
- Fuzzy: Levenshtein distance, threshold filtering, sliding window
- Sessions: JSONL parsing, malformed line handling, message extraction
- Session adapters: `isAvailable()` detection, `parseSession()` output normalization, graceful handling of missing/corrupt data

## Adding a Session Adapter

agent-knowledge uses a pluggable adapter system to read sessions from different AI coding tools. To add support for a new tool:

### 1. Create the adapter file

Create `src/sessions/adapters/<tool>.ts` implementing the `SessionAdapter` interface:

```typescript
import type { SessionEntry } from '../parser.js';
import type { SessionAdapter } from './index.js';

export const myToolAdapter: SessionAdapter = {
  prefix: 'mytool', // Unique prefix for virtual descriptors
  name: 'My Tool', // Human-readable name

  isAvailable(): boolean {
    // Return true if this tool is installed on the current machine.
    // Check for the existence of data files/directories.
    return existsSync('/path/to/mytool/data');
  },

  discoverProjects(): Array<{ name: string; path: string }> {
    // Return a list of projects/groups found for this tool.
    // Use `mytool://` prefixed paths as virtual descriptors.
    return [{ name: 'mytool', path: 'mytool://all' }];
  },

  listSessions(projectDescriptor: string): Array<{ id: string; file: string }> {
    // List individual sessions within a project.
    // Return virtual descriptors that parseSession() can handle.
    return [{ id: 'session-1', file: 'mytool://session:session-1' }];
  },

  parseSession(descriptor: string): SessionEntry[] {
    // Parse a session into normalized SessionEntry[] objects.
    // Each entry needs at minimum: type ('user'|'assistant'), message.role, message.content
    return [{ type: 'user', message: { role: 'user', content: 'Hello' } }];
  },
};
```

### 2. Register the adapter

Add a dynamic import to `src/sessions/adapters/index.ts` in the `initAdapters()` function:

```typescript
import('./mytool.js').then((m) => registerAdapter(m.myToolAdapter)).catch(() => {});
```

### 3. Key guidelines

- **Auto-detection only**: `isAvailable()` should check for the tool's data files on disk. No user configuration required.
- **Virtual descriptors**: Use `<prefix>://` URIs so the parser can dispatch to the correct adapter.
- **Graceful failure**: All methods should catch errors and return empty arrays rather than throwing.
- **Read-only access**: Never modify the source tool's data files. Use `{ readonly: true }` for database connections.
- **Platform-aware paths**: Handle Windows, macOS, and Linux path differences (see `cline.ts` for an example).

### 4. Update documentation

- Add the tool to the "Supported Tools" table in `README.md`
- Add the tool to the "Supported Session Sources" list in `CLAUDE.md`
- Add a changelog entry in `CHANGELOG.md`

## Pull Requests

1. All tests must pass
2. Type-check must be clean (`npm run typecheck`)
3. Lint and format checks must pass (`npm run check`)
4. Update docs if changing tool behavior or adding features
5. Keep commits focused -- one logical change per commit

## License

MIT

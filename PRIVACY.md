# Privacy Policy — agent-knowledge

**Last updated:** 2026-04-15

## What data this plugin accesses

- **Local filesystem only.** Reads session transcripts from `~/.claude/`, `~/.cursor/`, `~/.opencode/` (configurable via `EXTRA_SESSION_ROOTS`). Writes knowledge entries to `~/agent-knowledge/` (configurable via `KNOWLEDGE_DATA_DIR`).
- **No telemetry.** The plugin does not collect or transmit usage data.
- **No server-side storage by us.** All data stays on your machine.

## Third-party data flow (opt-in only)

If you configure an embedding provider (Claude/Voyage, OpenAI, Gemini), knowledge-base text is sent to that provider at your explicit configuration, governed by their respective terms. The default is the bundled local embedding model (`Xenova/all-MiniLM-L6-v2`) — no data leaves your machine.

## Git sync (opt-in)

If you enable git sync, knowledge entries are pushed to a git remote you configure. The plugin does not choose the remote; you do. Secrets (API keys, tokens, credentials) are scrubbed from auto-distilled session content before write.

## Data retention

- Knowledge entries: stored locally under `~/agent-knowledge/` until you delete them.
- Session cache: stored locally, invalidated automatically on file mtime changes.
- Vector store: stored locally in SQLite, rebuild on demand via `knowledge_admin(action: "rebuild_embeddings")`.

## Contact

Issues and security reports: <https://github.com/keshrath/agent-knowledge/issues>

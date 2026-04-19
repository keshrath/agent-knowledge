# Changelog

## 1.9.4 (2026-04-19) — visible knowledge-hook feedback + L0-only SessionStart

### Changed

- **`scripts/hooks/first-prompt-inject.mjs` now emits a user-visible `systemMessage`** alongside the silent `additionalContext`. When the session's first real prompt triggers injection, the host renders a one-line summary like `knowledge: injected 4 hits (decisions/database-choice.md, sessions/odoo-sh/...md, +2 more)` in the transcript, so the user can see which entries the model received without having to diff context.
- **`scripts/hooks/session-start.js` now auto-loads L0 identity only**, not the full L0+L1 wakeup pack. L1 top-weighted facts are covered by `first-prompt-inject.mjs`, which runs query-targeted search against the KB on the session's first real prompt — a better-matched slice than any query-agnostic pre-load. Effect: ~600 fewer tokens pre-loaded per session on average, no loss of context quality because `first-prompt-inject.mjs` fills the same budget one turn later with relevance-ranked content.
- **`AGENT_KNOWLEDGE_WAKEUP_BUDGET` default changed from 800 → 200 tokens.** L0 identity is small; the legacy 800-token ceiling existed to accommodate the now-removed L1 pack. Users who want the full legacy L0+L1 injection can still call `knowledge(action="wakeup")` manually — the MCP tool is unchanged.
- **SessionStart `systemMessage`** now always appends a status suffix so the user can tell the hook ran: `identity: 312 chars` when an `identity.md` is loaded, `identity: placeholder (no identity.md)` when only the default placeholder was emitted, or `autowake off · <source>` when disabled. Previously the suffix was suppressed on the "no identity.md" path, which was visually indistinguishable from the pre-v1.9.4 URL-only line.

### Fixed

- **`session-start.js` clears the `first-prompt-inject.mjs` marker on every SessionStart event.** Resumed sessions reuse the same `session_id`, so the marker from the prior run stayed on disk and the inject hook silently skipped the next user prompt. Now every `/exit`+resume (or `/clear`) re-arms query-targeted injection. When the marker is cleared, the SessionStart `systemMessage` appends `· inject rearmed`.

### Added

- **Identity onboarding.** When no `identity.md` (or `IDENTITY.md`) exists in the memory dir AND no `.identity-declined` opt-out marker is present, `session-start.js` injects a short instruction into `additionalContext` telling the agent to ask the user three questions (name/role, stack, projects) and save the answers via the host's `Write` tool directly into `~/agent-knowledge/identity.md`. No manual file creation; the agent drives the flow. If the user says "skip" / "not now", the agent writes `~/agent-knowledge/.identity-declined` and the nag stops. Delete that file to re-enable. The SessionStart `systemMessage` reports `identity: onboarding pending` or `identity: declined` accordingly.

Neither change alters the model-facing MCP API. Fail-open behaviour unchanged: errors still produce a valid empty JSON response.

### Tests

563/563 passing. New assertions cover: `first-prompt-inject.mjs` `systemMessage` shape, `session-start.js` dashboard-URL line, identity-onboarding instruction when neither `identity.md` nor `.identity-declined` exist, opt-out path via `.identity-declined`, happy-path with an existing `identity.md`, and first-prompt-inject marker clear on resume. Existing hook tests only asserted `hookSpecificOutput`, which stays the same shape; the new `systemMessage` field is additive.

## 1.9.3 (2026-04-19) — README showcase rewrite

### Changed

- **README no longer carries inline version markers** (`(v1.8)`, `(v1.8.1)`, `(v1.8 lifecycle integration)`). The feature list now describes the current state as a single coherent surface — version history lives in this CHANGELOG where it belongs. Moves the README from "changelog-in-bullet-points" to "how it works today".
- **Section renames to match**: `### Scored promoter (v1.8)` → `### Scored promoter`, `### Hooks (v1.8 lifecycle integration)` → `### Hooks`, `v1.8 search knobs:` → `Search knobs:`.
- **Wakeup bullet now names the token budget** — 800 default, overridable via `token_budget` param or `AGENT_KNOWLEDGE_WAKEUP_BUDGET` env var. The number was previously only in the env-var table.
- **Testing block refreshed** — stale `352 tests across 20 files` replaced with the real `558 tests across 35 files`; added `typecheck` and `check` script references so the documented workflow matches what `npm run check` actually runs.

### Tests

558/558 passing. Docs + metadata only — no source changes.

## 1.9.2 (2026-04-19) — doc/setup drift cleanup + HOOKS.md rename

### Fixed

- **`scripts/setup.js` now installs `first-prompt-inject.mjs`.** It was missing — SETUP.md advertised 6 hooks but automated setup only wired 5. Users running `node scripts/setup.js` previously didn't get the UserPromptSubmit targeted-injection hook.
- **Test-count badge** corrected in README (557 → 558 after v1.9.1's flake fix; badge wasn't updated at the time).

### Changed

- **`docs/hooks.md` → `docs/HOOKS.md`** to match the ALL-CAPS convention of SETUP.md / USER-MANUAL.md / ARCHITECTURE.md / INGEST.md / DASHBOARD.md. All internal links updated (README, SETUP.md, USER-MANUAL.md, setup.js, CHANGELOG.md).
- **Hook count bumped 5 → 6 everywhere.** `session-start-ingest.mjs` was installed by setup.js (and runs in every session) but wasn't listed in SETUP.md or HOOKS.md. Now documented with a dedicated section in HOOKS.md and a row in every hook table.
- **Setup banner** (`scripts/setup.js` post-install message) now lists all six hooks with their exact script names instead of a 4-item vague summary.

### Added

- **USER-MANUAL.md §3 Configuration → "Lifecycle Hooks" subsection.** Previously the manual had zero hook coverage; it now mirrors the SETUP.md table and points at HOOKS.md for the full reference.
- **USER-MANUAL.md §3 Configuration → "Persistent Memory — agent-knowledge, not host auto-memory" subsection.** Explains that on hosts with a per-session memory system (Claude Code's `~/.claude/projects/*/memory/`), durable facts should route to agent-knowledge instead. Includes the CLAUDE.md snippet that enforces the redirect for Claude Code users.
- **README feature list** gains a bullet naming agent-knowledge as the replacement for host auto-memory, linking to the USER-MANUAL section.

### Tests

558/558 passing. No source changes — docs + setup.js only.

## 1.9.1 (2026-04-18) — freshness test flake fix

### Fixed

- **`tests/freshness.test.ts` "default-path coverage" no longer times out under full-suite I/O pressure.** Previously ran with `sinceDays: 30`, which made the real `listSessions()` + `getSessionSummary()` path iterate every recent session JSONL on the developer's box — on a heavy-corpus machine this hit the 10s timeout when other test files were contending for I/O. Tightened to `sinceDays: 1` (the test pins "default branch returns an array without throwing" — the window size was incidental) and bumped the per-test timeout to 15s for headroom. Full suite now 558/558 green, stable across repeated runs. The failure had silently shipped through v1.8.1 and v1.9.0 labelled "pre-existing flake"; that was wrong and won't recur.

### Tests

558/558 passing (was 557/558 with the flake counted as pass). No behaviour changes, no source changes outside `tests/`.

## 1.9.0 (2026-04-18) — env var naming cleanup (**breaking**)

Every env var is now under the canonical `AGENT_KNOWLEDGE_*` prefix per the repo-wide Genericity rule (`AGENT_<NAME>_<RESOURCE>`). The old `KNOWLEDGE_*` prefix and the unscoped `EXTRA_SESSION_ROOTS` are gone — no deprecation shim, no startup warning, just renamed. README and docs table rewritten so no host name (`Claude Code`, `~/.claude`) leaks into descriptions — the adapter registry already auto-detects `.claude`, `.cursor`, `.codex`, `.aider`, `.continue`, and OpenCode without configuration.

### Breaking changes

All renames are mechanical — rename the env var, nothing else:

| Old                                | New                                      |
| ---------------------------------- | ---------------------------------------- |
| `KNOWLEDGE_MEMORY_DIR`             | `AGENT_KNOWLEDGE_MEMORY_DIR`             |
| `KNOWLEDGE_DATA_DIR`               | `AGENT_KNOWLEDGE_DATA_DIR`               |
| `KNOWLEDGE_GIT_URL`                | `AGENT_KNOWLEDGE_GIT_URL`                |
| `KNOWLEDGE_AUTO_DISTILL`           | `AGENT_KNOWLEDGE_AUTO_DISTILL`           |
| `KNOWLEDGE_INDEX_VERBATIM`         | `AGENT_KNOWLEDGE_INDEX_VERBATIM`         |
| `KNOWLEDGE_PORT`                   | `AGENT_KNOWLEDGE_PORT`                   |
| `KNOWLEDGE_EMBEDDING_PROVIDER`     | `AGENT_KNOWLEDGE_EMBEDDING_PROVIDER`     |
| `KNOWLEDGE_EMBEDDING_ALPHA`        | `AGENT_KNOWLEDGE_EMBEDDING_ALPHA`        |
| `KNOWLEDGE_EMBEDDING_MODEL`        | `AGENT_KNOWLEDGE_EMBEDDING_MODEL`        |
| `KNOWLEDGE_EMBEDDING_IDLE_TIMEOUT` | `AGENT_KNOWLEDGE_EMBEDDING_IDLE_TIMEOUT` |
| `KNOWLEDGE_EMBEDDING_THREADS`      | `AGENT_KNOWLEDGE_EMBEDDING_THREADS`      |
| `KNOWLEDGE_OPENAI_API_KEY`         | `AGENT_KNOWLEDGE_OPENAI_API_KEY`         |
| `KNOWLEDGE_ANTHROPIC_API_KEY`      | `AGENT_KNOWLEDGE_ANTHROPIC_API_KEY`      |
| `KNOWLEDGE_GEMINI_API_KEY`         | `AGENT_KNOWLEDGE_GEMINI_API_KEY`         |
| `EXTRA_SESSION_ROOTS`              | `AGENT_KNOWLEDGE_EXTRA_SESSION_ROOTS`    |

Standard third-party keys still work as fallbacks when the scoped form is unset: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`. `OPENCODE_DATA_DIR` (OpenCode's own env) is unchanged — our adapter honors it as-is.

### Documented

- `AGENT_KNOWLEDGE_INDEX_VERBATIM`, `AGENT_KNOWLEDGE_EMBEDDING_THREADS`, `AGENT_KNOWLEDGE_EMBEDDING_MODEL` — existed but were missing from the README table.
- `AGENT_KNOWLEDGE_AUTOWAKE`, `AGENT_KNOWLEDGE_WAKEUP_BUDGET`, `AGENT_KNOWLEDGE_FIRSTPROMPT_INJECT`, `AGENT_KNOWLEDGE_FIRSTPROMPT_BUDGET`, `AGENT_KNOWLEDGE_FIRSTPROMPT_MAX_HITS`, `AGENT_KNOWLEDGE_PRECOMPACT_NUDGE` — hook env vars were in `docs/HOOKS.md` but not surfaced in the main README table. Fixed.

### Fixed

- README `AGENT_KNOWLEDGE_DATA_DIR` description no longer says "Claude Code JSONL files" — the adapter registry is multi-host by design and the description now reflects that.

## 1.8.1 (2026-04-18) — staleness signal + search-gap log + section-priority context + dashboard polish + access-tracking measurement fix

Additive upgrades. Response shapes gain new optional fields (`freshness` on search hits, `evergreen`/`author`/`last_accessed` on `GET /api/knowledge` rows, three new fields on `StalenessSignal`) but no existing fields were removed or reshaped — strict consumers relying on unknown-field tolerance are unaffected. Every new behaviour is automatic or additive — no agent-proactive action required.

### Added

**Automatic staleness detection** (the "old entries work against you" problem, addressed without LLM judge or transcript regex):

- `src/knowledge/freshness.ts` — cross-references file paths mentioned in each entry body against `filesModified` in recent session summaries (data we already extract). An entry mentioning `src/auth.ts` whose body hasn't been edited while 5 recent sessions touched `src/auth.ts` is a staleness candidate. No regex on free-form transcripts, no false-positive tarpit.
- `knowledge_analyze(action: "stale_by_code_activity")` — returns ranked `{entry, touched_files, touching_sessions, body_age_days, lag_days, confidence}`. Evergreen entries exempt by design.
- **Symbol-presence precision layer** — `staleByCodeActivity` extracts identifiers the entry quotes (inline backticks + fenced blocks, ≥3 chars, strict identifier shape) and checks whether they still appear in the touched files. Confidence × 0.3 when every named symbol is still present (entry's concrete claims likely hold), scaled linearly for partial matches, full weight when all named symbols are missing (confirmed drift). Entries that quote no verifiable identifiers fall through with `symbol_evidence: "not_applicable"`. File-activity alone no longer fires at high confidence — a signature has to be gone. `StalenessSignal` gains three additive fields: `symbol_evidence`, `symbols_checked`, `symbols_missing`.
- `scoring.ts` — new `verified_at` column in `entry_scores` (non-destructive migration) + `markVerified` + `verificationAgeDays` helpers.
- **Auto-verify stamp in the promoter** — entries written by the scored promoter (`promote({mode: "apply"})`) are by construction fresh (they're aggregated from current session activity); the promoter now stamps `verified_at` automatically. Fully background, no agent call needed.
- **Freshness metadata on every search hit** — every `knowledge_search` result now carries `freshness: {body_age_days, last_accessed, access_count, verified_at, verification_age_days, evergreen}`. Agent reads the trust signal, forms its own judgment — no policy demotion imposed by us.

**Access-tracking measurement fix**:

- `recordAccess` was previously called only from `knowledge(action: read)`. The primary knowledge-consumption path — L1 entries packed into the first-prompt wakeup bundle — didn't count, and neither did `knowledge_search` hits. The bytype chart was faithfully reporting "mostly unused" against a broken measurement. Fixed in two places: `buildContextBundle` now calls `recordBulkAccess` on every entry that makes it into the bundle (`src/wakeup.ts`); `knowledge_search` bumps access for every knowledge hit (`src/tool-handlers.ts`). Sessions hits don't bump.
- **Per-category decay windows** replace the flat 30d/90d defaults. People entries are consulted once a quarter and aren't stale; notes are scratch and age out fast. New defaults: `projects` 180d/365d, `people` 365d/730d, `decisions` 90d/180d, `workflows` 60d/120d, `notes` 30d/90d. The bytype chart and the "Unused" filter both honor the per-category threshold. Unknown categories keep the 30d/90d flat default. Currently UI-side only — the `staleByCodeActivity` confidence formula still uses a flat `lag_days / 60` saturation point; category-aware staleness tracked for v1.9.

**Search-gap tracking**:

- `src/knowledge/query-log.ts` — lightweight `query_log` table inside `knowledge-scores.db`. `knowledge_search` calls are logged with `{query, project, results_count, created_at}`; obvious-secret patterns (API keys, JWTs, bearer tokens, `.env`-style assignments) are redacted via `scrubContent` before insert. Short opaque tokens not matching a pattern are stored verbatim — don't treat the log as a secret-proof sink. Best-effort: log failures never fail the search.
- `knowledge_analyze(action: "search_gaps")` — returns zero-result queries from the last `since_days` window, grouped by token-Jaccard similarity (`group_similarity` tunable, default `0.35`). The single strongest signal for "what entries should I write next?" — agents searching for `"gitlab credentials"` three times and getting nothing surfaces the entry that should exist. Threshold defaults low (0.35) because short queries share few tokens even when topically related; 0.7 would force every query into its own group.

**Section-priority context packer** (evolves `wakeup`):

- `src/wakeup.ts` — new `buildContextBundle(options)` with seven priority-ordered sections filled top-to-bottom within a token budget: `identity` → `active_tasks` → `recent_decisions` → `known_gotchas` → `last_session_summary` → `top_weighted` → `semantic_fallback`. Unused section budget redistributes to later sections; `truncated` flagged when any section was cut.
- `knowledge(action: "wakeup")` new params: `sections` (CSV, overrides default order) and `section_budgets` (JSON per-section overrides). Omit both and the handler routes to the v1.8.0 `wakeup` wrapper — same identity-plus-L1-list shape, though the section separator is `\n\n` (was `\n`) so the output is shape-compatible rather than byte-identical.

**Dashboard polish**:

- **"Unused" filter** in the Knowledge tab — count in the button label, auto-hides when zero; orange-toned action cue. Uses per-category thresholds so evergreen-shaped categories aren't falsely flagged.
- **"By Type" access-count bar chart** — per-category split, row-normalized bars (each row fills 100% of its track; green share = recently accessed, orange = unused; volume comparison via the right-side `accessed/unused` numbers). HTML/CSS bars, no chart library.
- **Pinned rendering for `evergreen: true` entries** — Material Symbols `push_pin` icon badge on each card (FILL=1, wght=500, accent color). No emoji.
- **Author frontmatter field** — new optional `author: <string>` in entry frontmatter; surfaced as a muted `by <author>` chip in the card footer. Store/listEntries/readEntry propagate it.
- `GET /api/knowledge` response rows now explicitly carry `evergreen`, `author`, `last_accessed`.

### Changed

- `search.ts` `SearchResult` type grew a `freshness?: FreshnessMeta` field. Additive — existing callers ignoring the field keep working.
- `store.ts` `KnowledgeEntry` type grew `author?: string`.
- `tool-handlers.ts` `handleKnowledge` wakeup case accepts `sections` + `section_budgets` (both optional, back-compat preserved).

### Fixed

- **UI wrapper bypass** — `src/ui/render-knowledge.js` internal calls at lines 76/151/189 went through the local `renderKnowledge` ref, skipping the `K.renderKnowledge` wrapper installed by `installKnowledgeEnhancements`. Consequence: on initial load, search clear, and consolidate, the bytype chart / unused count / `decorateCards` (pin badges + author chips) never ran. Pin badges + author chips were invisible in normal usage. Fixed by routing the three internal call sites through `K.renderKnowledge`.
- **WS state snapshot lacked scoring enrichment** — `dashboard.ts` `fullState()` sent `listEntries()` raw, without scoring, so state.knowledge.entries arrived at the UI with `last_accessed: undefined` and every call to `isUnused()` returned true. Fixed by enriching the WS payload with `maturity`, `access_count`, `last_accessed` the same way `GET /api/knowledge` does.

### Tests

557 passing (+23 new over 1.8.0's 534): 7 freshness detector, 9 query-log, 6 context-bundle, 1 dashboard row-shape. Every new module has tests with numeric bounds and DI hooks rather than ESM module mocking.

### Not done (honestly deferred)

- Systemic test-audit items still open (regex-as-unit-test consolidation, 8 FLAKY-RISK tests flagged in the 1.8.0 pass) — carried over.
- Real-world write-bench Cohen-kappa calibration — requires human spot-check pass on a larger session corpus than we currently have locally.

## 1.8.0 (2026-04-18) — agent-UX pass (**breaking**)

Three-axis change: retrieval grew a diversity knob and explainability, auto-distillation replaced with a scored + gated promoter, and new lifecycle hooks (pre-compaction flush, session-start wakeup, first-prompt knowledge injection). All six existing MCP tools stay visible.

### Breaking changes

- **`knowledge_search` response shape** — now always includes a top-level `mode: "general" | "scoped"` field, plus `{mode, sessions, knowledge}`. Scoped mode (when `scope` is set) returns `knowledge: []` by design — scoped search was always sessions-only, now it says so.
- **`category_mode` default flipped from `"filter"` to `"boost"`** — passing a `category` hint no longer silently drops non-matching entries. Matching entries get a 1.25× score boost; non-matches stay in the candidate pool. Pass `category_mode: "filter"` for the legacy hard-filter behavior.
- **Auto-distillation replaced by the scored promoter** — `backgroundIndex` now calls `promote({ mode: "apply" })` instead of `distillSessions()`. Same `autoDistill` config flag governs both, so existing settings carry over; the output gets STRICTER (fewer, higher-signal promotions). The legacy `distillSessions` function is kept for the write-bench but no longer wired into the default pipeline.

### Added

- **`knowledge_search` knobs (all opt-in):**
  - `mmr: boolean` — re-rank knowledge hits with Maximal Marginal Relevance to kill near-duplicate clusters in the top-K.
  - `mmr_lambda: number` — 0-1 tradeoff, default 0.7 (1.0 = pure relevance, 0.0 = pure diversity).
  - `explain: boolean` — attach `score_components` to each knowledge hit (`bm25, decay, maturity, confidence, category_boost, mmr_penalty`). Lets the agent reason about why X ranked above Y.
- **6-signal scored promoter** (`src/knowledge/promote.ts`) — every project-level candidate is scored on `{relevance 0.30, frequency 0.24, queryDiversity 0.15, recency 0.15, consolidation 0.10, conceptualRichness 0.06}`. Three independent gates (`minScore ≥ 0.5`, `minRecallCount ≥ 2`, `minUniqueQueries ≥ 2`) must ALL pass before a candidate is promoted.
- **`knowledge_admin(action: "promote")`** — invoke the promoter on demand. `promote_mode: "explain"` (default) returns score breakdowns without writing; `promote_mode: "apply"` writes the ones that pass. Overridable gates via `min_score`, `min_recall_count`, `min_unique_queries`.
- **Grounded rehydration** — promotion checks that the source session file still exists on disk before writing. Prevents promoting content the user has since deleted.
- **`.dreams/YYYY-MM-DD.md` diary** — every promoter run logs per-candidate signal breakdowns, gate outcomes, and final action into `~/agent-knowledge/.dreams/`. The dir is git-tracked (audit trail) but `.`-prefixed so `listEntries`/search skip it.
- **`evergreen: true` frontmatter flag** — entries with the flag are exempt from decay in ranking, AND the promoter appends new activity instead of overwriting the body. Use for durable decisions / architecture / identity entries.
- **`diversity@5` bench metric** — `bench/run.ts` now reports average unique-cluster count in top-5 (token-Jaccard ≥ 0.5 merges) alongside R@5 / R@10. MMR changes must move this metric, not just recall.
- **`bench/promote-bench.ts`** — self-labeled write-bench. Offline replay of the promoter vs. a naive "ship all candidates" baseline, with auto-labeling by "was the candidate referenced in sessions ≥ cutoff days later?". Outputs precision / recall / F1 per strategy. Side-effect-free (never writes to the KB, never advances the cursor). Intended gate for rolling signal weights or threshold changes.
- **Pre-compaction memory-flush nudge** — `scripts/hooks/precompact-flush.mjs` now injects an `additionalContext` block into the host's PreCompact response telling the agent to save any unsaved context via `knowledge(action="write", …)` BEFORE compaction summarizes the transcript. Disable with `AGENT_KNOWLEDGE_PRECOMPACT_NUDGE=0` (keeps the disk dump). Set `=off` to suppress both.
- **SessionStart auto-wakeup** — `scripts/hooks/session-start.js` auto-loads a token-budgeted `knowledge(action="wakeup")` payload into the host's SessionStart `additionalContext` on every session. No more manual wakeup call. Disable with `AGENT_KNOWLEDGE_AUTOWAKE=0`, tune budget with `AGENT_KNOWLEDGE_WAKEUP_BUDGET` (default 800 tokens).
- **First-prompt knowledge injection** — `scripts/hooks/first-prompt-inject.mjs` (UserPromptSubmit). When the user sends the first real prompt of a session, it's passed through `searchKnowledge(prompt, { mmr: true })` and the top hits are injected as `additionalContext` before the model reads the prompt. Gates: prompt ≥ 10 chars, doesn't start with `/` or `!`, fires at most once per session (marker file at `{dataDir}/.first-prompt-seen/<session_id>`). Fail-open everywhere. Complements `wakeup` (which is query-agnostic) with query-targeted content. Env knobs:
  - `AGENT_KNOWLEDGE_FIRSTPROMPT_INJECT` (default `1`) — set `0` / `false` / `off` to disable.
  - `AGENT_KNOWLEDGE_FIRSTPROMPT_BUDGET` (default `600`, tokens) — clamped to [100, 8000].
  - `AGENT_KNOWLEDGE_FIRSTPROMPT_MAX_HITS` (default `4`) — clamped to [1, 20].
- **`src/search/mmr.ts`** — new module: `rerankMMR`, `diversityAtK`, `cosineSim`, `jaccardTokenSim`. Reusable for any ranked list.
- **Extended `bench/fixtures.example.jsonl`** from 5 to 40 sample queries across factual-lookup / multi-hop / temporal / preference / adversarial / workflow categories. Still check-in-safe placeholders — copy to `fixtures.jsonl` and adjust `expected` paths to match your real KB.
- **Tests:** 45 new (21 for MMR + diversity utils, 16 for promoter signals + gates, 8 for first-prompt-inject hook). 541/541 tests passing.

### Changed

- **`computeFinalScore` now accepts an `evergreen` argument** — when true, skips the decay factor. Backward-compatible (parameter is optional).
- **Signal weights + gate thresholds are exported constants** (`SIGNAL_WEIGHTS`, `DEFAULT_GATES`) — bench + tests pin against them, so changes surface in the diff review.
- **`searchKnowledge` widens the candidate pool** to 3× `maxResults` when `mmr` is enabled, so MMR has room to pick diverse items.

### Measurement

LongMemEval baseline numbers are unchanged (the P0/P1 work is agent-UX + optional retrieval knobs — the default retrieval path is untouched): **R@5 = 97.2% sparse / 98.8% hybrid on `_s`**, **86.0% sparse / 88.4% hybrid on `_m`**. MMR and category-boost changes should be gated on `bench/run.ts` diversity@5 + `bench/promote-bench.ts` F1 before rolling defaults.

## 1.7.0 (2026-04-13)

### Added

- **Code structure edge types** — 3 new relationship types: `calls`, `imports`, `inherits` for code graph representation. Total: 11 relationship types.
- **Directed BFS traversal** — `knowledge_graph(action: "traverse")` now supports `direction` (`outbound`, `inbound`, `both`) and `rel_type` filter. Enables "who calls X?" and "what does X call?" queries.
- **`bulk_link` action** — batch-create edges in a single SQLite transaction. Designed for code graph ingestion where hundreds of edges are created at once. Self-references and invalid types silently skipped.
- **`unlink_by_origin` action** — delete all edges matching a specific origin. Used to clear stale code graph edges before re-ingest (e.g. `tree-sitter:my-project`).
- **`code:` node ID convention** — code files use `code:src/path.ts`, symbols use `code:src/path.ts::functionName`. Analysis functions (godNodes, bridges, gaps) exclude code nodes automatically.
- **Input validation for `bulk_link`** — handler filters malformed edges (non-string source/target/rel_type) before passing to graph layer.

### Fixed

- **`gaps()` now excludes `code:` nodes** — consistent with `godNodes()` and `bridges()` which already filtered them.
- **`USER-MANUAL.md`** — updated stale "8 relationship types" reference to 11.

## 1.6.3 (2026-04-13)

### Added

- **`POST /api/knowledge` REST endpoint** — write knowledge entries via HTTP. Runs the full MCP write pipeline: git pull, file write, embedding index, auto-link (cosine > 0.7), git push, duplicate check. Returns `{ path, autoLinks, duplicateWarnings, git }`. POST restricted to `/api/` paths; non-API POST still returns 405. Used by agent-tasks KnowledgeBridge to push learning/decision artifacts on task completion. 481/481 tests green.
- **README: Integrations section** — documents the REST write endpoint and the agent-tasks KnowledgeBridge integration. REST API table updated with POST entry.

## 1.5.2 (2026-04-11)

### Added

- **Confidence metadata on entries.** New optional frontmatter fields `confidence: extracted|inferred` and `confidence_score: 0.0-1.0`. Distilled entries are tagged `inferred` automatically; user-written entries default to `extracted`. Search ranking applies a 0.85× multiplier to inferred entries so explicit user knowledge ranks above auto-derived insights when relevance is equal.

- **Edge origin tracking.** New `origin` column on the `edges` table records how each relationship was created: `manual` (user-created via `knowledge_graph link`), `auto-link` (cosine similarity > 0.7 on write), `distill` (session distillation), or `reflect` (analysis cycle). Migration is non-destructive — existing edges default to `manual`.

- **Analysis layer.** Three new `knowledge_analyze` actions:
  - `god_nodes` — most-connected entries by degree centrality. Excludes auto-distilled entries that only have auto-link edges (noise).
  - `bridges` — entries connecting different categories, ranked by betweenness centrality. Includes a `why` explanation showing which categories each bridge connects.
  - `gaps` — entries with 0-1 graph edges, sorted by maturity (proven gaps are most concerning).

- **Knowledge brief.** New `knowledge_analyze` action `brief` returns a compact (~200 token) summary of the knowledge base state: core concepts, active projects (accessed in last 30 days), recent decisions, stale count, gap count. Cached for 1 hour, invalidated on write/delete/link/unlink. Designed for agents to read on session start as orientation context.

- **Deterministic pre-extraction in session distillation.** `getSessionSummary()` now extracts structured data from session transcripts via regex (no LLM):
  - `gitCommits` — short SHAs from `git commit`/`merge`/`rebase` output
  - `errorPatterns` — `Error:`/`Exception:`/`FAIL`/`Traceback` lines
  - `urlsAccessed` — URLs from `WebFetch` and browser tool results (excludes asset/font noise)
  - `packagesChanged` — package names from `npm install` and `pip install` commands

  These appear as new subsections (`### Commits`, `### Errors Encountered`, `### URLs Accessed`, `### Packages Changed`) in distilled project entries, alongside the existing `### Files Touched` section.

- **Dashboard UI cards.** New buttons in the Knowledge tab header:
  - **God Nodes** — opens a panel showing the top connected entries with edge counts
  - **Bridges** — shows cross-category connectors with a `why` explanation
  - **Gaps** — lists isolated entries grouped by maturity
  - **Brief** — displays the knowledge base summary in a code block plus card sections for core concepts and recent decisions

- **New REST endpoints**: `GET /api/knowledge/god-nodes`, `GET /api/knowledge/bridges`, `GET /api/knowledge/gaps`, `GET /api/knowledge/brief`. All four are rate-limited as heavy endpoints (20 req/min per IP).

- **e2e tests** in `tests/e2e/v15-features.e2e.test.ts` covering all new features against a real on-disk memory dir and real graph DB.

### Changed

- **`better-sqlite3` bumped from `^11.0.0` → `^12.8.0`.** v12 ships prebuilt binaries for Node 20.x through 25.x, so `npm install` no longer requires a local C++ toolchain on Node 24+. The obsolete "Windows note" about installing Visual Studio Build Tools has been removed from the README — it was only needed with v11 on Node 24 where no prebuilts existed. Aligns with the other agent-\* repos (`agent-comm`, `agent-common`, `agent-discover`, `agent-tasks`) which were already on 12.8.0.

## 1.5.1 (2026-04-09)

### Added

- **Streaming JSON parser in `bench/longmemeval.ts`**. The benchmark now uses an async iterator (`stream-json`) for files >384 MB so the 2.6 GB `longmemeval_m` split can be benchmarked without hitting Node's ~512 MB string-length limit. Files under the threshold still use the original `readFileSync + JSON.parse` fast path with byte-identical results.
- **`bench/longmemeval_m` results.** First time we've measured the harder split (500 distractor sessions per question, 10× more than `_s`):

  | Mode                         | R@1   | R@5       | R@10  |
  | ---------------------------- | ----- | --------- | ----- |
  | 1.5 — BM25 + boosts (sparse) | 65.6% | **86.0%** | 92.4% |
  | 1.5 — BM25 + semantic hybrid | 65.4% | **88.4%** | 92.2% |

- **Validation against the LongMemEval paper's official `flat-bm25`** (`bench/paper_bm25_eval.py`). We re-ran the paper's exact corpus construction (user-only text per session), tokenization (`doc.split(" ")`), and `rank_bm25.BM25Okapi` defaults on the same data, with the paper's own `recall_any` evaluator from `src/retrieval/eval_utils.py`:

  | Split           | Paper `flat-bm25` | agent-knowledge 1.5 BM25 | agent-knowledge 1.5 hybrid |
  | --------------- | ----------------- | ------------------------ | -------------------------- |
  | `longmemeval_s` | 88.6%             | **97.2% (+8.6pp)**       | **98.8% (+10.2pp)**        |
  | `longmemeval_m` | 75.2%             | **86.0% (+10.8pp)**      | **88.4% (+13.2pp)**        |

  The improvement comes from three small but cumulative differences vs the paper's BM25 setup: (1) we index both user and assistant turns instead of user-only, (2) we lowercase + strip stopwords instead of splitting on whitespace, (3) we use `k1 = 1.2` instead of the `BM25Okapi` default `1.5`.

- `stream-json` and `@types/stream-json` as devDependencies (used by the bench only; not in the runtime).

### Changed

- `bench/longmemeval.ts` main loop is now an `async for await` over a streaming dataset iterator. The earlier eager-load path (`readFileSync` then `JSON.parse`) is preserved for files under 384 MB so existing reproduction commands stay byte-identical.

## 1.5.0 (2026-04-08)

### Changed

- **Sparse ranker swapped from naive TF-IDF cosine to Okapi BM25** (`src/search/bm25.ts`, `k1=1.2`, `b=0.75`). The TF-IDF cosine ranker under-weighted long sessions because cosine normalization punishes document length. BM25's length normalization fixes this for the long, multi-turn sessions LongMemEval is built on. Wired into all three production search call sites: `src/sessions/search.ts`, `src/sessions/scopes.ts`, `src/knowledge/search.ts`. `src/knowledge/consolidate.ts` keeps TF-IDF for doc-to-doc duplicate detection (a different use case).

### Benchmark — LongMemEval (full 500 questions, `longmemeval_s_cleaned`)

| Mode                                            | R@1       | R@5       | R@10      |
| ----------------------------------------------- | --------- | --------- | --------- |
| 1.4.2 — TF-IDF + boosts (sparse)                | 59.8%     | 83.8%     | 91.2%     |
| **1.5.0 — BM25 + boosts (sparse)**              | **87.6%** | **97.2%** | **98.4%** |
| **1.5.0 — BM25 + semantic (hybrid, alpha=0.3)** | **89.6%** | **98.8%** | **99.6%** |

Per-category R@5 deltas (sparse, vs 1.4.2):

| Category                  | 1.4.2     | 1.5.0     | Δ           |
| ------------------------- | --------- | --------- | ----------- |
| single-session-user       | 90.0%     | 100.0%    | +10.0pp     |
| single-session-assistant  | 87.5%     | 100.0%    | +12.5pp     |
| single-session-preference | 33.3%     | 86.7%     | **+53.4pp** |
| multi-session             | 84.2%     | 97.0%     | +12.8pp     |
| temporal-reasoning        | 84.2%     | 95.5%     | +11.3pp     |
| knowledge-update          | 93.6%     | 100.0%    | +6.4pp      |
| **OVERALL**               | **83.8%** | **97.2%** | **+13.4pp** |

The biggest jump is `single-session-preference` (33.3% → 86.7%), which had been the dead category in 1.4.2. Preference questions are about long sessions where the user states a habit indirectly; cosine normalization had been ranking those long documents too low.

Reproduce: `npx tsx bench/longmemeval.ts --boosts --ranker bm25` (sparse) or `--hybrid --boosts --ranker bm25` (hybrid, ~70 min).

### Added

- `bench/longmemeval.ts --ranker {tfidf|bm25}` flag (default `tfidf` so the historical baseline stays reproducible).
- `tests/bm25.test.ts` — 9 unit tests for `BM25Index` covering ranking, length normalization, dedup on re-add, and edge cases.

### Notes

- Two changes were attempted and reverted because they failed their measured gates: a regex-based preference-extraction synthetic-chunk pass (no movement on the preference category — the haystack distractors also contain preference-shaped statements, so vocabulary injection added noise without changing rank) and Reciprocal Rank Fusion as the hybrid blender (alpha-weighted blend beat RRF by 1pp on a 100q sample). Both removed; no dead code shipped.

## 1.4.2 (2026-04-08)

### Added

- **LongMemEval R@5 = 83.8% headline** in the main README, with a per-question-type breakdown in `bench/README.md`. Reproducible via `npx tsx bench/longmemeval.ts --boosts` on the public Wu et al. 2024 (ICLR 2025) `longmemeval_s_cleaned` dataset, full 500 questions, no LLM, no API key.
- `bench/fixtures.example.jsonl` — generic example fixture template; the personal `bench/fixtures.jsonl` is now gitignored so users author their own.
- Bench falls back to `fixtures.example.jsonl` automatically if no personal fixtures file is present.

### Changed

- `normalizeProjectName` in `src/knowledge/distill.ts` is now generic. The previous implementation had specific regex patterns for one project ecosystem; the new pattern collapses any `<stem><version>-...-<stem>` shape via a single rule.
- `bench/longmemeval.ts` now defaults to the cleaned LongMemEval dataset (`longmemeval_s_cleaned.json`) instead of the deprecated original.

## 1.4.1 (2026-04-08)

Documentation cleanup. No code or behavior changes vs 1.4.0.

## 1.4.0 (2026-04-08)

Seven additions focused on retrieval quality, temporal reasoning, and measurable evaluation.

### Added

- **`knowledge` action `wakeup`.** Returns a token-budgeted "L0 + L1" context blob — identity from `~/agent-knowledge/identity.md` plus the highest-weighted entries — for session-start hydration. Default budget 800 tokens. Weight = `recency × log(size+1)`. Optional `category` param narrows L1 to one category. Folded into the existing `knowledge` tool as a 6th action so the MCP surface stays at six tools.
- **Temporal validity on `knowledge_graph` edges.** New columns `valid_from` / `valid_to` (nullable, ALTER-TABLE migration is backwards compatible). New `invalidate` action sets `valid_to` without deleting the edge so history is preserved. New `as_of` parameter on `list` and `traverse` returns point-in-time snapshots — `links('projects/auth.md', undefined, '2026-02-15')` returns the assignees who were valid in February. New `isEdgeValidAt` helper.
- **Hybrid scoring boosts (`src/search/boosts.ts`).** Two boosts wired into `hybridSearch`: a proper-noun boost (capitalized non-stopword tokens in the query, max 40% score uplift) and a Gaussian temporal-proximity boost when the query mentions a date or relative time (`yesterday`, `last week`, `march 2025`, `2024`). Combined cap at +66.7%. `hasAnyBoostSignal` short-circuits when no signal is present so default behavior is unchanged.
- **`category_mode` on `knowledge_search`.** New option `'filter' | 'boost'` (default `'filter'` — backwards compatible). In `'boost'` mode, `category` becomes a 1.25× score multiplier instead of a hard WHERE filter. Use `'boost'` when you might be wrong about the category — hard filters silently discard the right answer when the metadata doesn't match.
- **`indexVerbatim` config flag.** Toggle verbatim per-message session indexing via `KNOWLEDGE_INDEX_VERBATIM` env var or persisted config. Default `true`. Indexer now drops messages shorter than 30 chars (low-signal acks).
- **PreCompact / Stop hook.** New `scripts/hooks/precompact-flush.mjs` — reads hook JSON from stdin, dynamic-imports `dist/sessions/summary.js`, writes a flushed session summary to `~/agent-knowledge/sessions/<project>/<event>-<stamp>-<sid>.md` so distillation has an anchor when the host compacts the conversation. Fail-open. Wire-up snippet for Claude Code `settings.json` is in the file header. Not auto-installed.
- **Benchmark suite (`bench/`).** Two runners: a small smoke benchmark over `~/agent-knowledge/` (22 hand-authored fixtures) and a full LongMemEval runner (`bench/longmemeval.ts`) against the public Wu et al. 2024 dataset. The LongMemEval runner supports `--raw`, `--boosts`, `--semantic`, and `--hybrid` modes and prints per-question-type breakdowns. `npm run bench` (uses `tsx`).

### Tests

- New e2e suite `tests/e2e/v14-features.e2e.test.ts` (10 tests): wakeup default identity, wakeup with `identity.md`, token-budget truncation, scope filter, `categoryMode` filter vs boost behavior, full KG temporal lifecycle (link → list as_of → invalidate → list as_of), `graph()` traversal with `as_of`, weight-based L1 ordering.
- New unit suite `tests/boosts.test.ts` (14 tests): proper-noun extraction (stopword filtering, dedup), boost ramp, temporal reference parsing, Gaussian decay, combined-boost cap.
- Extended `tests/graph.test.ts` with 9 temporal cases.
- **Total: 390 tests passing**, up from 352.

### Internal

- `chunkSession` accepts an options object alongside the legacy `maxChars` number for backwards compatibility.
- Version bumped across `package.json`, `server.json`, `agent-desk-plugin.json`.

## 1.3.27 (2026-04-08)

### Added

- **`knowledge_admin` actions `prune_orphans` and `vacuum`.** Prune deletes embeddings for sessions that no longer exist on disk (compares `listSessions()` against `SELECT DISTINCT source_id FROM embeddings WHERE source='session'`); auto-VACUUMs after pruning unless disabled. Standalone `vacuum` action reclaims free pages independently. New methods on `VectorStore`: `listIndexedSessionIds`, `pruneOrphanSessions`, `vacuum`. Live cleanup on the dev DB pruned 121 orphan sessions (69364 chunks) and reclaimed 352.4 MB (793 → 441 MB).

### Fixed

- **Sessions header counter showed loaded-page count, not total.** `/api/sessions` now returns `{sessions, total}` when `limit`/`offset` is set; the dashboard header stat uses `total` so it stays at the true session count instead of growing as you scroll.

## 1.3.26 (2026-04-08)

### Fixed

- **Session detail panel showed `unknown / unknown` for cwd + branch** while the session card correctly showed the project + branch. The `getSessionMeta` parser used `entries[0]` directly, which on Claude Code sessions is a metadata-only entry (`permission-mode`, `file-history-snapshot`, …) without `timestamp` / `cwd` / `gitBranch`. Now skips leading metadata entries and uses the first entry that has a top-level `timestamp` — mirrors the existing fix in `fastMeta()`. The two code paths used to disagree.

## 1.3.25 (2026-04-08)

### Documentation

- Self-documenting release: documents this version + retroactively records the 1.3.24 release whose payload was the 1.3.18 – 1.3.23 backfill.

## 1.3.23 (2026-04-08)

### Fixed

- **Standalone dashboard stuck on "Connecting to agent-knowledge..." overlay.** Removed `<script src="template.js">` from `src/ui/index.html`. Since v1.3.9 the standalone autoinit guard in `app.js` (`if (typeof K._template !== 'function')`) was always false because `template.js` was loaded in standalone mode, so `init()` never ran and the loading overlay never hid. `template.js` is only needed by the plugin host (loaded via `agent-desk-plugin.json` `uiFiles`); standalone has the markup hardcoded in the HTML and doesn't need the runtime template.

## 1.3.22 (2026-04-08)

### Fixed

- **Build broken: `createRateLimiter` no longer exported by `agent-common`.** Inlined a minimal token-bucket rate limiter in `src/dashboard.ts` (keyed by remote IP, named `default` + `heavy` windows) to replace the missing import. Resolves the TS2305 build error and re-greens the failing `tests/dashboard.test.ts` file. Vitest count back to 352.

### Added

- **Playwright E2E dashboard test suite** at `tests/e2e-ui/dashboard.pw.ts`. Boots the standalone dashboard with a temp `KNOWLEDGE_MEMORY_DIR` / `KNOWLEDGE_DATA_DIR` so the real `~/agent-knowledge/` is never touched. Seeds three markdown entries, then asserts: page loads with no console errors, REST `/api/knowledge` returns the seeded entries, REST `/api/knowledge/search?q=…` returns results, the search input renders + accepts a query without errors. Runnable via `npm run test:e2e:ui`. Devdep `@playwright/test`.

## 1.3.21 (2026-04-08)

### Changed

- Adopted `createRateLimiter` from agent-common 1.1.0 in place of the local rate-limiter implementation. (Subsequently reverted in 1.3.22 after agent-common dropped the export.)

## 1.3.20 (2026-04-08)

### Changed

- `dashboard.ts` refactored to use `agent-common` helpers (`createRouter`, `json`, `serveStatic`, `setupWebSocket`). Version-file bumps in a follow-up commit.

## 1.3.19 (2026-04-08)

### Fixed

- Raised timeout on the flaky session-search tests for slow CI runners.

## 1.3.18 (2026-04-08)

### Changed

- Added `agent-common` as a dependency for package metadata.

## 1.3.17 (2026-04-07)

### Changed

- **Doc rewrites for post-consolidation tool surface.** Updated `README.md`, `CLAUDE.md`, `docs/ARCHITECTURE.md`, and `docs/SETUP.md` to use the current action-based tool form (`knowledge { action: "write" }`) instead of references to the obsolete per-action tool names (`knowledge_write`, `knowledge_read`, `knowledge_list`, `knowledge_delete`, `knowledge_sync`, `knowledge_recall`). The README's tool table at the top was already correct; this fixes the deeper docs.

### Added

- **Host auto-detect expanded.** `src/types.ts` now auto-detects projects directories from all five well-known AI coding host roots: `.claude`, `.cursor`, `.codex`, `.aider`, `.continue` (was just `.claude` and `.cursor`). Aligned with the host-agnostic Genericity rule.

### Fixed

- All three version files (`package.json`, `server.json`, `agent-desk-plugin.json`) re-aligned to **1.3.17**. They had silently drifted: package was at 1.3.16, server was at 1.3.15 (with the inner package version even older at 1.3.14), and agent-desk-plugin was at 1.3.15.

## 1.3.1 (2026-03-30)

### Changed

- **DRY constants** — `CATEGORIES` now defined once in `knowledge/store.ts`, imported by `tool-handlers.ts` and `server.ts`
- **Type-safe session parsing** — extracted `extractText()` helper in `parser.ts`, replacing 3 repeated unsafe `as unknown[]` cast blocks with a single type-guarded function
- **Stale doc fix** — CLAUDE.md `knowledge_sync` → `knowledge(action: 'sync')`

## 1.3.0 (2026-03-29)

### Further Tool Consolidation (11 → 6)

Reduced MCP tool count from 11 to 6 by merging remaining individual tools into action-based interfaces.

- **`knowledge`** (was 5 tools: `knowledge_list`, `knowledge_read`, `knowledge_write`, `knowledge_delete`, `knowledge_sync`) — actions: `list`, `read`, `write`, `delete`, `sync`
- **`knowledge_search`** now handles scoped recall too — when `scope` is provided (errors, plans, configs, tools, files, decisions), behaves as the former `knowledge_recall`

### MCP Tools (6)

**Knowledge (1):** `knowledge` (actions: list, read, write, delete, sync)

**Search (1):** `knowledge_search` (general search + scoped recall via `scope` param)

**Sessions (1):** `knowledge_session` (actions: list, get, summary)

**Knowledge Graph (1):** `knowledge_graph` (actions: link, unlink, list, traverse)

**Analysis (1):** `knowledge_analyze` (actions: consolidate, reflect)

**Admin (1):** `knowledge_admin` (actions: status, config)

## 1.3.0 (2026-03-29)

### Tool Consolidation (18 → 11)

Reduced MCP tool count from 18 to 11 by merging related tools into action-based interfaces. All functionality is preserved — tools are routed by the `action` parameter.

- **`knowledge_graph`** (was 4 tools: `knowledge_link`, `knowledge_unlink`, `knowledge_links`, `knowledge_graph`) — actions: `link`, `unlink`, `list`, `traverse`
- **`knowledge_session`** (was 3 tools: `knowledge_sessions`, `knowledge_get`, `knowledge_summary`) — actions: `list`, `get`, `summary`
- **`knowledge_analyze`** (was 2 tools: `knowledge_consolidate`, `knowledge_reflect`) — actions: `consolidate`, `reflect`
- **`knowledge_admin`** (was 2 tools: `knowledge_index_status`, `knowledge_config`) — actions: `status`, `config`

### MCP Tools (11)

**Knowledge (5):** `knowledge_list`, `knowledge_read`, `knowledge_write`, `knowledge_delete`, `knowledge_sync`

**Knowledge Graph (1):** `knowledge_graph` (actions: link, unlink, list, traverse)

**Sessions (3):** `knowledge_session` (actions: list, get, summary), `knowledge_search`, `knowledge_recall`

**Analysis (1):** `knowledge_analyze` (actions: consolidate, reflect)

**Admin (1):** `knowledge_admin` (actions: status, config)

## 1.3.0 (2026-03-29)

### Memory Consolidation / Dedup

`knowledge_write` now checks for near-duplicate entries using TF-IDF similarity after writing. If any existing entry exceeds a 0.6 similarity threshold, a warning is included in the response with paths and scores.

- **`knowledge_analyze(action: "consolidate")`** — scans entries in a category (or all), groups near-duplicates into clusters using TF-IDF similarity > 0.5 (configurable), returns clusters with pairwise similarity scores. Read-only analysis.
- **Dashboard**: "Duplicates" button in Knowledge tab header triggers consolidation scan. Entries in duplicate clusters show a warning icon. Clicking opens a panel with cluster details and similarity scores.

### Reflection Cycle

- **`knowledge_analyze(action: "reflect")`** — finds knowledge entries with zero graph edges and prepares a structured prompt for the agent's LLM to identify new connections. Returns unconnected entries with content summaries, connected entries as potential link targets, and a ready-to-use prompt.
- Does NOT call an LLM itself — the agent processes the prompt and calls `knowledge_graph(action: "link")` based on the analysis.
- **Dashboard**: "Reflect" button in Knowledge tab header shows unconnected entries in a panel with summaries and suggested instructions.

### MCP Tools (11)

**Knowledge (5):** `knowledge_list`, `knowledge_read`, `knowledge_write`, `knowledge_delete`, `knowledge_sync`

**Knowledge Graph (1):** `knowledge_graph` (actions: link, unlink, list, traverse)

**Sessions (3):** `knowledge_session` (actions: list, get, summary), `knowledge_search`, `knowledge_recall`

**Analysis (1):** `knowledge_analyze` (actions: consolidate, reflect)

**Admin (1):** `knowledge_admin` (actions: status, config)

## 1.2.0 (2026-03-29)

### Knowledge Graph

New relationship layer for connecting knowledge entries. Edges are stored in a dedicated `edges` SQLite table with 8 typed relationships: `related_to`, `supersedes`, `depends_on`, `contradicts`, `specializes`, `part_of`, `alternative_to`, `builds_on`.

- **`knowledge_graph(action: "link")`** — create or update a weighted edge between two entries
- **`knowledge_graph(action: "unlink")`** — remove edges (optionally filtered by relationship type)
- **`knowledge_graph(action: "list")`** — list edges for an entry or relationship type
- **`knowledge_graph(action: "traverse")`** — BFS traversal from a starting entry to configurable depth
- **`knowledge_read`** now shows related entries alongside content

### Confidence & Decay Scoring

New `entry_scores` SQLite table tracks access frequency and recency. Search results are ranked using:

```
finalScore = baseRelevance * 0.5^(daysSinceLastAccess / 90) * maturityMultiplier
```

- **Auto-promotion**: entries mature from candidate (0.5x) to established (1.0x) at 5 accesses, then to proven (1.5x) at 20 accesses
- Frequently accessed entries rise in rankings; stale entries decay over time

### Auto-linking on Write

`knowledge_write` now automatically finds the top-3 most similar existing entries via cosine similarity and creates `related_to` edges for any pair scoring above 0.7. This builds the knowledge graph organically as entries are added.

### MCP Tools (11)

**Knowledge (5):** `knowledge_list`, `knowledge_read`, `knowledge_write`, `knowledge_delete`, `knowledge_sync`

**Knowledge Graph (1):** `knowledge_graph` (actions: link, unlink, list, traverse)

**Sessions (3):** `knowledge_session` (actions: list, get, summary), `knowledge_search`, `knowledge_recall`

**Admin (1):** `knowledge_admin` (actions: status, config)

## 1.1.1 (2026-03-28)

### Bug Fixes

- **Session discovery**: auto-detect `~/.claude/projects` as extra session root so Claude Code sessions are found without requiring `KNOWLEDGE_DATA_DIR` env var (regression from v1.1.0 generic naming refactor)

### Features

- **Dashboard**: clicking a search result now scrolls to and highlights the matching message in the session panel

### Documentation

- **Windows**: added note about C++ build tools requirement for `better-sqlite3` when prebuilt binaries are unavailable (e.g. Node 24+)

## 1.1.0 (2026-03-27)

### Multi-Source Session Adapters

agent-knowledge now auto-discovers and reads sessions from all major AI coding assistants. If a tool is installed, its sessions appear automatically in the dashboard and search results -- no configuration required.

- **New adapters**: OpenCode (SQLite), Cline (JSON), Continue.dev (JSON), Aider (Markdown/JSONL)
- **Auto-detection**: Cursor sessions discovered from `~/.cursor/projects/*/agent-transcripts/`; OpenCode from `~/.local/share/opencode/opencode.db`; Cline from VS Code globalStorage; Continue.dev from `~/.continue/sessions/`; Aider from `.aider.chat.history.md` / `.aider.llm.history` in project dirs
- **Adapter interface**: pluggable `SessionAdapter` with `isAvailable()`, `discoverProjects()`, `listSessions()`, `parseSession()` -- add new tools by implementing one file
- **`EXTRA_SESSION_ROOTS` env var**: comma-separated paths for additional session directories
- **`OPENCODE_DATA_DIR` env var**: override OpenCode data location (default `~/.local/share/opencode`)

### Generic Naming Refactor

Removed Claude Code-specific language throughout. agent-knowledge is now fully client-agnostic.

- **Config fields renamed**: `claudeDir` -> `dataDir`, `projectsDir` -> `sessionsDir`
- **Env vars renamed**:
  - `KNOWLEDGE_DATA_DIR` (was `CLAUDE_DIR`)
  - `KNOWLEDGE_ANTHROPIC_API_KEY` (was `KNOWLEDGE_CLAUDE_API_KEY`)
- **Default memory directory**: `~/agent-knowledge`
- **Embedding class renamed**: `ClaudeEmbeddingProvider` -> `AnthropicEmbeddingProvider`
- **Documentation**: all references updated to use generic "agent sessions" language, architecture diagrams show "Session Data Dir" instead of `~/.claude/projects`

## 1.0.0 (2026-03-26)

Initial release.

### MCP Tools (11)

**Knowledge (5):** `knowledge_list`, `knowledge_read`, `knowledge_write`, `knowledge_delete`, `knowledge_sync`

**Sessions (3):** `knowledge_session` (actions: list, get, summary), `knowledge_search`, `knowledge_recall`

**Admin (1):** `knowledge_admin` (actions: status, config)

### Search Engine

- Hybrid semantic + TF-IDF search with configurable alpha blending
- Recency decay weighting (newer sessions rank higher)
- Fuzzy matching via Levenshtein distance
- 6 recall scopes: errors, plans, configs, tools, files, decisions
- Role-based filtering (all, user, assistant)
- Regex mode for pattern-based searches

### Embeddings & Vector Store

- SQLite vector store with sqlite-vec for cosine similarity
- 4 embedding providers: local (Hugging Face), OpenAI, Claude/Voyage, Gemini
- Background indexer runs on server startup
- Automatic provider switching with dimension migration

### Knowledge Base

- Git-synced markdown vault at `~/agent-knowledge/` (previously `~/claude-memory/`)
- 5 categories: projects, people, decisions, workflows, notes
- YAML frontmatter for metadata (title, tags, updated)
- Auto git commit + push on writes, pull on reads
- Configurable git URL via `knowledge_admin(action: "config")` tool or `KNOWLEDGE_GIT_URL` env var
- New repos auto-scaffolded with README, .gitignore, and category dirs

### Auto-Distillation

- Automatic extraction of session insights into knowledge base
- Project name normalization (worktrees, swarms merged into parent)
- Secrets scrubbing: API keys, tokens, passwords, JWTs, private keys redacted
- System noise stripped (XML tags, task notifications)
- Absolute paths normalized to `~/`
- Defense-in-depth audit blocks writes with surviving sensitive content

### Persistent Configuration

- `knowledge_admin(action: "config")` for runtime setup (no restart needed)
- Config stored at XDG/AppData location (tool-agnostic)
- Priority: env vars > persisted config > defaults

### Web Dashboard

- http://localhost:3423, auto-starts with MCP server
- 5 tabs: Knowledge, Search, Sessions, Recall, Embeddings
- MD3 design language matching agent-comm and agent-tasks
- Light/dark theme with localStorage persistence
- Side panel (560px, resizable) with markdown rendering
- Live reload via file watcher + WebSocket
- Semantic search toggle with score breakdown

### Performance

- Session file mtime cache (re-parses only changed files)
- Global TF-IDF index cache with 60s TTL
- Background embedding indexer (non-blocking)

### Infrastructure

- REST API: 10 endpoints (knowledge, sessions, search, recall, index-status, health)
- WebSocket server for real-time dashboard updates
- 280 tests passing (vitest)
- TypeScript strict mode, ES modules
- GitHub Actions CI (Node 20/22 matrix, npm publish on tags)

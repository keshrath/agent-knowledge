# /knowledge pane — test coverage

Every control, key, command form, view, notice, toast, status and context output and layout of the
pane, and the test that covers it. **E2E** = `tests/e2e-claude/pane.e2e.test.ts` (the real Claude
Code CLI, `npm run e2e:claude`); **unit** = `plugin/tests/knowledge.test.ts` (`claude plugin test
plugin`); **REST** = `tests/rest-pane.test.ts` / `tests/rest.test.ts` (vitest). E2E names are
`<describe> > <it>`, shortened.

## Commands

| What                                                                               | E2E                                                          | Unit                                                   |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------ |
| `/knowledge` answers the counts, opens a plain sidebar on Browse                   | docked > /knowledge answers with the counts and opens Browse | /knowledge opens a plain sidebar on Browse             |
| `/knowledge <words>` searches, answers the hit counts                              | docked > /knowledge <words> searches; a session hit opens    | /knowledge <words> searches entries and sessions       |
| `/knowledge <path>` (with or without `.md`) opens the entry, says `opened <title>` | docked > /knowledge <path> opens that entry                  | /knowledge <path> opens the entry; says what it opened |
| `/knowledge <path>` not there: said, Browse shows                                  | docked > /knowledge <path> … one not there is said           | /knowledge <path> … one not there is said              |
| `/knowledge` while down: nothing answers at the port                               | server away > /knowledge while down                          | server down: what to do                                |
| `/knowledge` with an older server: names its version                               | server away > an older agent-knowledge on the port           | an agent-knowledge from before the pane                |
| Pane not placed: the reason in the answer                                          | — (the CLI places it at every tested width)                  | /knowledge says why when the pane is not placed        |

## Header and keys

| What                                                                       | E2E                                                                                                  | Unit                                   |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `1` `2` `3` `4` switch Browse, Search, Sessions, Health                    | docked > 2 opens Search …; 3 lists sessions …; 4 shows Health …; an entry another session writes (1) | —                                      |
| `r` refreshes, the key goes to the pane not the prompt                     | docked > an entry another session writes shows without a key (r at its end)                          | —                                      |
| Tab / shift+Tab walk the controls                                          | docked > Tab and shift+Tab walk the rows                                                             | —                                      |
| In a text field the digits type; the bar drops them, the hint says how out | docked > Tab and shift+Tab … where keys type; search with no hit (field)                             | `isField` in categories … one headline |
| Esc gives the keyboard to the prompt (a digit is prompt text)              | docked > Esc gives the keyboard to the prompt                                                        | —                                      |
| ctrl+x tab takes it back, the ring where it was                            | docked > Esc … ctrl+x tab takes it back where it was                                                 | —                                      |
| Key hint fits the width (long, short, unfocused)                           | docked (wide hint), narrow > the tab bar …                                                           | —                                      |
| Tab bar wraps between controls on the narrow dock                          | narrow > the tab bar wraps between controls                                                          | —                                      |
| Mouse: a tab, a row, the back link                                         | docked > the mouse: a tab, a row, the way back                                                       | —                                      |
| Status line under the tabs: busy, outcome (✓ / ✗ tone), keys               | every action test (✓ hits, ✓ synced, ✓ deleted, ✗ still nothing)                                     | Health …; delete …; server down …      |

## Browse

| What                                                                                                                   | E2E                                                                                                                            | Unit                                                                             |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Category bar with counts, `other` for files at the top, last                                                           | docked > /knowledge answers … opens Browse                                                                                     | categories in the knowledge base order                                           |
| Newest first; row facts: category, evergreen (accent), maturity, tags, age                                             | docked > /knowledge answers … opens Browse                                                                                     | /knowledge opens a plain sidebar on Browse                                       |
| Ring lands on the first row                                                                                            | docked > /knowledge answers …; inline > opens Browse                                                                           | /knowledge opens …; a category narrows …                                         |
| A category narrows the list (keys per category), lands on its first row; all back                                      | docked > a category narrows the list                                                                                           | a category narrows the list under keys of its own                                |
| Find or a category while filtered: the list is headed `Matches` (`Matches in <category>`)                              | docked > Find narrows by tag                                                                                                   | a filtered list is headed as matches                                             |
| Find by title, tag (row says `tag x`), path; `n matches`                                                               | docked > Find narrows by tag …, by path                                                                                        | a category narrows … Find narrows it                                             |
| No match: says so, ring on Clear the filter; Clear restores                                                            | docked > Find … nothing found offers Clear the filter                                                                          | a category narrows …                                                             |
| Back from an entry lands on the row it came from (first row when it is off the page); along links on the link followed | docked > a link opens its entry; back walks … to the row; large > back to Browse from an entry beyond the shown page           | — (focus: e2e only)                                                              |
| Paging: `▸ 25 more (n left)`, lands on the first row it adds                                                           | large > lists a page at a time                                                                                                 | a long list comes a page at a time                                               |
| A category of hundreds                                                                                                 | large > a category of hundreds narrows at once                                                                                 | —                                                                                |
| Wide-character titles keep a row to two lines                                                                          | docked > a title in wide characters; narrow > … wide titles included                                                           | widths count terminal columns                                                    |
| Long titles cut with `…`                                                                                               | narrow > the tab bar … rows … keep to two                                                                                      | widths … `clip`                                                                  |
| Empty knowledge base                                                                                                   | empty > says what lands here                                                                                                   | an empty knowledge base says what lands here                                     |
| A change made by another session shows without a key (ring kept), in the counts and the status entry                   | docked > an entry another session writes shows without a key; large > the row holding the ring pushed off the page, or deleted | Browse follows entries other sessions write; the status entry follows the counts |

## An entry's page

| What                                                                                                                | E2E                                                                                                | Unit                                                                                     |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Back link names where it returns (Browse / Search / Health / the entry walked from)                                 | docked > an entry …; a link opens …; 2 opens Search …; 4 shows Health …                            | an entry …; /knowledge <words> …; Health …                                               |
| Title, path, category, evergreen, maturity (not `candidate`), reads, updated                                        | docked > an entry: path, reads …                                                                   | an entry: its facts …                                                                    |
| Dates relative up to a week (`2d ago`), as the rows; then the date                                                  | docked > an entry: path, reads … (updated …)                                                       | times: a bare day is a local day                                                         |
| Never read: no read count, no Last read row                                                                         | docked > the mouse … (Release ritual)                                                              | /knowledge <path> opens the entry                                                        |
| Tags, author, last read                                                                                             | docked > an entry: path, reads, tags, author                                                       | an entry: its facts …                                                                    |
| Links both ways with relation words and origin; each opens its entry                                                | docked > an entry …; a link opens its entry; large > /knowledge <path> first: links … carry titles | an entry … links walk and back returns                                                   |
| Body as Markdown without frontmatter or a heading repeating the title                                               | docked > an entry … the body without its frontmatter                                               | an entry …; a page or excerpt drops a first heading                                      |
| Long body folds; toggle names its state and keeps the ring                                                          | docked > a long body folds                                                                         | a long body folds                                                                        |
| Delete asks first (box, warning, ring on Never mind)                                                                | docked > delete asks first                                                                         | delete asks first                                                                        |
| Never mind keeps it, ring back on Delete                                                                            | docked > delete asks first                                                                         | delete asks first                                                                        |
| Delete removes the file, the row, says ✓ deleted                                                                    | docked > delete asks first                                                                         | delete asks first                                                                        |
| Without git: the confirmation says the file goes from this machine, nothing said about pushing; the box shows whole | docked > delete asks first                                                                         | without a remote the delete confirmation …; without git a delete says nothing of pushing |
| With git: the confirmation says so, and the deletion is pushed to the remote                                        | git > a delete is pushed to the remote                                                             | the delete confirmation says what happens …                                              |
| Remote refused the push: said with the deletion                                                                     | git > a remote that refuses the push is said with the deletion                                     | a delete the remote refused is said with it                                              |

## Search

| What                                                                                                    | E2E                                                       | Unit                                                                       |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------- |
| Field with the ring on opening the tab; the hint before a search                                        | docked > 2 opens Search with the ring in its field        | a search with no hit says so                                               |
| Entry hits: title, category, plain excerpt (no frontmatter, no Markdown)                                | docked > 2 opens Search … a search lands on the best hit  | /knowledge <words> …; an excerpt is plain text                             |
| Session hits: project, time, asked / answered, excerpt                                                  | docked > /knowledge <words> searches; a session hit opens | /knowledge <words> …                                                       |
| Ring on the best hit; `✓ n hits for "q"`                                                                | docked > 2 opens Search …                                 | /knowledge <words> …                                                       |
| A hit opens its entry or session; back returns to the results                                           | docked > 2 opens Search …; /knowledge <words> …           | /knowledge <words> …                                                       |
| No hit typed in the field: says so, keeps the words, the ring stays in the field                        | docked > a search with no hit says so                     | a search with no hit says so                                               |
| No hit from `/knowledge <words>`: lands on a button, the next command runs (never typed into the field) | docked > /knowledge <words> with no hit lands on a button | a command search with no hit lands on a button                             |
| Server excerpts come from the body, without headings, segments joined with `·`                          | docked > 2 opens Search … (no heading leads it)           | tests/search.test.ts > takes excerpts from the body; builds excerpt text … |

## Sessions

| What                                                                      | E2E                                                                             | Unit                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Newest first, time, duration (none under a minute), branch, preview       | docked > 3 lists sessions newest first                                          | Sessions: newest first …                                    |
| A short session's duration is its real length                             | docked > 3 lists sessions (20m)                                                 | REST: rest-pane > a short session ends at its last line     |
| Summary: what was asked, files changed, commits, errors (red), tools; cwd | docked > /knowledge <words> … a session hit opens; 3 lists sessions … one opens | Sessions: … a summary with what was asked, files and errors |
| Nothing to summarise                                                      | — (every seeded session says something; a session only of tool calls)           | Sessions: … (s-2)                                           |
| No sessions                                                               | empty > … Sessions and Search say they have nothing                             | —                                                           |
| Paging, lands on the first session it adds                                | large > Sessions come a page at a time too                                      | —                                                           |

## Health

| What                                                                                                                        | E2E                                                               | Unit                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Entries by category, sessions, search mode, folder, git, server version                                                     | docked > 4 shows Health                                           | Health: counts, search index …                                                         |
| No git: no Sync, warning tone, ring on Analyze                                                                              | docked > 4 shows Health … no git                                  | Health without git offers no Sync                                                      |
| Sync now pulls and pushes; ✓ synced                                                                                         | git > Health offers Sync now, which pulls and pushes              | Health … Sync and Analyze                                                              |
| Sync failing: ✗ with the reason's first line                                                                                | —                                                                 | Health … (pull: could not resolve host)                                                |
| Analyze links: most linked (2+ links), one link or none, disjoint; opens an entry; the folder cut from the left on one line | docked > 4 shows Health … Analyze lists                           | Health … Analyze; times … clipPath; REST: rest-pane > lists an entry in one group only |
| Recent activity: live events, newest first                                                                                  | docked > a live event toasts once and shows under Recent activity | live events toast once … Health lists them                                             |

## Status entry, toasts, context

| What                                                              | E2E                                                       | Unit                                                    |
| ----------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------- |
| Status entry `n entries · m sessions` before the pane opens       | docked > the status entry counts entries and sessions     | /knowledge opens …; the status entry follows the counts |
| `offline` / `old server x on the port`                            | server away > says so …; an older agent-knowledge …       | server down …; an agent-knowledge from before the pane  |
| A live event toasts once, the news first; the first poll is quiet | docked > a live event toasts once                         | live events toast once, the news first                  |
| The model's context block (counts, categories, how to search)     | docked > the model is given what the knowledge base holds | the model starts with what the knowledge base holds     |

## The session lifecycle

**E2E** here = `tests/e2e-claude/lifecycle.e2e.test.ts` (real `claude` sessions; the context the model was sent is read from the session's own transcript); **REST** = `tests/rest-lifecycle.test.ts`; **index** = `tests/index-freshness.test.ts`; **leader** = `tests/rest-leader.test.ts`. Shots: `~/.claude/tmp/pane-shots-knowledge/e2e/lifecycle-*.png`.

| What                                                                                     | E2E                                                                                                                     | Unit / REST                                                                              |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Context: holdings, who the person is (identity.md), never ingested                       | known person > the context block: what the knowledge base holds …                                                       | the context carries who the person is; REST wakeup                                       |
| Context: onboarding while nobody said; files named with the folder's separator           | not yet known > the context block asks who the person is … (`lifecycle-onboarding`)                                     | the context asks who the person is …; … the folder's own separator                       |
| Context: a declined identity; `AGENT_KNOWLEDGE_AUTOWAKE=0`                               | —                                                                                                                       | a declined identity …; AUTOWAKE=0 …                                                      |
| Context: changed since the ingest (changed, new, deleted)                                | not yet known > … says what changed since the ingest                                                                    | the context says when the project changed …; REST ingest (5)                             |
| First real prompt: hits beside it, the transcript line, latency on 2,000 entries (< 2 s) | known person > the first real prompt carries … (`lifecycle-first-prompt`)                                               | the first real prompt carries the matching entries, once per conversation                |
| Gates: short, `/`, `!`, a task notice, a peer message; identity.md never a hit           | —                                                                                                                       | short prompts …; a background task notice …; identity.md is not one of the hits          |
| Spent by the first answered search; budget, max hits, kill switch                        | —                                                                                                                       | a prompt with no hit …; the hits keep to …; …\_INJECT=off                                |
| Again in the next conversation                                                           | known person > the next conversation gets its own hits again …                                                          | —                                                                                        |
| `/compact`: snapshot file and contents, the line, summary keeps "Knowledge to save"      | known person > /compact snapshots … (`lifecycle-compact`)                                                               | a compaction takes the snapshot …; …\_NUDGE=0; …\_NUDGE=off                              |
| `/clear`: last snapshot (event end), the line                                            | known person > /clear ends the conversation …                                                                           | the session ending takes its last snapshot …                                             |
| `/exit`: the conversation's snapshot                                                     | known person > … /exit leaves its snapshot                                                                              | nothing asked writes nothing                                                             |
| Snapshot: scrubbed, noise dropped, one file per session, live event                      | —                                                                                                                       | REST snapshot (4)                                                                        |
| A server that takes the connection and never answers                                     | stuck server > the status line says offline and a prompt is answered …                                                  | a stuck server: the first prompt / the first message / the pane / compaction and end (4) |
| Progress while an entry / a session loads                                                | slow server > an entry still loading … (`lifecycle-progress`); a session still loading … (`lifecycle-progress-session`) | —                                                                                        |
| The REST holder that stops answering lets the port go                                    | —                                                                                                                       | leader (4)                                                                               |
| Indexes follow their files; builds give the event loop back                              | —                                                                                                                       | index (9)                                                                                |

## The server

| What                                                             | E2E                                                    | Unit                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------- |
| Down: explains, only Refresh drawn, ring on it                   | server away > says so instead of showing stale entries | server down: …                           |
| Refresh while down: `✗ still nothing at the port (time)`         | server away > … Refresh says it tried                  | server down: …                           |
| Back by itself on the next poll, ring on the first row           | server away > … back by itself                         | server down: … (retry)                   |
| Taken over by another MCP process when the serving one exits     | server away > a second MCP process takes the port over | REST: tests/rest-leader.test.ts          |
| An older version on the port                                     | server away > an older agent-knowledge on the port     | an agent-knowledge from before the pane  |
| Overview counts without parsing entries; a write drops the cache | —                                                      | REST: rest-pane > GET /api/overview      |
| Delete, sync and analysis routes                                 | git >; docked > delete …; 4 shows Health …             | REST: rest-pane > DELETE, sync, analysis |

## Layouts

| What                                                                  | E2E                                                                          |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Docked, fullscreen 160 columns                                        | docked beside the conversation (every view)                                  |
| Docked narrow, fullscreen 110 columns (about 40 columns of pane)      | docked narrow > the tab bar …; an entry, a search and Health fit the sidebar |
| Inline above the prompt, 120 columns                                  | inline above the prompt > opens Browse … Enter opens a row and back returns  |
| Surfaces terminal, desktop, vscode, mobile (no text fields on mobile) | unit: /knowledge opens a plain sidebar on Browse … on every surface          |

## UX review round 1

| What                                                                             | E2E (`pane.e2e`, `lifecycle.e2e`)                                       | Unit / REST                                                                   |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Search: 2 lands on its tab (hotkeys work), 2 again types                         | docked > 2 opens Search on its tab …; an empty knowledge base           | 2 lands on the Search tab …                                                   |
| Session snapshots: own category, not in `all`                                    | links that lead nowhere … > Browse all leaves the session snapshots out | session snapshots are their own category                                      |
| A link to a gone entry: drawn `· gone`, not pressed                              | … > a link to an entry that is not there …                              | a link to an entry that is gone …; REST links missing                         |
| Following a link to an entry deleted meanwhile: said, page stays                 | … > an entry deleted elsewhere, followed from a link …                  | an entry deleted elsewhere, opened from a page …                              |
| Delete drops links; Analyze ignores dead edges; `30 of 68`                       | —                                                                       | REST delete drops links; links missing; a capped hit list …; empty KB analyze |
| A deleted entry leaves the search hits                                           | … > a deleted entry leaves the search hits …                            | a deleted entry leaves the search hits                                        |
| After a delete from a long page, Browse at its top                               | … > a delete from far down a long page …                                | —                                                                             |
| First-prompt line under the prompt, by title; snapshots as toasts                | lifecycle > the first real prompt …; /compact …; /clear …               | the first prompt line comes after …; compaction / end toasts                  |
| Commits from `git commit`, files from edit tool calls; snapshot title/cwd/branch | docked > 3 lists sessions … (Files changed, Commits)                    | REST snapshot (2)                                                             |
| MMR diversifies on BM25-scale scores                                             | —                                                                       | mmr: diversifies on raw BM25-scale scores                                     |
| An outcome survives one unanswered poll; 10 s otherwise                          | —                                                                       | an outcome stays its ten seconds …; … outlives one poll …                     |

## UX review round 2

| What                                                                                   | E2E (`pane.e2e`)                                                        | Unit / REST                                                                        |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Sessions by folder name and first prompt as typed (`/name args`, no wrappers, no HEAD) | … > a real session reads by its folder and its first prompt in Sessions | human.test; REST a session as a real store holds it                                |
| Session summary: prompts, id, `claude --resume <id>`, MCP tool names                   | docked > /knowledge <words> searches …; … > a snapshot page names …     | a session summary says its id and how to resume it                                 |
| Snapshot page: session facts, Open the session                                         | … > a snapshot page names its session and opens it                      | a snapshot page: its session facts …                                               |
| Headline and `all` count curated entries; snapshots named `snapshots`; empty state     | … > Browse all leaves the session snapshots out (start: 10 entries)     | only snapshots so far …; the snapshots category is named snapshots                 |
| First-prompt hits skip snapshots, drop weak matches                                    | —                                                                       | first-prompt hits leave the snapshots out …; REST a search can leave them out      |
| Incoming link `← title · rel this`; body links as mentions, text plain; wide tables    | docked > an entry …; … > a link in the body is listed with the links …  | an incoming link reads with the other entry first …; a table wider than the pane   |
| Command replies: `N entries and M past-session messages for "x"`, `nothing found`      | docked > /knowledge <words> …; … with no hit lands on a button          | /knowledge <words> searches entries and sessions                                   |
| Times with their date, ages in days; facts cut whole; unknown event kinds as words     | docked > 3 lists sessions …                                             | one way of saying when …; a row drops facts …; an event kind not known …           |
| Find narrows as typed; `/knowledge README.md` opens; empty Analyze; toast once         | docked > Find narrows …                                                 | Find narrows as the person types; README.md …; Analyze on an empty …; toasted once |
| Excerpts centred on a query word; short code lines kept                                | —                                                                       | search.test excerpts                                                               |

## UX review round 3 and the pane conventions

| What                                                                                   | E2E (`pane.e2e`, `lifecycle.e2e`)                                        | Unit / REST                                                                    |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Near-copies come once (MMR drops similarity ≥ 0.8); one shared word is no match        | lifecycle > the first real prompt …                                      | mmr: drops copies …; REST the first-prompt search (mmr, min_terms, prompt)     |
| Slash commands are no prompt: preview, count, What was asked; nothing asked folded     | … > a real session reads by its folder …; … > a snapshot page names …    | Sessions: this session marked …; REST sessions (server)                        |
| Snapshot page: open the session only when here; back to the snapshot                   | … > a snapshot page names its session and opens it                       | a snapshot page … and back; a snapshot whose transcript is not on this machine |
| An open page follows its file: edit shows, delete elsewhere `!` back to the tab        | … > an open page follows its file                                        | an open entry follows its file                                                 |
| Counts from the server (`entries`, `snapshots`); `snapshots` named the same everywhere | links that lead nowhere … (start: 12 entries · 4 sessions); docked > 4 … | only snapshots so far …; the snapshots category …                              |
| Analyze pages One link or none (30 at a time, fewest links first); empty: one line     | a large knowledge base > Analyze lists every entry …                     | a capped hit list … (paging); Analyze on an empty knowledge base               |
| Errors in any case (`FAILED`, `errors.UniqueViolation`)                                | —                                                                        | summary-errors.test                                                            |
| Ingest never done or behind reaches the person: toast, Health, empty Browse            | lifecycle > the first real prompt … (toast)                              | a project never ingested is told …; an empty knowledge base … next step        |
| Digits stay the pane's while down                                                      | server away > says so …                                                  | server down: …                                                                 |
| Code drawn apart, a wrapped command indented; wide tables as `Header: value`           | … > code is drawn apart …; … > a link in the body … wide table           | code in a body …; bodyParts; a table wider than the pane …                     |
| Replies silent unless wrong; plain `/knowledge` clears Find and category               | docked > /knowledge opens Browse … says nothing; … searches              | /knowledge opens a plain sidebar …; /knowledge README.md …                     |
| Busy as Progress; outcomes ✓ ✗ ! –, mirrored in the status entry while shown           | git > a remote that refuses … (`!`); server away (`✗ still nothing …`)   | an outcome is mirrored in the status entry …; a delete the remote refused …    |
| Toasts `Label: subject`, three at most                                                 | docked > a live event toasts once …                                      | a toast says three events at most …; live events toast once …                  |
| Folds `▸ N more` / `▾ Show less`, dimmed                                               | a large knowledge base > lists a page at a time                          | a long list comes a page at a time                                             |
| Confirmation: what goes, links lost, Keep it first with the ring, Delete names it      | docked > delete asks first …; git > a delete is pushed                   | delete asks first, saying what it does …                                       |
| Never auto-landing on Sync                                                             | git > Health offers Sync now                                             | Health: counts …                                                               |
| Order kept while the pane holds the keys; an open pane opened afresh                   | —                                                                        | while the pane holds the keyboard, Browse keeps its order                      |
| A failed sync kept under Recent activity                                               | —                                                                        | a sync that failed is kept under Recent activity                               |

## UX review round 4

| What                                                                         | E2E (`pane.e2e`)                                                     | Unit / REST                                                                              |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Event ids rise across processes: toasts go on after a takeover               | server away > a second MCP process takes the port over (toast after) | events.test (a fresh module after a busy one)                                            |
| Quoted frontmatter values read without quotes                                | —                                                                    | store.test parseFrontmatter quoted                                                       |
| Words with a slash searched unless `.md` or a KB folder                      | docked > /knowledge words with a slash search them                   | /knowledge with a slash in its words searches them …                                     |
| First-prompt hits: content terms, share needed, title/tag one fewer          | lifecycle > the first real prompt …                                  | REST the first-prompt search (prompt=true, mmr): the table                               |
| Snapshots named snapshots in heading and facts                               | … > Browse all leaves the session snapshots out (heading)            | the snapshots category is named snapshots on its page and in its heading                 |
| Sessions page past the loaded 100 from the server                            | —                                                                    | Sessions go on past the ones loaded                                                      |
| First-prompt line names its hits whole                                       | lifecycle > the first real prompt …                                  | the first prompt line comes after …                                                      |
| An edit elsewhere to the open entry is said                                  | … > an open page follows its file                                    | an edit made elsewhere to the open entry is said                                         |
| The ring waits on Refresh while a delete is drawn away; no "Running…"        | docked > delete asks first … (ring watched through the gap)          | —                                                                                        |
| Analyze sorts numbered titles as numbers                                     | —                                                                    | REST sorts numbered titles as numbers                                                    |
| Folder whole; no entry hit said; last activity; row shown whole; no old Find | docked > 4 shows Health … (folder)                                   | Health: the folder whole …; a snapshot page says when …; /knowledge <path> clears a Find |

## UX review round 5

| What                                                                         | E2E (`pane.e2e`, `lifecycle.e2e`)                   | Unit / REST                                                           |
| ---------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------- |
| The ring in Find stays when a folder appears or goes above it                | docked > typing fast … (a new folder, then emptied) | —                                                                     |
| /clear with the pane open: Browse draws again                                | docked > /clear with the pane open                  | —                                                                     |
| The /clear snapshot said in the next conversation's first line, by its title | lifecycle > /clear ends the conversation …          | the session ending takes its last snapshot …                          |
| First-prompt rule measured: acks/chit-chat none, every on-topic answer found | lifecycle > the first real prompt …                 | first-prompt-eval.test (table); REST the first-prompt search          |
| 2.x session dumps are session records; title from H1; date from the name     | —                                                   | REST what the 2.x hooks left beside the curated entries               |
| Plain /knowledge is Browse; Find wants every word; `/knowledge projects/`    | —                                                   | Find wants every word …; /knowledge projects/ opens Browse …          |
| A tab key while down is said; a search while warming up waits, retries       | —                                                   | a tab key while the server is down …; a search while the server warms |

## UX review round 6

| What                                                                                    | E2E (`pane.e2e`, `lifecycle.e2e`)                                  | Unit / REST                                                  |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| Enter twice on Ingest runs nothing (the Enter at the prompt held, the command put back) | lifecycle > Enter twice on Ingest … (10/40/60 ms)                  | an empty knowledge base … the next step (second Enter held)  |
| A Find / Search field drawn anew shows what is applied or typed                         | —                                                                  | a Find field drawn anew …; words typed into Search …         |
| A compaction summary is no prompt                                                       | lifecycle > /clear ends the conversation … (user_turns 1)          | parser: a compaction summary in the person turn is no prompt |
| First-prompt rule: 0 off-topic on four bases, on-topic ≥ 9 in 10                        | lifecycle > the first real prompt …                                | first-prompt-eval.test (table, 64 prompts, four bases)       |
| A key pressed while the ring lands wins (claims); search leaves its field               | docked > typing fast … (no settle before 1)                        | —                                                            |
| After a delete the ring rests on Refresh                                                | docked > delete asks first … (an Enter more opens nothing)         | —                                                            |
| Text with terminal control draws everywhere, cleaned                                    | links that lead nowhere … > text with terminal control in it draws | text with terminal control …; text.test (snapshot, excerpts) |
| 2.x dumps named by project, day and kind                                                | —                                                                  | REST a 2.x dump without a title is named …                   |

## UX review round 7

| What                                                                           | E2E (`pane.e2e`, `lifecycle.e2e`)                                  | Unit / REST                                                   |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------- |
| First-prompt rule: holdout 0 off-topic, ≥ 80% hits on topic (words and hybrid) | lifecycle > the first real prompt …                                | first-prompt-eval.test (TUNE/HOLDOUT), first-prompt-rule.test |
| A burst of Enter on Ingest: every Enter held, said once                        | lifecycle > a burst of Enter on Ingest … (2×10/40/60, 3×30/120 ms) | an empty knowledge base … the next step                       |
| A press on a redrawn button: a move by its key, a change said                  | —                                                                  | a press whose button was drawn again … (moveOf)               |
| A coloured error line is found in a session summary                            | —                                                                  | summary-errors.test                                           |
| Back from a session opened from Sessions lands on its row                      | 3 lists sessions … (back lands on the row)                         | —                                                             |
| A burst of Enter on Open the session stays on the page                         | a snapshot page names its session … (Enter ×3, 80 ms)              | a snapshot page … (back held as the session opens)            |
| C1 OSC/DCS/CSI taken whole                                                     | —                                                                  | text.test; text with terminal control … (C1 OSC payload)      |

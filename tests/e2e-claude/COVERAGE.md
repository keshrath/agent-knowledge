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

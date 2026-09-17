# git.md — when Claude commits

Companion to `CLAUDE.md` §8 (AI-usage discipline). `CLAUDE.md` governs architecture; this file governs
version-control behaviour only. If the two ever disagree, `CLAUDE.md` wins.

This file is standing authorisation to **commit** without asking each time.
It is **not** authorisation to push, to create branches, or to rewrite history — those still need an explicit ask.

---

## 1. Commit triggers — commit when ALL of these hold

1. A unit of work from the `CLAUDE.md` §10 build order is **complete**, not half-done.
2. `pnpm typecheck` passes.
3. `pnpm test` passes — once tests exist (Step 8). Before that, the step's actual path was run end-to-end
   at least once (`CLAUDE.md` §13.8).
4. No secret, key, token or `.env.local` content is in the diff (see §4).

One commit per build-order step is the default rhythm:

| Step | Commit subject |
|---|---|
| 1 | `chore: scaffold hono + tsx + strict ts + store interface` |
| 2 | `feat: discovery, polite fetch, extract` |
| 3 | `feat: normalize, frontmatter, runCrawl` |
| 4 | `feat: bigram tf-idf retrieval` |
| 5 | `feat: forced search tool + grounded answer + trace` |
| 6 | `feat: diff, webhook, runCheck lifecycle` |
| 7 | `feat: one-page UI` |
| 8 | `test: five high-value tests` |
| 9 | `docs: README, tech note, demo script` |

Split a step into two commits when it produces genuinely separable pieces (e.g. `Store` interface vs.
`FsStore` implementation). Never batch two steps into one commit — `CLAUDE.md` §8 says small commits,
and the reviewer reads this history to see how the work was built.

## 2. Commit when NOT at a step boundary

Also commit immediately after:

- a dependency change (add/remove) — the commit body names the dependency
- a bug fix that has a reproducing test
- any environment/toolchain fix that a fresh clone depends on (lockfile, `pnpm-workspace.yaml`, tsconfig)
- finishing a doc file

## 3. Do NOT commit when

- typecheck or tests are red — fix first, or the reviewer sees a broken history
- the work is mid-refactor and the tree only half-compiles
- the only change is a scratchpad/debug artefact
- the change is purely a local-machine preference (shell profile, editor config) — that is not project state
- the user is actively editing the same files

Never `git add -A` blindly. Stage named paths, then `git diff --cached --stat` before committing.

## 4. Never commit — hard stops

- `.env`, `.env.local`, or any real API key, token or bearer secret — keys live only in `.env.local`
- `docs/` and `quick_start_zh.md` — kept locally, never committed (both are gitignored)
- `node_modules/`
- `data/cache/`, `data/index/`, `data/trace/`, `data/last-check.json` — all generated, all gitignored
- real scraped EDB HTML outside `data/snapshots/` (bulk, noisy, no grading value)
- anything under the session scratchpad directory

Pre-commit guard:

```sh
git diff --cached | grep -nE 'sk-[A-Za-z0-9]{20,}|Bearer [A-Za-z0-9._-]{20,}' && echo "SECRET IN DIFF — ABORT"
```

## 5. Always commit (these are deliverables, not noise)

- `data/snapshots/*.md` — the **editable baseline the reviewer hand-edits**. `CLAUDE.md` §3 marks it
  COMMITTED. Committing snapshots is required, not an accident.
- `config/pages.json` — the human-reviewed allowlist
- `pnpm-lock.yaml` and `pnpm-workspace.yaml` — §12 requires the lockfile committed

## 6. Message format

```
<type>: <imperative subject, <= 72 chars>

- <what changed>
- <what changed>
```

Types: `feat` `fix` `chore` `test` `docs` `refactor` `build`.

- The body is optional. When present, it is a short list of **what** the commit changes.
- **No trailers** — no `Co-Authored-By`, no `Signed-off-by`, no generated-with lines.
- **No process content** — no investigation narrative, failed attempts, measurements, provider
  outages, or notes on who drafted what. Describe the change, not how it was arrived at. That
  context stays out of git.

## 7. Things that always need an explicit ask

- `git push` (any remote, any branch)
- creating or switching branches
- `git rebase`, `git reset --hard`, `git commit --amend` on anything already pushed
- force-push of any kind
- `git clean -fdx`
- deleting or rewriting `data/snapshots/` in a way that discards a reviewer's hand-edit

## 8. Working branch

Work happens on `main` for this assessment — it is a solo take-home with no collaborators, so branch
overhead buys nothing. If the user asks for a PR-based flow, switch and update this file.

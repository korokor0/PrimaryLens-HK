# EDB primary-education agent

A grounded question-answering agent over the Hong Kong EDB primary-education pages, with
change detection on the pages it monitors.

It answers **only** from the pages it watches, cites the page title and URL for every fact,
and says so plainly when the pages do not support an answer. Separately, it compares those
pages against a committed baseline each day and sends a plain-language notification describing
what changed.

- **Q&A** — one real LLM tool call per question, with the full tool trace shown in the UI and
  written to `data/trace/*.jsonl`.
- **Change detection** — sentence-level diffs against `data/snapshots/*.md`, which are
  committed to this repository and meant to be edited by hand.
- **Notification** — a generic webhook carrying readable text, never raw HTML.
- **Triggers** — `pnpm check` for cron, and a 「檢查更新」 button in the UI. Both run the same code.

**In a hurry?** [quick_start.md](quick_start.md)

---

## 1. Requirements

- **Node 20 or newer** (developed on 26.8.2)
- **pnpm 12**

```bash
npm install -g pnpm@12     # npm ships with Node
```

> `corepack enable` also works, but **only on Node ≤ 24** — corepack is no longer bundled with
> Node 25+. The `packageManager` field is committed either way.

## 2. Install and run (about 5 minutes)

```bash
pnpm install
cp .env.example .env.local     # then add your OpenAI key, see §3

pnpm crawl                     # ~35s: fetches the 22 watched pages, builds the baseline + index
pnpm dev                       # http://127.0.0.1:3666
```

That is the whole setup. `config/pages.json` and `data/snapshots/` are already committed, so
you do **not** need to run `pnpm discover` unless you want to rebuild the watch list.

If port 3666 is busy: `PORT=3667 pnpm dev`. The server listens on `127.0.0.1` only; to serve it
publicly, put a reverse proxy (e.g. Caddy) in front rather than changing `HOST`.

## 3. Environment variables

Copy `.env.example` to `.env.local`. Never commit `.env.local`.

| Variable               | Required for | Default                                                                                                                   |
| ---------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`     | chat only    | —                                                                                                                        |
| `OPENAI_MODEL`       | chat only    | —                                                                                                                        |
| `OPENAI_QUERY_MODEL` | optional     | unset → same as `OPENAI_MODEL`. A cheaper model for the search-query call only; the answer always uses `OPENAI_MODEL` |
| `OPENAI_BASE_URL`    | chat only    | `https://api.openai.com/v1`                                                                                             |
| `WEBHOOK_URL`        | optional     | unset → notification is skipped, and the run still succeeds                                                              |
| `EDB_SEED_URL`       | discovery    | the EDB 小學教育 page                                                                                                     |
| `FETCH_DELAY_MS`     | crawl/check  | `1500`                                                                                                                  |
| `BOT_USER_AGENT`     | crawl/check  | `edb-primary-agent/0.1 (+contact)`                                                                                      |

**`discover`, `crawl` and `check` never need an API key.** Monitoring is fully deterministic
and must not depend on a model. Only chat does.

The LLM client uses an **OpenAI-compatible Chat Completions endpoint with native function
calling**. Tested with: OpenAI (`api.openai.com`), models `gpt-5.4-mini`, `gpt-5.4` and
`gpt-4.1-mini`. No other provider has been tested, and there is no JSON tool-call fallback.

## 4. `crawl` vs `check` — the important distinction

|                           | `pnpm crawl`                                | `pnpm check`                                      |
| ------------------------- | --------------------------------------------- | --------------------------------------------------- |
| Purpose                   | **Initialise or reset** the baseline    | **Compare** against the baseline              |
| Writes `data/snapshots/` | Yes, always                                   | Only *after* a notification succeeds or is skipped |
| When to run               | Once at setup, or to deliberately re-baseline | Daily, from cron or the UI button                   |

**Never use `crawl` as the daily monitor.** It overwrites the snapshots, which are the very
thing `check` compares against — running it daily would mean never detecting anything.

## 5. Commands

```bash
pnpm dev                                 # server with reload
pnpm start                               # server, no reload

pnpm check                               # compare, notify, advance the baseline
pnpm check -- --dry-run                  # compare and print; writes nothing, notifies nobody
pnpm check -- --simulate "全日制::半日制"   # no network at all; deterministic demo of the diff

pnpm discover                            # rebuild config/pages.json (review it by hand after)
pnpm crawl                               # reset the baseline
pnpm test                                # 19 tests, no network
pnpm typecheck
```

`pnpm check` exits `0` whether anything changed or not, and `1` only if a page could not be
checked. It prints a machine-readable summary line: `status=unchanged`, or
`status=changed pages=2 notified=true`.

Cron:

```cron
TZ=Asia/Hong_Kong
0 8 * * * cd /path/to/repo && pnpm check >> logs/check.log 2>&1
```

## 6. Demo path

**Grounded answer.** Ask 「小學全日制的背景是甚麼？」 — you get an answer citing 背景 with its
EDB URL, and the right-hand panel shows the real tool call, the query the model chose, the
retrieval scores and the timings.

**Honest refusal.** Ask 「香港今日天氣點樣？」 or paste a prompt-injection attempt. The agent
replies that it can only answer from the monitored pages. The trace shows the search happened
and scored 0 — and shows **no second model call at all**, because the refusal comes from
application code rather than from asking the model nicely.

**Change detection.** Edit one sentence in any file under `data/snapshots/`, for example:

```bash
# in data/snapshots/applicable-to-primary-whole-day-schooling-background-index.md
# change 一九九三年 to 二零零三年
pnpm check
```

`check` reports that one sentence, on that one page, in plain language, and then advances the
baseline so a second run prints `status=unchanged`. The UI's 「檢查更新」 button does the same
thing through the same code path.

**Status page.** `http://127.0.0.1:3666/status` is a read-only, server-rendered view of the
same state: whether chat and the webhook are configured, when the index was built, the last
check's result, and each watched page's snapshot age. It triggers nothing.

To watch a webhook fire, point `WEBHOOK_URL` at any endpoint that accepts a POST.

## 6b. Docker (optional)

```bash
cp docker-compose.yml.example docker-compose.yml
cp .env.example .env.local                  # add your key
docker compose run --rm app pnpm crawl      # one-off: build baseline + index
docker compose up -d                        # http://127.0.0.1:3666
```

`./data` is bind-mounted, so the snapshots the container compares against are the ones in your
checkout — you can still hand-edit `data/snapshots/*.md` and watch `check` notice. Nothing
schedules the daily check: see the comments in `docker-compose.yml.example` for the host-cron
line, or the optional sidecar.

## 7. How it works

```
config/pages.json      reviewed allowlist of 22 pages — the only URLs ever fetched
   |
   |  pnpm crawl                                 pnpm check
   v                                                 |
data/snapshots/*.md    committed baseline  <---- compared against, never overwritten first
   |                                                 |
   |  chunk + bigram TF-IDF                          |  sentence/section diff
   v                                                 v
data/index/            retrieval index          readable notification -> WEBHOOK_URL
   |
   v
search_edb_knowledge   the single tool the model can call
```

**Retrieval** is character-bigram TF-IDF over ~104 chunks — no embeddings, no vector database.
Chinese has no word boundaries, so bigrams need no segmenter; IDF stops ubiquitous terms like
教育 and 學校 from matching everything. Latin text is tokenised as whole words instead, because
two-letter English fragments match almost any English text.

**The agent** gets exactly one tool, `search_edb_knowledge`, and exactly one turn to use it.
The first model call is *forced* to search. If the evidence scores below a calibrated
threshold, application code returns a fixed not-found message and the model is never asked to
write an answer. Change detection and notification are deliberately **not** exposed to the
model: they are deterministic, side-effecting operations, and letting a model trigger them
would add nondeterminism without improving anything.

**Politeness.** Allowlist only, never recursive. Serial requests, 1.5s apart, identified by
`BOT_USER_AGENT`, 15s timeout, one retry, `robots.txt` respected. Chat never touches
edb.gov.hk; it reads only the local index.

## 8. Layout

```
config/pages.json        reviewed allowlist (+ candidates discovery saw but did not select)
data/snapshots/*.md      COMMITTED baseline, one file per page — edit these to test detection
data/{cache,index,trace} generated, git-ignored
src/lib/                 all logic; Web-standard APIs only, no node:* except store/fs.ts
src/lib/store/           one Store interface; FsStore for disk, MemoryStore for tests
src/app.ts               Hono routes;  src/ui/page.tsx  the single page
scripts/                 discover / crawl / check CLI entrypoints
tests/                   5 test files, 19 tests, none touching the network
```

`src/lib` has no Node dependencies and all state goes through the `Store` interface, so the
same code could run on a VPS with the filesystem or on a Worker with KV.

## 9. Limits

Honest scope for a proof of concept — see `docs/TECH_NOTE.md` for the full list.

- 22 pages, Traditional Chinese only. An English question cannot match this corpus and will
  correctly receive the not-found message.
- EDB sends no `ETag` or `Last-Modified`, so every check is a full fetch. The conditional-GET
  and 304 handling is implemented and tested, but never exercised against the live site.
- The no-evidence threshold (0.10) was calibrated by hand over 41 queries on this corpus. It
  is a tuned heuristic, not an evaluated metric.
- File-based storage with no locking — fine for one process, not for concurrent writers.

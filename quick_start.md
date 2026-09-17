# Quick start

Five minutes from clone to a working demo. For the full picture see [README.md](README.md).

## 1. Prerequisites

- **Node 20 or newer** — check with `node -v`
- **pnpm 12** — `npm install -g pnpm@12`
- An **OpenAI API key** (only for asking questions; change detection works without one)

> Don't use `corepack enable` unless you're on Node ≤ 24 — corepack is no longer bundled with
> Node 25+.

## 2. Set up

```bash
pnpm install
cp .env.example .env.local
```

Open `.env.local` and fill in two lines:

```env
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.4-mini
```

Leave everything else as it is. Never commit this file.

## 3. Build the baseline and start

```bash
pnpm crawl      # ~35 seconds: fetches the 22 watched pages, builds snapshots + search index
pnpm dev        # http://localhost:3000
```

`pnpm crawl` is a one-off. You do **not** need `pnpm discover` — the watch list is already
committed.

## 4. Try it

Open http://localhost:3000.

**A question it can answer** — 「小學全日制的背景是甚麼？」
You get an answer citing the EDB page it came from. The right-hand panel shows the real tool
call, the search query the model chose, the retrieval score and the timings.

**A question it can't** — 「香港今日天氣點樣？」
It tells you it can only answer from the monitored pages. In the trace you'll see the search
ran and scored 0 — and that there is **no second model call at all**. The refusal is code, not
a prompt instruction, so it can't be argued out of. Try a prompt injection and you get the same.

## 5. See change detection work

Open any file in `data/snapshots/` — these are the committed baseline. For example
`applicable-to-primary-whole-day-schooling-background-index.md`. Change one sentence: replace
`一九九三年` with `二零零三年`, and save.

Then click **檢查更新** in the UI, or run:

```bash
pnpm check
```

It reports that one sentence, on that one page, in plain language — never raw HTML. Run it
again and you get `status=unchanged`, because the baseline moved forward once the change was
reported.

To see a webhook fire, set `WEBHOOK_URL` in `.env.local` to any endpoint that accepts a POST
(a [webhook.site](https://webhook.site) URL works).

## 6. Handy commands

```bash
pnpm check -- --dry-run                  # compare and print; writes nothing, notifies nobody
pnpm check -- --simulate "全日制::半日制"   # demo the diff with no network at all
pnpm test                                # 19 tests, no network needed
pnpm typecheck
```

## Troubleshooting

| Problem | Fix |
|---|---|
| `corepack: command not found` | Use `npm install -g pnpm@12`; corepack is gone in Node 25+ |
| `Port 3000 is already in use` | `PORT=3001 pnpm dev` |
| `No retrieval index yet` | Run `pnpm crawl` once |
| `Chat needs OPENAI_API_KEY and OPENAI_MODEL` | Add both to `.env.local`. Monitoring still works without them |
| `pnpm check` exits 1 | A page couldn't be fetched; the failing pages are listed above the error |

## Next

- [README.md](README.md) — env vars, architecture, the `crawl` vs `check` distinction
- [docs/DEMO.md](docs/DEMO.md) — a timed 4-minute walkthrough
- [docs/TECH_NOTE.md](docs/TECH_NOTE.md) — design decisions and honest limits

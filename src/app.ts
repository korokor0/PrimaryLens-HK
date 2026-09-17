/**
 * Hono app factory.
 *
 * Takes its Store, env bag and reviewed allowlist as arguments so the same routes can be
 * mounted by the Node server (FsStore) or, later, a Worker (KvStore) — CLAUDE.md §2, §11.
 * The UI's 「檢查更新」 button and the `pnpm check` CLI both drive the same runCheck(), so there
 * is one lifecycle with two entrypoints (§6).
 */
import { Hono } from 'hono';
import { ConfigError, exampleTopics, parseConfig, type WatchedPage } from './lib/config.ts';
import { createOpenAIModel, runChat } from './lib/agent/loop.ts';
import { runCheck } from './lib/check.ts';
import { PoliteFetcher } from './lib/fetch/polite.ts';
import type { Store } from './lib/store/types.ts';
import { renderPage } from './ui/page.tsx';
import { renderStatusPage, type StatusView } from './ui/status.tsx';
import { parseSnapshot } from './lib/snapshot/frontmatter.ts';

export interface AppDeps {
  store: Store;
  env: Record<string, string | undefined>;
  pages: WatchedPage[];
}

export function createApp({ store, env, pages }: AppDeps): Hono {
  const app = new Hono();
  const topics = exampleTopics(pages);
  const allowedUrls = new Set(pages.map((page) => page.url));

  app.get('/', (c) => c.html(renderPage()));

  // Read-only operational view. Reads the same Store the checker writes; triggers nothing.
  const startedAt = new Date();
  app.get('/status', async (c) => {
    const now = new Date();
    const [lastCheck, index] = await Promise.all([store.readStatus(), store.readIndex()]);
    const byStatus = new Map((lastCheck?.pages ?? []).map((p) => [p.slug, p] as const));

    const rows = await Promise.all(
      pages.map(async (page) => {
        const markdown = await store.readSnapshot(page.slug);
        const meta = markdown === null ? {} : parseSnapshot(markdown).meta;
        const last = byStatus.get(page.slug);
        return {
          slug: page.slug,
          title: meta['title'] ?? page.title,
          url: page.url,
          hasSnapshot: markdown !== null,
          fetchedAt: meta['fetched_at'],
          status: last?.status,
          note: last?.note,
        };
      }),
    );

    // Config is reported as configured / not configured. The key itself is never rendered.
    let chat: StatusView['chat'];
    try {
      const cfg = parseConfig(env, 'chat');
      chat = {
        configured: true,
        model: cfg.openaiModel,
        queryModel: cfg.openaiQueryModel ?? cfg.openaiModel,
        baseUrl: cfg.openaiBaseUrl,
      };
    } catch (err) {
      chat = { configured: false, error: err instanceof ConfigError ? err.message : String(err) };
    }
    let monitor: StatusView['monitor'];
    try {
      const cfg = parseConfig(env, 'monitor');
      monitor = { webhookConfigured: cfg.webhookUrl !== undefined, fetchDelayMs: cfg.fetchDelayMs };
    } catch (err) {
      monitor = { webhookConfigured: false, error: err instanceof ConfigError ? err.message : String(err) };
    }

    return c.html(
      renderStatusPage({
        startedAt,
        now,
        chat,
        monitor,
        index: index === null ? null : { builtAt: index.builtAt, chunkCount: index.chunkCount },
        lastCheck,
        rows,
      }),
    );
  });

  // Source Monitor panel: last check result, or null before the first run.
  app.get('/api/status', async (c) => {
    return c.json({ lastCheck: await store.readStatus(), watchedPages: pages.length });
  });

  app.post('/api/chat', async (c) => {
    let question: string;
    try {
      const body = (await c.req.json()) as { question?: unknown };
      question = typeof body.question === 'string' ? body.question : '';
    } catch {
      return c.json({ error: 'Expected a JSON body of the form {"question": "..."}' }, 400);
    }

    let cfg;
    try {
      // 'chat' requires the LLM vars; monitoring commands deliberately do not (§4).
      cfg = parseConfig(env, 'chat');
    } catch (err) {
      // One readable line, never a stack trace (§12).
      return c.json({ error: err instanceof ConfigError ? err.message : 'Chat is not configured.' }, 503);
    }

    const index = await store.readIndex();
    if (index === null) {
      return c.json({ error: 'No retrieval index yet. Run `pnpm crawl` first.' }, 503);
    }

    try {
      const result = await runChat(
        {
          model: createOpenAIModel({
            apiKey: cfg.openaiApiKey ?? '',
            baseUrl: cfg.openaiBaseUrl,
            model: cfg.openaiModel ?? '',
          }),
          // Only build a second client when the query model actually differs.
          ...(cfg.openaiQueryModel !== undefined && cfg.openaiQueryModel !== cfg.openaiModel
            ? {
                queryModel: createOpenAIModel({
                  apiKey: cfg.openaiApiKey ?? '',
                  baseUrl: cfg.openaiBaseUrl,
                  model: cfg.openaiQueryModel,
                }),
              }
            : {}),
          index,
          allowedUrls,
          exampleTopics: topics,
        },
        question,
      );

      // JSONL trace on disk, mirroring what the UI's activity panel shows (§1.2).
      await store.appendTrace('chat', result.trace);

      return c.json({
        answer: result.answer,
        grounded: result.grounded,
        sources: result.sources,
        trace: result.trace,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 502);
    }
  });

  // 「檢查更新」 button. Runs exactly the same runCheck() as `pnpm check` — one lifecycle,
  // two entrypoints (§6), so the UI can never drift from what cron does.
  // data/ is plain files with no locking, so two checks in this process must never overlap.
  // The UI disables its button while a run is in flight; this guards the API itself.
  let checkInFlight = false;

  app.post('/api/check', async (c) => {
    if (checkInFlight) {
      return c.json({ error: 'A check is already running. Wait for it to finish, then try again.' }, 409);
    }
    let cfg;
    try {
      cfg = parseConfig(env, 'monitor');
    } catch (err) {
      return c.json({ error: err instanceof ConfigError ? err.message : 'Monitoring is not configured.' }, 503);
    }

    const fetcher = new PoliteFetcher({ userAgent: cfg.botUserAgent, delayMs: cfg.fetchDelayMs });
    checkInFlight = true;
    try {
      const robots = await fetcher.loadRobots(new URL(cfg.seedUrl).origin);
      const result = await runCheck({ store, fetcher, pages, robots, webhookUrl: cfg.webhookUrl });
      return c.json({
        status: result.status,
        changedPages: result.changedPages,
        notified: result.notified,
        pages: result.pages,
        messages: result.messages,
        webhookConfigured: cfg.webhookUrl !== undefined,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    } finally {
      checkInFlight = false;
    }
  });

  return app;
}

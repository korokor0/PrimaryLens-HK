/**
 * Hono app factory.
 *
 * Takes its Store and env bag as arguments so the same routes can be mounted by the Node
 * server (FsStore) or, later, a Worker (KvStore) — CLAUDE.md §2, §11. The UI's
 * 「檢查更新」 button and the `pnpm check` CLI both drive the same `runCheck()`, so there is
 * one lifecycle with two entrypoints (§6).
 */
import { Hono } from 'hono';
import type { Store } from './lib/store/types.ts';

export interface AppDeps {
  store: Store;
  env: Record<string, string | undefined>;
}

export function createApp({ store }: AppDeps): Hono {
  const app = new Hono();

  // Source Monitor panel: last check result, or null before the first run.
  app.get('/api/status', async (c) => {
    return c.json({ lastCheck: await store.readStatus() });
  });

  return app;
}

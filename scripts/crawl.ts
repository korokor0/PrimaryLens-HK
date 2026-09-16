/**
 * `pnpm crawl` — initialise or reset the baseline.
 *
 * This is NOT the daily monitor. It overwrites data/snapshots/, which is exactly what the
 * daily check must never do. README states the distinction; CLAUDE.md §5.2 requires it.
 */
import { readFile } from 'node:fs/promises';
import { config as loadEnv } from 'dotenv';
import { ConfigError, parseConfig, parsePages } from '../src/lib/config.ts';
import { PoliteFetcher } from '../src/lib/fetch/polite.ts';
import { FsStore } from '../src/lib/store/fs.ts';
import { runCrawl } from '../src/lib/crawl.ts';

loadEnv({ path: ['.env.local', '.env'], quiet: true });

async function main(): Promise<void> {
  const cfg = parseConfig(process.env, 'monitor');
  const pages = parsePages(JSON.parse(await readFile('config/pages.json', 'utf8')));

  const fetcher = new PoliteFetcher({ userAgent: cfg.botUserAgent, delayMs: cfg.fetchDelayMs });
  const robots = await fetcher.loadRobots(new URL(cfg.seedUrl).origin);

  console.log(`crawling ${pages.length} page(s) — this resets the baseline in data/snapshots/`);
  const result = await runCrawl({
    store: new FsStore('data'),
    fetcher,
    pages,
    robots,
    log: (line) => console.log(line),
  });

  console.log(`\nsaved=${result.saved} skipped=${result.skipped} failed=${result.failed}`);
  if (result.failed > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err instanceof ConfigError || err instanceof Error ? err.message : String(err));
  process.exit(1);
});

/**
 * `runCrawl` — baseline initialisation / reset.
 *
 * CLAUDE.md §5.2 draws a hard line between this and `runCheck`: crawl is allowed to write
 * snapshots because it *establishes* the baseline. The daily monitor must never call it, or
 * it would overwrite the very thing it is supposed to compare against.
 *
 * Takes its Store, fetcher and page list as arguments so nothing here touches the filesystem
 * or process.env — the Node script supplies those, and a Worker could supply different ones.
 */
import type { WatchedPage } from './config.ts';
import type { Store } from './store/types.ts';
import { isAllowed, type PoliteFetcher, type RobotsRules } from './fetch/polite.ts';
import { normalize } from './snapshot/normalize.ts';
import { serializeSnapshot } from './snapshot/frontmatter.ts';

export interface CrawlDeps {
  store: Store;
  fetcher: PoliteFetcher;
  pages: WatchedPage[];
  robots: RobotsRules;
  /** Progress reporting, so the CLI can stream lines without lib importing anything. */
  log?: (line: string) => void;
}

export interface CrawlPageResult {
  slug: string;
  url: string;
  title: string;
  status: 'saved' | 'skipped' | 'failed';
  note?: string;
  bodyChars?: number;
}

export interface CrawlResult {
  saved: number;
  skipped: number;
  failed: number;
  pages: CrawlPageResult[];
}

export async function runCrawl(deps: CrawlDeps): Promise<CrawlResult> {
  const { store, fetcher, pages, robots } = deps;
  const log = deps.log ?? ((): void => {});
  const results: CrawlPageResult[] = [];

  for (const page of pages) {
    // A robots-blocked URL is skipped with a report line, never a failed run (§5.1).
    if (!isAllowed(robots, page.url)) {
      results.push({ ...page, status: 'skipped', note: 'robots.txt disallows this path' });
      log(`  skip ${page.slug}: robots.txt disallows this path`);
      continue;
    }

    let result;
    try {
      // No conditional headers: a reset wants the full current representation.
      result = await fetcher.get(page.url);
    } catch (err) {
      const note = err instanceof Error ? err.message : String(err);
      results.push({ ...page, status: 'failed', note });
      log(`  fail ${page.slug}: ${note}`);
      continue;
    }

    if (result.status !== 200 || result.html === null) {
      const note = `HTTP ${result.status}`;
      results.push({ ...page, status: 'failed', note });
      log(`  fail ${page.slug}: ${note}`);
      continue;
    }

    const normalized = normalize(result.html, page.url);
    const title = normalized.title !== '' ? normalized.title : page.title;

    await store.writeSnapshot(
      page.slug,
      serializeSnapshot({ url: page.url, title, fetched_at: new Date().toISOString() }, normalized.body),
    );
    // The raw HTML is kept as the last-known *live* representation, which is all the HTTP
    // cache ever is. It is never the comparison baseline (§13.4).
    await store.writeCache(page.slug, {
      html: result.html,
      ...(result.etag !== undefined ? { etag: result.etag } : {}),
      ...(result.lastModified !== undefined ? { lastModified: result.lastModified } : {}),
    });

    results.push({ ...page, title, status: 'saved', bodyChars: normalized.body.length });
    log(`  save ${page.slug}: ${title} (${normalized.body.length} chars)`);
  }

  return {
    saved: results.filter((r) => r.status === 'saved').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
    pages: results,
  };
}

/**
 * `pnpm discover` — propose the watch allowlist, for a human to review.
 *
 * Writes config/pages.json. CLAUDE.md §5.1 step 7 requires a person to read that file and
 * commit it; nothing crawls from it until then. This script never writes snapshots.
 *
 * Depth: the seed's links, plus one further level for links that turn out to be *hubs*
 * (a list of links rather than prose). Measuring the live site showed several of the seed's
 * own links are hubs holding 25-187 characters, so a strict one-hop allowlist would build a
 * corpus with nothing to cite. Approved deviation, recorded in docs/AI_LOG.md.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { config as loadEnv } from 'dotenv';
import { ConfigError, parseConfig } from '../src/lib/config.ts';
import { PoliteFetcher, isAllowed, type RobotsRules } from '../src/lib/fetch/polite.ts';
import { extractPage, isHubPage, type ExtractedPage } from '../src/lib/fetch/extract.ts';

loadEnv({ path: ['.env.local', '.env'], quiet: true });

/** CLAUDE.md §5.1 step 5. */
const MAX_PAGES = 25;
/** Everything we watch lives under this path; it is what "primary education" means here. */
const SCOPE_PREFIX = '/tc/edu-system/primary-secondary/';

interface PageEntry {
  slug: string;
  url: string;
  title: string;
  contentChars: number;
  discoveredFrom: string;
}

/** Same-site, in-scope, HTML, robots-permitted. PDFs and other files are skipped in v1. */
function inScope(url: string, robots: RobotsRules): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.host !== 'www.edb.gov.hk') return false;
  if (!parsed.pathname.startsWith(SCOPE_PREFIX)) return false;
  if (!parsed.pathname.endsWith('.html')) return false;
  if (parsed.pathname.startsWith('/attachment/')) return false;
  return isAllowed(robots, url);
}

/**
 * Filesystem-safe id derived from the URL path, so a snapshot filename is traceable back to
 * its page. `primary.html` and `primary/index.html` are different pages and must not collide.
 */
function slugFor(url: string, taken: Set<string>): string {
  const path = new URL(url).pathname.slice(SCOPE_PREFIX.length).replace(/\.html$/, '');
  const base = path.replace(/\//g, '-').replace(/[^a-zA-Z0-9-]/g, '').replace(/-+/g, '-') || 'page';
  let slug = base;
  for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
  taken.add(slug);
  return slug;
}

async function main(): Promise<void> {
  const cfg = parseConfig(process.env, 'monitor');
  const fetcher = new PoliteFetcher({ userAgent: cfg.botUserAgent, delayMs: cfg.fetchDelayMs });

  const robots = await fetcher.loadRobots(new URL(cfg.seedUrl).origin);
  console.log(
    robots.fetched
      ? `robots.txt: ${robots.disallow.length} Disallow rule(s) apply to us`
      : 'robots.txt: not retrievable; proceeding (only an explicit Disallow blocks a URL)',
  );

  /** Fetch + extract one page, or null if it could not be read. */
  const load = async (url: string): Promise<ExtractedPage | null> => {
    const result = await fetcher.get(url);
    if (result.status !== 200 || result.html === null) {
      console.log(`  skip ${url} (HTTP ${result.status})`);
      return null;
    }
    return extractPage(result.html, url);
  };

  const seed = await load(cfg.seedUrl);
  if (seed === null) throw new Error(`seed page could not be fetched: ${cfg.seedUrl}`);
  console.log(`seed: ${seed.title} (${seed.links.length} links in content area)`);

  const taken = new Set<string>();
  const visited = new Set<string>([cfg.seedUrl]);
  const entries: PageEntry[] = [
    {
      slug: slugFor(cfg.seedUrl, taken),
      url: cfg.seedUrl,
      title: seed.title,
      contentChars: seed.contentText.length,
      discoveredFrom: 'seed',
    },
  ];

  // Level 1: the seed's in-scope links. A hub among them contributes its children too.
  const level2: { url: string; parent: string }[] = [];
  for (const url of seed.links.filter((u) => inScope(u, robots))) {
    if (visited.has(url)) continue;
    visited.add(url);
    const page = await load(url);
    if (page === null) continue;

    const hub = isHubPage(page);
    entries.push({
      slug: slugFor(url, taken),
      url,
      title: page.title,
      contentChars: page.contentText.length,
      discoveredFrom: 'seed',
    });
    console.log(`  ${hub ? 'hub ' : 'page'} ${page.title} — ${page.contentText.length} chars`);

    if (hub) {
      for (const child of page.links.filter((u) => inScope(u, robots))) {
        if (!visited.has(child)) level2.push({ url: child, parent: page.title });
      }
    }
  }

  // Level 2: children of hubs only. These are not expanded further.
  for (const { url, parent } of level2) {
    if (visited.has(url)) continue;
    visited.add(url);
    const page = await load(url);
    if (page === null) continue;
    entries.push({
      slug: slugFor(url, taken),
      url,
      title: page.title,
      contentChars: page.contentText.length,
      discoveredFrom: parent,
    });
    console.log(`    child ${page.title} — ${page.contentText.length} chars (via ${parent})`);
  }

  // The seed is always watched, however little prose it holds: §1 scopes the task as "the
  // seed page plus pages it links to", and a change to its link list is itself news worth
  // notifying. Only the remainder competes for the cap.
  const [seedEntry, ...rest] = entries;
  if (seedEntry === undefined) throw new Error('no pages discovered');

  const ranked = [...rest].sort((a, b) => b.contentChars - a.contentChars);
  const selected = ranked.slice(0, MAX_PAGES - 1);
  const notSelected = ranked.slice(MAX_PAGES - 1);

  // Restore discovery order so the file reads top-down like the site.
  const byDiscovery = (a: PageEntry, b: PageEntry) => entries.indexOf(a) - entries.indexOf(b);
  const pages = [seedEntry, ...selected.sort(byDiscovery)];

  await mkdir('config', { recursive: true });
  await writeFile(
    'config/pages.json',
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        seed: cfg.seedUrl,
        // `pages` is the watch list. `candidates` is everything else discovery saw, kept so a
        // reviewer can promote one by hand without re-crawling the site (§5.1 step 7).
        pages,
        candidates: notSelected.sort(byDiscovery),
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  console.log(`\nwrote config/pages.json: ${pages.length} watched, ${notSelected.length} unselected candidate(s)`);
  console.log('REVIEW config/pages.json BY HAND before running `pnpm crawl`.');
}

main().catch((err: unknown) => {
  // One readable line, never a stack trace (CLAUDE.md §4).
  console.error(err instanceof ConfigError || err instanceof Error ? err.message : String(err));
  process.exit(1);
});
